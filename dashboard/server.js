#!/usr/bin/env node
// Moby Dashboard — Express server for Flow, Riptide, and Theta strategies
const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.MOBY_DASH_PORT || 3200;
const DATA_DIR = path.join(__dirname, '..', 'data');
// MOBY_EPOCH: ISO timestamp or YYYY-MM-DD — only show positions entered on/after this date
const EPOCH = process.env.MOBY_EPOCH || null;
const EPOCH_MS = EPOCH ? new Date(EPOCH).getTime() : 0;

const app = express();

// Serve static frontend
app.use(express.static(__dirname));

// ─── API Endpoints ───

function readState(file) {
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

// Epoch filter: exclude positions entered before MOBY_EPOCH
function passesEpochFilter(p) {
  if (!EPOCH_MS) return true;
  const entryMs = new Date(p.entryTime || p.entryDate || 0).getTime();
  return entryMs >= EPOCH_MS;
}

// IV filter: exclude NO_DATA and IV > 80% (matches strategy.js PARAMS)
const MAX_IV = 0.80;
function passesIvFilter(p) {
  return p.entryIv && p.entryIv > 0 && p.entryIv <= MAX_IV;
}

app.get('/api/flow', (req, res) => {
  const state = readState('strategy-state.json');
  if (!state) return res.json({ error: 'No flow state file' });
  delete state.seenAlertIds;

  // Filter positions by IV and epoch
  state.openPositions = (state.openPositions || []).filter(p => passesIvFilter(p) && passesEpochFilter(p));
  state.closedPositions = (state.closedPositions || []).filter(p => passesIvFilter(p) && passesEpochFilter(p));

  // Recalculate stats from filtered closed positions
  let wins = 0, losses = 0, totalPnl = 0;
  for (const p of state.closedPositions) {
    totalPnl += p.pnl || 0;
    if ((p.pnl || 0) > 0) wins++; else if ((p.pnl || 0) < 0) losses++;
  }
  state.stats = { ...state.stats, totalPnl, totalTrades: state.closedPositions.length, wins, losses };

  res.json(state);
});

app.get('/api/riptide', (req, res) => {
  const state = readState('riptide-state.json');
  if (!state) return res.json({ openPositions: [], closedPositions: [], stats: { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0, totalCreditCollected: 0 } });
  delete state.seenAlertIds;

  // Apply epoch filter
  state.openPositions = (state.openPositions || []).filter(passesEpochFilter);
  state.closedPositions = (state.closedPositions || []).filter(passesEpochFilter);

  // Recalculate stats from filtered positions
  let wins = 0, losses = 0, totalPnl = 0, totalCredit = 0;
  for (const p of state.closedPositions) {
    totalPnl += p.pnl || 0;
    totalCredit += p.totalCredit || 0;
    if ((p.pnl || 0) > 0) wins++; else if ((p.pnl || 0) < 0) losses++;
  }
  for (const p of state.openPositions) totalCredit += p.totalCredit || 0;
  state.stats = { totalPnl, totalTrades: state.closedPositions.length, wins, losses, totalCreditCollected: totalCredit };

  res.json(state);
});

app.get('/api/theta', (req, res) => {
  const state = readState('theta-state.json');
  if (!state) return res.json({ error: 'No theta state file' });

  // Apply epoch filter
  state.openPositions = (state.openPositions || []).filter(passesEpochFilter);
  state.closedPositions = (state.closedPositions || []).filter(passesEpochFilter);

  let wins = 0, losses = 0, totalPnl = 0;
  for (const p of state.closedPositions) {
    totalPnl += p.pnl || 0;
    if ((p.pnl || 0) > 0) wins++; else if ((p.pnl || 0) < 0) losses++;
  }
  state.stats = { ...state.stats, totalPnl, totalTrades: state.closedPositions.length, wins, losses };

  res.json(state);
});

app.get('/api/summary', (req, res) => {
  const flow = readState('strategy-state.json');
  const riptide = readState('riptide-state.json');
  const theta = readState('theta-state.json');

  // Apply IV + epoch filters to flow data for summary
  const flowOpen = (flow?.openPositions || []).filter(p => passesIvFilter(p) && passesEpochFilter(p));
  const flowClosed = (flow?.closedPositions || []).filter(p => passesIvFilter(p) && passesEpochFilter(p));
  let fWins = 0, fLosses = 0, fPnl = 0;
  for (const p of flowClosed) { fPnl += p.pnl || 0; if ((p.pnl||0) > 0) fWins++; else if ((p.pnl||0) < 0) fLosses++; }
  const flowStats = { totalPnl: fPnl, totalTrades: flowClosed.length, wins: fWins, losses: fLosses };

  // Apply epoch filter to riptide and theta for summary
  const riptideOpen = (riptide?.openPositions || []).filter(passesEpochFilter);
  const riptideClosed = (riptide?.closedPositions || []).filter(passesEpochFilter);
  let rWins = 0, rLosses = 0, rPnl = 0;
  for (const p of riptideClosed) { rPnl += p.pnl || 0; if ((p.pnl||0) > 0) rWins++; else if ((p.pnl||0) < 0) rLosses++; }
  const riptideStats = { totalPnl: rPnl, totalTrades: riptideClosed.length, wins: rWins, losses: rLosses };

  const thetaOpen = (theta?.openPositions || []).filter(passesEpochFilter);
  const thetaClosed = (theta?.closedPositions || []).filter(passesEpochFilter);
  let tWins = 0, tLosses = 0, tPnl = 0;
  for (const p of thetaClosed) { tPnl += p.pnl || 0; if ((p.pnl||0) > 0) tWins++; else if ((p.pnl||0) < 0) tLosses++; }
  const thetaStats = { totalPnl: tPnl, totalTrades: thetaClosed.length, wins: tWins, losses: tLosses };

  const flowUnrealized = flowOpen.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  const riptideUnrealized = riptideOpen.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  const thetaUnrealized = thetaOpen.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);

  res.json({
    flow: { ...flowStats, openCount: flowOpen.length, unrealized: flowUnrealized },
    riptide: { ...riptideStats, openCount: (riptide?.openPositions || []).length, unrealized: riptideUnrealized },
    theta: { ...thetaStats, openCount: (theta?.openPositions || []).length, unrealized: thetaUnrealized },
    combined: {
      totalPnl: flowStats.totalPnl + riptideStats.totalPnl + thetaStats.totalPnl,
      totalUnrealized: flowUnrealized + riptideUnrealized + thetaUnrealized,
      totalTrades: flowStats.totalTrades + riptideStats.totalTrades + thetaStats.totalTrades,
      wins: flowStats.wins + riptideStats.wins + thetaStats.wins,
      losses: flowStats.losses + riptideStats.losses + thetaStats.losses,
      openPositions: flowOpen.length + riptideOpen.length + thetaOpen.length
    },
    lastUpdated: new Date().toISOString(),
    epoch: EPOCH || null
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🐋 Moby Dashboard running on http://0.0.0.0:${PORT}`);
});
