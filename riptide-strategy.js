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
  minPremium: 100000,
  minVolOiRatio: 3,
  maxDte: 90,
  minDte: 5,
  minOtmPct: 0,
  maxOtmPct: 15,
  requireEarnings: false,
  earningsWindowDays: 10,
  excludeIndexes: true,
  requireSingleLeg: true,
  minAskSidePct: 0.70,

  // Riptide-specific: only fade puts, skip sweeps, require high IV
  allowedTypes: ['put', 'call'],    // fade both puts and calls
  skipSweeps: false,               // allow sweeps — high IV = more premium, exit logic protects us
  minEntryIv: 0.60,               // need ≥ 60% IV for enough premium to sell
  // No max IV — the higher the better for selling premium
  minIvPctl: 0.70,                 // only sell premium when IV is historically elevated (70th+ pctl)

  // Spread construction
  minCreditWidthPct: 0.25,         // credit must be ≥ 25% of spread width (risk/reward gate)
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
  dteFloor: 7,                     // exit at ≤ 7 DTE — gamma risk ramps exponentially last week
  timeDecayStopPct: 50,            // exit if 50% of time elapsed and P&L is negative
  moneynessExitPct: 2,             // exit if underlying within 2% of short strike
  ivCrushExitPct: 30,              // exit if IV dropped ≥ 30% from entry (edge is gone)
  earningsProximityDays: 2,        // exit ≤ 2 trading days before ER if one exists
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
  const typeUpper = pos.type === 'put' ? 'P' : 'C';
  const spreadName = pos.type === 'put' ? 'bull put' : 'bear call';
  return `🌊 RIPTIDE ENTRY: ${pos.ticker} ${pos.strike}${typeUpper} ${spreadName} spread\n` +
    `Sell ${pos.strike}${typeUpper} / Buy ${pos.protectionStrike}${typeUpper} ($${pos.spreadWidth.toFixed(2)} wide)\n` +
    `${pos.contracts}x | Credit: $${pos.creditPerContract.toFixed(2)} ($${pos.totalCredit.toFixed(0)} total)\n` +
    `Max risk: $${pos.maxRisk.toFixed(0)} | IV: ${(pos.entryIv * 100).toFixed(0)}%\n` +
    `ER: ${pos.earningsDate} (${pos.erTime || '?'})`;
}

function formatExit(pos) {
  const pnl = pos.pnl;
  const emoji = pnl >= 0 ? '✅' : '❌';
  const typeUpper = pos.type === 'put' ? 'P' : 'C';
  return `🌊 RIPTIDE EXIT: ${pos.ticker} ${pos.strike}${typeUpper} spread ${emoji}\n` +
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

// ─── Underlying Price ───
async function getUnderlyingPrice(ticker) {
  try {
    await sleep(RATE_LIMIT_MS);
    const url = `https://api.unusualwhales.com/api/stock/${ticker}/quote`;
    const result = await fetchJson(url);
    const price = parseFloat(result?.data?.last || result?.data?.price || 0);
    return price > 0 ? price : null;
  } catch (e) {
    console.error(`  Underlying price fetch failed for ${ticker}: ${e.message}`);
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
    const otmPct = alert.type === 'put'
      ? ((underlying - strike) / underlying) * 100   // put OTM: strike below underlying
      : ((strike - underlying) / underlying) * 100;  // call OTM: strike above underlying
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
      otmPct: (alert.type === 'put'
        ? (underlying - strike) / underlying * 100
        : (strike - underlying) / underlying * 100).toFixed(1)
    }
  };
}

