#!/usr/bin/env node
// Riptide: credit spread fade strategy — sells put spreads against unusual flow alerts
// Inverse of Flow strategy: profits from IV crush by selling premium on high-IV puts
//
// Entry: sell bull put spread at alert strike, buy protection lower
// Exit: close after earnings, 50% profit take, or 2x credit stop loss

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_TOKEN = process.env.UW_API_TOKEN;
if (!API_TOKEN) { console.error('Missing UW_API_TOKEN env var'); process.exit(1); }
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'riptide-state.json');
const TRADES_FILE = path.join(DATA_DIR, 'riptide-trades.jsonl');

// ─── Strategy Parameters ───
const PARAMS = {
  // Entry filters (from flow alert)
  minPremium: 200000,
  minVolOiRatio: 5,
  maxDte: 45,
  minDte: 5,
  minOtmPct: 2,
  maxOtmPct: 15,
  requireEarnings: true,
  earningsWindowDays: 10,
  excludeIndexes: true,
  requireSingleLeg: true,
  minAskSidePct: 0.70,

  // Riptide-specific: only fade puts, skip sweeps, require high IV
  allowedTypes: ['put'],           // only fade puts (calls skipped entirely)
  skipSweeps: true,                // sweeps have real conviction — don't fade
  minEntryIv: 0.60,               // need ≥ 60% IV for enough premium to sell
  // No max IV — the higher the better for selling premium

  // Spread construction
  spreadWidthByStrike: [           // dynamic spread width
    { maxStrike: 50, width: 2.50 },
    { maxStrike: Infinity, width: 5.00 },
  ],

  // Position sizing
  accountSize: 100000,             // $100K account
  maxRiskPct: 0.05,               // 5% max risk per trade = $5,000
  maxOpenPositions: 5,

  // Exit rules
  profitTakePct: 50,               // close at 50% of max credit received
  stopLossMultiple: 2,             // close if spread cost hits 2x credit (100% loss)
  emergencyExitDte: 1,             // emergency exit at ≤ 1 DTE
  preExpiryExitDte: 3,             // exit early if ER is after expiry
};

const INDEX_TICKERS = new Set(['SPX', 'SPXW', 'SPY', 'QQQ', 'IWM', 'DIA', 'XSP', 'VIX', 'NDX', 'RUT']);

// ─── Signal Notifications ───
const SIGNAL_TARGET = process.env.SIGNAL_TARGET_UUID || '';

function sendSignal(message) {
  if (!SIGNAL_TARGET) { console.log('[Signal] No target UUID, skipping notification'); return; }
  try {
    const { execSync } = require('child_process');
    execSync(`openclaw message send --channel signal -t "${SIGNAL_TARGET}" -m ${JSON.stringify(message)}`, { timeout: 15000, stdio: 'pipe' });
    console.log('[Signal] Notification sent');
  } catch (e) {
    console.log('[Signal] Notification failed:', e.message);
  }
}

function formatEntry(pos) {
  return `🌊 RIPTIDE ENTRY: ${pos.ticker} ${pos.strike}P bull put spread\n` +
    `Sell ${pos.strike}P / Buy ${pos.protectionStrike}P ($${pos.spreadWidth.toFixed(2)} wide)\n` +
    `${pos.contracts}x | Credit: $${pos.creditPerContract.toFixed(2)} ($${pos.totalCredit.toFixed(0)} total)\n` +
    `Max risk: $${pos.maxRisk.toFixed(0)} | IV: ${(pos.entryIv * 100).toFixed(0)}%\n` +
    `ER: ${pos.earningsDate} (${pos.erTime || '?'})`;
}

function formatExit(pos) {
  const pnl = pos.pnl;
  const emoji = pnl >= 0 ? '✅' : '❌';
  return `🌊 RIPTIDE EXIT: ${pos.ticker} ${pos.strike}P spread ${emoji}\n` +
    `Credit $${pos.creditPerContract.toFixed(2)} → Cost $${pos.exitCostPerContract.toFixed(2)}\n` +
    `PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} | Held ${pos.holdDays}d\n` +
    `Reason: ${pos.exitReason}`;
}

// ─── Utilities ───
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const RATE_LIMIT_MS = 300;

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

