#!/usr/bin/env node
// Moby Dashboard — Express server for Flow, Riptide, and Theta strategies
const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.MOBY_DASH_PORT || 3200;
const DATA_DIR = path.join(__dirname, '..', 'data');

const app = express();

// Serve static frontend
app.use(express.static(__dirname));

// ─── API Endpoints ───

function readState(file) {
  const fp = path.join(DATA_DIR, file);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
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

  // Filter positions by IV
  state.openPositions = (state.openPositions || []).filter(passesIvFilter);
  state.closedPositions = (state.closedPositions || []).filter(passesIvFilter);

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
  res.json(state);
});

app.get('/api/theta', (req, res) => {
  const state = readState('theta-state.json');
  if (!state) return res.json({ error: 'No theta state file' });
  res.json(state);
});

app.get('/api/summary', (req, res) => {
  const flow = readState('strategy-state.json');
  const riptide = readState('riptide-state.json');
  const theta = readState('theta-state.json');

  // Apply IV filter to flow data for summary
  const flowOpen = (flow?.openPositions || []).filter(passesIvFilter);
  const flowClosed = (flow?.closedPositions || []).filter(passesIvFilter);
  let fWins = 0, fLosses = 0, fPnl = 0;
  for (const p of flowClosed) { fPnl += p.pnl || 0; if ((p.pnl||0) > 0) fWins++; else if ((p.pnl||0) < 0) fLosses++; }
  const flowStats = { totalPnl: fPnl, totalTrades: flowClosed.length, wins: fWins, losses: fLosses };

  const riptideStats = riptide?.stats || { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0 };
  const thetaStats = theta?.stats || { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0 };

  const flowUnrealized = flowOpen.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  const riptideUnrealized = (riptide?.openPositions || []).reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  const thetaUnrealized = (theta?.openPositions || []).reduce((s, p) => s + (p.unrealizedPnl || 0), 0);

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
      openPositions: flowOpen.length + (riptide?.openPositions || []).length + (theta?.openPositions || []).length
    },
    lastUpdated: new Date().toISOString()
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🐋 Moby Dashboard running on http://0.0.0.0:${PORT}`);
});
