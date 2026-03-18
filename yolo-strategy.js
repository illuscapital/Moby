#!/usr/bin/env node
// Yolo: go WITH the unusual flow — buy the same option the whales are buying
// Naked long options, fixed $5K per trade, time-based theta guard
//
// Entry: buy same option as UW alert (put flow → buy put, call flow → buy call)
// Exit: 200% gain, 50% loss, or 2/3 time elapsed (theta guard)

const https = require('https');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const API_TOKEN = process.env.UW_API_TOKEN;
if (!API_TOKEN) { console.error('Missing UW_API_TOKEN env var'); process.exit(1); }
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'yolo-state.json');
const TRADES_FILE = path.join(DATA_DIR, 'yolo-trades.jsonl');

// ─── Strategy Parameters ───
const PARAMS = {
  // Entry filters (mirrors Flow, except earnings logic is inverted)
  minPremium: 100000,
  maxPremium: 5000000,
  minVolOiRatio: 0,
  maxVolOiRatio: 50,
  maxDte: 90,
  minDte: 15,
  minOtmPct: 0,
  maxOtmPct: 20,
  minOptionPrice: 0,
  maxOptionPrice: 3.00,           // per-share option price ($0-$3)
  excludeIndexes: true,
  requireSingleLeg: true,
  minAskSidePct: 0.70,
  allowedTypes: ['put', 'call'],
  skipSweeps: false,
  minEntryIv: 0,
  maxEntryIv: 0.70,
  earningsExclusionDays: 14,      // ENTER only if no earnings OR earnings >= 14 trading days away

  // Position sizing
  maxCostPerTrade: 500,           // $500 per trade
  maxOpenPositions: 50,
  maxEntryDelta: 0.10,            // skip if our ask is > $0.10 above alert ask

  // Dark pool confirmation — boost position size when DP confirms direction
  dpConfirmMinPrints: 50,
  dpConfirmMinNotional: 1000000,
  dpConfirmSizeMultiplier: 1.5,

  // Exit rules
  profitTargetPct: 200,           // exit at 200% gain (option worth 3x entry)
  stopLossPct: 50,                // exit at 50% loss (option worth 0.5x entry)
  thetaGuardFraction: 2 / 3,     // exit after 2/3 of calendar days elapsed
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
  const deltaStr = pos.priceDelta !== null
    ? `\nΔ from alert: ${pos.priceDelta >= 0 ? '+' : ''}$${pos.priceDelta.toFixed(2)} (${pos.priceDeltaPct >= 0 ? '+' : ''}${pos.priceDeltaPct.toFixed(1)}%) | ${pos.alertDelaySec}s delay`
    : '';
  return `🎲 YOLO ENTRY: ${pos.ticker} ${pos.strike}${typeUpper} ${pos.expiry}\n` +
    `${pos.contracts}x @ $${pos.entryPrice.toFixed(2)} ($${pos.totalCost.toFixed(0)} total)\n` +
    `IV: ${(pos.entryIv * 100).toFixed(0)}% | OTM: ${pos.otmPct}%\n` +
    `Targets: no cap (trail 15% from peak) / -10% ($${(pos.entryPrice * 0.90).toFixed(2)})\n` +
    `Theta guard: exit by ${pos.thetaExitDate}${deltaStr}`;
}

