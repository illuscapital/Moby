#!/usr/bin/env node
// Moby Dashboard — Express server for Flow, Riptide, and Theta strategies
// Trade history: JSONL files are source of truth (append-only, crash-safe)
// State files: only used for openPositions and seenAlertIds
const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.MOBY_DASH_PORT || 3200;
const DATA_DIR = path.join(__dirname, '..', 'data');
// MOBY_EPOCH: ISO timestamp or YYYY-MM-DD — only show positions entered on/after this date
const EPOCH = process.env.MOBY_EPOCH || null;
const EPOCH_MS = EPOCH ? new Date(EPOCH).getTime() : 0;

// JSONL trade log files (source of truth for closed positions)
const TRADE_FILES = {
  flow: path.join(DATA_DIR, 'trades.jsonl'),
  riptide: path.join(DATA_DIR, 'riptide-trades.jsonl'),
  theta: path.join(DATA_DIR, 'theta-trades.jsonl'),
  yolo: path.join(DATA_DIR, 'yolo-trades.jsonl'),
};

const app = express();

// Serve static frontend
app.use(express.static(__dirname));

// ─── Shared Helpers ───

function readState(file) {
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

/**
 * Parse JSONL trade log → closedPositions array.
 * Each CLOSE line is a closed position. Filters by epoch.
 */
function readClosedFromJsonl(filePath, extraFilter) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  const closed = [];
  for (const line of lines) {
    try {
      const trade = JSON.parse(line);
      if (!trade.action || !trade.action.startsWith('CLOSE')) continue;
      if (!passesEpochFilter(trade)) continue;
      if (extraFilter && !extraFilter(trade)) continue;
      closed.push(trade);
    } catch { /* skip malformed lines */ }
  }
  return closed;
}

// Epoch filter: exclude positions entered before MOBY_EPOCH
function passesEpochFilter(p) {
  if (!EPOCH_MS) return true;
  const entryMs = new Date(p.entryTime || p.entryDate || 0).getTime();
  return entryMs >= EPOCH_MS;
}

// IV filter: show all positions regardless of IV
function passesIvFilter(p) {
  return true;
}

/** Compute stats from an array of closed positions */
function computeStats(closed, extras) {
  let wins = 0, losses = 0, totalPnl = 0;
  for (const p of closed) {
    totalPnl += p.pnl || 0;
    if ((p.pnl || 0) > 0) wins++; else if ((p.pnl || 0) < 0) losses++;
  }
  return { totalPnl, totalTrades: closed.length, wins, losses, ...extras };
}

// ─── API Endpoints ───

app.get('/api/flow', (req, res) => {
  const state = readState('strategy-state.json');
  if (!state) return res.json({ error: 'No flow state file' });
  delete state.seenAlertIds;

  const openPositions = (state.openPositions || []).filter(p => passesIvFilter(p) && passesEpochFilter(p));
  const closedPositions = readClosedFromJsonl(TRADE_FILES.flow, passesIvFilter);

  res.json({
    openPositions,
    closedPositions,
    stats: computeStats(closedPositions),
    lastRun: state.lastRun,
  });
});

app.get('/api/riptide', (req, res) => {
  const state = readState('riptide-state.json');
  const openPositions = (state?.openPositions || []).filter(passesEpochFilter);
  const closedPositions = readClosedFromJsonl(TRADE_FILES.riptide);

  let totalCredit = 0;
  for (const p of closedPositions) totalCredit += p.totalCredit || 0;
  for (const p of openPositions) totalCredit += p.totalCredit || 0;

  res.json({
    openPositions,
    closedPositions,
    stats: computeStats(closedPositions, { totalCreditCollected: totalCredit }),
    lastRun: state?.lastRun,
  });
});

app.get('/api/theta', (req, res) => {
  const state = readState('theta-state.json');
  if (!state) return res.json({ error: 'No theta state file' });

  const openPositions = (state.openPositions || []).filter(passesEpochFilter);
  const closedPositions = readClosedFromJsonl(TRADE_FILES.theta);

  res.json({
    openPositions,
    closedPositions,
    stats: computeStats(closedPositions),
    lastRun: state.lastRun,
  });
});

