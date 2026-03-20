#!/usr/bin/env node
// Unified Alert Scanner — persistent process that polls UW flow alerts every N seconds,
// deduplicates, archives to JSONL, and runs all 4 strategies' entry filters in near-real-time.
//
// Replaces the 30-minute cron cycle for entries. Exits are still handled by exit-monitor.js.
//
// Start: cd Moby && nohup setsid node scanner.js </dev/null >> data/scanner.log 2>&1 &
// Stop:  pkill -f "scanner.js"

const https = require('https');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const API_TOKEN = process.env.UW_API_TOKEN;
if (!API_TOKEN) { console.error('Missing UW_API_TOKEN env var'); process.exit(1); }

const DATA_DIR = path.join(__dirname, 'data');
const POLL_INTERVAL_MS = parseInt(process.env.SCANNER_POLL_INTERVAL_MS || '90000', 10);
const RATE_LIMIT_MS = 300;
const SEEN_ALERTS_FILE = path.join(DATA_DIR, 'seen-flow-alerts.json');
const ENRICHMENT_FILE = path.join(DATA_DIR, 'enrichment-cache.json');
const ENRICHMENT_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours — IV/DP data doesn't move fast enough for 30min

const LOG_PREFIX = () => `[${new Date().toISOString()}]`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const INDEX_TICKERS = new Set(['SPX', 'SPXW', 'SPY', 'QQQ', 'IWM', 'DIA', 'XSP', 'VIX', 'NDX', 'RUT']);

// ─── Signal Notifications ───
const SIGNAL_TARGET = process.env.SIGNAL_TARGET_UUID || '';

function sendSignal(message) {
  if (!SIGNAL_TARGET) return;
  try {
    const { execSync } = require('child_process');
    execSync(`openclaw message send --channel signal -t "${SIGNAL_TARGET}" -m ${JSON.stringify(message)}`, { timeout: 15000, stdio: 'pipe' });
    console.log(`${LOG_PREFIX()} [signal] Notification sent`);
  } catch (e) {
    console.log(`${LOG_PREFIX()} [signal] Failed: ${e.message}`);
  }
}

// ─── API ───
async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'Authorization': `Bearer ${API_TOKEN}` }
    }, res => {
      if (res.statusCode === 429) {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => reject(new Error('RATE_LIMITED')));
        return;
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Parse error: ${d.slice(0, 300)}`)); }
      });
    }).on('error', reject);
  });
}

async function getOptionPrice(ticker, optionSymbol) {
  try {
    await sleep(RATE_LIMIT_MS);
    const url = `https://api.unusualwhales.com/api/stock/${ticker}/option-contracts?option_symbol=${optionSymbol}`;
    const result = await fetchJson(url);
    const c = result?.data?.[0];
    if (!c) return null;
    const last = parseFloat(c.last_price) || 0;
    const bid = parseFloat(c.nbbo_bid) || 0;
    const ask = parseFloat(c.nbbo_ask) || 0;
    if (last <= 0 && bid <= 0) return null;
    return {
      bid, ask,
      mid: bid > 0 && ask > 0 ? (bid + ask) / 2 : last,
      last, price: last,
      iv: parseFloat(c.implied_volatility) || 0,
      volume: c.volume || 0,
      oi: c.open_interest || 0
    };
  } catch (e) {
    console.error(`${LOG_PREFIX()} Price fetch failed for ${optionSymbol}: ${e.message}`);
    return null;
  }
}

async function getUnderlyingPrice(ticker) {
  try {
    await sleep(RATE_LIMIT_MS);
    const url = `https://api.unusualwhales.com/api/stock/${ticker}/quote`;
    const result = await fetchJson(url);
    const price = parseFloat(result?.data?.last || result?.data?.price || 0);
    return price > 0 ? price : null;
  } catch (e) {
    console.error(`${LOG_PREFIX()} Underlying price fetch failed for ${ticker}: ${e.message}`);
    return null;
  }
}

// ─── Helpers ───
function isMarketHours() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const h = et.getHours(), m = et.getMinutes();
  const mins = h * 60 + m;
  return mins >= 570 && mins <= 960; // 9:30 - 16:00
}

function today() { return new Date().toISOString().slice(0, 10); }

function dte(expiry) {
  return Math.round((new Date(expiry + 'T16:00:00') - new Date()) / 86400000);
}

function tradingDaysBetween(d1, d2) {
  let count = 0;
  const cur = new Date(d1);
  const end = new Date(d2);
  while (cur < end) {
    cur.setDate(cur.getDate() + 1);
    if (cur.getDay() !== 0 && cur.getDay() !== 6) count++;
  }
  return count;
}