function formatExit(pos) {
  const pnl = pos.pnl;
  const emoji = pnl >= 0 ? '✅' : '❌';
  const typeUpper = pos.type === 'put' ? 'P' : 'C';
  const pnlPctStr = pos.pnlPct >= 0 ? `+${pos.pnlPct.toFixed(0)}` : pos.pnlPct.toFixed(0);
  return `🎲 YOLO EXIT: ${pos.ticker} ${pos.strike}${typeUpper} ${emoji}\n` +
    `Entry $${pos.entryPrice.toFixed(2)} → Exit $${pos.exitPrice.toFixed(2)} (${pnlPctStr}%)\n` +
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

function addCalendarDays(dateStr, days) {
  const d = new Date(dateStr + 'T16:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
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

// ─── Alert Filtering ───
function filterAlert(alert) {
  const premium = parseFloat(alert.total_premium || 0);
  if (premium < PARAMS.minPremium || premium > PARAMS.maxPremium) return { pass: false };

  const volOi = parseFloat(alert.volume_oi_ratio || 0);
  if (volOi < PARAMS.minVolOiRatio || volOi > PARAMS.maxVolOiRatio) return { pass: false };

  // Option price filter (per-share ask price from alert)
  const optionAsk = parseFloat(alert.ask || 0);
  if (optionAsk > 0 && (optionAsk < PARAMS.minOptionPrice || optionAsk > PARAMS.maxOptionPrice)) return { pass: false };

  if (PARAMS.excludeIndexes && INDEX_TICKERS.has(alert.ticker)) return { pass: false };

  if (!PARAMS.allowedTypes.includes(alert.type)) return { pass: false };

  if (PARAMS.skipSweeps && alert.has_sweep) return { pass: false };

  if (alert.expiry) {
    const d = dte(alert.expiry);
    if (d < PARAMS.minDte || d > PARAMS.maxDte) return { pass: false };
  } else return { pass: false };

  const strike = parseFloat(alert.strike || 0);
  const underlying = parseFloat(alert.underlying_price || 0);
  if (strike && underlying) {
    const otmPct = alert.type === 'put'
      ? ((underlying - strike) / underlying) * 100
      : ((strike - underlying) / underlying) * 100;
    if (otmPct < PARAMS.minOtmPct || otmPct > PARAMS.maxOtmPct) return { pass: false };
  } else return { pass: false };

  // Earnings: only enter if NO earnings date OR earnings >= 14 trading days away
  if (alert.next_earnings_date && PARAMS.earningsExclusionDays > 0) {
    const erBdays = tradingDaysBetween(new Date(), new Date(alert.next_earnings_date));
    if (erBdays >= 0 && erBdays < PARAMS.earningsExclusionDays) {
      return { pass: false };
    }
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
function shouldExit(position, currentPrice) {
  if (!isAfterExitWindow()) return { exit: false };

  const entryPrice = position.entryPrice;
  const pnlPct = (currentPrice - entryPrice) / entryPrice * 100;

  // Track high-water mark for trailing stop
  if (!position.peakPrice || currentPrice > position.peakPrice) {
    position.peakPrice = currentPrice;
  }

  // 1. Trailing stop — exit if price drops 15% from peak (only when in profit)
  //    No hard profit cap — let winners run, trailing stop locks in gains.
  if (position.peakPrice && position.peakPrice > entryPrice) {
    const dropFromPeak = (position.peakPrice - currentPrice) / position.peakPrice * 100;
    if (dropFromPeak >= 15) {
      const peakGainPct = ((position.peakPrice - entryPrice) / entryPrice * 100).toFixed(0);
      return { exit: true, reason: `trailing_stop (peak $${position.peakPrice.toFixed(2)} +${peakGainPct}% → now $${currentPrice.toFixed(2)} ${pnlPct.toFixed(0)}%, dropped ${dropFromPeak.toFixed(0)}% from peak)` };
    }
  }

  // 3. Stop loss — 10% loss
  if (currentPrice <= entryPrice * 0.90) {
    const lossPct = pnlPct.toFixed(0);
    return { exit: true, reason: `stop_loss (${lossPct}%, $${entryPrice.toFixed(2)} → $${currentPrice.toFixed(2)})` };
  }

  // 4. Theta guard — exit after 2/3 of calendar days elapsed
  const todayStr = today();
  if (todayStr >= position.thetaExitDate) {
    return { exit: true, reason: `theta_guard (${pnlPct.toFixed(0)}% P&L, exit date ${position.thetaExitDate} reached)` };
  }

  return { exit: false };
}

// ─── Main Logic ───
async function run() {
  console.log('\n=== 🎲 Yolo Strategy ===');
  const state = loadState();
  const seenIds = new Set(state.seenAlertIds);
  const output = { newSignals: [], exits: [], positions: [], summary: '' };

  // ── Step 1: Check exits on open positions ──
  for (let i = state.openPositions.length - 1; i >= 0; i--) {
    const pos = state.openPositions[i];

    await sleep(RATE_LIMIT_MS);
    const quote = await getOptionPrice(pos.ticker, pos.optionChain);

    // Use mid price for exit valuation, fallback to bid (conservative)
    const currentPrice = quote?.mid > 0 ? quote.mid : (quote?.bid > 0 ? quote.bid : null);

    if (currentPrice === null) {
      console.log(`  SKIP exit check (no price): ${pos.ticker} ${pos.optionChain}`);
      // Still update mark-to-market with last known
      continue;
    }

    const exitCheck = shouldExit(pos, currentPrice);

    if (exitCheck.exit) {
      // Use bid for actual exit price (realistic fill)
      const exitPrice = quote?.bid > 0 ? quote.bid : currentPrice;
      const pnlPerContract = (exitPrice - pos.entryPrice) * 100;
      const totalPnl = pnlPerContract * pos.contracts;

      const closedPos = {
        ...pos,
        exitDate: today(),
        exitTime: new Date().toISOString(),
        exitPrice,
        pnl: totalPnl,
        pnlPct: (exitPrice - pos.entryPrice) / pos.entryPrice * 100,
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
      console.log(`  EXIT: ${pos.ticker} ${pos.strike}${pos.type === 'put' ? 'P' : 'C'} | ${exitCheck.reason} | PnL: $${totalPnl.toFixed(0)}`);
    } else {
      // Mark-to-market
      pos.currentPrice = currentPrice;
      pos.unrealizedPnl = (currentPrice - pos.entryPrice) * pos.contracts * 100;
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
        if (seenIds.has(`yolo-${alert.id}`)) continue;
        seenIds.add(`yolo-${alert.id}`);

        const result = filterAlert(alert);
        if (!result.pass) continue;

        passed++;
        const sig = result.meta;

        // Check duplicates (same ticker/strike/expiry already open)
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

        // Fetch current price for the option
        await sleep(RATE_LIMIT_MS);
        const quote = await getOptionPrice(sig.ticker, sig.optionChain);
        if (!quote || (quote.ask <= 0 && quote.price <= 0)) {
          console.log(`  SKIP (no price): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        }

        // IV filter
        if (PARAMS.minEntryIv > 0 && (!quote.iv || quote.iv < PARAMS.minEntryIv)) {
          console.log(`  SKIP (IV too low: ${quote.iv ? (quote.iv * 100).toFixed(0) + '%' : 'N/A'}): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        }
        if (PARAMS.maxEntryIv > 0 && quote.iv && quote.iv > PARAMS.maxEntryIv) {
          console.log(`  SKIP (IV too high: ${(quote.iv * 100).toFixed(0)}% > ${(PARAMS.maxEntryIv * 100).toFixed(0)}%): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        }

        const enrichment = enrichmentCache[sig.ticker] || {};
        const ivPctl = enrichment._ivPctl || 0;

        // Buy at the ask (worst-case entry)
        const entryPrice = quote.ask > 0 ? quote.ask : quote.price;
        const costPerContract = entryPrice * 100;

        if (costPerContract <= 0) {
          console.log(`  SKIP (zero cost): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
          continue;
        }

        // ── Price delta tracking ──
        // Compare our entry price to the alert-time ask (what the whale paid)
        const alertAsk = parseFloat(sig.ask) || 0;
        const alertBid = parseFloat(sig.bid) || 0;
        const alertMid = alertBid > 0 && alertAsk > 0 ? (alertBid + alertAsk) / 2 : alertAsk;
        const priceDelta = alertAsk > 0 ? entryPrice - alertAsk : null;
        const priceDeltaPct = alertAsk > 0 ? ((entryPrice - alertAsk) / alertAsk * 100) : null;
        const alertDelayMs = sig.alertTime ? (Date.now() - new Date(sig.alertTime).getTime()) : null;
        const alertDelaySec = alertDelayMs !== null ? Math.round(alertDelayMs / 1000) : null;

        if (priceDelta !== null) {
          console.log(`  DELTA: alert ask $${alertAsk.toFixed(2)} → our ask $${entryPrice.toFixed(2)} | Δ $${priceDelta.toFixed(2)} (${priceDeltaPct.toFixed(1)}%) | ${alertDelaySec}s delay`);
          if (priceDelta > PARAMS.maxEntryDelta) {
            console.log(`  SKIP (delta $${priceDelta.toFixed(2)} > max $${PARAMS.maxEntryDelta.toFixed(2)}): ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry}`);
            continue;
          }
        }

        // Dark pool confirmation check
        const dpPrintCount = enrichment._dpPrintCount || 0;
        const dpNotional = enrichment._dpRecentNotional || 0;
        const dpConfirmed = dpPrintCount >= PARAMS.dpConfirmMinPrints && dpNotional >= PARAMS.dpConfirmMinNotional;
        const effectiveSize = dpConfirmed ? PARAMS.maxCostPerTrade * PARAMS.dpConfirmSizeMultiplier : PARAMS.maxCostPerTrade;

        // Position sizing
        const contracts = Math.max(1, Math.floor(effectiveSize / costPerContract));
        const totalCost = contracts * costPerContract;

        // Calculate theta guard exit date: entry + 2/3 of days to expiry
        const daysToExpiry = dte(sig.expiry);
        const maxHoldDays = Math.floor(daysToExpiry * PARAMS.thetaGuardFraction);
        const thetaExitDate = addCalendarDays(today(), maxHoldDays);

        const position = {
          ...sig,
          entryPrice,
          costPerContract,
          totalCost,
          contracts,
          entryDate: today(),
          entryTime: sig.alertTime || new Date().toISOString(),
          entryIv: quote.iv,
          thetaExitDate,
          maxHoldDays,
          status: 'open',
          ivPctl: ivPctl || null,
          dpPrintCount: enrichment._dpPrintCount || null,
          dpRecentNotional: enrichment._dpRecentNotional || null,
          dpAvgPrintSize: enrichment._dpAvgPrintSize || null,
          // Price delta tracking
          alertAsk,
          alertBid,
          alertMid,
          priceDelta,
          priceDeltaPct,
          alertDelaySec,
        };

        state.openPositions.push(position);
        state.stats.totalInvested += totalCost;
        logTrade({ action: 'OPEN', ...position });
        output.newSignals.push(position);
        sendSignal(formatEntry(position));

        const pctlStr = ivPctl > 0 ? ` | IVpctl: ${(ivPctl * 100).toFixed(0)}%` : '';
        console.log(`  ENTRY: ${sig.type.toUpperCase()} ${sig.ticker} ${sig.strike} ${sig.expiry} | ${contracts}x @ $${entryPrice.toFixed(2)} ($${totalCost.toFixed(0)}) | IV: ${(quote.iv * 100).toFixed(0)}%${pctlStr} | theta exit: ${thetaExitDate}`);
      } catch (e) {
        console.error(`  Error processing alert: ${e.message}`);
      }
    }

    console.log(`  Scanned: ${scanned} alerts, ${passed} passed filters`);
  }

  // ── Step 3: Mark-to-market open positions ──
  if (state.openPositions.length > 0) {
    console.log('\n--- Yolo Open Positions ---');
    let totalCost = 0, totalUnrealized = 0;
    for (const pos of state.openPositions) {
      if (pos.currentPrice === undefined) {
        await sleep(RATE_LIMIT_MS);
        const q = await getOptionPrice(pos.ticker, pos.optionChain);
        pos.currentPrice = q?.mid > 0 ? q.mid : (q?.bid > 0 ? q.bid : pos.entryPrice);
        pos.unrealizedPnl = (pos.currentPrice - pos.entryPrice) * pos.contracts * 100;
      }
      totalCost += pos.totalCost;
      totalUnrealized += pos.unrealizedPnl;

      const daysHeld = Math.round((new Date() - new Date(pos.entryDate)) / 86400000);
      const typeChar = pos.type === 'put' ? 'P' : 'C';
      const pnlPct = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(0);
      console.log(`  ${pos.ticker} ${pos.strike}${typeChar} ${pos.expiry} | ${pos.contracts}x @ $${pos.entryPrice.toFixed(2)} → $${pos.currentPrice.toFixed(2)} (${pnlPct}%) | $${pos.unrealizedPnl.toFixed(0)} | ${daysHeld}d held | theta exit: ${pos.thetaExitDate}`);
    }
    console.log(`  TOTAL: $${totalCost.toFixed(0)} invested | unrealized: $${totalUnrealized.toFixed(0)}`);
  }

  // ── Step 4: Save state ──
  state.seenAlertIds = [...seenIds].slice(-10000);
  saveState(state);

  // ── Delta Stats ──
  const allPositions = [...state.openPositions, ...state.closedPositions];
  const deltas = allPositions.filter(p => p.priceDelta !== null && p.priceDelta !== undefined);
  if (deltas.length > 0) {
    const avgDelta = deltas.reduce((s, p) => s + p.priceDelta, 0) / deltas.length;
    const avgDeltaPct = deltas.reduce((s, p) => s + (p.priceDeltaPct || 0), 0) / deltas.length;
    const avgDelay = deltas.reduce((s, p) => s + (p.alertDelaySec || 0), 0) / deltas.length;
    const totalSlippage = deltas.reduce((s, p) => s + (p.priceDelta * p.contracts * 100), 0);
    console.log(`\n--- Yolo Price Delta ---`);
    console.log(`Avg Δ: ${avgDelta >= 0 ? '+' : ''}$${avgDelta.toFixed(2)} (${avgDeltaPct >= 0 ? '+' : ''}${avgDeltaPct.toFixed(1)}%) | Avg delay: ${avgDelay.toFixed(0)}s | Total slippage: $${totalSlippage.toFixed(0)} | Samples: ${deltas.length}`);
  }

  const s = state.stats;
  const winRate = s.totalTrades > 0 ? (s.wins / s.totalTrades * 100).toFixed(1) : 'N/A';
  console.log(`\n--- Yolo Summary ---`);
  console.log(`Open: ${state.openPositions.length}/${PARAMS.maxOpenPositions} | Closed: ${s.totalTrades} (${winRate}% WR, ${s.wins}W/${s.losses}L) | Realized PnL: $${s.totalPnl.toFixed(0)}`);

  output.summary = `Yolo: ${state.openPositions.length} open, ${s.totalTrades} closed (${winRate}% WR), $${s.totalPnl.toFixed(0)} realized`;
  return output;
}

run().catch(e => console.error('Yolo fatal:', e.message));