app.get('/api/yolo', (req, res) => {
  const state = readState('yolo-state.json');
  const openPositions = (state?.openPositions || []).filter(passesEpochFilter);
  const closedPositions = readClosedFromJsonl(TRADE_FILES.yolo);

  let totalInvested = 0;
  for (const p of closedPositions) totalInvested += p.totalCost || 0;
  for (const p of openPositions) totalInvested += p.totalCost || 0;

  // Delta stats
  const allPos = [...openPositions, ...closedPositions];
  const deltas = allPos.filter(p => p.priceDelta !== null && p.priceDelta !== undefined);
  const deltaStats = deltas.length > 0 ? {
    avgDelta: deltas.reduce((s, p) => s + p.priceDelta, 0) / deltas.length,
    avgDeltaPct: deltas.reduce((s, p) => s + (p.priceDeltaPct || 0), 0) / deltas.length,
    avgDelaySec: deltas.reduce((s, p) => s + (p.alertDelaySec || 0), 0) / deltas.length,
    totalSlippage: deltas.reduce((s, p) => s + (p.priceDelta * p.contracts * 100), 0),
    samples: deltas.length,
  } : null;

  res.json({
    openPositions,
    closedPositions,
    stats: computeStats(closedPositions, { totalInvested }),
    deltaStats,
    lastRun: state?.lastRun,
  });
});

app.get('/api/research', (req, res) => {
  // Load shadow state
  const shadowFile = path.join(DATA_DIR, 'shadow-state.json');
  let shadow = { positions: {} };
  if (fs.existsSync(shadowFile)) {
    try { shadow = JSON.parse(fs.readFileSync(shadowFile, 'utf8')); } catch { /* empty */ }
  }

  // Load all JSONL alerts (deduplicated)
  const alerts = new Map();
  const files = fs.readdirSync(DATA_DIR).filter(f => /^flow-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  for (const file of files) {
    const lines = fs.readFileSync(path.join(DATA_DIR, file), 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const a = JSON.parse(line);
        if (a.id) alerts.set(a.id, a);
      } catch { /* skip */ }
    }
  }

  // Merge: for each alert, attach shadow pricing if available
  const results = [];
  for (const [id, alert] of alerts) {
    const s = shadow.positions[id] || null;
    const entryPrice = s ? s.entryPrice : (parseFloat(alert.ask || 0) || parseFloat(alert.price || 0));
    const peakPrice = s ? s.peakPrice : null;
    const bid = parseFloat(alert.bid || 0);
    const ask = parseFloat(alert.ask || 0);

    // Parse marketCap: may be string like "686.33206" (billions) or raw number like 40179636000
    let marketCap = null;
    if (alert.marketcap != null) {
      const mcVal = parseFloat(alert.marketcap);
      if (!isNaN(mcVal)) {
        marketCap = mcVal < 100000 ? mcVal * 1e9 : mcVal; // small numbers are billions
      }
    }

    results.push({
      id,
      ticker: alert.ticker,
      type: alert.type,
      strike: parseFloat(alert.strike || 0),
      expiry: alert.expiry,
      optionSymbol: alert.option_chain,
      premium: parseFloat(alert.total_premium || 0),
      volOi: parseFloat(alert.volume_oi_ratio || 0),
      iv: parseFloat(alert.iv_start || alert.iv_end || 0),
      underlying: parseFloat(alert.underlying_price || 0),
      earningsDate: alert.next_earnings_date || null,
      hasEarnings: !!alert.next_earnings_date,
      isSweep: !!alert.has_sweep,
      isSingleLeg: !!alert.has_singleleg && !alert.has_multileg,
      askSidePct: parseFloat(alert.total_premium || 0) > 0 ? parseFloat(alert.total_ask_side_prem || 0) / parseFloat(alert.total_premium) : 0,
      isIndex: ['SPX','SPXW','SPY','QQQ','IWM','DIA','XSP','VIX','NDX','RUT'].includes(alert.ticker),
      alertTime: alert.created_at || null,
      alertDate: (alert.created_at || '').slice(0, 10),
      entryPrice,
      entryBid: s ? s.entryBid : bid,
      entryAsk: s ? s.entryAsk : ask,
      entryMid: s ? s.entryMid : 0,
      otmPct: s ? s.alertOtmPct : 0,
      dte: s ? s.alertDte : 0,
      lastPrice: s ? s.lastPrice : null,
      lastBid: s ? s.lastBid : null,
      lastAsk: s ? s.lastAsk : null,
      peakPrice,
      status: s ? s.status : 'unknown',
      daysToEr: alert.next_earnings_date && alert.created_at
        ? Math.round((new Date(alert.next_earnings_date + 'T16:00:00') - new Date(alert.created_at)) / 86400000)
        : null,
      simulatedPnl: s ? s.simulatedPnl : null,
      simulatedPnlPct: s ? s.simulatedPnlPct : null,
      lastUpdated: s ? s.lastUpdated : null,
      sector: alert.sector || null,
      marketCap,
      totalSize: parseFloat(alert.total_size || 0),
      tradeCount: parseInt(alert.trade_count || 0, 10),
      alertRule: alert.alert_rule || null,
      peakPnlPct: (peakPrice != null && entryPrice > 0) ? ((peakPrice - entryPrice) / entryPrice * 100) : null,
      bidAskSpread: (ask > 0 && bid >= 0) ? ((ask - bid) / ask * 100) : null,
      issueType: alert.issue_type || null,
      allOpeningTrades: !!alert.all_opening_trades,
      ivPctl: alert._ivPctl != null ? parseFloat(alert._ivPctl) : null,
      iv30: alert._iv30 != null ? parseFloat(alert._iv30) : null,
      dpRecentNotional: alert._dpRecentNotional != null ? parseFloat(alert._dpRecentNotional) : null,
      dpPrintCount: alert._dpPrintCount != null ? parseInt(alert._dpPrintCount, 10) : null,
      dpAvgPrintSize: alert._dpAvgPrintSize != null ? parseInt(alert._dpAvgPrintSize, 10) : null,
    });
  }

  res.json({
    totalAlerts: results.length,
    shadowLastRun: shadow.lastRun || null,
    alerts: results,
  });
});

