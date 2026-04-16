#!/usr/bin/env node
// Shadow Tracker — monitors option prices for ALL historical flow alerts (not just traded ones).
// Runs every 30 minutes during market hours. Saves pricing snapshots to data/shadow-state.json.
//
// Start: cd Moby && nohup setsid node shadow-tracker.js </dev/null >> data/shadow-tracker.log 2>&1 &
// Stop:  pkill -f "shadow-tracker.js"

const https = require('https');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const API_TOKEN = process.env.UW_API_TOKEN;
if (!API_TOKEN) { console.error('Missing UW_API_TOKEN env var'); process.exit(1); }

// ─── Crash handlers ───
const LOG_PREFIX = () => `[${new Date().toISOString()}]`;
process.on('uncaughtException', (err) => {
  console.error(`${LOG_PREFIX()} FATAL uncaughtException: ${err.stack || err.message || err}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error(`${LOG_PREFIX()} FATAL unhandledRejection: ${reason?.stack || reason}`);
  process.exit(1);
});

const DATA_DIR = path.join(__dirname, 'data');
const SHADOW_STATE_FILE = path.join(DATA_DIR, 'shadow-state.json');
const CYCLE_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MS = 300; // match scanner rate limit
const SIM_ALLOCATION = 500; // $500 max spend per alert for PnL simulation
const CLOSED_MARKET_SLEEP_MS = 5 * 60 * 1000;

const INDEX_TICKERS = new Set(['SPX', 'SPXW', 'SPY', 'QQQ', 'IWM', 'DIA', 'XSP', 'VIX', 'NDX', 'RUT']);

// Tickers that differ between UW and Yahoo option chains
const YAHOO_TICKER_MAP = {
  'BRKB': 'BRK-B',
  'SPXW': 'SPX',  // Yahoo uses SPX for SPXW weeklies
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Yahoo Finance helpers (crumb + cookie auth) ───
let yahooCrumb = null;
let yahooCookie = null;
let yahooCrumbExpiry = 0;

function yahooRequest(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)', ...extraHeaders };
    https.get(url, { headers, timeout: 15000 }, res => {
      let d = '';
      const cookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, data: d, cookies }));
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Yahoo timeout')); });
  });
}

async function ensureYahooCrumb() {
  if (yahooCrumb && yahooCookie && Date.now() < yahooCrumbExpiry) return;
  // Step 1: get cookie
  const r1 = await yahooRequest('https://fc.yahoo.com');
  yahooCookie = r1.cookies;
  // Step 2: get crumb
  const r2 = await yahooRequest('https://query2.finance.yahoo.com/v1/test/getcrumb', { Cookie: yahooCookie });
  yahooCrumb = r2.data.trim();
  yahooCrumbExpiry = Date.now() + 3600000; // 1hr
}

async function fetchYahooJson(url) {
  await ensureYahooCrumb();
  const fullUrl = url + (url.includes('?') ? '&' : '?') + 'crumb=' + encodeURIComponent(yahooCrumb);
  const r = await yahooRequest(fullUrl, { Cookie: yahooCookie });
  if (r.status === 401 || r.data.includes('Invalid Crumb')) {
    // Crumb expired, refresh and retry once
    yahooCrumb = null;
    await ensureYahooCrumb();
    const fullUrl2 = url + (url.includes('?') ? '&' : '?') + 'crumb=' + encodeURIComponent(yahooCrumb);
    const r2 = await yahooRequest(fullUrl2, { Cookie: yahooCookie });
    return JSON.parse(r2.data);
  }
  return JSON.parse(r.data);
}

/**
 * Fetch option contracts for a ticker from Yahoo Finance.
 * Only fetches expiry dates that contain positions we need (not all 24+ expiries).
 * Returns flat array of {contractSymbol, lastPrice, bid, ask, ...}.
 */
async function fetchYahooOptionChain(ticker, neededExpiries) {
  try {
    // First call — gets available expiry timestamps + first expiry's chain
    const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}`;
    const data = await fetchYahooJson(url);
    const result = data?.optionChain?.result?.[0];
    if (!result) return [];

    const contracts = [];
    if (result.options?.[0]) {
      const opt = result.options[0];
      if (opt.calls) contracts.push(...opt.calls);
      if (opt.puts) contracts.push(...opt.puts);
    }

    // Only fetch expiry dates we actually need
    const expirations = result.expirationDates || [];
    const firstExpiry = expirations[0];
    for (let i = 1; i < expirations.length; i++) {
      // Convert epoch to YYYY-MM-DD to check if we need it
      const expDate = new Date(expirations[i] * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      if (neededExpiries && !neededExpiries.has(expDate)) continue;

      await sleep(250);
      try {
        const expUrl = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}?date=${expirations[i]}`;
        const expData = await fetchYahooJson(expUrl);
        const expResult = expData?.optionChain?.result?.[0];
        if (expResult?.options?.[0]) {
          const opt = expResult.options[0];
          if (opt.calls) contracts.push(...opt.calls);
          if (opt.puts) contracts.push(...opt.puts);
        }
      } catch (e) {
        // Skip this expiry, continue
      }
    }
    return contracts;
  } catch (e) {
    return [];
  }
}

function isMarketHours() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
}

function today() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function dte(expiry) {
  const expiryClose = new Date(expiry + 'T16:00:00-05:00');
  return Math.max(0, Math.round((expiryClose - Date.now()) / 86400000));
}

// ─── API ───
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'Authorization': `Bearer ${API_TOKEN}` }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Parse error: ${d.slice(0, 300)}`)); }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch option contracts for a ticker. Fetches page 1 first, then only
 * fetches additional pages if some target option symbols are still unmatched.
 * @param {string} ticker
 * @param {Set<string>} [neededSymbols] - option symbols we need prices for
 */
async function getOptionContracts(ticker, neededSymbols) {
  const allContracts = [];
  const MAX_PAGES = 10;

  for (let page = 1; page <= MAX_PAGES; page++) {
    await sleep(RATE_LIMIT_MS);
    try {
      const url = `https://api.unusualwhales.com/api/stock/${ticker}/option-contracts?page=${page}`;
      const result = await fetchJson(url);
      const data = result?.data || [];
      if (data.length === 0) break;
      allContracts.push(...data);
      if (data.length < 500) break; // last page

      // After page 1, only continue if we still have unmatched symbols
      if (neededSymbols && neededSymbols.size > 0) {
        for (const c of data) {
          if (c.option_symbol) neededSymbols.delete(c.option_symbol);
        }
        if (neededSymbols.size === 0) break; // all found
      } else if (page >= 1 && !neededSymbols) {
        break; // no symbol list provided, just fetch page 1
      }
    } catch (e) {
      console.error(`${LOG_PREFIX()} Chain fetch failed for ${ticker} page ${page}: ${e.message}`);
      break;
    }
  }
  return allContracts;
}

// ─── State I/O ───
function loadShadowState() {
  if (!fs.existsSync(SHADOW_STATE_FILE)) return { lastRun: null, positions: {} };
  try { return JSON.parse(fs.readFileSync(SHADOW_STATE_FILE, 'utf8')); }
  catch (e) { return { lastRun: null, positions: {} }; }
}

function saveShadowState(state) {
  state.lastRun = new Date().toISOString();
  fs.writeFileSync(SHADOW_STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── JSONL Loading ───
function loadAllAlerts() {
  const alerts = new Map(); // id -> alert object
  const files = fs.readdirSync(DATA_DIR).filter(f => /^flow-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  for (const file of files) {
    const lines = fs.readFileSync(path.join(DATA_DIR, file), 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const alert = JSON.parse(line);
        if (alert.id && alert.option_chain && alert.expiry) {
          alerts.set(alert.id, alert);
        }
      } catch { /* skip malformed */ }
    }
  }
  return alerts;
}

function loadTodayAlerts() {
  const todayFile = path.join(DATA_DIR, `flow-${today()}.jsonl`);
  const alerts = new Map();
  if (!fs.existsSync(todayFile)) return alerts;
  const lines = fs.readFileSync(todayFile, 'utf8').trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const alert = JSON.parse(line);
      if (alert.id && alert.option_chain && alert.expiry) {
        alerts.set(alert.id, alert);
      }
    } catch { /* skip */ }
  }
  return alerts;
}

// ─── Shadow Position Builder ───
function alertToShadowPosition(alert) {
  const strike = parseFloat(alert.strike || 0);
  const underlying = parseFloat(alert.underlying_price || 0);
  const bid = parseFloat(alert.bid || 0);
  const ask = parseFloat(alert.ask || 0);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : parseFloat(alert.price || 0);
  const premium = parseFloat(alert.total_premium || 0);
  const volOi = parseFloat(alert.volume_oi_ratio || 0);
  const iv = parseFloat(alert.iv_start || alert.iv_end || 0);

  let otmPct = 0;
  if (strike > 0 && underlying > 0) {
    otmPct = alert.type === 'call'
      ? ((strike - underlying) / underlying) * 100
      : ((underlying - strike) / underlying) * 100;
  }

  // DTE from alert creation date, not from now
  const alertCreated = alert.created_at ? new Date(alert.created_at) : new Date();
  const d = alert.expiry ? Math.max(0, Math.round((new Date(alert.expiry + 'T16:00:00') - alertCreated) / 86400000)) : 0;
  const hasEarnings = !!alert.next_earnings_date;

  return {
    alertId: alert.id,
    ticker: alert.ticker,
    optionSymbol: alert.option_chain,
    type: alert.type || 'call',
    strike,
    expiry: alert.expiry,
    entryPrice: ask > 0 ? ask : mid,  // what you'd pay to enter (ask), fallback to mid
    entryBid: bid,
    entryAsk: ask,
    entryMid: mid,
    alertPremium: premium,
    alertVolOi: volOi,
    alertIv: iv,
    alertOtmPct: Math.max(0, otmPct),
    alertDte: d,
    underlying,
    earningsDate: alert.next_earnings_date || null,
    hasEarnings,
    isIndex: INDEX_TICKERS.has(alert.ticker),
    isSweep: !!alert.has_sweep,
    alertDate: (alert.created_at || '').slice(0, 10),
    lastPrice: null,
    lastBid: null,
    lastAsk: null,
    lastUpdated: null,
    peakPrice: null,
    status: 'active',
    simulatedPnl: null,
    simulatedPnlPct: null,
  };
}

// ─── Main Cycle ───
async function runCycle(state, isFirstRun) {
  const cycleStart = Date.now();
  const todayStr = today();

  // Load alerts
  let alerts;
  if (isFirstRun || Object.keys(state.positions).length === 0) {
    console.log(`${LOG_PREFIX()} [shadow] Full backfill — loading all JSONL files`);
    alerts = loadAllAlerts();
  } else {
    alerts = loadTodayAlerts();
  }

  // Add new alerts to state
  let newCount = 0;
  for (const [id, alert] of alerts) {
    if (!state.positions[id]) {
      state.positions[id] = alertToShadowPosition(alert);
      newCount++;
    }
  }
  if (newCount > 0) {
    console.log(`${LOG_PREFIX()} [shadow] Added ${newCount} new alerts to shadow state`);
  }

  // Final pricing sweep + mark expired
  const expiring = Object.values(state.positions).filter(p => p.status === 'active' && p.expiry < todayStr);
  let expiredCount = expiring.length;

  if (expiring.length > 0) {
    // Group by ticker for batch fetching
    const expiringByTicker = {};
    for (const pos of expiring) {
      if (!expiringByTicker[pos.ticker]) expiringByTicker[pos.ticker] = [];
      expiringByTicker[pos.ticker].push(pos);
    }

    let finalPriced = 0;
    console.log(`${LOG_PREFIX()} [shadow] Final pricing sweep: ${expiring.length} positions across ${Object.keys(expiringByTicker).length} tickers expiring`);

    for (const [ticker, positions] of Object.entries(expiringByTicker)) {
      try {
        await sleep(RATE_LIMIT_MS);
        const resp = await fetchJson(`https://api.unusualwhales.com/api/stock/${ticker}/option-contracts`);
        const data = resp?.data || [];
        const lookup = {};
        for (const c of data) {
          if (c.option_symbol) lookup[c.option_symbol] = c;
        }

        for (const pos of positions) {
          const c = lookup[pos.optionSymbol];
          if (c) {
            const last = parseFloat(c.last_price) || 0;
            const bid = parseFloat(c.nbbo_bid) || 0;
            const ask = parseFloat(c.nbbo_ask) || 0;
            const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
            if (last > 0 || bid > 0 || ask > 0) {
              pos.lastPrice = mid > 0 ? mid : (last > 0 ? last : ask);
              pos.lastBid = bid;
              pos.lastAsk = ask;
              pos.lastUpdated = new Date().toISOString();
              if (pos.peakPrice === null || pos.lastPrice > pos.peakPrice) {
                pos.peakPrice = pos.lastPrice;
              }
              finalPriced++;
            }
          }
        }
      } catch (e) {
        if (e.message === 'RATE_LIMITED') {
          console.log(`${LOG_PREFIX()} [shadow] Final sweep rate limited after ${finalPriced} — continuing with stale prices`);
          break;
        }
      }
    }

    if (finalPriced > 0) {
      console.log(`${LOG_PREFIX()} [shadow] Final sweep priced ${finalPriced} / ${expiring.length} positions`);
    }

    // Now mark all as expired with final PnL
    for (const pos of expiring) {
      pos.status = 'expired';
      if (pos.lastPrice !== null && pos.lastPrice !== undefined && pos.entryPrice > 0) {
        pos.simulatedPnlPct = ((pos.lastPrice - pos.entryPrice) / pos.entryPrice) * 100;
        pos.simulatedPnl = Math.round(SIM_ALLOCATION * pos.simulatedPnlPct) / 100;
      }
    }
  }

  // Freeze worthless active positions (≤$0.05) — stop repricing
  let terminalCount = 0;
  for (const pos of Object.values(state.positions)) {
    if (pos.status === 'active' && pos.lastPrice !== null && pos.lastPrice <= 0.05) {
      pos.status = 'terminal';
      if (pos.entryPrice > 0) {
        pos.simulatedPnlPct = ((pos.lastPrice - pos.entryPrice) / pos.entryPrice) * 100;
        pos.simulatedPnl = Math.round(SIM_ALLOCATION * pos.simulatedPnlPct) / 100;
      }
      terminalCount++;
    }
  }
  if (terminalCount > 0) {
    console.log(`${LOG_PREFIX()} [shadow] Froze ${terminalCount} terminal positions (≤$0.05)`);
  }

  // Group active positions by ticker
  const tickerGroups = {};
  for (const pos of Object.values(state.positions)) {
    if (pos.status !== 'active') continue;
    if (!tickerGroups[pos.ticker]) tickerGroups[pos.ticker] = [];
    tickerGroups[pos.ticker].push(pos);
  }

  // Sort tickers: 1) unpriced or very stale (>8h), 2) stalest first (round-robin fairness)
  const todayMs = Date.now();
  const STALE_THRESHOLD_MS = 8 * 60 * 60 * 1000; // 8 hours — treat as urgent
  const tickerPriority = (positions) => {
    let hasUnpriced = false;
    let hasVeryStale = false;
    let minExpiry = Infinity;
    let oldestUpdate = Infinity; // lower = staler = higher priority
    for (const p of positions) {
      if (p.lastPrice === null) {
        hasUnpriced = true;
        const expiryMs = new Date(p.expiry).getTime();
        if (expiryMs < minExpiry) minExpiry = expiryMs;
      }
      if (p.lastUpdated) {
        const updMs = new Date(p.lastUpdated).getTime();
        if (updMs < oldestUpdate) oldestUpdate = updMs;
        if ((todayMs - updMs) > STALE_THRESHOLD_MS) hasVeryStale = true;
      } else {
        oldestUpdate = 0; // never updated = most stale
        hasVeryStale = true;
      }
    }
    // Unpriced short-DTE get top priority (sort key = expiry timestamp)
    if (hasUnpriced) return -1e15 + minExpiry; // negative = always first, sorted by expiry
    // Very stale (>8h) get second priority — sorted by staleness
    if (hasVeryStale) return -0.5e15 + oldestUpdate;
    return oldestUpdate; // older = lower number = higher priority
  };
  const sortedTickers = Object.entries(tickerGroups)
    .sort((a, b) => tickerPriority(a[1]) - tickerPriority(b[1]));

  const urgentCount = sortedTickers.filter(([, positions]) =>
    positions.some(p => p.lastPrice === null && (new Date(p.expiry).getTime() - todayMs) < 3 * 86400000)
  ).length;
  console.log(`${LOG_PREFIX()} [shadow] Active: ${Object.values(state.positions).filter(p=>p.status==='active').length} | Expired: ${expiredCount} | Tickers to price: ${sortedTickers.length} (${urgentCount} urgent DTE<3)`);

  // Fetch prices grouped by ticker (short-DTE unpriced first)
  let tickerCount = 0;
  let pricedCount = 0;

  for (const [ticker, positions] of sortedTickers) {
    tickerCount++;

    // Build set of option symbols we still need (unpriced or stale)
    const allSymbols = new Set(positions.map(p => p.optionSymbol).filter(Boolean));
    const neededSymbols = new Set(
      positions.filter(p => p.lastPrice === null).map(p => p.optionSymbol).filter(Boolean)
    );
    // Pass neededSymbols so pagination only kicks in if page 1 missed some
    const contracts = await getOptionContracts(ticker, neededSymbols.size > 0 ? new Set(neededSymbols) : null);
    if (!contracts.length) continue;

    // Build lookup by option_symbol
    const lookup = {};
    for (const c of contracts) {
      if (c.option_symbol) lookup[c.option_symbol] = c;
    }

    for (const pos of positions) {
      const c = lookup[pos.optionSymbol];
      if (!c) continue; // Not found in chain — skip

      const last = parseFloat(c.last_price) || 0;
      const bid = parseFloat(c.nbbo_bid) || 0;
      const ask = parseFloat(c.nbbo_ask) || 0;
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;

      if (last <= 0 && bid <= 0 && ask <= 0) continue;

      pos.lastPrice = mid > 0 ? mid : (last > 0 ? last : ask);
      pos.lastBid = bid;
      pos.lastAsk = ask;
      pos.lastUpdated = new Date().toISOString();

      // Track peak
      if (pos.peakPrice === null || pos.lastPrice > pos.peakPrice) {
        pos.peakPrice = pos.lastPrice;
      }

      // Simulated PnL: $500 fixed allocation per trade; skip if too expensive
      if (pos.entryPrice > 0) {
        pos.simulatedPnlPct = ((pos.lastPrice - pos.entryPrice) / pos.entryPrice) * 100;
        pos.simulatedPnl = Math.round(SIM_ALLOCATION * pos.simulatedPnlPct) / 100;
      } else if (pos.entryPrice > 0) {
        pos.simulatedPnl = 0;
        pos.simulatedPnlPct = 0;
      }

      pricedCount++;
    }
  }

  // ─── Targeted fallback: individually price positions that chain fetch missed ───
  // Sort by expiry ascending so short-DTE get priced first before rate limits hit
  const stillUnpriced = Object.values(state.positions).filter(
    p => p.status === 'active' && p.lastPrice === null && p.optionSymbol && p.ticker
  ).sort((a, b) => (a.expiry || '9999').localeCompare(b.expiry || '9999'));
  let fallbackPriced = 0;
  let uwRateLimited = false;
  if (stillUnpriced.length > 0) {
    console.log(`${LOG_PREFIX()} [shadow] Fallback: ${stillUnpriced.length} active positions still unpriced, fetching individually`);
    for (const pos of stillUnpriced) {
      if (uwRateLimited) break; // switch to Yahoo below
      try {
        await sleep(RATE_LIMIT_MS);
        const url = `https://api.unusualwhales.com/api/stock/${pos.ticker}/option-contracts?option_symbol=${pos.optionSymbol}`;
        const result = await fetchJson(url);
        const c = result?.data?.[0];
        if (!c) continue;

        const last = parseFloat(c.last_price) || 0;
        const bid = parseFloat(c.nbbo_bid) || 0;
        const ask = parseFloat(c.nbbo_ask) || 0;
        const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
        if (last <= 0 && bid <= 0 && ask <= 0) continue;

        pos.lastPrice = mid > 0 ? mid : (last > 0 ? last : ask);
        pos.lastBid = bid;
        pos.lastAsk = ask;
        pos.lastUpdated = new Date().toISOString();
        if (pos.peakPrice === null || pos.lastPrice > pos.peakPrice) {
          pos.peakPrice = pos.lastPrice;
        }
        if (pos.entryPrice > 0) {
          pos.simulatedPnlPct = ((pos.lastPrice - pos.entryPrice) / pos.entryPrice) * 100;
        pos.simulatedPnl = Math.round(SIM_ALLOCATION * pos.simulatedPnlPct) / 100;
        }
        fallbackPriced++;
      } catch (e) {
        if (e.message === 'RATE_LIMITED') {
          console.log(`${LOG_PREFIX()} [shadow] UW fallback rate limited after ${fallbackPriced} — switching to Yahoo`);
          uwRateLimited = true;
        }
      }
    }
    if (fallbackPriced > 0) {
      console.log(`${LOG_PREFIX()} [shadow] Fallback priced ${fallbackPriced} / ${stillUnpriced.length} positions via UW`);
      saveShadowState(state); // save progress even if rate limited
    }
  }

  // ─── Yahoo Finance fallback for positions UW couldn't price ───
  const yahooUnpriced = Object.values(state.positions).filter(
    p => p.status === 'active' && p.lastPrice === null && p.optionSymbol && p.ticker
  ).sort((a, b) => (a.expiry || '9999').localeCompare(b.expiry || '9999'));
  let yahooPriced = 0;
  if (yahooUnpriced.length > 0) {
    console.log(`${LOG_PREFIX()} [shadow] Yahoo fallback: ${yahooUnpriced.length} positions still unpriced`);
    // Group by ticker to use option chain endpoint (fewer requests)
    const byTicker = {};
    for (const pos of yahooUnpriced) {
      const yt = YAHOO_TICKER_MAP[pos.ticker] || pos.ticker;
      if (!byTicker[yt]) byTicker[yt] = { yahooTicker: yt, positions: [] };
      byTicker[yt].positions.push(pos);
    }
    for (const [yt, group] of Object.entries(byTicker)) {
      try {
        await sleep(300);
        const neededExpiries = new Set(group.positions.map(p => p.expiry).filter(Boolean));
        const chain = await fetchYahooOptionChain(yt, neededExpiries);
        if (!chain || chain.length === 0) continue;
        const lookup = {};
        for (const c of chain) {
          if (c.contractSymbol) lookup[c.contractSymbol] = c;
        }
        for (const pos of group.positions) {
          const c = lookup[pos.optionSymbol];
          if (!c) continue;
          const last = c.lastPrice || 0;
          const bid = c.bid || 0;
          const ask = c.ask || 0;
          const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
          if (last <= 0 && bid <= 0 && ask <= 0) continue;

          pos.lastPrice = mid > 0 ? mid : (last > 0 ? last : ask);
          pos.lastBid = bid;
          pos.lastAsk = ask;
          pos.lastUpdated = new Date().toISOString();
          pos.pricingSource = 'yahoo';
          if (pos.peakPrice === null || pos.lastPrice > pos.peakPrice) {
            pos.peakPrice = pos.lastPrice;
          }
          if (pos.entryPrice > 0) {
            pos.simulatedPnlPct = ((pos.lastPrice - pos.entryPrice) / pos.entryPrice) * 100;
        pos.simulatedPnl = Math.round(SIM_ALLOCATION * pos.simulatedPnlPct) / 100;
          }
          yahooPriced++;
        }
      } catch (e) {
        // Yahoo is best-effort, log and continue
        console.error(`${LOG_PREFIX()} [shadow] Yahoo chain fetch failed for ${yt}: ${e.message}`);
      }
    }
    if (yahooPriced > 0) {
      console.log(`${LOG_PREFIX()} [shadow] Yahoo fallback priced ${yahooPriced} / ${yahooUnpriced.length} positions`);
      saveShadowState(state);
    }
  }

  const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
  console.log(`${LOG_PREFIX()} Shadow cycle: ${tickerCount} tickers, ${pricedCount} chain-priced, ${fallbackPriced} UW-fallback, ${yahooPriced} yahoo-fallback, ${expiredCount} expired, took ${elapsed}s`);

  saveShadowState(state);
}

async function main() {
  console.log(`${LOG_PREFIX()} Shadow Tracker started`);
  console.log(`${LOG_PREFIX()} Cycle interval: ${CYCLE_INTERVAL_MS / 60000} min | Rate limit: ${RATE_LIMIT_MS}ms`);

  const state = loadShadowState();

  // Always do full backfill on startup to catch any gaps from downtime
  try {
    await runCycle(state, true);
  } catch (e) {
    console.error(`${LOG_PREFIX()} Initial cycle error: ${e.message}`);
  }

  while (true) {
    if (!isMarketHours()) {
      console.log(`${LOG_PREFIX()} Market closed — sleeping 5 min`);
      await sleep(CLOSED_MARKET_SLEEP_MS);
      continue;
    }

    await sleep(CYCLE_INTERVAL_MS);

    try {
      await runCycle(state, false);
    } catch (e) {
      console.error(`${LOG_PREFIX()} Cycle error: ${e.message}`);
    }
  }
}

main();
