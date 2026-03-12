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
const CYCLE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const RATE_LIMIT_MS = 300;
const CLOSED_MARKET_SLEEP_MS = 5 * 60 * 1000;

const INDEX_TICKERS = new Set(['SPX', 'SPXW', 'SPY', 'QQQ', 'IWM', 'DIA', 'XSP', 'VIX', 'NDX', 'RUT']);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function isMarketHours() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 9 * 60 + 30 && mins <= 16 * 60;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function dte(expiry) {
  return Math.round((new Date(expiry + 'T16:00:00') - new Date()) / 86400000);
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

  const d = alert.expiry ? dte(alert.expiry) : 0;
  const hasEarnings = !!alert.next_earnings_date;

  return {
    alertId: alert.id,
    ticker: alert.ticker,
    optionSymbol: alert.option_chain,
    type: alert.type || 'call',
    strike,
    expiry: alert.expiry,
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

  // Mark expired positions
  let expiredCount = 0;
  for (const pos of Object.values(state.positions)) {
    if (pos.status === 'active' && pos.expiry < todayStr) {
      pos.status = 'expired';
      // Final PnL based on last known price (option expired, likely worthless or near it)
      // Fixed $1000 allocation: contracts = floor($1000 / (ask * 100)); skip if too expensive
      if (pos.entryAsk * 100 > 1000) {
        pos.simulatedPnl = 0;
        pos.simulatedPnlPct = 0;
      } else if (pos.lastPrice !== null && pos.entryAsk > 0) {
        const contracts = Math.floor(1000 / (pos.entryAsk * 100));
        pos.simulatedPnl = (pos.lastPrice - pos.entryAsk) * 100 * contracts;
        pos.simulatedPnlPct = (pos.lastPrice - pos.entryAsk) / pos.entryAsk * 100;
      } else if (pos.entryAsk > 0) {
        // Expired with no price data — assume worthless
        const contracts = Math.floor(1000 / (pos.entryAsk * 100));
        pos.simulatedPnl = -pos.entryAsk * 100 * contracts;
        pos.simulatedPnlPct = -100;
      }
      expiredCount++;
    }
  }

  // Group active positions by ticker
  const tickerGroups = {};
  for (const pos of Object.values(state.positions)) {
    if (pos.status !== 'active') continue;
    if (!tickerGroups[pos.ticker]) tickerGroups[pos.ticker] = [];
    tickerGroups[pos.ticker].push(pos);
  }
  console.log(`${LOG_PREFIX()} [shadow] Active: ${Object.values(state.positions).filter(p=>p.status==='active').length} | Expired: ${expiredCount} | Tickers to price: ${Object.keys(tickerGroups).length}`);

  // Fetch prices grouped by ticker
  let tickerCount = 0;
  let pricedCount = 0;

  for (const [ticker, positions] of Object.entries(tickerGroups)) {
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

      if (last <= 0 && bid <= 0) continue;

      pos.lastPrice = mid > 0 ? mid : last;
      pos.lastBid = bid;
      pos.lastAsk = ask;
      pos.lastUpdated = new Date().toISOString();

      // Track peak
      if (pos.peakPrice === null || pos.lastPrice > pos.peakPrice) {
        pos.peakPrice = pos.lastPrice;
      }

      // Simulated PnL: $1000 fixed allocation per trade; skip if too expensive
      if (pos.entryAsk > 0 && pos.entryAsk * 100 <= 1000) {
        const contracts = Math.floor(1000 / (pos.entryAsk * 100));
        pos.simulatedPnl = (pos.lastPrice - pos.entryAsk) * 100 * contracts;
        pos.simulatedPnlPct = (pos.lastPrice - pos.entryAsk) / pos.entryAsk * 100;
      } else if (pos.entryAsk > 0) {
        pos.simulatedPnl = 0;
        pos.simulatedPnlPct = 0;
      }

      pricedCount++;
    }
  }

  const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);
  console.log(`${LOG_PREFIX()} Shadow cycle: ${tickerCount} tickers, ${pricedCount} alerts priced, ${expiredCount} expired, took ${elapsed}s`);

  saveShadowState(state);
}

async function main() {
  console.log(`${LOG_PREFIX()} Shadow Tracker started`);
  console.log(`${LOG_PREFIX()} Cycle interval: ${CYCLE_INTERVAL_MS / 60000} min | Rate limit: ${RATE_LIMIT_MS}ms`);

  const state = loadShadowState();
  const isFirstRun = !state.lastRun;

  // Run initial cycle immediately
  try {
    await runCycle(state, isFirstRun);
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