function today() {
  return new Date().toISOString().slice(0, 10);
}

function isAfterExitWindow() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 600; // 10:00 ET
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
    stats: { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0, totalCreditCollected: 0 },
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

// ─── Option Price Fetching (UW API) ───
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
      iv: parseFloat(c.implied_volatility) || 0,
      volume: c.volume || 0,
      oi: c.open_interest || 0
    };
  } catch (e) {
    console.error(`  Price fetch failed for ${optionSymbol}: ${e.message}`);
    return null;
  }
}

// ─── Spread Width Calculation ───
function getSpreadWidth(strike) {
  for (const tier of PARAMS.spreadWidthByStrike) {
    if (strike <= tier.maxStrike) return tier.width;
  }
  return 5.00; // fallback
}

// ─── Build Protection Leg Symbol ───
// Option symbols: TICKER + YYMMDD + C/P + strike*1000 (8 digits)
// e.g., MDB260307P00405000
function buildOptionSymbol(ticker, expiry, type, strike) {
  const dateStr = expiry.replace(/-/g, '').slice(2); // YYMMDD
  const typeChar = type === 'put' ? 'P' : 'C';
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0');
  return `${ticker}${dateStr}${typeChar}${strikeStr}`;
}

// ─── Alert Filtering (shared with Flow, plus Riptide-specific rules) ───
function filterAlert(alert) {
  const premium = parseFloat(alert.total_premium || 0);
  if (premium < PARAMS.minPremium) return { pass: false };

  const volOi = parseFloat(alert.volume_oi_ratio || 0);
  if (volOi < PARAMS.minVolOiRatio) return { pass: false };

  if (PARAMS.excludeIndexes && INDEX_TICKERS.has(alert.ticker)) return { pass: false };

  // Riptide: only fade puts
  if (!PARAMS.allowedTypes.includes(alert.type)) return { pass: false };

  // Riptide: skip sweeps
  if (PARAMS.skipSweeps && alert.has_sweep) return { pass: false };

  if (alert.expiry) {
    const d = dte(alert.expiry);
    if (d < PARAMS.minDte || d > PARAMS.maxDte) return { pass: false };
  } else return { pass: false };

  const strike = parseFloat(alert.strike || 0);
  const underlying = parseFloat(alert.underlying_price || 0);
  if (strike && underlying) {
    const otmPct = ((underlying - strike) / underlying) * 100; // put OTM
    if (otmPct < PARAMS.minOtmPct || otmPct > PARAMS.maxOtmPct) return { pass: false };
  } else return { pass: false };

  if (PARAMS.requireEarnings) {
    if (!alert.next_earnings_date) return { pass: false };
    const erDate = alert.next_earnings_date;
    const erTime = (alert.er_time || '').toLowerCase();
    const todayStr = today();
    const bdays = tradingDaysBetween(new Date(), new Date(erDate));

    if (bdays < 0) return { pass: false };
    if (erDate === todayStr && (erTime === 'bmo' || erTime === 'before' || erTime === 'premarket')) return { pass: false };
    if (erDate < todayStr && bdays === 0) return { pass: false };
    if (bdays > PARAMS.earningsWindowDays) return { pass: false };
  }

  if (PARAMS.requireSingleLeg && alert.has_multileg) return { pass: false };

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
      erTime: alert.er_time,
      optionChain: alert.option_chain,
      alertId: alert.id,
      alertTime: alert.created_at,
      bid: alert.bid,
      ask: alert.ask,
      otmPct: ((underlying - strike) / underlying * 100).toFixed(1)
    }
  };
}

