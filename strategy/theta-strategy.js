#!/usr/bin/env node
// Moby Theta 🐋⏳ — Earnings Premium Seller (Iron Condors)
// Sells IV crush around earnings when no strong directional flow exists.

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_TOKEN = process.env.UW_API_TOKEN;
if (!API_TOKEN) { console.error('Missing UW_API_TOKEN env var'); process.exit(1); }

const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'theta-state.json');
const TRADES_FILE = path.join(DATA_DIR, 'theta-trades.jsonl');
const MOBY_STATE_FILE = path.join(DATA_DIR, 'strategy-state.json');

// ─── Parameters ───
const PARAMS = {
  // Entry filters
  minIvRank: 0.50,              // IV rank must be >50% (elevated IV to sell into)
  maxBidAskSpreadPct: 0.15,     // max 15% spread on the short strikes
  earningsWindowDays: 3,        // enter 1-3 trading days before earnings
  minEarningsWindowDays: 0,     // can enter day of earnings (BMO)

  // Condor structure
  shortStrikeOtmPct: 0.08,     // short strikes ~8% OTM each side
  wingWidth: 5,                 // buy wings $5 further out (adjusts based on price)
  wingWidthPct: 0.03,           // or 3% of stock price, whichever is greater

  // Position sizing
  maxRiskPerTrade: 2500,        // $2.5K max risk per condor
  maxOpenPositions: 5,

  // Exit
  profitTargetPct: 0.50,        // close at 50% of max profit
  maxLossPct: 2.0,              // close at 200% of credit received (stop loss)

  // Exclusions
  excludeIndexes: true,
};

const INDEX_TICKERS = new Set(['SPX', 'SPXW', 'SPY', 'QQQ', 'IWM', 'DIA', 'XSP', 'VIX', 'NDX', 'RUT']);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RATE_LIMIT_MS = 300;

// ─── API Helpers ───
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

function today() { return new Date().toISOString().slice(0, 10); }

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

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { openPositions: [], closedPositions: [], stats: { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0 } }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function logTrade(trade) {
  fs.appendFileSync(TRADES_FILE, JSON.stringify({ ...trade, timestamp: new Date().toISOString() }) + '\n');
}

function sendSignal(message) {
  const target = process.env.SIGNAL_TARGET_UUID || '';
  if (!target) { console.log('[Signal] No target UUID, skipping'); return; }
  try {
    const { execSync } = require('child_process');
    execSync(`openclaw message send --channel signal -t "${target}" -m ${JSON.stringify(message)}`, { timeout: 15000, stdio: 'pipe' });
    console.log('[Signal] Notification sent');
  } catch (e) { console.log('[Signal] Failed:', e.message); }
}

// ─── Find suitable earnings stocks ───
async function findEarningsCandidates() {
  // Use the screener to find stocks with upcoming earnings
  const url = `https://api.unusualwhales.com/api/screener/option-contracts?limit=200&min_premium=100000&issue_types[]=Common%20Stock`;
  await sleep(RATE_LIMIT_MS);
  const resp = await fetchJson(url);
  const data = resp.data || [];

  // Group by ticker, get unique tickers with earnings info
  const tickers = new Map();
  for (const row of data) {
    const ticker = row.ticker_symbol || row.ticker;
    if (!ticker || tickers.has(ticker)) continue;
    if (INDEX_TICKERS.has(ticker)) continue;
    if (row.next_earnings_date) {
      tickers.set(ticker, {
        ticker,
        earningsDate: row.next_earnings_date,
        erTime: row.er_time || null,
        underlying: parseFloat(row.underlying_price || 0),
      });
    }
  }

  // Filter to earnings within window
  const candidates = [];
  const todayStr = today();
  for (const [, info] of tickers) {
    const bdays = tradingDaysBetween(new Date(), new Date(info.earningsDate));
    if (bdays < PARAMS.minEarningsWindowDays || bdays > PARAMS.earningsWindowDays) continue;

    // Skip if earnings already released (BMO today)
    const erTime = (info.erTime || '').toLowerCase();
    if (info.earningsDate === todayStr && (erTime === 'bmo' || erTime === 'before' || erTime === 'premarket')) continue;
    if (info.earningsDate < todayStr) continue;

    candidates.push(info);
  }

  return candidates;
}