function addCalendarDays(dateStr, days) {
  const d = new Date(dateStr + 'T16:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── Enrichment Cache ───
function loadEnrichmentCache() {
  if (fs.existsSync(ENRICHMENT_FILE)) {
    try { return JSON.parse(fs.readFileSync(ENRICHMENT_FILE, 'utf8')); }
    catch (e) { return {}; }
  }
  return {};
}

function saveEnrichmentCache(cache) {
  fs.writeFileSync(ENRICHMENT_FILE, JSON.stringify(cache, null, 2));
}

// ─── Seen Alerts (deduplication) ───
function loadSeenAlerts() {
  if (fs.existsSync(SEEN_ALERTS_FILE)) {
    try { return new Set(JSON.parse(fs.readFileSync(SEEN_ALERTS_FILE, 'utf8'))); }
    catch (e) { return new Set(); }
  }
  return new Set();
}

function saveSeenAlerts(seenSet) {
  // Keep last 20,000 to bound file size
  const arr = [...seenSet].slice(-20000);
  fs.writeFileSync(SEEN_ALERTS_FILE, JSON.stringify(arr));
}

// ─── Flow Alert Fetching (from collector.js) ───
async function fetchFlowAlerts() {
  const params = new URLSearchParams({
    limit: '200',
    min_premium: '100000',
    is_otm: 'true',
    size_greater_oi: 'true'
  });
  const url = `https://api.unusualwhales.com/api/option-trades/flow-alerts?${params}`;
  await sleep(RATE_LIMIT_MS);
  const result = await fetchJson(url);
  return result.data || [];
}

// ─── Archive to daily JSONL ───
function archiveAlerts(alerts, seenAlerts, enrichmentCache) {
  const todayStr = today();
  const outFile = path.join(DATA_DIR, `flow-${todayStr}.jsonl`);

  // Also load IDs already in file to avoid duplicates from previous runs
  const existingIds = new Set();
  if (fs.existsSync(outFile)) {
    fs.readFileSync(outFile, 'utf8').trim().split('\n').forEach(line => {
      try { existingIds.add(JSON.parse(line).id); } catch (e) {}
    });
  }

  let newCount = 0;
  const fd = fs.openSync(outFile, 'a');
  for (const alert of alerts) {
    if (!existingIds.has(alert.id)) {
      // Stamp enrichment data (DP + IV percentile) onto the alert if available
      const enriched = { ...alert };
      const enrich = enrichmentCache ? enrichmentCache[alert.ticker] : null;
      if (enrich) {
        enriched._ivPctl = enrich._ivPctl || null;
        enriched._iv30 = enrich._iv30 || null;
        enriched._dpRecentNotional = enrich._dpRecentNotional || null;
        enriched._dpPrintCount = enrich._dpPrintCount || null;
        enriched._dpAvgPrintSize = enrich._dpAvgPrintSize || null;
      }
      fs.writeSync(fd, JSON.stringify(enriched) + '\n');
      existingIds.add(alert.id);
      newCount++;
    }
  }
  fs.closeSync(fd);
  return newCount;
}

// ─── Screener Collection (from collector.js, runs every 30min) ───
async function collectScreener() {
  const params = new URLSearchParams({
    limit: '150',
    min_premium: '200000',
    is_otm: 'true',
    vol_greater_oi: 'true',
    'issue_types[]': 'Common Stock',
    max_dte: '45',
    min_volume_oi_ratio: '3'
  });

  await sleep(RATE_LIMIT_MS);
  const callUrl = `https://api.unusualwhales.com/api/screener/option-contracts?${params}&type=Calls`;
  const putUrl = `https://api.unusualwhales.com/api/screener/option-contracts?${params}&type=Puts`;

  const [calls, puts] = await Promise.all([fetchJson(callUrl), sleep(RATE_LIMIT_MS).then(() => fetchJson(putUrl))]);

  const todayStr = today();
  const outFile = path.join(DATA_DIR, `screener-${todayStr}.jsonl`);

  const existingSymbols = new Set();
  if (fs.existsSync(outFile)) {
    fs.readFileSync(outFile, 'utf8').trim().split('\n').forEach(line => {
      try { existingSymbols.add(JSON.parse(line).option_symbol); } catch (e) {}
    });
  }

  let newCount = 0;
  const fd = fs.openSync(outFile, 'a');
  const allData = [...(calls.data || []), ...(puts.data || [])];
  for (const rec of allData) {
    if (!existingSymbols.has(rec.option_symbol)) {
      fs.writeSync(fd, JSON.stringify({ ...rec, collected_at: new Date().toISOString(), type: calls.data?.includes(rec) ? 'call' : 'put' }) + '\n');
      existingSymbols.add(rec.option_symbol);
      newCount++;
    }
  }
  fs.closeSync(fd);
  console.log(`${LOG_PREFIX()} [screener] ${allData.length} contracts, ${newCount} new`);
}

// ─── Enrichment (from collector.js, runs periodically) ───
async function enrichTickers() {
  const todayStr = today();
  const flowFile = path.join(DATA_DIR, `flow-${todayStr}.jsonl`);
  if (!fs.existsSync(flowFile)) return;

  const tickers = new Set();
  fs.readFileSync(flowFile, 'utf8').trim().split('\n').forEach(line => {
    try { tickers.add(JSON.parse(line).ticker); } catch (e) {}
  });

  const SKIP = new Set(['SPX', 'SPXW', 'SPY', 'QQQ', 'IWM', 'DIA', 'XSP', 'VIX', 'NDX', 'RUT']);
  const toEnrich = [...tickers].filter(t => !SKIP.has(t));
  const cache = loadEnrichmentCache();
  const now = Date.now();
  let fetched = 0, skipped = 0;

  for (const ticker of toEnrich) {
    if (cache[ticker] && (now - cache[ticker]._fetchedAt) < ENRICHMENT_MAX_AGE_MS) {
      skipped++;
      continue;
    }

    const entry = { _ticker: ticker, _fetchedAt: now };

    try {
      await sleep(550);
      const ivResult = await fetchJson(`https://api.unusualwhales.com/api/stock/${ticker}/interpolated-iv`);
      const entries = ivResult?.data || [];
      const d30 = entries.find(e => e.days == 30) || {};
      const d365 = entries.find(e => e.days == 365) || {};
      entry._iv30 = parseFloat(d30.volatility || 0);
      entry._ivPctl = parseFloat(d365.percentile || d30.percentile || 0);
      entry._impliedMove = parseFloat(d30.implied_move_perc || 0);
    } catch (e) {
      console.error(`${LOG_PREFIX()} [enrich] IV fetch failed for ${ticker}: ${e.message}`);
    }

    try {
      await sleep(550);
      const dpResult = await fetchJson(`https://api.unusualwhales.com/api/darkpool/${ticker}`);
      const prints = dpResult?.data || [];
      const recent = prints.slice(0, 20);
      let totalVolume = 0, totalNotional = 0;
      for (const p of recent) {
        const size = parseFloat(p.size || 0);
        const price = parseFloat(p.price || 0);
        totalVolume += size;
        totalNotional += size * price;
      }
      entry._dpPrintCount = prints.length;
      entry._dpRecentVolume = totalVolume;
      entry._dpRecentNotional = totalNotional;
      entry._dpAvgPrintSize = recent.length > 0 ? Math.round(totalVolume / recent.length) : 0;
    } catch (e) {
      console.error(`${LOG_PREFIX()} [enrich] DP fetch failed for ${ticker}: ${e.message}`);
    }

    if (entry._iv30 > 0 || entry._dpPrintCount > 0) {
      cache[ticker] = entry;
      fetched++;
    }
  }

  saveEnrichmentCache(cache);
  if (fetched > 0 || toEnrich.length > 0) {
    console.log(`${LOG_PREFIX()} [enrich] ${fetched} tickers fetched, ${skipped} cached, ${toEnrich.length} total`);
  }
}


// ════════════════════════════════════════════════════════════════════
// STRATEGY STATE MANAGEMENT
// ════════════════════════════════════════════════════════════════════

const STRATEGY_FILES = {
  flow: {
    stateFile: path.join(DATA_DIR, 'strategy-state.json'),
    tradesFile: path.join(DATA_DIR, 'trades.jsonl'),
  },
  riptide: {
    stateFile: path.join(DATA_DIR, 'riptide-state.json'),
    tradesFile: path.join(DATA_DIR, 'riptide-trades.jsonl'),
  },
  theta: {
    stateFile: path.join(DATA_DIR, 'theta-state.json'),
    tradesFile: path.join(DATA_DIR, 'theta-trades.jsonl'),
  },
  yolo: {
    stateFile: path.join(DATA_DIR, 'yolo-state.json'),
    tradesFile: path.join(DATA_DIR, 'yolo-trades.jsonl'),
  },
};

function loadState(stateFile, defaults) {
  if (fs.existsSync(stateFile)) {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch (e) { /* fall through */ }
  }
  return defaults;
}

function saveState(stateFile, state) {
  state.lastRun = new Date().toISOString();
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function logTrade(tradesFile, trade) {
  fs.appendFileSync(tradesFile, JSON.stringify({ ...trade, timestamp: new Date().toISOString() }) + '\n');
}


// ════════════════════════════════════════════════════════════════════
// FLOW STRATEGY — Entry Filters + Entry Logic (from strategy.js)
// ════════════════════════════════════════════════════════════════════

const FLOW_PARAMS = {
  minPremium: 100000,
  maxPremium: 5000000,
  minVolOiRatio: 0,
  maxVolOiRatio: 50,
  maxDte: 120,
  minDte: 15,
  minOtmPct: 0,
  maxOtmPct: 20,
  minOptionPrice: 0,
  maxOptionPrice: 3.00,
  requireEarnings: true,
  earningsWindowDays: 60,
  excludeIndexes: true,
  requireSingleLeg: true,
  requireSweep: true,
  minAskSidePct: 0.70,
  maxEntryIv: 0.70,
  minEntryIv: 0,
  maxPositionSize: 500,
  maxOpenPositions: 50,
  dpConfirmMinPrints: 50,
  dpConfirmMinNotional: 1000000,
  dpConfirmSizeMultiplier: 1.5,
};

function flowFilterAlert(alert) {
  const premium = parseFloat(alert.total_premium || 0);
  if (premium < FLOW_PARAMS.minPremium || premium > FLOW_PARAMS.maxPremium) return { pass: false };

  const volOi = parseFloat(alert.volume_oi_ratio || 0);
  if (volOi < FLOW_PARAMS.minVolOiRatio || volOi > FLOW_PARAMS.maxVolOiRatio) return { pass: false };

  // Option price filter (per-share ask price from alert)
  const optionAsk = parseFloat(alert.ask || 0);
  if (optionAsk > 0 && (optionAsk < FLOW_PARAMS.minOptionPrice || optionAsk > FLOW_PARAMS.maxOptionPrice)) return { pass: false };

  if (FLOW_PARAMS.excludeIndexes && INDEX_TICKERS.has(alert.ticker)) return { pass: false };

  if (alert.expiry) {
    const d = dte(alert.expiry);
    if (d < FLOW_PARAMS.minDte || d > FLOW_PARAMS.maxDte) return { pass: false };
  } else return { pass: false };

  const strike = parseFloat(alert.strike || 0);
  const underlying = parseFloat(alert.underlying_price || 0);
  if (strike && underlying) {
    const otmPct = alert.type === 'call'
      ? ((strike - underlying) / underlying) * 100
      : ((underlying - strike) / underlying) * 100;
    if (otmPct < FLOW_PARAMS.minOtmPct || otmPct > FLOW_PARAMS.maxOtmPct) return { pass: false };
  } else return { pass: false };

  if (FLOW_PARAMS.requireEarnings) {
    if (!alert.next_earnings_date) return { pass: false };
    const erDate = alert.next_earnings_date;
    const erTime = (alert.er_time || '').toLowerCase();
    const todayStr = new Date().toISOString().slice(0, 10);
    const bdays = tradingDaysBetween(new Date(), new Date(erDate));
    if (bdays < 0) return { pass: false };
    if (erDate === todayStr && (erTime === 'bmo' || erTime === 'before' || erTime === 'premarket')) return { pass: false };
    if (erDate < todayStr && bdays === 0) return { pass: false };
    if (bdays > FLOW_PARAMS.earningsWindowDays) return { pass: false };
  }

  if (FLOW_PARAMS.requireSingleLeg && alert.has_multileg) return { pass: false };

  if (FLOW_PARAMS.requireSweep && !alert.has_sweep) return { pass: false };

  const askPrem = parseFloat(alert.total_ask_side_prem || 0);
  if (premium > 0 && (askPrem / premium) < FLOW_PARAMS.minAskSidePct) return { pass: false };

  return {
    pass: true,
    meta: {
      ticker: alert.ticker, type: alert.type, strike, expiry: alert.expiry,
      premium, volOi, underlying, hasSweep: alert.has_sweep,
      earningsDate: alert.next_earnings_date, erTime: alert.er_time,
      optionChain: alert.option_chain, alertId: alert.id, alertTime: alert.created_at,
      bid: alert.bid, ask: alert.ask,
      otmPct: alert.type === 'call'
        ? ((strike - underlying) / underlying * 100).toFixed(1)
        : ((underlying - strike) / underlying * 100).toFixed(1)
    }
  };
}

function flowFormatEntry(pos) {
  const dir = pos.type.toUpperCase();
  const pnlNote = pos.hasSweep ? ' 🔥 SWEEP' : '';
  return `🐋 MOBY ENTRY: ${pos.ticker} ${pos.strike}${dir.charAt(0)} ${pos.expiry}\n` +
    `${pos.contracts}x @ $${pos.entryPrice.toFixed(2)} = $${pos.entryValue.toFixed(0)}\n` +
    `Vol/OI: ${pos.volOi.toFixed(1)}x | ${pos.otmPct}% OTM | IV: ${(pos.entryIv * 100).toFixed(0)}%\n` +
    `ER: ${pos.earningsDate} (${pos.erTime})${pnlNote}`;
}

async function processFlowEntry(alert, enrichmentCache) {
  const cfg = STRATEGY_FILES.flow;
  const state = loadState(cfg.stateFile, {
    openPositions: [], closedPositions: [], seenAlertIds: [],
    stats: { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0, totalInvested: 0 }, lastRun: null
  });
  const seenIds = new Set(state.seenAlertIds);

  if (seenIds.has(alert.id)) return null;

  const result = flowFilterAlert(alert);
  if (!result.pass) return null;

  const sig = result.meta;

  // Check duplicate position
  const dupe = state.openPositions.find(p =>
    p.ticker === sig.ticker && p.strike === sig.strike && p.expiry === sig.expiry && p.type === sig.type
  );
  if (dupe) return null;

  if (state.openPositions.length >= FLOW_PARAMS.maxOpenPositions) return null;

  // Fetch real option price
  const quote = await getOptionPrice(sig.ticker, sig.optionChain);
  if (!quote || quote.price <= 0) {
    console.log(`${LOG_PREFIX()} [flow] SKIP (no price): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
    return null;
  }

  // IV filter
  if (FLOW_PARAMS.minEntryIv > 0 && (!quote.iv || quote.iv < FLOW_PARAMS.minEntryIv)) {
    console.log(`${LOG_PREFIX()} [flow] SKIP (IV too low: ${quote.iv ? (quote.iv * 100).toFixed(0) + '%' : 'N/A'}): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
    return null;
  }
  if (FLOW_PARAMS.maxEntryIv > 0 && quote.iv && quote.iv > FLOW_PARAMS.maxEntryIv) {
    console.log(`${LOG_PREFIX()} [flow] SKIP (IV too high: ${(quote.iv * 100).toFixed(0)}%): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
    return null;
  }

  // Dark pool confirmation
  const enrichment = enrichmentCache[sig.ticker] || {};
  const dpPrintCount = enrichment._dpPrintCount || 0;
  const dpNotional = enrichment._dpRecentNotional || 0;
  const dpConfirmed = dpPrintCount >= FLOW_PARAMS.dpConfirmMinPrints && dpNotional >= FLOW_PARAMS.dpConfirmMinNotional;

  const alertAsk = parseFloat(sig.ask) || 0;
  const alertBid = parseFloat(sig.bid) || 0;
  const entryPrice = alertAsk > 0 ? alertAsk : quote.price;
  const pricePerContract = entryPrice * 100;
  const effectiveSize = dpConfirmed ? FLOW_PARAMS.maxPositionSize * FLOW_PARAMS.dpConfirmSizeMultiplier : FLOW_PARAMS.maxPositionSize;
  const contracts = Math.max(1, Math.floor(effectiveSize / pricePerContract));
  const entryValue = entryPrice * 100 * contracts;

  const position = {
    ...sig, entryDate: today(), entryTime: sig.alertTime || new Date().toISOString(),
    entryPrice, entryBid: alertBid, entryAsk: alertAsk, entryIv: quote.iv, ivFlag: 'OK',
    contracts, entryValue, status: 'open',
    dpConfirmed, dpPrintCount, dpNotional, ivPctl: enrichment._ivPctl || null,
    entrySource: 'scanner',
  };

  // Mark seen before modifying state
  seenIds.add(alert.id);

  state.openPositions.push(position);
  state.stats.totalInvested += entryValue;
  state.seenAlertIds = [...seenIds].slice(-10000);
  saveState(cfg.stateFile, state);
  logTrade(cfg.tradesFile, { action: 'OPEN', ...position });
  sendSignal(flowFormatEntry(position));

  const dpTag = dpConfirmed ? ' | DP confirmed' : '';
  console.log(`${LOG_PREFIX()} [flow] ENTRY: ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry} | ${contracts}x @ $${entryPrice.toFixed(2)} ($${entryValue.toFixed(0)}) | ER: ${sig.earningsDate} (${sig.erTime || '?'}) | ${sig.volOi.toFixed(1)}x vol/OI${dpTag}`);
  return position;
}


// ════════════════════════════════════════════════════════════════════
// RIPTIDE STRATEGY — Entry Filters + Entry Logic (from riptide-strategy.js)
// ════════════════════════════════════════════════════════════════════

const RIPTIDE_PARAMS = {
  minPremium: 100000,
  maxPremium: 5000000,
  minVolOiRatio: 0,
  maxVolOiRatio: 10,
  minOptionPrice: 0,
  maxOptionPrice: 3.00,
  maxDte: 30,
  minDte: 0,
  minOtmPct: 0,
  maxOtmPct: 50,
  requireEarnings: false,
  earningsWindowDays: 10,
  excludeIndexes: true,
  requireSingleLeg: true,
  requireSweep: true,
  minAskSidePct: 0.15,
  allowedTypes: ['put', 'call'],
  minEntryIv: 0.20,
  maxEntryIv: 2.00,
  minIvPctl: 0.60,
  earningsExclusionDays: 0,
  minCreditPerContract: 1.50,
  minCreditWidthPct: 0.25,
  spreadWidthByStrike: [
    { maxStrike: 50, width: 2.50 },
    { maxStrike: Infinity, width: 5.00 },
  ],
  accountSize: 10000,
  maxRiskPct: 0.05,            // 10000 * 0.05 = $500 max risk per trade
  maxOpenPositions: 50,
};

function riptideFilterAlert(alert) {
  const premium = parseFloat(alert.total_premium || 0);
  if (premium < RIPTIDE_PARAMS.minPremium || premium > RIPTIDE_PARAMS.maxPremium) return { pass: false };

  const volOi = parseFloat(alert.volume_oi_ratio || 0);
  if (volOi < RIPTIDE_PARAMS.minVolOiRatio || volOi > RIPTIDE_PARAMS.maxVolOiRatio) return { pass: false };

  // Option price filter
  const optionAsk = parseFloat(alert.ask || 0);
  if (optionAsk > 0 && (optionAsk < RIPTIDE_PARAMS.minOptionPrice || optionAsk > RIPTIDE_PARAMS.maxOptionPrice)) return { pass: false };

  if (RIPTIDE_PARAMS.excludeIndexes && INDEX_TICKERS.has(alert.ticker)) return { pass: false };
  if (!RIPTIDE_PARAMS.allowedTypes.includes(alert.type)) return { pass: false };
  if (RIPTIDE_PARAMS.requireSweep && !alert.has_sweep) return { pass: false };

  if (alert.expiry) {
    const d = dte(alert.expiry);
    if (d < RIPTIDE_PARAMS.minDte || d > RIPTIDE_PARAMS.maxDte) return { pass: false };
  } else return { pass: false };

  const strike = parseFloat(alert.strike || 0);
  const underlying = parseFloat(alert.underlying_price || 0);
  if (strike && underlying) {
    const otmPct = alert.type === 'put'
      ? ((underlying - strike) / underlying) * 100
      : ((strike - underlying) / underlying) * 100;
    if (otmPct < RIPTIDE_PARAMS.minOtmPct || otmPct > RIPTIDE_PARAMS.maxOtmPct) return { pass: false };
  } else return { pass: false };

  // Earnings exclusion
  if (alert.next_earnings_date && RIPTIDE_PARAMS.earningsExclusionDays > 0) {
    const erBdays = tradingDaysBetween(new Date(), new Date(alert.next_earnings_date));
    if (erBdays >= 0 && erBdays <= RIPTIDE_PARAMS.earningsExclusionDays) return { pass: false };
  }

  if (RIPTIDE_PARAMS.requireEarnings) {
    if (!alert.next_earnings_date) return { pass: false };
    const erDate = alert.next_earnings_date;
    const erTime = (alert.er_time || '').toLowerCase();
    const todayStr = today();
    const bdays = tradingDaysBetween(new Date(), new Date(erDate));
    if (bdays < 0) return { pass: false };
    if (erDate === todayStr && (erTime === 'bmo' || erTime === 'before' || erTime === 'premarket')) return { pass: false };
    if (erDate < todayStr && bdays === 0) return { pass: false };
    if (bdays > RIPTIDE_PARAMS.earningsWindowDays) return { pass: false };
  }

  if (RIPTIDE_PARAMS.requireSingleLeg && alert.has_multileg) return { pass: false };

  const askPrem = parseFloat(alert.total_ask_side_prem || 0);
  if (premium > 0 && (askPrem / premium) < RIPTIDE_PARAMS.minAskSidePct) return { pass: false };

  return {
    pass: true,
    meta: {
      ticker: alert.ticker, type: alert.type, strike, expiry: alert.expiry,
      premium, volOi, underlying, hasSweep: alert.has_sweep,
      earningsDate: alert.next_earnings_date, erTime: alert.er_time,
      optionChain: alert.option_chain, alertId: alert.id, alertTime: alert.created_at,
      bid: alert.bid, ask: alert.ask,
      otmPct: (alert.type === 'put'
        ? (underlying - strike) / underlying * 100
        : (strike - underlying) / underlying * 100).toFixed(1)
    }
  };
}

function getSpreadWidth(strike) {
  for (const tier of RIPTIDE_PARAMS.spreadWidthByStrike) {
    if (strike <= tier.maxStrike) return tier.width;
  }
  return 5.00;
}

function buildOptionSymbol(ticker, expiry, type, strike) {
  const dateStr = expiry.replace(/-/g, '').slice(2);
  const typeChar = type === 'put' ? 'P' : 'C';
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${ticker}${dateStr}${typeChar}${strikeStr}`;
}

function riptideFormatEntry(pos) {
  const typeUpper = pos.type === 'put' ? 'P' : 'C';
  const spreadName = pos.type === 'put' ? 'bull put' : 'bear call';
  return `🌊 RIPTIDE ENTRY: ${pos.ticker} ${pos.strike}${typeUpper} ${spreadName} spread\n` +
    `Sell ${pos.strike}${typeUpper} / Buy ${pos.protectionStrike}${typeUpper} ($${pos.spreadWidth.toFixed(2)} wide)\n` +
    `${pos.contracts}x | Credit: $${pos.creditPerContract.toFixed(2)} ($${pos.totalCredit.toFixed(0)} total)\n` +
    `Max risk: $${pos.maxRisk.toFixed(0)} | IV: ${(pos.entryIv * 100).toFixed(0)}%\n` +
    `ER: ${pos.earningsDate} (${pos.erTime || '?'})`;
}

async function processRiptideEntry(alert, enrichmentCache) {
  const cfg = STRATEGY_FILES.riptide;
  const state = loadState(cfg.stateFile, {
    openPositions: [], closedPositions: [], seenAlertIds: [],
    stats: { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0, totalCreditCollected: 0 }, lastRun: null
  });
  const seenIds = new Set(state.seenAlertIds);

  if (seenIds.has(`riptide-${alert.id}`)) return null;

  const result = riptideFilterAlert(alert);
  if (!result.pass) return null;

  const sig = result.meta;

  const dupe = state.openPositions.find(p =>
    p.ticker === sig.ticker && p.strike === sig.strike && p.expiry === sig.expiry
  );
  if (dupe) return null;

  if (state.openPositions.length >= RIPTIDE_PARAMS.maxOpenPositions) return null;

  // Fetch price for short leg
  const shortQuote = await getOptionPrice(sig.ticker, sig.optionChain);
  if (!shortQuote || shortQuote.price <= 0) {
    console.log(`${LOG_PREFIX()} [riptide] SKIP (no price): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
    return null;
  }

  // IV filters
  if (RIPTIDE_PARAMS.minEntryIv > 0 && (!shortQuote.iv || shortQuote.iv < RIPTIDE_PARAMS.minEntryIv)) {
    console.log(`${LOG_PREFIX()} [riptide] SKIP (IV too low: ${shortQuote.iv ? (shortQuote.iv * 100).toFixed(0) + '%' : 'N/A'}): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
    return null;
  }
  if (RIPTIDE_PARAMS.maxEntryIv > 0 && shortQuote.iv && shortQuote.iv > RIPTIDE_PARAMS.maxEntryIv) {
    console.log(`${LOG_PREFIX()} [riptide] SKIP (IV too high: ${(shortQuote.iv * 100).toFixed(0)}%): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
    return null;
  }

  // IV percentile check
  const enrichment = enrichmentCache[sig.ticker] || {};
  const ivPctl = enrichment._ivPctl || 0;
  if (RIPTIDE_PARAMS.minIvPctl > 0 && ivPctl > 0 && ivPctl < RIPTIDE_PARAMS.minIvPctl) {
    console.log(`${LOG_PREFIX()} [riptide] SKIP (IV pctl too low: ${(ivPctl * 100).toFixed(0)}%): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
    return null;
  }

  // Calculate spread
  const spreadWidth = getSpreadWidth(sig.strike);
  const protectionStrike = sig.type === 'put'
    ? sig.strike - spreadWidth
    : sig.strike + spreadWidth;
  const protectionSymbol = buildOptionSymbol(sig.ticker, sig.expiry, sig.type, protectionStrike);

  // Fetch protection leg price
  const longQuote = await getOptionPrice(sig.ticker, protectionSymbol);
  if (!longQuote) {
    console.log(`${LOG_PREFIX()} [riptide] SKIP (no protection leg price): ${sig.type.toUpperCase()} ${sig.ticker} ${protectionStrike} ${sig.expiry}`);
    return null;
  }

  const shortBid = shortQuote.bid > 0 ? shortQuote.bid : shortQuote.price * 0.95;
  const longAsk = longQuote.ask > 0 ? longQuote.ask : longQuote.price * 1.05;
  const creditPerContract = shortBid - longAsk;

  if (creditPerContract <= 0.05) {
    console.log(`${LOG_PREFIX()} [riptide] SKIP (credit too small: $${creditPerContract.toFixed(2)}): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike}/${protectionStrike} ${sig.expiry}`);
    return null;
  }

  if (creditPerContract < RIPTIDE_PARAMS.minCreditPerContract) {
    console.log(`${LOG_PREFIX()} [riptide] SKIP (credit $${creditPerContract.toFixed(2)} < min $${RIPTIDE_PARAMS.minCreditPerContract.toFixed(2)}): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike}/${protectionStrike} ${sig.expiry}`);
    return null;
  }

  const creditWidthPct = creditPerContract / spreadWidth;
  if (creditWidthPct < RIPTIDE_PARAMS.minCreditWidthPct) {
    console.log(`${LOG_PREFIX()} [riptide] SKIP (credit/width ${(creditWidthPct*100).toFixed(0)}%): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike}/${protectionStrike} ${sig.expiry}`);
    return null;
  }

  const maxRiskPerContract = (spreadWidth - creditPerContract) * 100;
  const maxRiskAllowed = RIPTIDE_PARAMS.accountSize * RIPTIDE_PARAMS.maxRiskPct;
  const contracts = Math.max(1, Math.floor(maxRiskAllowed / maxRiskPerContract));
  const totalCredit = creditPerContract * contracts * 100;
  const maxRisk = maxRiskPerContract * contracts;

  const position = {
    ...sig, spreadWidth, protectionStrike, protectionSymbol,
    creditPerContract, totalCredit, maxRisk, contracts,
    entryDate: today(), entryTime: sig.alertTime || new Date().toISOString(),
    entryIv: shortQuote.iv, shortBid, shortAsk: shortQuote.ask,
    longBid: longQuote.bid, longAsk, status: 'open',
    ivPctl: ivPctl || null,
    dpPrintCount: enrichment._dpPrintCount || null,
    dpRecentNotional: enrichment._dpRecentNotional || null,
    dpAvgPrintSize: enrichment._dpAvgPrintSize || null,
    entrySource: 'scanner',
  };

  seenIds.add(`riptide-${alert.id}`);

  state.openPositions.push(position);
  state.stats.totalCreditCollected += totalCredit;
  state.seenAlertIds = [...seenIds].slice(-10000);
  saveState(cfg.stateFile, state);
  logTrade(cfg.tradesFile, { action: 'OPEN', ...position });
  sendSignal(riptideFormatEntry(position));

  console.log(`${LOG_PREFIX()} [riptide] ENTRY: ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike}/${protectionStrike} ${sig.expiry} | ${contracts}x | credit $${creditPerContract.toFixed(2)} ($${totalCredit.toFixed(0)}) | max risk $${maxRisk.toFixed(0)} | IV: ${(shortQuote.iv * 100).toFixed(0)}%`);
  return position;
}


// ════════════════════════════════════════════════════════════════════
// YOLO STRATEGY — Entry Filters + Entry Logic (from yolo-strategy.js)
// ════════════════════════════════════════════════════════════════════

const YOLO_PARAMS = {
  minPremium: 100000,
  maxPremium: 5000000,
  minVolOiRatio: 0,
  maxVolOiRatio: 50,
  maxDte: 90,
  minDte: 15,
  minOtmPct: 0,
  maxOtmPct: 20,
  minOptionPrice: 0,
  maxOptionPrice: 3.00,
  excludeIndexes: true,
  requireSingleLeg: true,
  minAskSidePct: 0.70,
  allowedTypes: ['put', 'call'],
  skipSweeps: false,
  minEntryIv: 0,
  maxEntryIv: 0.70,
  earningsExclusionDays: 14,
  maxCostPerTrade: 500,
  maxOpenPositions: 50,
  maxEntryDelta: 0.10,
  thetaGuardFraction: 2 / 3,
  dpConfirmMinPrints: 50,
  dpConfirmMinNotional: 1000000,
  dpConfirmSizeMultiplier: 1.5,
};

function yoloFilterAlert(alert) {
  const premium = parseFloat(alert.total_premium || 0);
  if (premium < YOLO_PARAMS.minPremium || premium > YOLO_PARAMS.maxPremium) return { pass: false };

  const volOi = parseFloat(alert.volume_oi_ratio || 0);
  if (volOi < YOLO_PARAMS.minVolOiRatio || volOi > YOLO_PARAMS.maxVolOiRatio) return { pass: false };

  // Option price filter
  const optionAsk = parseFloat(alert.ask || 0);
  if (optionAsk > 0 && (optionAsk < YOLO_PARAMS.minOptionPrice || optionAsk > YOLO_PARAMS.maxOptionPrice)) return { pass: false };

  if (YOLO_PARAMS.excludeIndexes && INDEX_TICKERS.has(alert.ticker)) return { pass: false };
  if (!YOLO_PARAMS.allowedTypes.includes(alert.type)) return { pass: false };
  if (YOLO_PARAMS.skipSweeps && alert.has_sweep) return { pass: false };

  if (alert.expiry) {
    const d = dte(alert.expiry);
    if (d < YOLO_PARAMS.minDte || d > YOLO_PARAMS.maxDte) return { pass: false };
  } else return { pass: false };

  const strike = parseFloat(alert.strike || 0);
  const underlying = parseFloat(alert.underlying_price || 0);
  if (strike && underlying) {
    const otmPct = alert.type === 'put'
      ? ((underlying - strike) / underlying) * 100
      : ((strike - underlying) / underlying) * 100;
    if (otmPct < YOLO_PARAMS.minOtmPct || otmPct > YOLO_PARAMS.maxOtmPct) return { pass: false };
  } else return { pass: false };

  // Earnings: only enter if NO earnings date OR earnings >= 14 trading days away
  if (alert.next_earnings_date && YOLO_PARAMS.earningsExclusionDays > 0) {
    const erBdays = tradingDaysBetween(new Date(), new Date(alert.next_earnings_date));
    if (erBdays >= 0 && erBdays < YOLO_PARAMS.earningsExclusionDays) return { pass: false };
  }

  if (YOLO_PARAMS.requireSingleLeg && alert.has_multileg) return { pass: false };

  const askPrem = parseFloat(alert.total_ask_side_prem || 0);
  if (premium > 0 && (askPrem / premium) < YOLO_PARAMS.minAskSidePct) return { pass: false };

  return {
    pass: true,
    meta: {
      ticker: alert.ticker, type: alert.type, strike, expiry: alert.expiry,
      premium, volOi, underlying, hasSweep: alert.has_sweep,
      earningsDate: alert.next_earnings_date, erTime: alert.er_time,
      optionChain: alert.option_chain, alertId: alert.id, alertTime: alert.created_at,
      bid: alert.bid, ask: alert.ask,
      otmPct: (alert.type === 'put'
        ? (underlying - strike) / underlying * 100
        : (strike - underlying) / underlying * 100).toFixed(1)
    }
  };
}

function yoloFormatEntry(pos) {
  const typeUpper = pos.type === 'put' ? 'P' : 'C';
  const deltaStr = pos.priceDelta !== null
    ? `\nΔ from alert: ${pos.priceDelta >= 0 ? '+' : ''}$${pos.priceDelta.toFixed(2)} (${pos.priceDeltaPct >= 0 ? '+' : ''}${pos.priceDeltaPct.toFixed(1)}%) | ${pos.alertDelaySec}s delay`
    : '';
  return `🎲 YOLO ENTRY: ${pos.ticker} ${pos.strike}${typeUpper} ${pos.expiry}\n` +
    `${pos.contracts}x @ $${pos.entryPrice.toFixed(2)} ($${pos.totalCost.toFixed(0)} total)\n` +
    `IV: ${(pos.entryIv * 100).toFixed(0)}% | OTM: ${pos.otmPct}%\n` +
    `Targets: no cap (trail 15% from peak) / -10% ($${(pos.entryPrice * 0.90).toFixed(2)})\n` +
    `Theta guard: exit by ${pos.thetaExitDate}${deltaStr}`;
}

async function processYoloEntry(alert, enrichmentCache) {
  const cfg = STRATEGY_FILES.yolo;
  const state = loadState(cfg.stateFile, {
    openPositions: [], closedPositions: [], seenAlertIds: [],
    stats: { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0, totalInvested: 0 }, lastRun: null
  });
  const seenIds = new Set(state.seenAlertIds);

  if (seenIds.has(`yolo-${alert.id}`)) return null;

  const result = yoloFilterAlert(alert);
  if (!result.pass) return null;

  const sig = result.meta;

  const dupe = state.openPositions.find(p =>
    p.ticker === sig.ticker && p.strike === sig.strike && p.expiry === sig.expiry
  );
  if (dupe) return null;

  if (state.openPositions.length >= YOLO_PARAMS.maxOpenPositions) return null;

  const quote = await getOptionPrice(sig.ticker, sig.optionChain);
  if (!quote || (quote.ask <= 0 && quote.price <= 0)) {
    console.log(`${LOG_PREFIX()} [yolo] SKIP (no price): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
    return null;
  }

  if (YOLO_PARAMS.minEntryIv > 0 && (!quote.iv || quote.iv < YOLO_PARAMS.minEntryIv)) {
    console.log(`${LOG_PREFIX()} [yolo] SKIP (IV too low: ${quote.iv ? (quote.iv * 100).toFixed(0) + '%' : 'N/A'}): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
    return null;
  }
  if (YOLO_PARAMS.maxEntryIv > 0 && quote.iv && quote.iv > YOLO_PARAMS.maxEntryIv) {
    console.log(`${LOG_PREFIX()} [yolo] SKIP (IV too high: ${(quote.iv * 100).toFixed(0)}%): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
    return null;
  }

  const enrichment = enrichmentCache[sig.ticker] || {};
  const ivPctl = enrichment._ivPctl || 0;

  const entryPrice = quote.ask > 0 ? quote.ask : quote.price;
  const costPerContract = entryPrice * 100;
  if (costPerContract <= 0) return null;

  // Price delta tracking
  const alertAsk = parseFloat(sig.ask) || 0;
  const alertBid = parseFloat(sig.bid) || 0;
  const alertMid = alertBid > 0 && alertAsk > 0 ? (alertBid + alertAsk) / 2 : alertAsk;
  const priceDelta = alertAsk > 0 ? entryPrice - alertAsk : null;
  const priceDeltaPct = alertAsk > 0 ? ((entryPrice - alertAsk) / alertAsk * 100) : null;
  const alertDelayMs = sig.alertTime ? (Date.now() - new Date(sig.alertTime).getTime()) : null;
  const alertDelaySec = alertDelayMs !== null ? Math.round(alertDelayMs / 1000) : null;

  if (priceDelta !== null && priceDelta > YOLO_PARAMS.maxEntryDelta) {
    console.log(`${LOG_PREFIX()} [yolo] SKIP (delta $${priceDelta.toFixed(2)} > max $${YOLO_PARAMS.maxEntryDelta.toFixed(2)}): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
    return null;
  }

  // Dark pool confirmation check
  const dpPrintCount = enrichment._dpPrintCount || 0;
  const dpNotional = enrichment._dpRecentNotional || 0;
  const dpConfirmed = dpPrintCount >= YOLO_PARAMS.dpConfirmMinPrints && dpNotional >= YOLO_PARAMS.dpConfirmMinNotional;
  const effectiveSize = dpConfirmed ? YOLO_PARAMS.maxCostPerTrade * YOLO_PARAMS.dpConfirmSizeMultiplier : YOLO_PARAMS.maxCostPerTrade;

  const contracts = Math.max(1, Math.floor(effectiveSize / costPerContract));
  const totalCost = contracts * costPerContract;

  const daysToExpiry = dte(sig.expiry);
  const maxHoldDays = Math.floor(daysToExpiry * YOLO_PARAMS.thetaGuardFraction);
  const thetaExitDate = addCalendarDays(today(), maxHoldDays);

  const position = {
    ...sig, entryPrice, costPerContract, totalCost, contracts,
    entryDate: today(), entryTime: sig.alertTime || new Date().toISOString(),
    entryIv: quote.iv, thetaExitDate, maxHoldDays, status: 'open',
    ivPctl: ivPctl || null, dpConfirmed,
    dpPrintCount: enrichment._dpPrintCount || null,
    dpRecentNotional: enrichment._dpRecentNotional || null,
    dpAvgPrintSize: enrichment._dpAvgPrintSize || null,
    alertAsk, alertBid, alertMid, priceDelta, priceDeltaPct, alertDelaySec,
    entrySource: 'scanner',
  };

  seenIds.add(`yolo-${alert.id}`);

  state.openPositions.push(position);
  state.stats.totalInvested += totalCost;
  state.seenAlertIds = [...seenIds].slice(-10000);
  saveState(cfg.stateFile, state);
  logTrade(cfg.tradesFile, { action: 'OPEN', ...position });
  sendSignal(yoloFormatEntry(position));

  console.log(`${LOG_PREFIX()} [yolo] ENTRY: ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry} | ${contracts}x @ $${entryPrice.toFixed(2)} ($${totalCost.toFixed(0)}) | IV: ${(quote.iv * 100).toFixed(0)}% | theta exit: ${thetaExitDate}`);
  return position;
}


// ════════════════════════════════════════════════════════════════════
// THETA STRATEGY — Earnings Scan + Condor Entry (from theta-strategy.js)
// ════════════════════════════════════════════════════════════════════

const THETA_PARAMS = {
  minIvRank: 0.50,
  maxBidAskSpreadPct: 0.15,
  earningsWindowDays: 3,
  minEarningsWindowDays: 0,
  shortStrikeOtmPct: 0.08,
  wingWidth: 5,
  wingWidthPct: 0.03,
  maxRiskPerTrade: 5000,
  maxOpenPositions: 5,
  excludeIndexes: true,
};

const MOBY_STATE_FILE = path.join(DATA_DIR, 'strategy-state.json');

async function findEarningsCandidates() {
  const url = `https://api.unusualwhales.com/api/screener/option-contracts?limit=200&min_premium=100000&issue_types[]=Common%20Stock`;
  await sleep(RATE_LIMIT_MS);
  const resp = await fetchJson(url);
  const data = resp.data || [];

  const tickers = new Map();
  for (const row of data) {
    const ticker = row.ticker_symbol || row.ticker;
    if (!ticker || tickers.has(ticker)) continue;
    if (INDEX_TICKERS.has(ticker)) continue;
    if (row.next_earnings_date) {
      tickers.set(ticker, {
        ticker, earningsDate: row.next_earnings_date,
        erTime: row.er_time || null,
        underlying: parseFloat(row.underlying_price || 0),
      });
    }
  }

  const candidates = [];
  const todayStr = today();
  for (const [, info] of tickers) {
    const bdays = tradingDaysBetween(new Date(), new Date(info.earningsDate));
    if (bdays < THETA_PARAMS.minEarningsWindowDays || bdays > THETA_PARAMS.earningsWindowDays) continue;
    const erTime = (info.erTime || '').toLowerCase();
    if (info.earningsDate === todayStr && (erTime === 'bmo' || erTime === 'before' || erTime === 'premarket')) continue;
    if (info.earningsDate < todayStr) continue;
    candidates.push(info);
  }

  return candidates;
}

function mobyHasPosition(ticker) {
  try {
    const mobyState = JSON.parse(fs.readFileSync(MOBY_STATE_FILE, 'utf8'));
    return mobyState.openPositions.some(p => p.ticker === ticker);
  } catch { return false; }
}

async function getIvRank(ticker) {
  await sleep(RATE_LIMIT_MS);
  try {
    const resp = await fetchJson(`https://api.unusualwhales.com/api/stock/${ticker}/interpolated-iv`);
    const data = resp.data || [];
    const d30 = data.find(d => d.days === 30);
    if (d30) return parseFloat(d30.percentile || 0);
    if (data.length > 0) return parseFloat(data[0].percentile || 0);
    return 0;
  } catch { return 0; }
}

async function getOptionChain(ticker) {
  await sleep(RATE_LIMIT_MS);
  try {
    const resp = await fetchJson(`https://api.unusualwhales.com/api/stock/${ticker}/option-contracts`);
    const data = resp.data || [];
    return data.map(c => {
      if (!c.expiry && c.option_symbol) {
        const match = c.option_symbol.match(/(\d{6})([CP])/);
        if (match) {
          const ds = match[1];
          c.expiry = `20${ds.slice(0,2)}-${ds.slice(2,4)}-${ds.slice(4,6)}`;
          c.option_type = match[2] === 'C' ? 'call' : 'put';
          c.strike = parseFloat(c.option_symbol.slice(c.option_symbol.indexOf(match[2]) + 1)) / 1000;
        }
      }
      c.bid = c.nbbo_bid || c.bid || '0';
      c.ask = c.nbbo_ask || c.ask || '0';
      return c;
    });
  } catch { return []; }
}

function findBestExpiry(chain, earningsDate) {
  const expirations = [...new Set(chain.map(c => c.expiry))].sort();
  for (const exp of expirations) {
    if (exp >= earningsDate) return exp;
  }
  return null;
}

function buildCondor(chain, underlying, expiry) {
  const calls = chain.filter(c => c.option_type === 'call' && c.expiry === expiry)
    .map(c => ({ ...c, strike: parseFloat(c.strike) }))
    .sort((a, b) => a.strike - b.strike);
  const puts = chain.filter(c => c.option_type === 'put' && c.expiry === expiry)
    .map(c => ({ ...c, strike: parseFloat(c.strike) }))
    .sort((a, b) => a.strike - b.strike);

  if (calls.length < 4 || puts.length < 4) return null;

  const shortCallTarget = underlying * (1 + THETA_PARAMS.shortStrikeOtmPct);
  const shortCall = calls.reduce((best, c) =>
    Math.abs(c.strike - shortCallTarget) < Math.abs(best.strike - shortCallTarget) ? c : best);

  const shortPutTarget = underlying * (1 - THETA_PARAMS.shortStrikeOtmPct);
  const shortPut = puts.reduce((best, p) =>
    Math.abs(p.strike - shortPutTarget) < Math.abs(best.strike - shortPutTarget) ? p : best);

  const wingWidth = Math.max(THETA_PARAMS.wingWidth, underlying * THETA_PARAMS.wingWidthPct);

  const longCallTarget = shortCall.strike + wingWidth;
  const longCall = calls.reduce((best, c) =>
    Math.abs(c.strike - longCallTarget) < Math.abs(best.strike - longCallTarget) ? c : best);

  const longPutTarget = shortPut.strike - wingWidth;
  const longPut = puts.reduce((best, p) =>
    Math.abs(p.strike - longPutTarget) < Math.abs(best.strike - longPutTarget) ? p : best);

  if (longCall.strike <= shortCall.strike || longPut.strike >= shortPut.strike) return null;
  if (shortPut.strike >= shortCall.strike) return null;

  const shortCallMid = (parseFloat(shortCall.bid || 0) + parseFloat(shortCall.ask || 0)) / 2;
  const shortPutMid = (parseFloat(shortPut.bid || 0) + parseFloat(shortPut.ask || 0)) / 2;
  const longCallMid = (parseFloat(longCall.bid || 0) + parseFloat(longCall.ask || 0)) / 2;
  const longPutMid = (parseFloat(longPut.bid || 0) + parseFloat(longPut.ask || 0)) / 2;

  const credit = (shortCallMid + shortPutMid) - (longCallMid + longPutMid);
  if (credit <= 0) return null;

  const callWingWidth = longCall.strike - shortCall.strike;
  const putWingWidth = shortPut.strike - longPut.strike;
  const maxWingWidth = Math.max(callWingWidth, putWingWidth);
  const maxRisk = (maxWingWidth - credit) * 100;

  if (maxRisk <= 0) return null;

  const shortCallSpread = parseFloat(shortCall.ask || 0) - parseFloat(shortCall.bid || 0);
  const shortPutSpread = parseFloat(shortPut.ask || 0) - parseFloat(shortPut.bid || 0);
  if (shortCallMid > 0 && shortCallSpread / shortCallMid > THETA_PARAMS.maxBidAskSpreadPct) return null;
  if (shortPutMid > 0 && shortPutSpread / shortPutMid > THETA_PARAMS.maxBidAskSpreadPct) return null;

  return {
    shortCall: { strike: shortCall.strike, symbol: shortCall.option_symbol, mid: shortCallMid, bid: parseFloat(shortCall.bid || 0), ask: parseFloat(shortCall.ask || 0) },
    longCall: { strike: longCall.strike, symbol: longCall.option_symbol, mid: longCallMid },
    shortPut: { strike: shortPut.strike, symbol: shortPut.option_symbol, mid: shortPutMid, bid: parseFloat(shortPut.bid || 0), ask: parseFloat(shortPut.ask || 0) },
    longPut: { strike: longPut.strike, symbol: longPut.option_symbol, mid: longPutMid },
    expiry, credit, maxRisk, callWingWidth, putWingWidth,
  };
}

async function runThetaScan() {
  console.log(`${LOG_PREFIX()} [theta] Starting earnings scan...`);
  const cfg = STRATEGY_FILES.theta;
  const state = loadState(cfg.stateFile, {
    openPositions: [], closedPositions: [],
    stats: { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0 }
  });

  if (state.openPositions.length >= THETA_PARAMS.maxOpenPositions) {
    console.log(`${LOG_PREFIX()} [theta] Max positions (${THETA_PARAMS.maxOpenPositions}) reached, skipping scan`);
    return;
  }

  const candidates = await findEarningsCandidates();
  console.log(`${LOG_PREFIX()} [theta] Found ${candidates.length} earnings candidates within ${THETA_PARAMS.earningsWindowDays} trading days`);

  let entered = 0;
  for (const cand of candidates) {
    if (state.openPositions.length >= THETA_PARAMS.maxOpenPositions) break;

    if (mobyHasPosition(cand.ticker)) {
      console.log(`${LOG_PREFIX()} [theta] SKIP (Moby has position): ${cand.ticker}`);
      continue;
    }

    if (state.openPositions.some(p => p.ticker === cand.ticker)) {
      console.log(`${LOG_PREFIX()} [theta] SKIP (duplicate): ${cand.ticker}`);
      continue;
    }

    const ivRank = await getIvRank(cand.ticker);
    if (ivRank < THETA_PARAMS.minIvRank) {
      console.log(`${LOG_PREFIX()} [theta] SKIP (IV rank ${(ivRank * 100).toFixed(0)}% < ${(THETA_PARAMS.minIvRank * 100).toFixed(0)}%): ${cand.ticker}`);
      continue;
    }

    const chain = await getOptionChain(cand.ticker);
    if (chain.length === 0) {
      console.log(`${LOG_PREFIX()} [theta] SKIP (no chain data): ${cand.ticker}`);
      continue;
    }

    const expiry = findBestExpiry(chain, cand.earningsDate);
    if (!expiry) {
      console.log(`${LOG_PREFIX()} [theta] SKIP (no suitable expiry): ${cand.ticker}`);
      continue;
    }

    // Infer underlying from ATM options
    const expCalls = chain.filter(c => c.option_type === 'call' && c.expiry === expiry).sort((a, b) => a.strike - b.strike);
    const expPuts = chain.filter(c => c.option_type === 'put' && c.expiry === expiry).sort((a, b) => a.strike - b.strike);
    if (expCalls.length > 0 && expPuts.length > 0) {
      for (let i = 0; i < expCalls.length; i++) {
        const cMid = (parseFloat(expCalls[i].bid || 0) + parseFloat(expCalls[i].ask || 0)) / 2;
        const matchPut = expPuts.find(p => p.strike === expCalls[i].strike);
        if (matchPut) {
          const pMid = (parseFloat(matchPut.bid || 0) + parseFloat(matchPut.ask || 0)) / 2;
          if (Math.abs(cMid - pMid) < cMid * 0.3) {
            cand.underlying = expCalls[i].strike;
            break;
          }
        }
      }
    }

    if (!cand.underlying || cand.underlying <= 0) {
      console.log(`${LOG_PREFIX()} [theta] SKIP (no underlying price): ${cand.ticker}`);
      continue;
    }

    const condor = buildCondor(chain, cand.underlying, expiry);
    if (!condor) {
      console.log(`${LOG_PREFIX()} [theta] SKIP (can't build condor): ${cand.ticker}`);
      continue;
    }

    const contracts = Math.max(1, Math.floor(THETA_PARAMS.maxRiskPerTrade / condor.maxRisk));
    const totalRisk = condor.maxRisk * contracts;
    const maxCredit = condor.credit * 100 * contracts;

    const position = {
      ticker: cand.ticker, earningsDate: cand.earningsDate, erTime: cand.erTime,
      underlying: cand.underlying, expiry: condor.expiry,
      shortCall: condor.shortCall, longCall: condor.longCall,
      shortPut: condor.shortPut, longPut: condor.longPut,
      credit: condor.credit, maxRisk: condor.maxRisk,
      contracts, totalRisk, maxCredit, ivRank,
      entryDate: today(), status: 'open',
      entrySource: 'scanner',
    };

    state.openPositions.push(position);
    logTrade(cfg.tradesFile, { action: 'OPEN_CONDOR', ...position });
    entered++;

    sendSignal(`🐋⏳ THETA ENTRY: ${cand.ticker} Iron Condor\n` +
      `Sell ${condor.shortPut.strike}P / ${condor.shortCall.strike}C\n` +
      `Buy ${condor.longPut.strike}P / ${condor.longCall.strike}C\n` +
      `Expiry: ${condor.expiry} | ${contracts}x\n` +
      `Credit: $${maxCredit.toFixed(0)} | Max Risk: $${totalRisk.toFixed(0)}\n` +
      `IV Rank: ${(ivRank * 100).toFixed(0)}% | ER: ${cand.earningsDate} (${cand.erTime || '?'})`);

    console.log(`${LOG_PREFIX()} [theta] ENTRY CONDOR: ${cand.ticker} | ${condor.shortPut.strike}P/${condor.shortCall.strike}C | credit $${condor.credit.toFixed(2)} | ${contracts}x | risk $${totalRisk.toFixed(0)} | IV rank ${(ivRank * 100).toFixed(0)}%`);
  }

  saveState(cfg.stateFile, state);
  console.log(`${LOG_PREFIX()} [theta] Scan complete: ${candidates.length} candidates, ${entered} new entries, ${state.openPositions.length}/${THETA_PARAMS.maxOpenPositions} open`);
}


// ════════════════════════════════════════════════════════════════════
// MAIN LOOP
// ════════════════════════════════════════════════════════════════════

async function runCycle(cycleNum, seenAlerts, enrichmentCache) {
  // 1. Fetch flow alerts
  let alerts;
  try {
    alerts = await fetchFlowAlerts();
  } catch (e) {
    console.error(`${LOG_PREFIX()} Flow alert fetch failed: ${e.message}`);
    return { flowEntries: 0, riptideEntries: 0, yoloEntries: 0, newAlerts: 0 };
  }

  // 2. Identify new alerts
  const newAlerts = alerts.filter(a => !seenAlerts.has(a.id));
  for (const a of alerts) seenAlerts.add(a.id);

  // 3. Archive to JSONL (with enrichment data stamped on)
  const archived = archiveAlerts(alerts, seenAlerts, enrichmentCache);

  console.log(`${LOG_PREFIX()} Cycle #${cycleNum}: ${alerts.length} fetched, ${newAlerts.length} new, ${archived} archived`);

  if (newAlerts.length === 0) {
    return { flowEntries: 0, riptideEntries: 0, yoloEntries: 0, newAlerts: 0 };
  }

  // 4. Run each new alert through all 3 flow-based strategies
  let flowEntries = 0, riptideEntries = 0, yoloEntries = 0;

  for (const alert of newAlerts) {
    // Flow
    try {
      const result = await processFlowEntry(alert, enrichmentCache);
      if (result) flowEntries++;
    } catch (e) {
      console.error(`${LOG_PREFIX()} [flow] Error on ${alert.ticker}: ${e.message}`);
    }

    // Riptide
    try {
      const result = await processRiptideEntry(alert, enrichmentCache);
      if (result) riptideEntries++;
    } catch (e) {
      console.error(`${LOG_PREFIX()} [riptide] Error on ${alert.ticker}: ${e.message}`);
    }

    // Yolo
    try {
      const result = await processYoloEntry(alert, enrichmentCache);
      if (result) yoloEntries++;
    } catch (e) {
      console.error(`${LOG_PREFIX()} [yolo] Error on ${alert.ticker}: ${e.message}`);
    }
  }

  return { flowEntries, riptideEntries, yoloEntries, newAlerts: newAlerts.length };
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log(`${LOG_PREFIX()} Scanner started`);
  console.log(`${LOG_PREFIX()} Poll interval: ${POLL_INTERVAL_MS / 1000}s | Rate limit: ${RATE_LIMIT_MS}ms`);
  console.log(`${LOG_PREFIX()} Strategies: flow, riptide, yolo (per-cycle) | theta (every 30min)`);
  console.log(`${LOG_PREFIX()} Entry filters:`);
  console.log(`${LOG_PREFIX()}   Flow:    prem $${FLOW_PARAMS.minPremium/1000}K-$${FLOW_PARAMS.maxPremium/1000000}M, vol/OI ${FLOW_PARAMS.minVolOiRatio}-${FLOW_PARAMS.maxVolOiRatio}x, opt $${FLOW_PARAMS.minOptionPrice}-$${FLOW_PARAMS.maxOptionPrice}, DTE ${FLOW_PARAMS.minDte}-${FLOW_PARAMS.maxDte}, OTM ${FLOW_PARAMS.minOtmPct}-${FLOW_PARAMS.maxOtmPct}%, IV ${(FLOW_PARAMS.minEntryIv*100).toFixed(0)}-${(FLOW_PARAMS.maxEntryIv*100).toFixed(0)}%, ER within ${FLOW_PARAMS.earningsWindowDays}d, sweeps=${FLOW_PARAMS.requireSweep}, $${FLOW_PARAMS.maxPositionSize}/trade, max ${FLOW_PARAMS.maxOpenPositions}`);
  console.log(`${LOG_PREFIX()}   Riptide: prem $${RIPTIDE_PARAMS.minPremium/1000}K-$${RIPTIDE_PARAMS.maxPremium/1000000}M, vol/OI ${RIPTIDE_PARAMS.minVolOiRatio}-${RIPTIDE_PARAMS.maxVolOiRatio}x, opt $${RIPTIDE_PARAMS.minOptionPrice}-$${RIPTIDE_PARAMS.maxOptionPrice}, DTE ${RIPTIDE_PARAMS.minDte}-${RIPTIDE_PARAMS.maxDte}, OTM ${RIPTIDE_PARAMS.minOtmPct}-${RIPTIDE_PARAMS.maxOtmPct}%, IV ${(RIPTIDE_PARAMS.minEntryIv*100).toFixed(0)}-${(RIPTIDE_PARAMS.maxEntryIv*100).toFixed(0)}%, sweeps=${RIPTIDE_PARAMS.requireSweep}, credit≥$${RIPTIDE_PARAMS.minCreditPerContract}, $${RIPTIDE_PARAMS.accountSize * RIPTIDE_PARAMS.maxRiskPct} max risk, max ${RIPTIDE_PARAMS.maxOpenPositions}`);
  console.log(`${LOG_PREFIX()}   Yolo:    prem $${YOLO_PARAMS.minPremium/1000}K-$${YOLO_PARAMS.maxPremium/1000000}M, vol/OI ${YOLO_PARAMS.minVolOiRatio}-${YOLO_PARAMS.maxVolOiRatio}x, opt $${YOLO_PARAMS.minOptionPrice}-$${YOLO_PARAMS.maxOptionPrice}, DTE ${YOLO_PARAMS.minDte}-${YOLO_PARAMS.maxDte}, OTM ${YOLO_PARAMS.minOtmPct}-${YOLO_PARAMS.maxOtmPct}%, IV ${(YOLO_PARAMS.minEntryIv*100).toFixed(0)}-${(YOLO_PARAMS.maxEntryIv*100).toFixed(0)}%, ER excl ${YOLO_PARAMS.earningsExclusionDays}d, $${YOLO_PARAMS.maxCostPerTrade}/trade, max ${YOLO_PARAMS.maxOpenPositions}`);
  console.log(`${LOG_PREFIX()}   Theta:   IV rank≥${(THETA_PARAMS.minIvRank*100).toFixed(0)}%, ER in ${THETA_PARAMS.minEarningsWindowDays}-${THETA_PARAMS.earningsWindowDays}d, condor ${(THETA_PARAMS.shortStrikeOtmPct*100).toFixed(0)}% OTM, wings $${THETA_PARAMS.wingWidth}`);

  const seenAlerts = loadSeenAlerts();
  let enrichmentCache = loadEnrichmentCache();
  let cycleNum = 0;
  let lastScreenerRun = 0;
  let lastThetaRun = 0;
  let lastEnrichmentRun = 0;
  const THIRTY_MIN = 30 * 60 * 1000;

  while (true) {
    if (!isMarketHours()) {
      console.log(`${LOG_PREFIX()} Market closed — sleeping 5 min`);
      await sleep(5 * 60_000);
      continue;
    }

    cycleNum++;
    const now = Date.now();

    try {
      // Main flow-based cycle (every poll interval)
      const results = await runCycle(cycleNum, seenAlerts, enrichmentCache);

      const totalEntries = results.flowEntries + results.riptideEntries + results.yoloEntries;
      if (totalEntries > 0) {
        console.log(`${LOG_PREFIX()} Cycle #${cycleNum} entries: flow=${results.flowEntries} riptide=${results.riptideEntries} yolo=${results.yoloEntries}`);
      }

      // Save seen alerts periodically
      if (cycleNum % 10 === 0) {
        saveSeenAlerts(seenAlerts);
      }

      // Theta scan (every 30 min)
      if (now - lastThetaRun >= THIRTY_MIN) {
        try {
          await runThetaScan();
        } catch (e) {
          console.error(`${LOG_PREFIX()} [theta] Scan error: ${e.message}`);
        }
        lastThetaRun = now;
      }

      // Screener collection (every 30 min)
      if (now - lastScreenerRun >= THIRTY_MIN) {
        try {
          await collectScreener();
        } catch (e) {
          console.error(`${LOG_PREFIX()} [screener] Collection error: ${e.message}`);
        }
        lastScreenerRun = now;
      }

      // Enrichment (every 30 min)
      if (now - lastEnrichmentRun >= THIRTY_MIN) {
        try {
          await enrichTickers();
          enrichmentCache = loadEnrichmentCache();
        } catch (e) {
          console.error(`${LOG_PREFIX()} [enrich] Error: ${e.message}`);
        }
        lastEnrichmentRun = now;
      }

    } catch (e) {
      console.error(`${LOG_PREFIX()} Cycle #${cycleNum} error: ${e.message}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

// Save seen alerts on shutdown
process.on('SIGTERM', () => {
  console.log(`${LOG_PREFIX()} SIGTERM received, saving state...`);
  try { saveSeenAlerts(loadSeenAlerts()); } catch (e) {}
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log(`${LOG_PREFIX()} SIGINT received, saving state...`);
  try { saveSeenAlerts(loadSeenAlerts()); } catch (e) {}
  process.exit(0);
});

main();
