#!/usr/bin/env node
/**
 * One-time recalc of all simulatedPnl values in shadow-state.json
 * Uses the current SIM_ALLOCATION ($500) to recompute contracts + PnL
 * 
 * Usage: node scripts/recalc-shadow-pnl.js [--dry-run]
 * 
 * --dry-run: show what would change without writing
 */

const fs = require('fs');
const path = require('path');

const SHADOW_FILE = path.join(__dirname, '..', 'data', 'shadow-state.json');
const SIM_ALLOCATION = 500;
const dryRun = process.argv.includes('--dry-run');

if (!fs.existsSync(SHADOW_FILE)) {
  console.error('shadow-state.json not found');
  process.exit(1);
}

const state = JSON.parse(fs.readFileSync(SHADOW_FILE, 'utf8'));
const positions = state.positions || {};

let recalculated = 0;
let skipped = 0;
let changed = 0;

for (const [id, pos] of Object.entries(positions)) {
  if (!pos.entryPrice || pos.entryPrice <= 0) {
    skipped++;
    continue;
  }

  const costPerContract = pos.entryPrice * 100;

  if (costPerContract > SIM_ALLOCATION) {
    // Too expensive for even 1 contract at this allocation
    if (pos.simulatedPnl !== 0 || pos.simulatedPnlPct !== 0) {
      if (dryRun) console.log(`[CHANGE] ${pos.ticker} ${pos.strike}${pos.type === 'call' ? 'C' : 'P'} ${pos.expiry}: entry $${pos.entryPrice.toFixed(2)} > $${(SIM_ALLOCATION/100).toFixed(2)}/share cap → PnL ${pos.simulatedPnl} → 0`);
      pos.simulatedPnl = 0;
      pos.simulatedPnlPct = 0;
      changed++;
    }
    recalculated++;
    continue;
  }

  if (pos.lastPrice === null || pos.lastPrice === undefined) {
    skipped++;
    continue;
  }

  const contracts = Math.max(1, Math.floor(SIM_ALLOCATION / costPerContract));
  const newPnl = Math.round((pos.lastPrice - pos.entryPrice) * 100 * contracts);
  const newPnlPct = (pos.lastPrice - pos.entryPrice) / pos.entryPrice * 100;
  const oldPnl = pos.simulatedPnl;

  if (oldPnl !== null && Math.abs(newPnl - oldPnl) >= 1) {
    if (dryRun) {
      const oldContracts = oldPnl !== 0 ? Math.round(oldPnl / ((pos.lastPrice - pos.entryPrice) * 100)) : '?';
      console.log(`[CHANGE] ${pos.ticker} ${pos.strike}${pos.type === 'call' ? 'C' : 'P'} ${pos.expiry}: entry $${pos.entryPrice.toFixed(2)} × ${contracts}ct → PnL $${oldPnl} → $${newPnl} (was ~${oldContracts}ct)`);
    }
    changed++;
  }

  pos.simulatedPnl = newPnl;
  pos.simulatedPnlPct = newPnlPct;
  recalculated++;
}

console.log(`\nAllocation: $${SIM_ALLOCATION}`);
console.log(`Total positions: ${Object.keys(positions).length}`);
console.log(`Recalculated: ${recalculated}`);
console.log(`Skipped (no entry/last price): ${skipped}`);
console.log(`Changed: ${changed}`);

if (dryRun) {
  console.log('\n--dry-run mode: no changes written');
} else {
  fs.writeFileSync(SHADOW_FILE, JSON.stringify(state, null, 2));
  console.log(`\nWritten to ${SHADOW_FILE}`);
}