// ─── Exit Logic ───
function shouldExit(position, currentSpreadCost) {
  const todayStr = today();
  const d = dte(position.expiry);

  if (!isAfterExitWindow()) return { exit: false };

  // 1. Profit take: spread cost dropped to ≤ 50% of original credit
  //    (we keep the remaining premium)
  if (currentSpreadCost !== null && currentSpreadCost !== undefined) {
    const profitPct = ((position.creditPerContract - currentSpreadCost) / position.creditPerContract) * 100;
    if (profitPct >= PARAMS.profitTakePct) {
      return { exit: true, reason: `profit_take (${profitPct.toFixed(0)}% of credit captured)` };
    }

    // 2. Stop loss: spread cost >= 2x credit (100% loss on premium)
    if (currentSpreadCost >= position.creditPerContract * PARAMS.stopLossMultiple) {
      return { exit: true, reason: `stop_loss (spread cost $${currentSpreadCost.toFixed(2)} ≥ ${PARAMS.stopLossMultiple}x credit $${position.creditPerContract.toFixed(2)})` };
    }
  }

  // 3. Emergency exit: DTE ≤ 1
  if (d <= PARAMS.emergencyExitDte) {
    return { exit: true, reason: `emergency_dte (${d} DTE remaining)` };
  }

  // 4. Pre-expiry exit: if earnings are AFTER option expiry
  if (position.earningsDate && position.expiry) {
    if (position.earningsDate > position.expiry && d <= PARAMS.preExpiryExitDte) {
      return { exit: true, reason: `pre_expiry (ER ${position.earningsDate} after expiry ${position.expiry}, ${d} DTE)` };
    }
  }

  // 5. Earnings-based exit
  if (position.earningsDate) {
    const erDate = position.earningsDate;
    const erTime = position.erTime;

    if (erTime === 'bmo' || erTime === 'before' || erTime === 'premarket') {
      if (todayStr >= erDate) {
        return { exit: true, reason: `earnings_bmo (ER ${erDate} pre-market)` };
      }
    } else if (erTime === 'amc' || erTime === 'after' || erTime === 'postmarket') {
      const erDateObj = new Date(erDate + 'T00:00:00');
      const nextDay = new Date(erDateObj);
      nextDay.setDate(nextDay.getDate() + 1);
      while (nextDay.getDay() === 0 || nextDay.getDay() === 6) nextDay.setDate(nextDay.getDate() + 1);
      if (todayStr >= nextDay.toISOString().slice(0, 10)) {
        return { exit: true, reason: `earnings_amc (ER ${erDate} after-close)` };
      }
    } else {
      const erDateObj = new Date(erDate + 'T00:00:00');
      const nextDay = new Date(erDateObj);
      nextDay.setDate(nextDay.getDate() + 1);
      while (nextDay.getDay() === 0 || nextDay.getDay() === 6) nextDay.setDate(nextDay.getDate() + 1);
      if (todayStr >= nextDay.toISOString().slice(0, 10)) {
        return { exit: true, reason: `earnings_unknown (ER ${erDate})` };
      }
    }
  }

  return { exit: false };
}

