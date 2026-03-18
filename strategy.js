#!/usr/bin/env node
// Paper trading strategy: unusual options flow → pre-earnings directional bets
// Entry: next open after alert. Exit: first open after earnings. No stop losses.

const https = require('https');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const API_TOKEN = process.env.UW_API_TOKEN;
if (!API_TOKEN) { console.error('Missing UW_API_TOKEN env var'); process.exit(1); }
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'strategy-state.json');
const TRADES_FILE = path.join(DATA_DIR, 'trades.jsonl');

// ─── Strategy Parameters ───
const PARAMS = {
  // Entry filters
  minPremium: 100000,
  maxPremium: 5000000,
  minVolOiRatio: 0,
  maxVolOiRatio: 50,
  maxDte: 90,
  minDte: 15,
  minOtmPct: 0,
  maxOtmPct: 20,
  minOptionPrice: 0,
  maxOptionPrice: 3.00,         // per-share option price ($0-$3)
  requireEarnings: true,
  earningsWindowDays: 14,       // trading days
  excludeIndexes: true,
  requireSingleLeg: true,
  requireSweep: true,
  minAskSidePct: 0.70,

  // IV filters
  maxEntryIv: 0.70,
  minEntryIv: 0,

  // Position sizing
  maxPositionSize: 500,         // $500 per trade
  maxOpenPositions: 50,

  // Dark pool confirmation — boost position size when DP confirms direction
  dpConfirmMinPrints: 50,          // need at least 50 recent prints to consider
  dpConfirmMinNotional: 1000000,   // need at least $1M in recent DP notional
  dpConfirmSizeMultiplier: 1.5,    // 1.5x position size when DP confirms

  // Exit rules — NO stop losses
  // Exit at first market open after earnings release
  // Emergency exit if DTE <= 1 and earnings haven't happened
  emergencyExitDte: 1,
  // Profit-taking: exit when unrealized gain >= this percentage
  profitTakePct: 175,
  // Pre-expiry exit: if earnings are AFTER option expiry, exit at this DTE
  // to salvage remaining premium instead of holding to worthless
  preExpiryExitDte: 3,
};

const INDEX_TICKERS = new Set(['SPX', 'SPXW', 'SPY', 'QQQ', 'IWM', 'DIA', 'XSP', 'VIX', 'NDX', 'RUT']);

// ─── Signal Notifications ───
const SIGNAL_TARGET = process.env.SIGNAL_TARGET_UUID || '';
const SIGNAL_CLI = '/usr/local/bin/signal-cli'; // adjust if needed

function sendSignal(message) {
  if (!SIGNAL_TARGET) { console.log('[Signal] No target UUID, skipping notification'); return; }
  try {
    const { execSync } = require('child_process');
    // Try signal-cli first, fall back to openclaw message
    execSync(`openclaw message send --channel signal -t "${SIGNAL_TARGET}" -m ${JSON.stringify(message)}`, { timeout: 15000, stdio: 'pipe' });
    console.log('[Signal] Notification sent');
  } catch (e) {
    console.log('[Signal] Notification failed:', e.message);
  }
}

function formatEntry(pos) {
  const dir = pos.type.toUpperCase();
  const pnlNote = pos.hasSweep ? ' 🔥 SWEEP' : '';
  return `🐋 MOBY ENTRY: ${pos.ticker} ${pos.strike}${dir.charAt(0)} ${pos.expiry}\n` +
    `${pos.contracts}x @ $${pos.entryPrice.toFixed(2)} = $${pos.entryValue.toFixed(0)}\n` +
    `Vol/OI: ${pos.volOi.toFixed(1)}x | ${pos.otmPct}% OTM | IV: ${(pos.entryIv * 100).toFixed(0)}%\n` +
    `ER: ${pos.earningsDate} (${pos.erTime})${pnlNote}`;
}

function formatExit(pos) {
  const dir = pos.type.toUpperCase();
  const pnl = pos.pnl;
  const pct = pos.pnlPct.toFixed(0);
  const emoji = pnl >= 0 ? '✅' : '❌';
  return `🐋 MOBY EXIT: ${pos.ticker} ${pos.strike}${dir.charAt(0)} ${pos.expiry} ${emoji}\n` +
    `Entry $${pos.entryPrice.toFixed(2)} → Exit $${pos.exitPrice.toFixed(2)}\n` +
    `PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} (${pnl >= 0 ? '+' : ''}${pct}%) | Held ${pos.holdDays}d\n` +
    `Reason: ${pos.exitReason}`;
}

// ─── Utilities ───
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RATE_LIMIT_MS = 300; // 300ms between API calls

