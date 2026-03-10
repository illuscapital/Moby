#!/usr/bin/env node
// Yolo Exit Monitor — polls option prices and exits positions based on stop/trailing rules
// Runs continuously during market hours, checks every 90 seconds
// No LLM needed — pure price checks and math
//
// Start: cd Moby && setsid nohup node yolo-exit-monitor.js >> data/yolo-exit-monitor.log 2>&1 &
// Stop:  pkill -f "yolo-exit-monitor.js"

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_TOKEN = process.env.UW_API_TOKEN;
if (!API_TOKEN) { console.error('Missing UW_API_TOKEN env var'); process.exit(1); }

const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'yolo-state.json');
const TRADES_FILE = path.join(DATA_DIR, 'yolo-trades.jsonl');
const LOG_PREFIX = () => `[${new Date().toISOString()}]`;

// ─── Config ───
const POLL_INTERVAL_MS = 90_000;  // 90 seconds between full cycles
const RATE_LIMIT_MS = 300;        // between individual API calls
const STOP_LOSS_PCT = -10;        // exit at -10%
const TRAILING_STOP_PCT = 15;     // exit if drops 15% from peak

// ─── Helpers ───
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function isMarketHours() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const h = et.getHours(), m = et.getMinutes();
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 30 && mins <= 16 * 60; // 9:30 AM - 4:00 PM ET
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

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

async function getOptionPrice(ticker, optionSymbol) {
  try {
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
    };
  } catch (e) {
    console.error(`${LOG_PREFIX()} Price fetch failed for ${optionSymbol}: ${e.message}`);
    return null;
  }
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  state.lastExitCheck = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function logTrade(trade) {
  fs.appendFileSync(TRADES_FILE, JSON.stringify({ ...trade, timestamp: new Date().toISOString() }) + '\n');
}

// ─── Exit Logic ───
function shouldExit(position, currentPrice) {
  const entryPrice = position.entryPrice;
  const pnlPct = (currentPrice - entryPrice) / entryPrice * 100;

  // Track high-water mark
  if (!position.peakPrice || currentPrice > position.peakPrice) {
    position.peakPrice = currentPrice;
  }

  // 1. Trailing stop — 15% drop from peak (only when in profit)
  if (position.peakPrice && position.peakPrice > entryPrice) {
    const dropFromPeak = (position.peakPrice - currentPrice) / position.peakPrice * 100;
    if (dropFromPeak >= TRAILING_STOP_PCT) {
      const peakGainPct = ((position.peakPrice - entryPrice) / entryPrice * 100).toFixed(0);
      return { exit: true, reason: `trailing_stop (peak $${position.peakPrice.toFixed(2)} +${peakGainPct}% → now $${currentPrice.toFixed(2)} ${pnlPct.toFixed(0)}%, dropped ${dropFromPeak.toFixed(0)}% from peak)` };
    }
  }

  // 2. Stop loss — 10%
  if (currentPrice <= entryPrice * (1 + STOP_LOSS_PCT / 100)) {
    return { exit: true, reason: `stop_loss (${pnlPct.toFixed(0)}%, $${entryPrice.toFixed(2)} → $${currentPrice.toFixed(2)})` };
  }

  // 3. Theta guard
  if (position.thetaExitDate && today() >= position.thetaExitDate) {
    return { exit: true, reason: `theta_guard (${pnlPct.toFixed(0)}% P&L, exit date ${position.thetaExitDate} reached)` };
  }

  return { exit: false };
}

// ─── Main Loop ───
async function checkPositions() {
  const state = loadState();
  if (!state || !state.openPositions || state.openPositions.length === 0) {
    return 0;
  }

  let exits = 0;

  for (let i = state.openPositions.length - 1; i >= 0; i--) {
    const pos = state.openPositions[i];

    await sleep(RATE_LIMIT_MS);
    const quote = await getOptionPrice(pos.ticker, pos.optionChain);
    const currentPrice = quote?.mid > 0 ? quote.mid : (quote?.bid > 0 ? quote.bid : null);

    if (currentPrice === null) {
      console.log(`${LOG_PREFIX()} SKIP (no price): ${pos.ticker} ${pos.optionChain}`);
      continue;
    }

    // Update mark-to-market
    pos.currentPrice = currentPrice;
    pos.unrealizedPnl = (currentPrice - pos.entryPrice) * pos.contracts * 100;

    const exitCheck = shouldExit(pos, currentPrice);

    if (exitCheck.exit) {
      const exitPrice = quote?.bid > 0 ? quote.bid : currentPrice;
      const pnlPerContract = (exitPrice - pos.entryPrice) * 100;
      const totalPnl = pnlPerContract * pos.contracts;

      const closedPos = {
        ...pos,
        action: 'CLOSE',
        exitDate: today(),
        exitTime: new Date().toISOString(),
        exitPrice,
        pnl: totalPnl,
        pnlPct: (exitPrice - pos.entryPrice) / pos.entryPrice * 100,
        exitReason: exitCheck.reason,
        holdDays: Math.round((new Date() - new Date(pos.entryDate)) / 86400000),
        exitSource: 'exit-monitor',
      };

      state.closedPositions = state.closedPositions || [];
      state.closedPositions.push(closedPos);
      state.openPositions.splice(i, 1);
      state.stats = state.stats || { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0 };
      state.stats.totalTrades++;
      state.stats.totalPnl += totalPnl;
      if (totalPnl > 0) state.stats.wins++; else state.stats.losses++;

      logTrade(closedPos);
      exits++;
      console.log(`${LOG_PREFIX()} EXIT: ${pos.ticker} ${pos.strike}${pos.type === 'put' ? 'P' : 'C'} | ${exitCheck.reason} | PnL: $${totalPnl.toFixed(0)}`);
    } else {
      const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(1);
      const peakStr = pos.peakPrice ? ` | peak $${pos.peakPrice.toFixed(2)}` : '';
      console.log(`${LOG_PREFIX()} HOLD: ${pos.ticker} ${pos.strike}${pos.type === 'put' ? 'P' : 'C'} @ $${currentPrice.toFixed(2)} (${pnlPct}%)${peakStr}`);
    }
  }

  saveState(state);
  return exits;
}

async function main() {
  console.log(`${LOG_PREFIX()} Yolo Exit Monitor started`);
  console.log(`${LOG_PREFIX()} Poll interval: ${POLL_INTERVAL_MS / 1000}s | Stop: ${STOP_LOSS_PCT}% | Trail: ${TRAILING_STOP_PCT}% from peak`);

  while (true) {
    if (!isMarketHours()) {
      console.log(`${LOG_PREFIX()} Market closed — sleeping 5 min`);
      await sleep(5 * 60_000);
      continue;
    }

    try {
      const state = loadState();
      const openCount = state?.openPositions?.length || 0;

      if (openCount === 0) {
        console.log(`${LOG_PREFIX()} No open positions — sleeping 5 min`);
        await sleep(5 * 60_000);
        continue;
      }

      const exits = await checkPositions();
      if (exits > 0) {
        console.log(`${LOG_PREFIX()} ${exits} position(s) exited`);
      }
    } catch (e) {
      console.error(`${LOG_PREFIX()} Error: ${e.message}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

main();
