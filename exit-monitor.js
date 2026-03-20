#!/usr/bin/env node
// Unified Exit Monitor — polls prices and checks exit logic for ALL 4 Moby strategies
// Runs continuously during market hours, checks every 90 seconds
//
// Start: cd Moby && setsid nohup node exit-monitor.js >> data/exit-monitor.log 2>&1 &
// Stop:  pkill -f "exit-monitor.js"

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

// ─── Config ───
const POLL_INTERVAL_MS = 90_000;  // 90 seconds between full cycles
const RATE_LIMIT_MS = 300;        // between individual API calls

// Strategy file mappings
const STRATEGIES = {
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

function isAfterExitWindow() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 600; // 10:00 ET
}

function today() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function dte(expiry) {
  const expiryClose = new Date(expiry + "T16:00:00-05:00");
  return Math.max(0, Math.round((expiryClose - Date.now()) / 86400000));
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

function nextBusinessDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ─── API ───
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

async function getOptionChain(ticker) {
  try {
    await sleep(RATE_LIMIT_MS);
    const resp = await fetchJson(`https://api.unusualwhales.com/api/stock/${ticker}/option-contracts`);
    const data = resp.data || [];
    return data.map(c => {
      if (!c.expiry && c.option_symbol) {
        const match = c.option_symbol.match(/(\d{6})([CP])/);
        if (match) {
          const ds = match[1];
          c.expiry = `20${ds.slice(0, 2)}-${ds.slice(2, 4)}-${ds.slice(4, 6)}`;
          c.option_type = match[2] === 'C' ? 'call' : 'put';
          c.strike = parseFloat(c.option_symbol.slice(c.option_symbol.indexOf(match[2]) + 1)) / 1000;
        }
      }
      c.bid = c.nbbo_bid || c.bid || '0';
      c.ask = c.nbbo_ask || c.ask || '0';
      return c;
    });
  } catch (e) {
    console.error(`${LOG_PREFIX()} Option chain fetch failed for ${ticker}: ${e.message}`);
    return [];
  }
}

// ─── State I/O ───
function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) return null;
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch (e) { return null; }
}