// ─── Optimizer (server-side batch) ───

app.use(express.json());

let optimizerState = { status: 'idle', results: null, startedAt: null, finishedAt: null, combos: 0, baseline: null };

function filterAlerts(alerts, f) {
  return alerts.filter(a => {
    if (f.typeFilter === 'calls' && (a.type || '').toLowerCase() !== 'call') return false;
    if (f.typeFilter === 'puts' && (a.type || '').toLowerCase() !== 'put') return false;
    if (f.ruleFilter && f.ruleFilter !== 'all' && a.alertRule !== f.ruleFilter) return false;
    if (f.sectorFilter && f.sectorFilter !== 'all' && (a.sector || 'Unknown') !== f.sectorFilter) return false;
    if (f.openingOnly && !a.allOpeningTrades) return false;
    if (f.dateFrom && a.alertDate < f.dateFrom) return false;
    if (f.dateTo && a.alertDate > f.dateTo) return false;
    if (f.requireEarnings && !a.hasEarnings) return false;
    if (f.excludeIndexes && a.isIndex) return false;
    if (f.sweepsOnly && !a.isSweep) return false;
    if (f.singleLegOnly && !a.isSingleLeg) return false;
    if (f.showActive === false && a.status === 'active') return false;
    if (f.showExpired === false && a.status === 'expired') return false;
    if (f.showInvalid === false && (a.lastPrice === null || a.lastPrice === undefined)) return false;
    // Numeric grid filters
    if (f.premiumMin != null && a.premium < f.premiumMin) return false;
    if (f.premiumMax != null && a.premium > f.premiumMax) return false;
    if (f.volOiMin != null && a.volOi < f.volOiMin) return false;
    if (f.ivMax != null && (a.iv * 100) > f.ivMax) return false;
    if (f.dteMin != null && a.dte < f.dteMin) return false;
    if (f.dteMax != null && a.dte > f.dteMax) return false;
    if (f.otmMin != null && a.otmPct < f.otmMin) return false;
    if (f.otmMax != null && a.otmPct > f.otmMax) return false;
    if (f.tradeCountMin && (a.tradeCount || 0) < f.tradeCountMin) return false;
    if (f.spreadMax != null && f.spreadMax < 100 && (a.bidAskSpread === null || a.bidAskSpread > f.spreadMax)) return false;
    return true;
  });
}

