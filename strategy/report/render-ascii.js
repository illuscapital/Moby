#!/usr/bin/env node
// Renders Moby positions as a clean ASCII table
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'data', 'strategy-state.json');
const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

function pad(str, len) {
  str = String(str);
  return str + ' '.repeat(Math.max(0, len - str.length));
}
function rpad(str, len) { return pad(str, len); }
function lpad(str, len) { str = String(str); return ' '.repeat(Math.max(0, len - str.length)) + str; }

function fmt$(n) {
  const abs = Math.abs(n);
  const s = abs >= 1000 ? '$' + abs.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '$' + abs.toFixed(2);
  return n < 0 ? '-' + s : (n > 0 ? '+' + s : '$0');
}

function fmtPct(n) {
  const s = Math.abs(n).toFixed(0);
  return n < 0 ? '-' + s + '%' : (n > 0 ? '+' + s + '%' : '0%');
}

function erDateFmt(d, t) {
  const dt = new Date(d + 'T12:00:00');
  const mon = dt.toLocaleString('en-US', { month: 'short' });
  const day = dt.getDate();
  const timing = (t || '').replace('premarket', 'BMO').replace('bmo', 'BMO').replace('before', 'BMO')
    .replace('postmarket', 'AMC').replace('amc', 'AMC').replace('after', 'AMC');
  return `${mon} ${day}` + (timing ? ` (${timing.toUpperCase()})` : '');
}

function table(headers, rows, colWidths) {
  const sep = colWidths.map(w => '-'.repeat(w)).join('-+-');
  let out = ' ' + headers.map((h, i) => pad(h, colWidths[i])).join(' | ') + '\n';
  out += '-' + sep + '-\n';
  for (const row of rows) {
    out += ' ' + row.map((c, i) => pad(c, colWidths[i])).join(' | ') + '\n';
  }
  return out;
}

// Sort open: positive PnL first (desc), then negative (desc)
const open = [...state.openPositions].sort((a, b) => (b.unrealizedPnl || 0) - (a.unrealizedPnl || 0));
const closed = state.closedPositions || [];

const now = new Date();
const timeStr = now.toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

let output = `Moby Status - ${timeStr}\n\n`;
output += `Open: ${open.length}/10\n\n`;

const openRows = open.map(p => {
  const dir = p.type === 'call' ? 'C' : 'P';
  const pos = `${p.ticker} ${p.strike}${dir} ${p.expiry.slice(5).replace('-', '/')}`;
  const cts = `${p.contracts}x @ $${p.entryPrice.toFixed(2)}`;
  const entry = '$' + p.entryValue.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const last = '$' + (p.lastPrice || 0).toFixed(2);
  const pnl = p.unrealizedPnl || 0;
  const pct = p.entryValue > 0 ? (pnl / p.entryValue * 100) : 0;
  const unreal = `${fmt$(pnl)} (${fmtPct(pct)})`;
  const er = p.earningsDate ? erDateFmt(p.earningsDate, p.erTime) : '?';
  return [pos, cts, entry, last, unreal, er];
});

const openHeaders = ['Position', 'Contracts', 'Entry', 'Last', 'Unrealized', 'ER Date'];
const openWidths = openHeaders.map((h, i) => Math.max(h.length, ...openRows.map(r => r[i].length)));
output += table(openHeaders, openRows, openWidths);

if (closed.length > 0) {
  const w = state.stats.wins || 0;
  const l = state.stats.losses || 0;
  output += `\nClosed: ${w}W / ${l}L\n\n`;

  const closedRows = closed.map(p => {
    const dir = p.type === 'call' ? 'C' : 'P';
    const pos = `${p.ticker} ${p.strike}${dir} ${p.expiry.slice(5).replace('-', '/')}`;
    const entry = '$' + p.entryPrice.toFixed(2);
    const exit = '$' + (p.exitPrice || 0).toFixed(2);
    const pnl = `${fmt$(p.pnl)} (${fmtPct(p.pnlPct)})`;
    const reason = (p.exitReason || '').split(' ')[0].replace('earnings_bmo', 'Post-earnings').replace('earnings_amc', 'Post-earnings').replace('earnings_unknown_timing', 'Post-earnings').replace('profit_take', 'Profit-take');
    return [pos, entry, exit, pnl, reason];
  });

  const closedHeaders = ['Position', 'Entry', 'Exit', 'PnL', 'Reason'];
  const closedWidths = closedHeaders.map((h, i) => Math.max(h.length, ...closedRows.map(r => r[i].length)));
  output += table(closedHeaders, closedRows, closedWidths);
}

const totalInvested = open.reduce((s, p) => s + p.entryValue, 0);
const totalUnreal = open.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
const totalReal = state.stats.totalPnl || 0;
output += `\nTotals: $${totalInvested.toLocaleString('en-US', {maximumFractionDigits: 0})} invested | ${fmt$(totalUnreal)} unrealized | ${fmt$(totalReal)} realized`;

console.log(output);