// ─── Check if Moby has a directional position ───
function mobyHasPosition(ticker) {
  try {
    const mobyState = JSON.parse(fs.readFileSync(MOBY_STATE_FILE, 'utf8'));
    return mobyState.openPositions.some(p => p.ticker === ticker);
  } catch { return false; }
}

// ─── Get IV rank for a ticker ───
async function getIvRank(ticker) {
  await sleep(RATE_LIMIT_MS);
  try {
    const resp = await fetchJson(`https://api.unusualwhales.com/api/stock/${ticker}/interpolated-iv`);
    const data = resp.data || [];
    // Find the 30-day IV percentile (best proxy for IV rank)
    const d30 = data.find(d => d.days === 30);
    if (d30) return parseFloat(d30.percentile || 0);
    // Fallback to first available
    if (data.length > 0) return parseFloat(data[0].percentile || 0);
    return 0;
  } catch { return 0; }
}

// ─── Get option chain for condor construction ───
async function getOptionChain(ticker) {
  await sleep(RATE_LIMIT_MS);
  try {
    const resp = await fetchJson(`https://api.unusualwhales.com/api/stock/${ticker}/option-contracts`);
    const data = resp.data || [];
    // Parse expiry from option_symbol if not present: TICKER + YYMMDD + C/P + strike
    return data.map(c => {
      if (!c.expiry && c.option_symbol) {
        const sym = c.option_symbol;
        // Find where the date starts (6 digits after ticker)
        const match = sym.match(/(\d{6})([CP])/);
        if (match) {
          const ds = match[1];
          c.expiry = `20${ds.slice(0,2)}-${ds.slice(2,4)}-${ds.slice(4,6)}`;
          c.option_type = match[2] === 'C' ? 'call' : 'put';
          c.strike = parseFloat(sym.slice(sym.indexOf(match[2]) + 1)) / 1000;
        }
      }
      c.bid = c.nbbo_bid || c.bid || '0';
      c.ask = c.nbbo_ask || c.ask || '0';
      return c;
    });
  } catch { return []; }
}

// ─── Find nearest expiry after earnings ───
function findBestExpiry(chain, earningsDate) {
  const expirations = [...new Set(chain.map(c => c.expiry))].sort();
  // Find first expiry on or after earnings date (want condor to span earnings)
  for (const exp of expirations) {
    if (exp >= earningsDate) return exp;
  }
  return null;
}

