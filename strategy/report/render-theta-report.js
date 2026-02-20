#!/usr/bin/env node
// Generates Moby Theta HTML report to stdout
const fs = require('fs');
const path = require('path');
const STATE_FILE = path.join(__dirname, '..', 'data', 'theta-state.json');

let state;
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
catch { state = { openPositions: [], closedPositions: [], stats: { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0 } }; }

const open = [...state.openPositions].sort((a, b) => (b.maxCredit || 0) - (a.maxCredit || 0));
const closed = state.closedPositions || [];
const now = new Date();
const time = now.toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

function erFmt(d, t) {
  const dt = new Date(d + 'T12:00:00');
  const m = dt.toLocaleString('en-US', { month: 'short' });
  const day = dt.getDate();
  const tt = (t || '').replace('premarket', 'BMO').replace('bmo', 'BMO').replace('before', 'BMO')
    .replace('postmarket', 'AMC').replace('amc', 'AMC').replace('after', 'AMC');
  return `${m} ${day}${tt ? ` (${tt.toUpperCase()})` : ''}`;
}
function fmt(n) {
  const a = Math.abs(n);
  const s = a >= 1000 ? '$' + a.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '$' + a.toFixed(0);
  return n < 0 ? '-' + s : n > 0 ? '+' + s : '$0';
}
function pct(n) { return (n >= 0 ? '+' : '') + n.toFixed(0) + '%'; }
function cls(n) { return n > 0 ? 'green' : n < 0 ? 'red' : 'muted'; }

const openRows = open.map(p => {
  return `<tr>
    <td>${p.ticker}</td>
    <td>${p.shortPut.strike}P / ${p.shortCall.strike}C</td>
    <td>${p.longPut.strike}P / ${p.longCall.strike}C</td>
    <td>${p.expiry.slice(5).replace('-', '/')}</td>
    <td>${p.contracts}x</td>
    <td class="green">$${p.maxCredit.toFixed(0)}</td>
    <td>$${p.totalRisk.toFixed(0)}</td>
    <td>${(p.ivRank * 100).toFixed(0)}%</td>
    <td>${erFmt(p.earningsDate, p.erTime)}</td>
  </tr>`;
}).join('\n');

const closedRows = closed.map(p => {
  const pnl = p.pnl || 0;
  const pp = p.pnlPct || 0;
  return `<tr>
    <td>${p.ticker}</td>
    <td>${p.shortPut.strike}P / ${p.shortCall.strike}C</td>
    <td>${p.expiry.slice(5).replace('-', '/')}</td>
    <td class="green">$${(p.credit * 100 * p.contracts).toFixed(0)}</td>
    <td class="${cls(pnl)}">${fmt(pnl)} (${pct(pp)})</td>
    <td>${p.exitReason || ''}</td>
  </tr>`;
}).join('\n');

const totalCredit = open.reduce((s, p) => s + (p.maxCredit || 0), 0);
const totalRisk = open.reduce((s, p) => s + (p.totalRisk || 0), 0);
const tr = state.stats.totalPnl || 0;
const w = state.stats.wins || 0, l = state.stats.losses || 0;

console.log(`<!DOCTYPE html><html><head><style>
body{background:#1b2d3d;color:#e0e8f0;font-family:"Courier New",monospace;font-size:14px;padding:20px;margin:0}
h2{margin:0 0 12px;font-size:18px}
table{border-collapse:collapse;margin-bottom:16px}
th,td{border:1px solid #888;padding:6px 12px;text-align:left;white-space:nowrap}
th{font-weight:bold}.green{color:#4f4}.red{color:#f66}.muted{color:#aaa}
.summary{margin-top:8px;font-size:13px;line-height:1.6}
</style></head><body>
<h2>🐋⏳ Moby Theta — ${time}</h2>
<b>Open: ${open.length}/5</b>
<table>
<tr><th>Ticker</th><th>Short Strikes</th><th>Wings</th><th>Exp</th><th>Cts</th><th>Credit</th><th>Max Risk</th><th>IV Rank</th><th>ER Date</th></tr>
${openRows}
</table>
${closed.length > 0 ? `<b>Closed: ${w}W / ${l}L</b>
<table>
<tr><th>Ticker</th><th>Short Strikes</th><th>Exp</th><th>Credit</th><th>PnL</th><th>Reason</th></tr>
${closedRows}
</table>` : '<b>Closed: No trades yet</b>'}
<div class="summary"><b>Totals:</b> $${totalCredit.toFixed(0)} credit collected | $${totalRisk.toFixed(0)} at risk | ${fmt(tr)} realized | ${w}W/${l}L</div>
</body></html>`);