function runOptimizerBatch(alerts, baseline) {
  const premMins = [0, 100000, 250000, 500000];
  const voiMins = [0, 3, 5, 10];
  const ivMaxes = [50, 80, 120, 200];
  const dteRanges = [[0,30],[0,60],[0,120],[0,180],[31,60],[31,120],[60,180],[0,700]];
  const otmRanges = [[0,4],[0,10],[0,15],[0,30],[5,15],[10,30],[0,100]];
  const sweepOpts = [false, true];
  const tradeCountMins = [0, 5, 10, 20];
  const spreadMaxes = [5, 10, 20, 100];
  const typeOpts = ['all', 'calls', 'puts'];
  const MIN_TRADES = 15;

  const results = [];
  let combos = 0;

  for (const premMin of premMins) {
    for (const voiMin of voiMins) {
      for (const ivMax of ivMaxes) {
        for (const [dteMin, dteMax] of dteRanges) {
          for (const [otmMin, otmMax] of otmRanges) {
            for (const sweeps of sweepOpts) {
              for (const tcMin of tradeCountMins) {
                for (const spreadMax of spreadMaxes) {
                  for (const typeF of typeOpts) {
                    combos++;
                    const f = {
                      ...baseline,
                      premiumMin: premMin, premiumMax: 5000000,
                      volOiMin: voiMin, ivMax,
                      dteMin, dteMax, otmMin, otmMax,
                      sweepsOnly: sweeps,
                      tradeCountMin: tcMin || null,
                      spreadMax, typeFilter: typeF,
                    };
                    const passing = filterAlerts(alerts, f);
                    const withPnl = passing.filter(a => a.simulatedPnl !== null);
                    if (withPnl.length < MIN_TRADES) continue;

                    const totalPnl = withPnl.reduce((s, a) => s + a.simulatedPnl, 0);
                    const wins = withPnl.filter(a => a.simulatedPnl > 0).length;
                    const winRate = wins / withPnl.length;
                    const avgPnl = totalPnl / withPnl.length;
                    const withPeak = withPnl.filter(a => a.peakPnlPct !== null);
                    const avgPeak = withPeak.length > 0 ? withPeak.reduce((s, a) => s + a.peakPnlPct, 0) / withPeak.length : null;

                    results.push({
                      premMin, voiMin, ivMax, dteMin, dteMax, otmMin, otmMax,
                      sweeps, tcMin, spreadMax, typeF,
                      alerts: passing.length, trades: withPnl.length,
                      totalPnl, wins, losses: withPnl.length - wins, winRate, avgPnl, avgPeak,
                    });
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  results.sort((a, b) => b.totalPnl - a.totalPnl);
  return { results: results.slice(0, 50), totalCombos: combos, totalResults: results.length };
}

app.post('/api/research/optimize', (req, res) => {
  if (optimizerState.status === 'running') {
    return res.json({ status: 'running', startedAt: optimizerState.startedAt });
  }

  const baseline = req.body || {};
  optimizerState = { status: 'running', results: null, startedAt: new Date().toISOString(), finishedAt: null, combos: 0, baseline };

  // Load alerts (same as /api/research)
  const shadowFile = path.join(DATA_DIR, 'shadow-state.json');
  let shadow = { positions: {} };
  if (fs.existsSync(shadowFile)) {
    try { shadow = JSON.parse(fs.readFileSync(shadowFile, 'utf8')); } catch { }
  }
  const alertsMap = new Map();
  const files = fs.readdirSync(DATA_DIR).filter(f => /^flow-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  for (const file of files) {
    const lines = fs.readFileSync(path.join(DATA_DIR, file), 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try { const a = JSON.parse(line); if (a.id) alertsMap.set(a.id, a); } catch { }
    }
  }

  // Build alert objects (same schema as /api/research)
  const alerts = [];
  for (const [id, alert] of alertsMap) {
    const s = shadow.positions[id] || null;
    const entryPrice = s ? s.entryPrice : (parseFloat(alert.ask || 0) || parseFloat(alert.price || 0));
    const peakPrice = s ? s.peakPrice : null;
    const bid = parseFloat(alert.bid || 0);
    const ask = parseFloat(alert.ask || 0);
    let marketCap = null;
    if (alert.marketcap != null) {
      const mcVal = parseFloat(alert.marketcap);
      if (!isNaN(mcVal)) marketCap = mcVal < 100000 ? mcVal * 1e9 : mcVal;
    }
    alerts.push({
      id, ticker: alert.ticker, type: alert.type,
      strike: parseFloat(alert.strike || 0), expiry: alert.expiry,
      premium: parseFloat(alert.total_premium || 0),
      volOi: parseFloat(alert.volume_oi_ratio || 0),
      iv: parseFloat(alert.iv_start || alert.iv_end || 0),
      underlying: parseFloat(alert.underlying_price || 0),
      hasEarnings: !!alert.next_earnings_date,
      isSweep: !!alert.has_sweep,
      isSingleLeg: !!alert.has_singleleg && !alert.has_multileg,
      isIndex: ['SPX','SPXW','SPY','QQQ','IWM','DIA','XSP','VIX','NDX','RUT'].includes(alert.ticker),
      alertDate: (alert.created_at || '').slice(0, 10),
      entryPrice, otmPct: s ? s.alertOtmPct : 0, dte: s ? s.alertDte : 0,
      lastPrice: s ? s.lastPrice : null, peakPrice,
      status: s ? s.status : 'unknown',
      simulatedPnl: s ? s.simulatedPnl : null,
      simulatedPnlPct: s ? s.simulatedPnlPct : null,
      peakPnlPct: (peakPrice != null && entryPrice > 0) ? ((peakPrice - entryPrice) / entryPrice * 100) : null,
      bidAskSpread: (ask > 0 && bid >= 0) ? ((ask - bid) / ask * 100) : null,
      sector: alert.sector || null,
      totalSize: parseFloat(alert.total_size || 0),
      tradeCount: parseInt(alert.trade_count || 0, 10),
      alertRule: alert.alert_rule || null,
      allOpeningTrades: !!alert.all_opening_trades,
      ivPctl: alert._ivPctl != null ? parseFloat(alert._ivPctl) : null,
      dpRecentNotional: alert._dpRecentNotional != null ? parseFloat(alert._dpRecentNotional) : null,
    });
  }

  // Run in next tick so response returns immediately
  setImmediate(() => {
    try {
      const result = runOptimizerBatch(alerts, baseline);
      optimizerState = {
        status: 'done', results: result.results,
        startedAt: optimizerState.startedAt, finishedAt: new Date().toISOString(),
        combos: result.totalCombos, totalResults: result.totalResults, baseline,
      };
    } catch (e) {
      optimizerState = { status: 'error', error: e.message, startedAt: optimizerState.startedAt, finishedAt: new Date().toISOString() };
    }
  });

  res.json({ status: 'started' });
});

app.get('/api/research/optimize', (req, res) => {
  res.json(optimizerState);
});

app.get('/api/summary', (req, res) => {
  const flow = readState('strategy-state.json');
  const riptide = readState('riptide-state.json');
  const theta = readState('theta-state.json');

  const flowOpen = (flow?.openPositions || []).filter(p => passesIvFilter(p) && passesEpochFilter(p));
  const flowClosed = readClosedFromJsonl(TRADE_FILES.flow, passesIvFilter);
  const flowStats = computeStats(flowClosed);

  const riptideOpen = (riptide?.openPositions || []).filter(passesEpochFilter);
  const riptideClosed = readClosedFromJsonl(TRADE_FILES.riptide);
  const riptideStats = computeStats(riptideClosed);

  const thetaOpen = (theta?.openPositions || []).filter(passesEpochFilter);
  const thetaClosed = readClosedFromJsonl(TRADE_FILES.theta);
  const thetaStats = computeStats(thetaClosed);

  const yolo = readState('yolo-state.json');
  const yoloOpen = (yolo?.openPositions || []).filter(passesEpochFilter);
  const yoloClosed = readClosedFromJsonl(TRADE_FILES.yolo);
  const yoloStats = computeStats(yoloClosed);

  const flowUnrealized = flowOpen.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  const riptideUnrealized = riptideOpen.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  const thetaUnrealized = thetaOpen.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  const yoloUnrealized = yoloOpen.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);

  res.json({
    flow: { ...flowStats, openCount: flowOpen.length, unrealized: flowUnrealized },
    riptide: { ...riptideStats, openCount: riptideOpen.length, unrealized: riptideUnrealized },
    theta: { ...thetaStats, openCount: thetaOpen.length, unrealized: thetaUnrealized },
    yolo: { ...yoloStats, openCount: yoloOpen.length, unrealized: yoloUnrealized },
    combined: {
      totalPnl: flowStats.totalPnl + riptideStats.totalPnl + thetaStats.totalPnl + yoloStats.totalPnl,
      totalUnrealized: flowUnrealized + riptideUnrealized + thetaUnrealized + yoloUnrealized,
      totalTrades: flowStats.totalTrades + riptideStats.totalTrades + thetaStats.totalTrades + yoloStats.totalTrades,
      wins: flowStats.wins + riptideStats.wins + thetaStats.wins + yoloStats.wins,
      losses: flowStats.losses + riptideStats.losses + thetaStats.losses + yoloStats.losses,
      openPositions: flowOpen.length + riptideOpen.length + thetaOpen.length + yoloOpen.length
    },
    lastUpdated: new Date().toISOString(),
    epoch: EPOCH || null
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🐋 Moby Dashboard running on http://0.0.0.0:${PORT}`);
});