// ─── Construct iron condor ───
function buildCondor(chain, underlying, expiry) {
  const calls = chain.filter(c => c.option_type === 'call' && c.expiry === expiry)
    .map(c => ({ ...c, strike: parseFloat(c.strike) }))
    .sort((a, b) => a.strike - b.strike);
  const puts = chain.filter(c => c.option_type === 'put' && c.expiry === expiry)
    .map(c => ({ ...c, strike: parseFloat(c.strike) }))
    .sort((a, b) => a.strike - b.strike);

  if (calls.length < 4 || puts.length < 4) return null;

  // Short call: ~8% OTM above
  const shortCallTarget = underlying * (1 + PARAMS.shortStrikeOtmPct);
  const shortCall = calls.reduce((best, c) =>
    Math.abs(c.strike - shortCallTarget) < Math.abs(best.strike - shortCallTarget) ? c : best);

  // Short put: ~8% OTM below
  const shortPutTarget = underlying * (1 - PARAMS.shortStrikeOtmPct);
  const shortPut = puts.reduce((best, p) =>
    Math.abs(p.strike - shortPutTarget) < Math.abs(best.strike - shortPutTarget) ? p : best);

  // Wing width: $5 or 3% of price, whichever is greater
  const wingWidth = Math.max(PARAMS.wingWidth, underlying * PARAMS.wingWidthPct);

  // Long call: wing width above short call
  const longCallTarget = shortCall.strike + wingWidth;
  const longCall = calls.reduce((best, c) =>
    Math.abs(c.strike - longCallTarget) < Math.abs(best.strike - longCallTarget) ? c : best);

  // Long put: wing width below short put
  const longPutTarget = shortPut.strike - wingWidth;
  const longPut = puts.reduce((best, p) =>
    Math.abs(p.strike - longPutTarget) < Math.abs(best.strike - longPutTarget) ? p : best);

  // Validate structure
  if (longCall.strike <= shortCall.strike || longPut.strike >= shortPut.strike) return null;
  if (shortPut.strike >= shortCall.strike) return null; // strikes crossed

  // Calculate credit and max risk
  const shortCallMid = (parseFloat(shortCall.bid || 0) + parseFloat(shortCall.ask || 0)) / 2;
  const shortPutMid = (parseFloat(shortPut.bid || 0) + parseFloat(shortPut.ask || 0)) / 2;
  const longCallMid = (parseFloat(longCall.bid || 0) + parseFloat(longCall.ask || 0)) / 2;
  const longPutMid = (parseFloat(longPut.bid || 0) + parseFloat(longPut.ask || 0)) / 2;

  const credit = (shortCallMid + shortPutMid) - (longCallMid + longPutMid);
  if (credit <= 0) return null;

  const callWingWidth = longCall.strike - shortCall.strike;
  const putWingWidth = shortPut.strike - longPut.strike;
  const maxWingWidth = Math.max(callWingWidth, putWingWidth);
  const maxRisk = (maxWingWidth - credit) * 100; // per condor

  if (maxRisk <= 0) return null;

  // Bid-ask spread check on short legs
  const shortCallSpread = parseFloat(shortCall.ask || 0) - parseFloat(shortCall.bid || 0);
  const shortPutSpread = parseFloat(shortPut.ask || 0) - parseFloat(shortPut.bid || 0);
  if (shortCallMid > 0 && shortCallSpread / shortCallMid > PARAMS.maxBidAskSpreadPct) return null;
  if (shortPutMid > 0 && shortPutSpread / shortPutMid > PARAMS.maxBidAskSpreadPct) return null;

  return {
    shortCall: { strike: shortCall.strike, symbol: shortCall.option_symbol, mid: shortCallMid, bid: parseFloat(shortCall.bid || 0), ask: parseFloat(shortCall.ask || 0) },
    longCall: { strike: longCall.strike, symbol: longCall.option_symbol, mid: longCallMid },
    shortPut: { strike: shortPut.strike, symbol: shortPut.option_symbol, mid: shortPutMid, bid: parseFloat(shortPut.bid || 0), ask: parseFloat(shortPut.ask || 0) },
    longPut: { strike: longPut.strike, symbol: longPut.option_symbol, mid: longPutMid },
    expiry,
    credit,
    maxRisk,
    callWingWidth,
    putWingWidth,
  };
}