// ─── Exit Logic ───
// Priority: Moneyness → Stop loss → Profit target → IV crush → Time decay stop → Earnings proximity → DTE floor
function shouldExit(position, currentSpreadCost, currentIv, underlyingPrice) {
  if (!isAfterExitWindow()) return { exit: false };

  const d = dte(position.expiry);
  const entryDte = Math.round((new Date(position.expiry + 'T16:00:00') - new Date(position.entryDate + 'T16:00:00')) / 86400000);
  const timeElapsedPct = entryDte > 0 ? ((entryDte - d) / entryDte) * 100 : 100;
  const pnlPerContract = currentSpreadCost !== null ? position.creditPerContract - currentSpreadCost : null;
  const isLosing = pnlPerContract !== null && pnlPerContract < 0;

  // 1. Moneyness — underlying within 2% of short strike (thesis is broken)
  if (underlyingPrice && underlyingPrice > 0) {
    const distancePct = position.type === 'put'
      ? ((underlyingPrice - position.strike) / underlyingPrice) * 100   // put: underlying dropping toward strike
      : ((position.strike - underlyingPrice) / underlyingPrice) * 100;  // call: underlying rising toward strike
    if (distancePct <= PARAMS.moneynessExitPct) {
      return { exit: true, reason: `moneyness (underlying $${underlyingPrice.toFixed(2)} within ${distancePct.toFixed(1)}% of ${position.strike} strike)` };
    }
  }

  // 2. Stop loss — spread cost ≥ 2x credit
  if (currentSpreadCost !== null && currentSpreadCost !== undefined) {
    if (currentSpreadCost >= position.creditPerContract * PARAMS.stopLossMultiple) {
      return { exit: true, reason: `stop_loss (spread cost $${currentSpreadCost.toFixed(2)} ≥ ${PARAMS.stopLossMultiple}x credit $${position.creditPerContract.toFixed(2)})` };
    }
  }

  // 3. Profit target — captured ≥ 50% of credit
  if (currentSpreadCost !== null && currentSpreadCost !== undefined) {
    const profitPct = ((position.creditPerContract - currentSpreadCost) / position.creditPerContract) * 100;
    if (profitPct >= PARAMS.profitTakePct) {
      return { exit: true, reason: `profit_take (${profitPct.toFixed(0)}% of credit captured)` };
    }
  }

  // 4. IV crush — IV dropped ≥ 30% from entry (the edge is gone, take what we have)
  if (currentIv && position.entryIv && position.entryIv > 0) {
    const ivDropPct = ((position.entryIv - currentIv) / position.entryIv) * 100;
    if (ivDropPct >= PARAMS.ivCrushExitPct && !isLosing) {
      return { exit: true, reason: `iv_crush (IV ${(position.entryIv * 100).toFixed(0)}% → ${(currentIv * 100).toFixed(0)}%, dropped ${ivDropPct.toFixed(0)}%)` };
    }
  }

  // 5. Time decay stop — 50%+ of time elapsed and still losing
  if (timeElapsedPct >= PARAMS.timeDecayStopPct && isLosing) {
    return { exit: true, reason: `time_decay_stop (${timeElapsedPct.toFixed(0)}% of time elapsed, P&L $${(pnlPerContract * position.contracts * 100).toFixed(0)})` };
  }

  // 6. Earnings proximity — exit ≤ 2 trading days before ER
  if (position.earningsDate) {
    const erBdays = tradingDaysBetween(new Date(), new Date(position.earningsDate));
    if (erBdays >= 0 && erBdays <= PARAMS.earningsProximityDays) {
      return { exit: true, reason: `earnings_proximity (ER ${position.earningsDate} in ${erBdays} trading days)` };
    }
  }

  // 7. DTE floor — ≤ 7 DTE, gamma risk too high
  if (d <= PARAMS.dteFloor) {
    return { exit: true, reason: `dte_floor (${d} DTE remaining, floor is ${PARAMS.dteFloor})` };
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

    // Get current IV and underlying price for exit checks
    const currentIv = shortQuote?.iv || 0;
    const underlyingPrice = await getUnderlyingPrice(pos.ticker);

    const exitCheck = shouldExit(pos, currentSpreadCost, currentIv, underlyingPrice);

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
  const enrichmentCache = loadEnrichmentCache();
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
          console.log(`  SKIP (duplicate): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        }

        if (state.openPositions.length >= PARAMS.maxOpenPositions) {
          console.log(`  SKIP (max positions): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        }

        // Fetch price for the short leg (the alert's option)
        await sleep(RATE_LIMIT_MS);
        const shortQuote = await getOptionPrice(sig.ticker, sig.optionChain);
        if (!shortQuote || shortQuote.price <= 0) {
          console.log(`  SKIP (no price): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        }

        // IV filter: require IV data, minimum 60%, no ceiling
        if (!shortQuote.iv || shortQuote.iv === 0) {
          console.log(`  SKIP (no IV data): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        }
        if (shortQuote.iv < PARAMS.minEntryIv) {
          console.log(`  SKIP (IV too low: ${(shortQuote.iv * 100).toFixed(0)}% < ${(PARAMS.minEntryIv * 100).toFixed(0)}%): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        }

        // Enrichment check: IV percentile (historically elevated?)
        const enrichment = enrichmentCache[sig.ticker] || {};
        const ivPctl = enrichment._ivPctl || 0;
        if (PARAMS.minIvPctl > 0 && ivPctl > 0 && ivPctl < PARAMS.minIvPctl) {
          console.log(`  SKIP (IV pctl too low: ${(ivPctl * 100).toFixed(0)}% < ${(PARAMS.minIvPctl * 100).toFixed(0)}%): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        }

        // Calculate spread — puts: buy lower protection, calls: buy higher protection
        const spreadWidth = getSpreadWidth(sig.strike);
        const protectionStrike = sig.type === 'put'
          ? sig.strike - spreadWidth    // bull put spread: protection below
          : sig.strike + spreadWidth;   // bear call spread: protection above
        const protectionSymbol = buildOptionSymbol(sig.ticker, sig.expiry, sig.type, protectionStrike);

        // Fetch protection leg price
        await sleep(RATE_LIMIT_MS);
        const longQuote = await getOptionPrice(sig.ticker, protectionSymbol);
        if (!longQuote) {
          console.log(`  SKIP (no protection leg price): ${sig.type.toUpperCase()} ${sig.ticker} ${protectionStrike} ${sig.expiry}`);
          continue;
        }

        // Credit = sell short bid - buy long ask (worst-case fill)
        const shortBid = shortQuote.bid > 0 ? shortQuote.bid : shortQuote.price * 0.95;
        const longAsk = longQuote.ask > 0 ? longQuote.ask : longQuote.price * 1.05;
        const creditPerContract = shortBid - longAsk;

        if (creditPerContract <= 0.05) {
          console.log(`  SKIP (credit too small: $${creditPerContract.toFixed(2)}): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike}/${protectionStrike} ${sig.expiry}`);
          continue;
        }

        // Credit-to-width ratio gate — reject thin premium trades
        const creditWidthPct = creditPerContract / spreadWidth;
        if (creditWidthPct < PARAMS.minCreditWidthPct) {
          console.log(`  SKIP (credit/width ${(creditWidthPct*100).toFixed(0)}% < ${(PARAMS.minCreditWidthPct*100).toFixed(0)}%: $${creditPerContract.toFixed(2)}/$${spreadWidth.toFixed(2)}): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike}/${protectionStrike} ${sig.expiry}`);
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
          status: 'open',
          // Enrichment data
          ivPctl: ivPctl || null,
          dpPrintCount: enrichment._dpPrintCount || null,
          dpRecentNotional: enrichment._dpRecentNotional || null,
          dpAvgPrintSize: enrichment._dpAvgPrintSize || null,
        };

        state.openPositions.push(position);
        state.stats.totalCreditCollected += totalCredit;
        logTrade({ action: 'OPEN', ...position });
        output.newSignals.push(position);
        sendSignal(formatEntry(position));

        const pctlStr = ivPctl > 0 ? ` | IVpctl: ${(ivPctl * 100).toFixed(0)}%` : '';
        const dpStr = enrichment._dpRecentNotional ? ` | DP: $${(enrichment._dpRecentNotional / 1e6).toFixed(1)}M` : '';
        console.log(`  ENTRY: ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike}/${protectionStrike} ${sig.expiry} | ${contracts}x | credit $${creditPerContract.toFixed(2)} ($${totalCredit.toFixed(0)}) | max risk $${maxRisk.toFixed(0)} | IV: ${(shortQuote.iv * 100).toFixed(0)}%${pctlStr}${dpStr}`);
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