function saveState(stateFile, state) {
  state.lastExitCheck = new Date().toISOString();
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function logTrade(tradesFile, trade) {
  fs.appendFileSync(tradesFile, JSON.stringify({ ...trade, timestamp: new Date().toISOString() }) + '\n');
}

// ════════════════════════════════════════════════════════════
// FLOW EXIT LOGIC (from strategy.js)
// ════════════════════════════════════════════════════════════
const FLOW_PARAMS = {
  profitTakePct: 175,
  emergencyExitDte: 1,
  preExpiryExitDte: 3,
};

function flowShouldExit(pos, currentPrice) {
  if (!isAfterExitWindow()) return { exit: false };

  const todayStr = today();
  const d = dte(pos.expiry);

  // 1. Profit target: +175%
  if (currentPrice && pos.entryPrice > 0) {
    const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    if (pnlPct >= FLOW_PARAMS.profitTakePct) {
      return { exit: true, reason: `profit_take (${pnlPct.toFixed(0)}% gain, threshold ${FLOW_PARAMS.profitTakePct}%)` };
    }
  }

  // 2. Earnings-based exit (checked before DTE emergency — we hold through earnings)
  if (pos.earningsDate) {
    const erDate = pos.earningsDate;
    const erTime = (pos.erTime || '').toLowerCase();
    const earningsImminent = todayStr <= erDate; // earnings today or in the future

    if (erTime === 'bmo' || erTime === 'before' || erTime === 'premarket') {
      if (todayStr >= erDate) {
        return { exit: true, reason: `earnings_bmo (ER ${erDate} pre-market)` };
      }
    } else if (erTime === 'amc' || erTime === 'after' || erTime === 'postmarket') {
      const exitDate = nextBusinessDay(erDate);
      if (todayStr >= exitDate) {
        return { exit: true, reason: `earnings_amc (ER ${erDate} after-close, exit ${exitDate})` };
      }
    } else {
      const exitDate = nextBusinessDay(erDate);
      if (todayStr >= exitDate) {
        return { exit: true, reason: `earnings_unknown_timing (ER ${erDate}, exit ${exitDate})` };
      }
    }

    // If earnings are today or upcoming, do NOT fire emergency DTE — hold for the event
    if (earningsImminent) {
      return { exit: false };
    }
  }

  // 3. Emergency exit: DTE <= 1 (only if no imminent earnings)
  if (d <= FLOW_PARAMS.emergencyExitDte) {
    return { exit: true, reason: `emergency_dte (${d} DTE remaining)` };
  }

  // 4. Pre-expiry exit: if earnings are AFTER option expiry, exit at ≤3 DTE
  if (pos.earningsDate && pos.expiry) {
    if (pos.earningsDate > pos.expiry && d <= FLOW_PARAMS.preExpiryExitDte) {
      return { exit: true, reason: `pre_expiry (ER ${pos.earningsDate} is after expiry ${pos.expiry}, ${d} DTE left)` };
    }
  }

  return { exit: false };
}

async function checkFlowPositions() {
  const cfg = STRATEGIES.flow;
  const state = loadState(cfg.stateFile);
  if (!state || !state.openPositions || state.openPositions.length === 0) return 0;

  let exits = 0;
  for (let i = state.openPositions.length - 1; i >= 0; i--) {
    const pos = state.openPositions[i];
    const quote = await getOptionPrice(pos.ticker, pos.optionChain);
    const currentPrice = quote ? quote.price : null;

    if (currentPrice === null) {
      console.log(`${LOG_PREFIX()} [flow] SKIP (no price): ${pos.ticker} ${pos.optionChain}`);
      continue;
    }

    // Mark-to-market
    const exitBidPrice = quote.bid > 0 ? quote.bid : currentPrice;
    pos.lastPrice = currentPrice;
    pos.lastMtm = currentPrice * 100 * (pos.contracts || 1);
    pos.unrealizedPnl = pos.lastMtm - pos.entryValue;

    const exitCheck = flowShouldExit(pos, currentPrice);

    if (exitCheck.exit) {
      const exitPrice = exitBidPrice;
      const contracts = pos.contracts || 1;
      const exitValue = exitPrice * 100 * contracts;
      const pnl = exitValue - pos.entryValue;
      const pnlPct = pos.entryValue > 0 ? (pnl / pos.entryValue * 100) : 0;

      const closedPos = {
        ...pos,
        action: 'CLOSE',
        status: 'closed',
        exitDate: today(),
        exitTime: new Date().toISOString(),
        exitPrice,
        exitValue,
        pnl,
        pnlPct,
        exitReason: exitCheck.reason,
        holdDays: Math.round((new Date() - new Date(pos.entryDate)) / 86400000),
        exitSource: 'exit-monitor',
      };

      state.closedPositions = state.closedPositions || [];
      state.closedPositions.push(closedPos);
      state.openPositions.splice(i, 1);
      state.stats = state.stats || { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0 };
      state.stats.totalTrades++;
      state.stats.totalPnl += pnl;
      if (pnl > 0) state.stats.wins++; else state.stats.losses++;

      logTrade(cfg.tradesFile, closedPos);
      exits++;
      console.log(`${LOG_PREFIX()} [flow] EXIT: ${pos.ticker} ${pos.strike}${pos.type === 'call' ? 'C' : 'P'} | ${exitCheck.reason} | PnL: $${pnl.toFixed(0)}`);
    } else {
      const pnlPct = pos.entryValue > 0 ? ((pos.unrealizedPnl / pos.entryValue) * 100).toFixed(1) : '0.0';
      console.log(`${LOG_PREFIX()} [flow] HOLD: ${pos.ticker} ${pos.strike}${pos.type === 'call' ? 'C' : 'P'} @ $${currentPrice.toFixed(2)} (${pnlPct}%)`);
    }
  }

  saveState(cfg.stateFile, state);
  return exits;
}

// ════════════════════════════════════════════════════════════
// RIPTIDE EXIT LOGIC (from riptide-strategy.js)
// ════════════════════════════════════════════════════════════
const RIPTIDE_PARAMS = {
  profitTakePct: 50,
  stopLossMultiple: 3,
  dteFloor: 7,
  timeDecayStopPct: 50,
  moneynessExitPct: 2,
  ivCrushExitPct: 30,
  earningsProximityDays: 2,
};

function riptideShouldExit(pos, currentSpreadCost, currentIv, underlyingPrice) {
  if (!isAfterExitWindow()) return { exit: false };

  const d = dte(pos.expiry);
  const entryDte = Math.round((new Date(pos.expiry + 'T16:00:00') - new Date(pos.entryDate + 'T16:00:00')) / 86400000);
  const timeElapsedPct = entryDte > 0 ? ((entryDte - d) / entryDte) * 100 : 100;
  const pnlPerContract = currentSpreadCost !== null ? pos.creditPerContract - currentSpreadCost : null;
  const isLosing = pnlPerContract !== null && pnlPerContract < 0;

  // 1. Moneyness — underlying within 2% of short strike
  if (underlyingPrice && underlyingPrice > 0) {
    const distancePct = pos.type === 'put'
      ? ((underlyingPrice - pos.strike) / underlyingPrice) * 100
      : ((pos.strike - underlyingPrice) / underlyingPrice) * 100;
    if (distancePct <= RIPTIDE_PARAMS.moneynessExitPct) {
      return { exit: true, reason: `moneyness (underlying $${underlyingPrice.toFixed(2)} within ${distancePct.toFixed(1)}% of ${pos.strike} strike)` };
    }
  }

  // 2. Stop loss — spread cost ≥ 3x credit
  if (currentSpreadCost !== null && currentSpreadCost !== undefined) {
    if (currentSpreadCost >= pos.creditPerContract * RIPTIDE_PARAMS.stopLossMultiple) {
      return { exit: true, reason: `stop_loss (spread cost $${currentSpreadCost.toFixed(2)} >= ${RIPTIDE_PARAMS.stopLossMultiple}x credit $${pos.creditPerContract.toFixed(2)})` };
    }
  }

  // 3. Profit target — captured ≥ 50% of credit
  if (currentSpreadCost !== null && currentSpreadCost !== undefined) {
    const profitPct = ((pos.creditPerContract - currentSpreadCost) / pos.creditPerContract) * 100;
    if (profitPct >= RIPTIDE_PARAMS.profitTakePct) {
      return { exit: true, reason: `profit_take (${profitPct.toFixed(0)}% of credit captured)` };
    }
  }

  // 4. IV crush — IV dropped ≥ 30% from entry AND profitable
  if (currentIv && pos.entryIv && pos.entryIv > 0) {
    const ivDropPct = ((pos.entryIv - currentIv) / pos.entryIv) * 100;
    if (ivDropPct >= RIPTIDE_PARAMS.ivCrushExitPct && !isLosing) {
      return { exit: true, reason: `iv_crush (IV ${(pos.entryIv * 100).toFixed(0)}% -> ${(currentIv * 100).toFixed(0)}%, dropped ${ivDropPct.toFixed(0)}%)` };
    }
  }

  // 5. Time decay stop — 50%+ time elapsed and still losing
  if (timeElapsedPct >= RIPTIDE_PARAMS.timeDecayStopPct && isLosing) {
    return { exit: true, reason: `time_decay_stop (${timeElapsedPct.toFixed(0)}% of time elapsed, P&L $${(pnlPerContract * pos.contracts * 100).toFixed(0)})` };
  }

  // 6. Earnings proximity — exit ≤ 2 trading days before ER
  if (pos.earningsDate) {
    const erBdays = tradingDaysBetween(new Date(), new Date(pos.earningsDate));
    if (erBdays >= 0 && erBdays <= RIPTIDE_PARAMS.earningsProximityDays) {
      return { exit: true, reason: `earnings_proximity (ER ${pos.earningsDate} in ${erBdays} trading days)` };
    }
  }

  // 7. DTE floor — ≤ 7 DTE
  if (d <= RIPTIDE_PARAMS.dteFloor) {
    return { exit: true, reason: `dte_floor (${d} DTE remaining, floor is ${RIPTIDE_PARAMS.dteFloor})` };
  }

  return { exit: false };
}

async function checkRiptidePositions() {
  const cfg = STRATEGIES.riptide;
  const state = loadState(cfg.stateFile);
  if (!state || !state.openPositions || state.openPositions.length === 0) return 0;

  let exits = 0;
  for (let i = state.openPositions.length - 1; i >= 0; i--) {
    const pos = state.openPositions[i];

    // Fetch both legs
    const shortQuote = await getOptionPrice(pos.ticker, pos.optionChain);
    const longQuote = await getOptionPrice(pos.ticker, pos.protectionSymbol);

    // Spread cost to close = buy back short (ask) - sell long (bid)
    const shortAsk = shortQuote?.ask > 0 ? shortQuote.ask : (shortQuote?.price || pos.creditPerContract);
    const longBid = longQuote?.bid > 0 ? longQuote.bid : 0;
    const currentSpreadCost = shortAsk - longBid;

    const currentIv = shortQuote?.iv || 0;
    const underlyingPrice = await getUnderlyingPrice(pos.ticker);

    // Mark-to-market
    pos.currentSpreadCost = currentSpreadCost;
    pos.unrealizedPnl = (pos.creditPerContract - currentSpreadCost) * pos.contracts * 100;

    const exitCheck = riptideShouldExit(pos, currentSpreadCost, currentIv, underlyingPrice);

    if (exitCheck.exit) {
      const exitCostPerContract = Math.max(0, currentSpreadCost);
      const pnlPerContract = pos.creditPerContract - exitCostPerContract;
      const totalPnl = pnlPerContract * pos.contracts * 100;

      const closedPos = {
        ...pos,
        action: 'CLOSE',
        status: 'closed',
        exitDate: today(),
        exitTime: new Date().toISOString(),
        exitCostPerContract,
        pnl: totalPnl,
        pnlPct: pos.totalCredit > 0 ? (totalPnl / pos.totalCredit * 100) : 0,
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

      logTrade(cfg.tradesFile, closedPos);
      exits++;
      const typeChar = pos.type === 'put' ? 'P' : 'C';
      console.log(`${LOG_PREFIX()} [riptide] EXIT: ${pos.ticker} ${pos.strike}${typeChar} spread | ${exitCheck.reason} | PnL: $${totalPnl.toFixed(0)}`);
    } else {
      const pnlStr = pos.unrealizedPnl !== undefined ? `$${pos.unrealizedPnl.toFixed(0)}` : '?';
      const typeChar = pos.type === 'put' ? 'P' : 'C';
      const ulStr = underlyingPrice ? ` | ul $${underlyingPrice.toFixed(2)}` : '';
      console.log(`${LOG_PREFIX()} [riptide] HOLD: ${pos.ticker} ${pos.strike}${typeChar}/${pos.protectionStrike}${typeChar} | cost $${currentSpreadCost.toFixed(2)} vs credit $${pos.creditPerContract.toFixed(2)} | PnL: ${pnlStr}${ulStr}`);
    }
  }

  saveState(cfg.stateFile, state);
  return exits;
}

// ════════════════════════════════════════════════════════════
// THETA EXIT LOGIC (from theta-strategy.js)
// ════════════════════════════════════════════════════════════
const THETA_PARAMS = {
  profitTargetPct: 0.50,   // close at 50% of max profit
  maxLossPct: 2.0,         // close at 200% of credit received
};

function thetaShouldExit(pos, exitDebit) {
  if (!pos.earningsDate) return { exit: false };

  const todayStr = today();
  const pnl = (pos.credit - exitDebit) * 100 * pos.contracts;

  // 1. Profit target: captured ≥ 50% of max credit
  if (pos.maxCredit > 0 && pnl >= pos.maxCredit * THETA_PARAMS.profitTargetPct) {
    const pnlPct = (pnl / pos.maxCredit * 100).toFixed(0);
    return { exit: true, reason: `profit_take (${pnlPct}% of max credit, target ${(THETA_PARAMS.profitTargetPct * 100).toFixed(0)}%)` };
  }

  // 2. Stop loss: loss ≥ 200% of credit received
  if (pos.maxCredit > 0 && pnl < 0 && Math.abs(pnl) >= pos.maxCredit * THETA_PARAMS.maxLossPct) {
    const lossPct = (Math.abs(pnl) / pos.maxCredit * 100).toFixed(0);
    return { exit: true, reason: `stop_loss (${lossPct}% loss vs ${(THETA_PARAMS.maxLossPct * 100).toFixed(0)}% limit)` };
  }

  // 3. Post-earnings exit
  const erDate = pos.earningsDate;
  const erTime = (pos.erTime || '').toLowerCase();

  if (erTime === 'bmo' || erTime === 'before' || erTime === 'premarket') {
    if (todayStr >= erDate) {
      return { exit: true, reason: `post-earnings (ER ${erDate} BMO)` };
    }
  } else if (erTime === 'amc' || erTime === 'after' || erTime === 'postmarket') {
    const exitDate = nextBusinessDay(erDate);
    if (todayStr >= exitDate) {
      return { exit: true, reason: `post-earnings (ER ${erDate} AMC)` };
    }
  } else {
    const exitDate = nextBusinessDay(erDate);
    if (todayStr >= exitDate) {
      return { exit: true, reason: `post-earnings (ER ${erDate})` };
    }
  }

  return { exit: false };
}

async function checkThetaPositions() {
  const cfg = STRATEGIES.theta;
  const state = loadState(cfg.stateFile);
  if (!state || !state.openPositions || state.openPositions.length === 0) return 0;

  let exits = 0;
  for (let i = state.openPositions.length - 1; i >= 0; i--) {
    const pos = state.openPositions[i];

    // Fetch full option chain for this ticker (prices all 4 legs in one call)
    const chain = await getOptionChain(pos.ticker);

    let exitDebit = 0;
    let foundAll = true;
    for (const leg of ['shortCall', 'shortPut', 'longCall', 'longPut']) {
      const contract = chain.find(c => c.option_symbol === pos[leg].symbol);
      if (contract) {
        const mid = (parseFloat(contract.bid || contract.nbbo_bid || 0) + parseFloat(contract.ask || contract.nbbo_ask || 0)) / 2;
        if (leg.startsWith('short')) exitDebit += mid;
        else exitDebit -= mid;
      } else {
        foundAll = false;
        if (leg.startsWith('short')) exitDebit += pos[leg].mid;
        else exitDebit -= pos[leg].mid;
      }
    }

    // Mark-to-market
    const pnl = (pos.credit - exitDebit) * 100 * pos.contracts;
    const pnlPct = pos.maxCredit > 0 ? (pnl / pos.maxCredit * 100) : 0;
    pos.exitDebitMtm = exitDebit;
    pos.unrealizedPnl = pnl;
    pos.unrealizedPnlPct = pnlPct;
    pos.lastMtm = new Date().toISOString();

    const exitCheck = isAfterExitWindow() ? thetaShouldExit(pos, exitDebit) : { exit: false };

    if (exitCheck.exit) {
      const closedPos = {
        ...pos,
        action: 'CLOSE_CONDOR',
        status: 'closed',
        exitDate: today(),
        exitTime: new Date().toISOString(),
        exitDebit,
        pnl,
        pnlPct,
        exitReason: exitCheck.reason,
        holdDays: Math.round((new Date() - new Date(pos.entryDate)) / 86400000),
        exitSource: 'exit-monitor',
      };

      state.closedPositions = state.closedPositions || [];
      state.closedPositions.push(closedPos);
      state.openPositions.splice(i, 1);
      state.stats = state.stats || { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0 };
      state.stats.totalTrades++;
      state.stats.totalPnl += pnl;
      if (pnl > 0) state.stats.wins++; else state.stats.losses++;

      logTrade(cfg.tradesFile, closedPos);
      exits++;
      console.log(`${LOG_PREFIX()} [theta] EXIT: ${pos.ticker} IC ${pos.shortPut.strike}P/${pos.shortCall.strike}C | ${exitCheck.reason} | PnL: $${pnl.toFixed(0)} (${pnlPct.toFixed(0)}%)`);
    } else {
      const partialTag = foundAll ? '' : ' [partial]';
      console.log(`${LOG_PREFIX()} [theta] HOLD: ${pos.ticker} IC ${pos.shortPut.strike}P/${pos.shortCall.strike}C | credit=$${pos.credit.toFixed(3)} debit=$${exitDebit.toFixed(3)} | PnL: $${pnl.toFixed(0)} (${pnlPct.toFixed(0)}%)${partialTag}`);
    }
  }

  saveState(cfg.stateFile, state);
  return exits;
}

// ════════════════════════════════════════════════════════════
// YOLO EXIT LOGIC (from yolo-exit-monitor.js / yolo-strategy.js)
// ════════════════════════════════════════════════════════════
const YOLO_PARAMS = {
  stopLossPct: -10,
  trailingStopPct: 15,
};

function yoloShouldExit(pos, currentPrice) {
  if (!isAfterExitWindow()) return { exit: false };

  const entryPrice = pos.entryPrice;
  const pnlPct = (currentPrice - entryPrice) / entryPrice * 100;

  // Track high-water mark
  if (!pos.peakPrice || currentPrice > pos.peakPrice) {
    pos.peakPrice = currentPrice;
  }

  // 1. Trailing stop — 15% drop from peak (only when in profit)
  if (pos.peakPrice && pos.peakPrice > entryPrice) {
    const dropFromPeak = (pos.peakPrice - currentPrice) / pos.peakPrice * 100;
    if (dropFromPeak >= YOLO_PARAMS.trailingStopPct) {
      const peakGainPct = ((pos.peakPrice - entryPrice) / entryPrice * 100).toFixed(0);
      return { exit: true, reason: `trailing_stop (peak $${pos.peakPrice.toFixed(2)} +${peakGainPct}% -> now $${currentPrice.toFixed(2)} ${pnlPct.toFixed(0)}%, dropped ${dropFromPeak.toFixed(0)}% from peak)` };
    }
  }

  // 2. Stop loss — 10%
  if (currentPrice <= entryPrice * (1 + YOLO_PARAMS.stopLossPct / 100)) {
    return { exit: true, reason: `stop_loss (${pnlPct.toFixed(0)}%, $${entryPrice.toFixed(2)} -> $${currentPrice.toFixed(2)})` };
  }

  // 3. Theta guard — exit after 2/3 of calendar days elapsed
  if (pos.thetaExitDate && today() >= pos.thetaExitDate) {
    return { exit: true, reason: `theta_guard (${pnlPct.toFixed(0)}% P&L, exit date ${pos.thetaExitDate} reached)` };
  }

  return { exit: false };
}

async function checkYoloPositions() {
  const cfg = STRATEGIES.yolo;
  const state = loadState(cfg.stateFile);
  if (!state || !state.openPositions || state.openPositions.length === 0) return 0;

  let exits = 0;
  for (let i = state.openPositions.length - 1; i >= 0; i--) {
    const pos = state.openPositions[i];
    const quote = await getOptionPrice(pos.ticker, pos.optionChain);
    const currentPrice = quote?.mid > 0 ? quote.mid : (quote?.bid > 0 ? quote.bid : null);

    if (currentPrice === null) {
      console.log(`${LOG_PREFIX()} [yolo] SKIP (no price): ${pos.ticker} ${pos.optionChain}`);
      continue;
    }

    // Mark-to-market
    pos.currentPrice = currentPrice;
    pos.unrealizedPnl = (currentPrice - pos.entryPrice) * pos.contracts * 100;

    const exitCheck = yoloShouldExit(pos, currentPrice);

    if (exitCheck.exit) {
      const exitPrice = quote?.bid > 0 ? quote.bid : currentPrice;
      const pnlPerContract = (exitPrice - pos.entryPrice) * 100;
      const totalPnl = pnlPerContract * pos.contracts;

      const closedPos = {
        ...pos,
        action: 'CLOSE',
        status: 'closed',
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

      logTrade(cfg.tradesFile, closedPos);
      exits++;
      console.log(`${LOG_PREFIX()} [yolo] EXIT: ${pos.ticker} ${pos.strike}${pos.type === 'put' ? 'P' : 'C'} | ${exitCheck.reason} | PnL: $${totalPnl.toFixed(0)}`);
    } else {
      const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(1);
      const peakStr = pos.peakPrice ? ` | peak $${pos.peakPrice.toFixed(2)}` : '';
      console.log(`${LOG_PREFIX()} [yolo] HOLD: ${pos.ticker} ${pos.strike}${pos.type === 'put' ? 'P' : 'C'} @ $${currentPrice.toFixed(2)} (${pnlPct}%)${peakStr}`);
    }
  }

  saveState(cfg.stateFile, state);
  return exits;
}

// ════════════════════════════════════════════════════════════
// MAIN LOOP
// ════════════════════════════════════════════════════════════
function countAllOpen() {
  let total = 0;
  for (const key of Object.keys(STRATEGIES)) {
    const state = loadState(STRATEGIES[key].stateFile);
    total += state?.openPositions?.length || 0;
  }
  return total;
}

async function runCycle() {
  let totalExits = 0;

  // Check all 4 strategies
  try {
    const flowExits = await checkFlowPositions();
    totalExits += flowExits;
  } catch (e) {
    console.error(`${LOG_PREFIX()} [flow] Error: ${e.message}`);
  }

  try {
    const riptideExits = await checkRiptidePositions();
    totalExits += riptideExits;
  } catch (e) {
    console.error(`${LOG_PREFIX()} [riptide] Error: ${e.message}`);
  }

  try {
    const thetaExits = await checkThetaPositions();
    totalExits += thetaExits;
  } catch (e) {
    console.error(`${LOG_PREFIX()} [theta] Error: ${e.message}`);
  }

  try {
    const yoloExits = await checkYoloPositions();
    totalExits += yoloExits;
  } catch (e) {
    console.error(`${LOG_PREFIX()} [yolo] Error: ${e.message}`);
  }

  return totalExits;
}

async function main() {
  console.log(`${LOG_PREFIX()} Unified Exit Monitor started`);
  console.log(`${LOG_PREFIX()} Strategies: flow, riptide, theta, yolo`);
  console.log(`${LOG_PREFIX()} Poll: ${POLL_INTERVAL_MS / 1000}s | Rate limit: ${RATE_LIMIT_MS}ms`);

  while (true) {
    if (!isMarketHours()) {
      console.log(`${LOG_PREFIX()} Market closed — sleeping 5 min`);
      await sleep(5 * 60_000);
      continue;
    }

    const openCount = countAllOpen();
    if (openCount === 0) {
      console.log(`${LOG_PREFIX()} No open positions across all strategies — sleeping 5 min`);
      await sleep(5 * 60_000);
      continue;
    }

    console.log(`${LOG_PREFIX()} --- Cycle start (${openCount} open positions) ---`);

    try {
      const exits = await runCycle();
      if (exits > 0) {
        console.log(`${LOG_PREFIX()} --- Cycle done: ${exits} exit(s) ---`);
      } else {
        console.log(`${LOG_PREFIX()} --- Cycle done: no exits ---`);
      }
    } catch (e) {
      console.error(`${LOG_PREFIX()} Cycle error: ${e.message}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

main();