// ─── Check exits ───
async function checkExits(state) {
  const todayStr = today();

  for (let i = state.openPositions.length - 1; i >= 0; i--) {
    const pos = state.openPositions[i];
    let shouldExit = false;
    let reason = '';

    // Post-earnings exit
    const erDate = pos.earningsDate;
    const erTime = (pos.erTime || '').toLowerCase();

    if (erTime === 'bmo' || erTime === 'before' || erTime === 'premarket') {
      if (todayStr >= erDate) { shouldExit = true; reason = `post-earnings (ER ${erDate} BMO)`; }
    } else if (erTime === 'amc' || erTime === 'after' || erTime === 'postmarket') {
      const erDateObj = new Date(erDate + 'T00:00:00');
      const nextDay = new Date(erDateObj);
      nextDay.setDate(nextDay.getDate() + 1);
      while (nextDay.getDay() === 0 || nextDay.getDay() === 6) nextDay.setDate(nextDay.getDate() + 1);
      if (todayStr >= nextDay.toISOString().slice(0, 10)) { shouldExit = true; reason = `post-earnings (ER ${erDate} AMC)`; }
    } else {
      const erDateObj = new Date(erDate + 'T00:00:00');
      const nextDay = new Date(erDateObj);
      nextDay.setDate(nextDay.getDate() + 1);
      while (nextDay.getDay() === 0 || nextDay.getDay() === 6) nextDay.setDate(nextDay.getDate() + 1);
      if (todayStr >= nextDay.toISOString().slice(0, 10)) { shouldExit = true; reason = `post-earnings (ER ${erDate})`; }
    }

    if (shouldExit) {
      // Fetch current prices for all 4 legs
      await sleep(RATE_LIMIT_MS);
      const chain = await getOptionChain(pos.ticker);

      let exitDebit = 0;
      for (const leg of ['shortCall', 'shortPut', 'longCall', 'longPut']) {
        const contract = chain.find(c => c.option_symbol === pos[leg].symbol);
        const mid = contract ? (parseFloat(contract.bid || 0) + parseFloat(contract.ask || 0)) / 2 : pos[leg].mid;
        if (leg.startsWith('short')) exitDebit += mid;  // buy back short legs
        else exitDebit -= mid;  // sell long legs
      }

      const pnl = (pos.credit - exitDebit) * 100 * pos.contracts;
      const pnlPct = pos.maxCredit > 0 ? (pnl / pos.maxCredit * 100) : 0;

      const closedPos = {
        ...pos,
        exitDate: todayStr,
        exitDebit,
        pnl,
        pnlPct,
        exitReason: reason,
        holdDays: Math.round((new Date() - new Date(pos.entryDate)) / 86400000),
      };

      state.closedPositions.push(closedPos);
      state.openPositions.splice(i, 1);
      state.stats.totalTrades++;
      state.stats.totalPnl += pnl;
      if (pnl > 0) state.stats.wins++; else state.stats.losses++;

      logTrade({ action: 'CLOSE_CONDOR', ...closedPos });
      const emoji = pnl >= 0 ? '✅' : '❌';
      sendSignal(`🐋⏳ THETA EXIT: ${pos.ticker} Iron Condor ${emoji}\n` +
        `${pos.shortPut.strike}P/${pos.shortCall.strike}C ${pos.expiry}\n` +
        `Credit $${pos.credit.toFixed(2)} → Debit $${exitDebit.toFixed(2)}\n` +
        `PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(0)}%)\n` +
        `Reason: ${reason}`);
      console.log(`  EXIT CONDOR: ${pos.ticker} | ${reason} | PnL: $${pnl.toFixed(0)} (${pnlPct.toFixed(0)}%)`);
    }
  }
}