// ─── Main Logic ───
async function run() {
  console.log('\n=== 🌊 Riptide Strategy ===');
  const state = loadState();
  const seenIds = new Set(state.seenAlertIds);
  const output = { newSignals: [], exits: [], positions: [], summary: '' };

  // ── Step 1: Check exits on open positions ──
  for (let i = state.openPositions.length - 1; i >= 0; i--) {
    const pos = state.openPositions[i];

    // Fetch current prices for both legs to get spread cost
    await sleep(RATE_LIMIT_MS);
    const shortQuote = await getOptionPrice(pos.ticker, pos.optionChain);
    await sleep(RATE_LIMIT_MS);
    const longQuote = await getOptionPrice(pos.ticker, pos.protectionSymbol);

    // Spread cost to close = buy back short (ask) - sell long (bid)
    const shortAsk = shortQuote?.ask > 0 ? shortQuote.ask : (shortQuote?.price || pos.creditPerContract);
    const longBid = longQuote?.bid > 0 ? longQuote.bid : 0;
    const currentSpreadCost = shortAsk - longBid;

    const exitCheck = shouldExit(pos, currentSpreadCost);

    if (exitCheck.exit) {
      const exitCostPerContract = Math.max(0, currentSpreadCost);
      const pnlPerContract = pos.creditPerContract - exitCostPerContract;
      const totalPnl = pnlPerContract * pos.contracts * 100;

      const closedPos = {
        ...pos,
        exitDate: today(),
        exitTime: new Date().toISOString(),
        exitCostPerContract,
        pnl: totalPnl,
        pnlPct: pos.totalCredit > 0 ? (totalPnl / pos.totalCredit * 100) : 0,
        exitReason: exitCheck.reason,
        holdDays: Math.round((new Date() - new Date(pos.entryDate)) / 86400000)
      };

      state.closedPositions.push(closedPos);
      state.openPositions.splice(i, 1);
      state.stats.totalTrades++;
      state.stats.totalPnl += totalPnl;
      if (totalPnl > 0) state.stats.wins++; else state.stats.losses++;

      logTrade({ action: 'CLOSE', ...closedPos });
      output.exits.push(closedPos);
      sendSignal(formatExit(closedPos));
      console.log(`  EXIT: ${pos.ticker} ${pos.strike}P spread | ${exitCheck.reason} | PnL: $${totalPnl.toFixed(0)}`);
    } else {
      // Mark-to-market
      pos.currentSpreadCost = currentSpreadCost;
      pos.unrealizedPnl = (pos.creditPerContract - currentSpreadCost) * pos.contracts * 100;
    }
  }

  // ── Step 2: Scan for new signals ──
  const todayFile = `flow-${today()}.jsonl`;
  const filePath = path.join(DATA_DIR, todayFile);
  if (!fs.existsSync(filePath)) {
    console.log('  No flow file for today');
  } else {
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    let scanned = 0, passed = 0;

    for (const line of lines) {
      if (!line) continue;
      try {
        const alert = JSON.parse(line);
        scanned++;
        if (seenIds.has(`riptide-${alert.id}`)) continue;
        seenIds.add(`riptide-${alert.id}`);

        const result = filterAlert(alert);
        if (!result.pass) continue;

        passed++;
        const sig = result.meta;

        // Check duplicates
        const dupe = state.openPositions.find(p =>
          p.ticker === sig.ticker && p.strike === sig.strike && p.expiry === sig.expiry
        );
        if (dupe) {
          console.log(`  SKIP (duplicate): PUT ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        }

        if (state.openPositions.length >= PARAMS.maxOpenPositions) {
          console.log(`  SKIP (max positions): PUT ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        }

        // Fetch price for the short leg (the alert's option)
        await sleep(RATE_LIMIT_MS);
        const shortQuote = await getOptionPrice(sig.ticker, sig.optionChain);
        if (!shortQuote || shortQuote.price <= 0) {
          console.log(`  SKIP (no price): PUT ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        }

        // IV filter: require IV data, minimum 60%, no ceiling
        if (!shortQuote.iv || shortQuote.iv === 0) {
          console.log(`  SKIP (no IV data): PUT ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        }
        if (shortQuote.iv < PARAMS.minEntryIv) {
          console.log(`  SKIP (IV too low: ${(shortQuote.iv * 100).toFixed(0)}% < ${(PARAMS.minEntryIv * 100).toFixed(0)}%): PUT ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        }

        // Calculate spread
        const spreadWidth = getSpreadWidth(sig.strike);
        const protectionStrike = sig.strike - spreadWidth;
        const protectionSymbol = buildOptionSymbol(sig.ticker, sig.expiry, 'put', protectionStrike);

        // Fetch protection leg price
        await sleep(RATE_LIMIT_MS);
        const longQuote = await getOptionPrice(sig.ticker, protectionSymbol);
        if (!longQuote) {
          console.log(`  SKIP (no protection leg price): PUT ${sig.ticker} ${protectionStrike} ${sig.expiry}`);
          continue;
        }

        // Credit = sell short bid - buy long ask (worst-case fill)
        const shortBid = shortQuote.bid > 0 ? shortQuote.bid : shortQuote.price * 0.95;
        const longAsk = longQuote.ask > 0 ? longQuote.ask : longQuote.price * 1.05;
        const creditPerContract = shortBid - longAsk;

        if (creditPerContract <= 0.05) {
          console.log(`  SKIP (credit too small: $${creditPerContract.toFixed(2)}): PUT ${sig.ticker} ${sig.strike}/${protectionStrike} ${sig.expiry}`);
          continue;
        }

        // Position sizing: max risk per contract = spread width - credit
        const maxRiskPerContract = (spreadWidth - creditPerContract) * 100;
        const maxRiskAllowed = PARAMS.accountSize * PARAMS.maxRiskPct;
        const contracts = Math.max(1, Math.floor(maxRiskAllowed / maxRiskPerContract));
        const totalCredit = creditPerContract * contracts * 100;
        const maxRisk = maxRiskPerContract * contracts;

        const position = {
          ...sig,
          // Spread details
          spreadWidth,
          protectionStrike,
          protectionSymbol,
          creditPerContract,
          totalCredit,
          maxRisk,
          contracts,
          // Entry metadata
          entryDate: today(),
          entryTime: sig.alertTime || new Date().toISOString(),
          entryIv: shortQuote.iv,
          shortBid,
          shortAsk: shortQuote.ask,
          longBid: longQuote.bid,
          longAsk,
          status: 'open'
        };

        state.openPositions.push(position);
        state.stats.totalCreditCollected += totalCredit;
        logTrade({ action: 'OPEN', ...position });
        output.newSignals.push(position);
        sendSignal(formatEntry(position));

        console.log(`  ENTRY: PUT ${sig.ticker} ${sig.strike}/${protectionStrike} ${sig.expiry} | ${contracts}x | credit $${creditPerContract.toFixed(2)} ($${totalCredit.toFixed(0)}) | max risk $${maxRisk.toFixed(0)} | IV: ${(shortQuote.iv * 100).toFixed(0)}% | ER: ${sig.earningsDate}`);
      } catch (e) {
        console.error(`  Error processing alert: ${e.message}`);
      }
    }

    console.log(`  Scanned: ${scanned} alerts, ${passed} passed filters`);
  }

  // ── Step 3: Mark-to-market open positions ──
  if (state.openPositions.length > 0) {
    console.log('\n--- Riptide Open Positions ---');
    let totalCredit = 0, totalUnrealized = 0;
    for (const pos of state.openPositions) {
      if (pos.currentSpreadCost === undefined) {
        await sleep(RATE_LIMIT_MS);
        const sq = await getOptionPrice(pos.ticker, pos.optionChain);
        await sleep(RATE_LIMIT_MS);
        const lq = await getOptionPrice(pos.ticker, pos.protectionSymbol);
        const sa = sq?.ask > 0 ? sq.ask : pos.creditPerContract;
        const lb = lq?.bid > 0 ? lq.bid : 0;
        pos.currentSpreadCost = sa - lb;
        pos.unrealizedPnl = (pos.creditPerContract - pos.currentSpreadCost) * pos.contracts * 100;
      }
      totalCredit += pos.totalCredit;
      totalUnrealized += pos.unrealizedPnl;

      const daysHeld = Math.round((new Date() - new Date(pos.entryDate)) / 86400000);
      const daysToEr = pos.earningsDate ? tradingDaysBetween(new Date(), new Date(pos.earningsDate)) : '?';
      console.log(`  ${pos.ticker} ${pos.strike}P/${pos.protectionStrike}P | ${pos.contracts}x | credit $${pos.creditPerContract.toFixed(2)} | cost $${pos.currentSpreadCost.toFixed(2)} | PnL: $${pos.unrealizedPnl.toFixed(0)} | ${daysHeld}d held | ER in ${daysToEr} tdays`);
    }
    console.log(`  TOTAL: $${totalCredit.toFixed(0)} credit collected | unrealized: $${totalUnrealized.toFixed(0)}`);
  }

  // ── Step 4: Save state ──
  state.seenAlertIds = [...seenIds].slice(-10000);
  saveState(state);

  const s = state.stats;
  const winRate = s.totalTrades > 0 ? (s.wins / s.totalTrades * 100).toFixed(1) : 'N/A';
  console.log(`\n--- Riptide Summary ---`);
  console.log(`Open: ${state.openPositions.length}/${PARAMS.maxOpenPositions} | Closed: ${s.totalTrades} (${winRate}% WR, ${s.wins}W/${s.losses}L) | Realized PnL: $${s.totalPnl.toFixed(0)}`);

  output.summary = `Riptide: ${state.openPositions.length} open, ${s.totalTrades} closed (${winRate}% WR), $${s.totalPnl.toFixed(0)} realized`;
  return output;
}

run().catch(e => console.error('Riptide fatal:', e.message));