async function fetchJson(url) {
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

function dte(expiry) {
  return Math.round((new Date(expiry + 'T16:00:00') - new Date()) / 86400000);
}

function isMarketOpen() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const h = et.getHours(), m = et.getMinutes();
  const mins = h * 60 + m;
  return mins >= 570 && mins <= 960; // 9:30 - 16:00
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Enrichment Cache ───
const ENRICHMENT_FILE = path.join(DATA_DIR, 'enrichment-cache.json');

function loadEnrichmentCache() {
  if (fs.existsSync(ENRICHMENT_FILE)) {
    try { return JSON.parse(fs.readFileSync(ENRICHMENT_FILE, 'utf8')); }
    catch (e) { return {}; }
  }
  return {};
}

// ─── State Management ───
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
  return {
    openPositions: [],
    closedPositions: [],
    seenAlertIds: [],
    stats: { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0, totalInvested: 0 },
    lastRun: null
  };
}

function saveState(state) {
  state.lastRun = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function logTrade(trade) {
  fs.appendFileSync(TRADES_FILE, JSON.stringify({ ...trade, timestamp: new Date().toISOString() }) + '\n');
}

// ─── Option Price Fetching (Yahoo Finance) ───
async function getOptionPrice(ticker, optionSymbol) {
  try {
    // UW option-contracts endpoint — has real NBBO bid/ask
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
      last,
      price: last,
      iv: parseFloat(c.implied_volatility) || 0,
      volume: c.volume || 0,
      oi: c.open_interest || 0
    };
  } catch (e) {
    console.error(`  Price fetch failed for ${optionSymbol}: ${e.message}`);
    return null;
  }
}