// ─── Main ───
async function run() {
  const state = loadState();

  // Step 1: Check exits
  await checkExits(state);

  // Step 1.5: Mark-to-market open positions
  for (const pos of state.openPositions) {
    await sleep(RATE_LIMIT_MS);
    const chain = await getOptionChain(pos.ticker);
    if (chain.length === 0) {
      console.log(`  MTM: ${pos.ticker} — no chain data, skipping`);
      continue;
    }
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
        // Use entry mid as fallback
        if (leg.startsWith('short')) exitDebit += pos[leg].mid;
        else exitDebit -= pos[leg].mid;
      }
    }
    const pnl = (pos.credit - exitDebit) * 100 * pos.contracts;
    const pnlPct = pos.maxCredit > 0 ? (pnl / pos.maxCredit * 100) : 0;
    pos.exitDebitMtm = exitDebit;
    pos.unrealizedPnl = pnl;
    pos.unrealizedPnlPct = pnlPct;
    pos.lastMtm = new Date().toISOString();
    console.log(`  MTM: ${pos.ticker} | credit=${pos.credit.toFixed(3)} debit=${exitDebit.toFixed(3)} | PnL: $${pnl.toFixed(0)} (${pnlPct.toFixed(0)}%)${foundAll ? '' : ' [partial]'}`);
  }

  // Step 2: Find new candidates
  if (state.openPositions.length >= PARAMS.maxOpenPositions) {
    console.log(`Max theta positions (${PARAMS.maxOpenPositions}) reached, skipping scan`);
    saveState(state);
    return;
  }

  const candidates = await findEarningsCandidates();
  console.log(`Found ${candidates.length} earnings candidates within ${PARAMS.earningsWindowDays} trading days`);

  let entered = 0;
  for (const cand of candidates) {
    if (state.openPositions.length >= PARAMS.maxOpenPositions) break;

    // Skip if Moby has directional position
    if (mobyHasPosition(cand.ticker)) {
      console.log(`  SKIP (Moby has position): ${cand.ticker}`);
      continue;
    }

    // Skip if we already have a theta position
    if (state.openPositions.some(p => p.ticker === cand.ticker)) {
      console.log(`  SKIP (duplicate): ${cand.ticker}`);
      continue;
    }

    // Check IV rank
    const ivRank = await getIvRank(cand.ticker);
    if (ivRank < PARAMS.minIvRank) {
      console.log(`  SKIP (IV rank ${(ivRank * 100).toFixed(0)}% < ${(PARAMS.minIvRank * 100).toFixed(0)}%): ${cand.ticker}`);
      continue;
    }

    // Get real underlying price from option chain ATM options
    // (screener underlying can be stale/missing)

    // Get full option chain
    const chain = await getOptionChain(cand.ticker);
    if (chain.length === 0) {
      console.log(`  SKIP (no chain data): ${cand.ticker}`);
      continue;
    }

    // Find best expiry that spans earnings
    const expiry = findBestExpiry(chain, cand.earningsDate);
    if (!expiry) {
      console.log(`  SKIP (no suitable expiry): ${cand.ticker}`);
      continue;
    }

    // Infer underlying from ATM options if screener price seems wrong
    const expCalls = chain.filter(c => c.option_type === 'call' && c.expiry === expiry).sort((a, b) => a.strike - b.strike);
    const expPuts = chain.filter(c => c.option_type === 'put' && c.expiry === expiry).sort((a, b) => a.strike - b.strike);
    if (expCalls.length > 0 && expPuts.length > 0) {
      // ATM is where call mid ≈ put mid; approximate as midpoint of strikes where call < put flips
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
    console.log(`  ${cand.ticker}: underlying=$${cand.underlying.toFixed(2)}, expiry=${expiry}, IV rank=${(ivRank*100).toFixed(0)}%`);

    // Build iron condor
    const condor = buildCondor(chain, cand.underlying, expiry);
    if (!condor) {
      console.log(`  SKIP (can't build condor): ${cand.ticker}`);
      continue;
    }

    // Position sizing: how many condors fit within max risk
    const contracts = Math.max(1, Math.floor(PARAMS.maxRiskPerTrade / condor.maxRisk));
    const totalRisk = condor.maxRisk * contracts;
    const maxCredit = condor.credit * 100 * contracts;

    const position = {
      ticker: cand.ticker,
      earningsDate: cand.earningsDate,
      erTime: cand.erTime,
      underlying: cand.underlying,
      expiry: condor.expiry,
      shortCall: condor.shortCall,
      longCall: condor.longCall,
      shortPut: condor.shortPut,
      longPut: condor.longPut,
      credit: condor.credit,
      maxRisk: condor.maxRisk,
      contracts,
      totalRisk,
      maxCredit,
      ivRank,
      entryDate: today(),
      status: 'open',
    };

    state.openPositions.push(position);
    logTrade({ action: 'OPEN_CONDOR', ...position });
    entered++;

    sendSignal(`🐋⏳ THETA ENTRY: ${cand.ticker} Iron Condor\n` +
      `Sell ${condor.shortPut.strike}P / ${condor.shortCall.strike}C\n` +
      `Buy ${condor.longPut.strike}P / ${condor.longCall.strike}C\n` +
      `Expiry: ${condor.expiry} | ${contracts}x\n` +
      `Credit: $${(condor.credit * 100 * contracts).toFixed(0)} | Max Risk: $${totalRisk.toFixed(0)}\n` +
      `IV Rank: ${(ivRank * 100).toFixed(0)}% | ER: ${cand.earningsDate} (${cand.erTime || '?'})`);

    console.log(`  ENTRY CONDOR: ${cand.ticker} | ${condor.shortPut.strike}P/${condor.shortCall.strike}C | ` +
      `credit $${condor.credit.toFixed(2)} | ${contracts}x | risk $${totalRisk.toFixed(0)} | IV rank ${(ivRank * 100).toFixed(0)}%`);
  }

  saveState(state);
  console.log(`\n--- Theta Summary ---`);
  console.log(`Candidates: ${candidates.length} | New entries: ${entered} | Open: ${state.openPositions.length}/${PARAMS.maxOpenPositions}`);
  console.log(`Closed: ${state.stats.totalTrades} | Win rate: ${state.stats.totalTrades > 0 ? (state.stats.wins / state.stats.totalTrades * 100).toFixed(0) : 'N/A'}% | Realized: $${state.stats.totalPnl.toFixed(0)}`);
}

run().catch(e => console.error('Fatal:', e.message));
