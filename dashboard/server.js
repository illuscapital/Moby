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

app.get('/api/flow', (req, res) => {
  const state = readState('strategy-state.json');
  if (!state) return res.json({ error: 'No flow state file' });
  // Strip seenAlertIds (huge array, not needed for dashboard)
  delete state.seenAlertIds;
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

  const flowStats = flow?.stats || { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0 };
  const riptideStats = riptide?.stats || { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0 };
  const thetaStats = theta?.stats || { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0 };

  const flowUnrealized = (flow?.openPositions || []).reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  const riptideUnrealized = (riptide?.openPositions || []).reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
  const thetaUnrealized = (theta?.openPositions || []).reduce((s, p) => s + (p.unrealizedPnl || 0), 0);

  res.json({
    flow: { ...flowStats, openCount: (flow?.openPositions || []).length, unrealized: flowUnrealized },
    riptide: { ...riptideStats, openCount: (riptide?.openPositions || []).length, unrealized: riptideUnrealized },
    theta: { ...thetaStats, openCount: (theta?.openPositions || []).length, unrealized: thetaUnrealized },
    combined: {
      totalPnl: flowStats.totalPnl + riptideStats.totalPnl + thetaStats.totalPnl,
      totalUnrealized: flowUnrealized + riptideUnrealized + thetaUnrealized,
      totalTrades: flowStats.totalTrades + riptideStats.totalTrades + thetaStats.totalTrades,
      wins: flowStats.wins + riptideStats.wins + thetaStats.wins,
      losses: flowStats.losses + riptideStats.losses + thetaStats.losses,
      openPositions: (flow?.openPositions || []).length + (riptide?.openPositions || []).length + (theta?.openPositions || []).length
    },
    lastUpdated: new Date().toISOString()
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🐋 Moby Dashboard running on http://0.0.0.0:${PORT}`);
});