// Raw fetch without auth header (for Yahoo)
function fetchJsonRaw(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
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

// ─── Alert Filtering ───
function filterAlert(alert) {
  const reasons = [];

  const premium = parseFloat(alert.total_premium || 0);
  if (premium < PARAMS.minPremium || premium > PARAMS.maxPremium) return { pass: false };

  const volOi = parseFloat(alert.volume_oi_ratio || 0);
  if (volOi < PARAMS.minVolOiRatio || volOi > PARAMS.maxVolOiRatio) return { pass: false };

  // Option price filter (per-share ask price from alert)
  const optionAsk = parseFloat(alert.ask || 0);
  if (optionAsk > 0 && (optionAsk < PARAMS.minOptionPrice || optionAsk > PARAMS.maxOptionPrice)) return { pass: false };

  if (PARAMS.excludeIndexes && INDEX_TICKERS.has(alert.ticker)) return { pass: false };

  if (alert.expiry) {
    const d = dte(alert.expiry);
    if (d < PARAMS.minDte || d > PARAMS.maxDte) return { pass: false };
  } else return { pass: false };

  const strike = parseFloat(alert.strike || 0);
  const underlying = parseFloat(alert.underlying_price || 0);
  if (strike && underlying) {
    const otmPct = alert.type === 'call'
      ? ((strike - underlying) / underlying) * 100
      : ((underlying - strike) / underlying) * 100;
    if (otmPct < PARAMS.minOtmPct || otmPct > PARAMS.maxOtmPct) return { pass: false };
  } else return { pass: false };

  if (PARAMS.requireEarnings) {
    if (!alert.next_earnings_date) return { pass: false };
    const erDate = alert.next_earnings_date; // YYYY-MM-DD
    const erTime = (alert.er_time || '').toLowerCase();
    const todayStr = new Date().toISOString().slice(0, 10);
    const bdays = tradingDaysBetween(new Date(), new Date(erDate));

    // Reject if earnings already passed
    if (bdays < 0) return { pass: false };

    // Reject if earnings are today BMO (already released)
    if (erDate === todayStr && (erTime === 'bmo' || erTime === 'before' || erTime === 'premarket')) {
      return { pass: false };
    }

    // Reject if earnings were yesterday AMC and today is the exit day (already released)
    if (erDate < todayStr && bdays === 0) return { pass: false };

    if (bdays > PARAMS.earningsWindowDays) return { pass: false };
  }

  if (PARAMS.requireSingleLeg && alert.has_multileg) return { pass: false };

  if (PARAMS.requireSweep && !alert.has_sweep) return { pass: false };

  const askPrem = parseFloat(alert.total_ask_side_prem || 0);
  if (premium > 0 && (askPrem / premium) < PARAMS.minAskSidePct) return { pass: false };

  return {
    pass: true,
    meta: {
      ticker: alert.ticker,
      type: alert.type,
      strike,
      expiry: alert.expiry,
      premium,
      volOi,
      underlying,
      hasSweep: alert.has_sweep,
      earningsDate: alert.next_earnings_date,
      erTime: alert.er_time,  // "amc" or "bmo" or null
      optionChain: alert.option_chain,
      alertId: alert.id,
      alertTime: alert.created_at,
      bid: alert.bid,
      ask: alert.ask,
      otmPct: alert.type === 'call'
        ? ((strike - underlying) / underlying * 100).toFixed(1)
        : ((underlying - strike) / underlying * 100).toFixed(1)
    }
  };
}

function isAfterExitWindow() {
  // Exits only allowed 30 min after market open (10:00 ET)
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 600; // 10:00 ET
}

// ─── Exit Logic ───
// currentPrice is optional — needed for profit-taking check
function shouldExit(position, currentPrice) {
  const now = new Date();
  const todayStr = today();
  const d = dte(position.expiry);

  // Block all exits before 10:00 ET (30 min after open)
  if (!isAfterExitWindow()) {
    return { exit: false };
  }

  // 1. Profit-taking: exit when unrealized gain >= threshold
  if (currentPrice && position.entryPrice > 0) {
    const pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
    if (pnlPct >= PARAMS.profitTakePct) {
      return { exit: true, reason: `profit_take (${pnlPct.toFixed(0)}% gain, threshold ${PARAMS.profitTakePct}%)` };
    }
  }

  // 2. Emergency exit: DTE <= 1
  if (d <= PARAMS.emergencyExitDte) {
    return { exit: true, reason: `emergency_dte (${d} DTE remaining)` };
  }

  // 3. Pre-expiry exit: if earnings are AFTER option expiry, exit early
  //    to salvage remaining premium
  if (position.earningsDate && position.expiry) {
    const expiryDate = position.expiry;  // YYYY-MM-DD
    const erDate = position.earningsDate;
    if (erDate > expiryDate && d <= PARAMS.preExpiryExitDte) {
      return { exit: true, reason: `pre_expiry (ER ${erDate} is after expiry ${expiryDate}, ${d} DTE left)` };
    }
  }

  // 4. Earnings-based exit
  if (position.earningsDate) {
    const erDate = position.earningsDate; // YYYY-MM-DD
    const erTime = position.erTime;       // "amc", "bmo", or null

    if (erTime === 'bmo' || erTime === 'before' || erTime === 'premarket') {
      // Before market open: exit at open on earnings day
      if (todayStr >= erDate) {
        return { exit: true, reason: `earnings_bmo (ER ${erDate} pre-market)` };
      }
    } else if (erTime === 'amc' || erTime === 'after' || erTime === 'postmarket') {
      // After market close: exit at next day's open
      const erDateObj = new Date(erDate + 'T00:00:00');
      const nextDay = new Date(erDateObj);
      nextDay.setDate(nextDay.getDate() + 1);
      // Skip weekend
      while (nextDay.getDay() === 0 || nextDay.getDay() === 6) {
        nextDay.setDate(nextDay.getDate() + 1);
      }
      const exitDate = nextDay.toISOString().slice(0, 10);
      if (todayStr >= exitDate) {
        return { exit: true, reason: `earnings_amc (ER ${erDate} after-close, exit ${exitDate})` };
      }
    } else {
      // Unknown timing: exit day after earnings to be safe
      const erDateObj = new Date(erDate + 'T00:00:00');
      const nextDay = new Date(erDateObj);
      nextDay.setDate(nextDay.getDate() + 1);
      while (nextDay.getDay() === 0 || nextDay.getDay() === 6) {
        nextDay.setDate(nextDay.getDate() + 1);
      }
      const exitDate = nextDay.toISOString().slice(0, 10);
      if (todayStr >= exitDate) {
        return { exit: true, reason: `earnings_unknown_timing (ER ${erDate}, exit ${exitDate})` };
      }
    }
  }

  return { exit: false };
}

// ─── Main Logic ───
async function run() {
  const state = loadState();
  const seenIds = new Set(state.seenAlertIds);
  const output = { newSignals: [], exits: [], positions: [], summary: '' };

  // ── Step 1: Check exits on open positions ──
  for (let i = state.openPositions.length - 1; i >= 0; i--) {
    const pos = state.openPositions[i];

    // Fetch current price first (needed for profit-taking check)
    await sleep(RATE_LIMIT_MS);
    const quote = await getOptionPrice(pos.ticker, pos.optionChain);
    const currentPrice = quote ? quote.price : pos.lastPrice || 0;
    // Use bid for exit (worst-case fill for seller)
    const exitBidPrice = quote && quote.bid > 0 ? quote.bid : currentPrice;
    const exitCheck = shouldExit(pos, currentPrice);

    if (exitCheck.exit) {
      const exitPrice = exitBidPrice;
      const contracts = pos.contracts || 1;
      const exitValue = exitPrice * 100 * contracts;
      const pnl = exitValue - pos.entryValue;
      const pnlPct = pos.entryValue > 0 ? (pnl / pos.entryValue * 100) : 0;

      const closedPos = {
        ...pos,
        exitDate: today(),
        exitTime: new Date().toISOString(),
        exitPrice,
        exitValue,
        pnl,
        pnlPct,
        exitReason: exitCheck.reason,
        holdDays: Math.round((new Date() - new Date(pos.entryDate)) / 86400000)
      };

      state.closedPositions.push(closedPos);
      state.openPositions.splice(i, 1);
      state.stats.totalTrades++;
      state.stats.totalPnl += pnl;
      if (pnl > 0) state.stats.wins++; else state.stats.losses++;

      logTrade({ action: 'CLOSE', ...closedPos });
      output.exits.push(closedPos);
      sendSignal(formatExit(closedPos));
      console.log(`  EXIT: ${pos.type.toUpperCase()} ${pos.ticker} ${pos.strike} ${pos.expiry} | ${exitCheck.reason} | PnL: $${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`);
    } else {
      // Update price for mark-to-market (avoid re-fetching later)
      pos.lastPrice = currentPrice;
      pos.lastMtm = currentPrice * 100 * pos.contracts;
      pos.unrealizedPnl = pos.lastMtm - pos.entryValue;
    }
  }

  // ── Step 2: Scan for new signals ──
  const files = fs.readdirSync(DATA_DIR)
    .filter(f => f.startsWith('flow-') && f.endsWith('.jsonl'))
    .sort();

  // Only look at today's file
  const todayFile = `flow-${today()}.jsonl`;
  const targetFiles = files.filter(f => f === todayFile);

  const enrichmentCache = loadEnrichmentCache();
  let scanned = 0, passed = 0;

  for (const file of targetFiles) {
    const lines = fs.readFileSync(path.join(DATA_DIR, file), 'utf8').trim().split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const alert = JSON.parse(line);
        scanned++;
        if (seenIds.has(alert.id)) continue;
        seenIds.add(alert.id);

        const result = filterAlert(alert);
        if (!result.pass) continue;

        passed++;
        const sig = result.meta;

        // Check if we already have a position in same ticker+strike+expiry
        const dupe = state.openPositions.find(p =>
          p.ticker === sig.ticker && p.strike === sig.strike && p.expiry === sig.expiry && p.type === sig.type
        );
        if (dupe) {
          console.log(`  SKIP (duplicate): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        }

        if (state.openPositions.length >= PARAMS.maxOpenPositions) {
          console.log(`  SKIP (max positions): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        }

        // Fetch real option price for entry
        await sleep(RATE_LIMIT_MS);
        const quote = await getOptionPrice(sig.ticker, sig.optionChain);
        if (!quote || quote.price <= 0) {
          console.log(`  SKIP (no price): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        }

        // IV filter — reject NO_DATA and extremes (backtest shows +$7,942 with this filter)
        let ivFlag = 'OK';
        if (!quote.iv || quote.iv === 0) {
          ivFlag = 'NO_DATA';
          console.log(`  SKIP (no IV data): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        } else if (quote.iv > PARAMS.maxEntryIv) {
          ivFlag = 'HIGH';
          console.log(`  SKIP (IV too high: ${(quote.iv * 100).toFixed(0)}% > ${(PARAMS.maxEntryIv * 100).toFixed(0)}%): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        } else if (quote.iv < PARAMS.minEntryIv) {
          ivFlag = 'LOW';
          console.log(`  SKIP (IV too low: ${(quote.iv * 100).toFixed(0)}% < ${(PARAMS.minEntryIv * 100).toFixed(0)}%): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        }

        // Dark pool confirmation check
        const enrichment = enrichmentCache[sig.ticker] || {};
        const dpPrintCount = enrichment._dpPrintCount || 0;
        const dpNotional = enrichment._dpRecentNotional || 0;
        const dpConfirmed = dpPrintCount >= PARAMS.dpConfirmMinPrints && dpNotional >= PARAMS.dpConfirmMinNotional;

        // Use UW alert's ask for entry (worst-case fill for buyer), fall back to Yahoo last
        const alertAsk = parseFloat(sig.ask) || 0;
        const alertBid = parseFloat(sig.bid) || 0;
        const entryPrice = alertAsk > 0 ? alertAsk : quote.price;
        const pricePerContract = entryPrice * 100; // options are 100 shares
        const effectiveSize = dpConfirmed ? PARAMS.maxPositionSize * PARAMS.dpConfirmSizeMultiplier : PARAMS.maxPositionSize;
        const contracts = Math.max(1, Math.floor(effectiveSize / pricePerContract));
        const entryValue = entryPrice * 100 * contracts;

        const position = {
          ...sig,
          entryDate: today(),
          entryTime: sig.alertTime || new Date().toISOString(),
          entryPrice,
          entryBid: alertBid,
          entryAsk: alertAsk,
          entryIv: quote.iv,
          ivFlag,
          contracts,
          entryValue,
          status: 'open',
          // Enrichment data
          dpConfirmed,
          dpPrintCount,
          dpNotional,
          ivPctl: enrichment._ivPctl || null,
        };

        state.openPositions.push(position);
        state.stats.totalInvested += entryValue;
        logTrade({ action: 'OPEN', ...position });
        output.newSignals.push(position);
        sendSignal(formatEntry(position));

        const dpTag = dpConfirmed ? ' | 🏦 DP confirmed' : '';
        console.log(`  ENTRY: ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry} | ${contracts}x @ $${entryPrice.toFixed(2)} (ask) ($${entryValue.toFixed(0)}) | ER: ${sig.earningsDate} (${sig.erTime || '?'}) | ${sig.volOi.toFixed(1)}x vol/OI | sweep:${sig.hasSweep}${dpTag}`);
      } catch (e) {}
    }
  }

  // ── Step 3: Mark-to-market open positions ──
  // Prices already updated in Step 1 for existing positions; only new entries need fresh data
  if (state.openPositions.length > 0) {
    console.log('\n--- Open Positions (mark-to-market) ---');
    let totalMtm = 0, totalEntry = 0;
    for (const pos of state.openPositions) {
      // Use bid for MTM (what you'd get if you sold now)
      if (!pos.lastPrice || pos.lastPrice === pos.entryPrice) {
        await sleep(RATE_LIMIT_MS);
        const quote = await getOptionPrice(pos.ticker, pos.optionChain);
        if (quote) pos.lastPrice = quote.bid > 0 ? quote.bid : quote.price;
      }
      const currentPrice = pos.lastPrice || pos.entryPrice;
      const currentValue = currentPrice * 100 * pos.contracts;
      const unrealizedPnl = currentValue - pos.entryValue;
      const pnlPct = (unrealizedPnl / pos.entryValue * 100);
      totalMtm += currentValue;
      totalEntry += pos.entryValue;

      pos.lastPrice = currentPrice;
      pos.lastMtm = currentValue;
      pos.unrealizedPnl = unrealizedPnl;

      const daysHeld = Math.round((new Date() - new Date(pos.entryDate)) / 86400000);
      const daysToEr = pos.earningsDate ? tradingDaysBetween(new Date(), new Date(pos.earningsDate)) : '?';
      console.log(`  ${pos.type.toUpperCase()} ${pos.ticker} ${pos.strike} ${pos.expiry} | ${pos.contracts}x | entry $${pos.entryPrice.toFixed(2)} → $${currentPrice.toFixed(2)} | PnL: $${unrealizedPnl.toFixed(0)} (${pnlPct.toFixed(1)}%) | ${daysHeld}d held | ER in ${daysToEr} tdays`);
    }
    const totalUnrealized = totalMtm - totalEntry;
    console.log(`  TOTAL: $${totalEntry.toFixed(0)} invested → $${totalMtm.toFixed(0)} (unrealized: $${totalUnrealized.toFixed(0)})`);
  }

  // ── Step 4: Summary ──
  state.seenAlertIds = [...seenIds].slice(-10000);
  saveState(state);

  const s = state.stats;
  const winRate = s.totalTrades > 0 ? (s.wins / s.totalTrades * 100).toFixed(1) : 'N/A';
  console.log(`\n--- Summary ---`);
  console.log(`Scanned: ${scanned} | New signals: ${passed} | Open: ${state.openPositions.length}/${PARAMS.maxOpenPositions}`);
  console.log(`Closed trades: ${s.totalTrades} | Win rate: ${winRate}% (${s.wins}W/${s.losses}L) | Realized PnL: $${s.totalPnl.toFixed(2)}`);

  output.summary = `${passed} new signals, ${state.openPositions.length} open, ${s.totalTrades} closed (${winRate}% WR), $${s.totalPnl.toFixed(2)} realized PnL`;
  return output;
}

run().catch(e => console.error('Fatal:', e.message));
