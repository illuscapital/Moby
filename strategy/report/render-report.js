#!/usr/bin/env node
// Generates Moby HTML report to stdout
const fs = require('fs');
const path = require('path');
const STATE_FILE = path.join(__dirname, '..', 'data', 'strategy-state.json');
const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
const open = [...state.openPositions].sort((a, b) => (b.unrealizedPnl || 0) - (a.unrealizedPnl || 0));
const closed = (state.closedPositions || []).filter(p => !(p.exitReason || '').includes('invalid_strike'));
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
  const dir = p.type === 'call' ? 'C' : 'P';
  const pnl = p.unrealizedPnl || 0;
  const pp = p.entryValue > 0 ? (pnl / p.entryValue * 100) : 0;
  return `<tr><td>${p.ticker} ${p.strike}${dir} ${p.expiry.slice(5).replace('-', '/')}</td>` +
    `<td>${p.contracts}x @ $${p.entryPrice.toFixed(2)}</td>` +
    `<td>$${p.entryValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}</td>` +
    `<td>$${(p.lastPrice || 0).toFixed(2)}</td>` +
    `<td class="${cls(pnl)}">${fmt(pnl)} (${pct(pp)})</td>` +
    `<td>${erFmt(p.earningsDate, p.erTime)}</td></tr>`;
}).join('\n');

const closedRows = closed.map(p => {
  const dir = p.type === 'call' ? 'C' : 'P';
  const reason = (p.exitReason || '').split(' ')[0]
    .replace('earnings_bmo', 'Post-earnings').replace('earnings_amc', 'Post-earnings')
    .replace('earnings_unknown_timing', 'Post-earnings').replace('profit_take', 'Profit-take');
  return `<tr><td>${p.ticker} ${p.strike}${dir} ${p.expiry.slice(5).replace('-', '/')}</td>` +
    `<td>$${p.entryPrice.toFixed(2)}</td><td>$${(p.exitPrice || 0).toFixed(2)}</td>` +
    `<td class="${cls(p.pnl)}">${fmt(p.pnl)} (${pct(p.pnlPct)})</td><td>${reason}</td></tr>`;
}).join('\n');

// Theta state
const THETA_FILE = path.join(__dirname, '..', 'data', 'theta-state.json');
let theta = { openPositions: [], closedPositions: [], stats: { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0 } };
try { theta = JSON.parse(fs.readFileSync(THETA_FILE, 'utf8')); } catch {}

const thetaOpen = theta.openPositions || [];
const thetaClosed = (theta.closedPositions || []);

const thetaOpenRows = thetaOpen.map(p => {
  const pnl = p.unrealizedPnl || 0;
  const pnlPct = p.unrealizedPnlPct || 0;
  return `<tr><td>${p.ticker}</td>` +
    `<td>${p.shortPut.strike}P / ${p.shortCall.strike}C</td>` +
    `<td>${p.longPut.strike}P / ${p.longCall.strike}C</td>` +
    `<td>${p.expiry.slice(5).replace('-', '/')}</td>` +
    `<td>${p.contracts}x</td>` +
    `<td>$${Math.round(p.maxCredit).toLocaleString('en-US')}</td>` +
    `<td>$${Math.round(p.totalRisk).toLocaleString('en-US')}</td>` +
    `<td class="${cls(pnl)}">${fmt(pnl)} (${pct(pnlPct)})</td>` +
    `<td>${Math.round(p.ivRank * 100)}%</td>` +
    `<td>${erFmt(p.earningsDate, p.erTime)}</td></tr>`;
}).join('\n');

const thetaClosedRows = thetaClosed.map(p => {
  const reason = (p.exitReason || '').split(' ')[0]
    .replace('post-earnings', 'Post-earnings');
  return `<tr><td>${p.ticker}</td>` +
    `<td>${p.shortPut.strike}P / ${p.shortCall.strike}C</td>` +
    `<td>$${Math.round(p.maxCredit).toLocaleString('en-US')}</td>` +
    `<td class="${cls(p.pnl)}">${fmt(p.pnl)} (${pct(p.pnlPct)})</td>` +
    `<td>${reason}</td></tr>`;
}).join('\n');

const tw = theta.stats.wins || 0, tl = theta.stats.losses || 0;
const thetaTotalCredit = thetaOpen.reduce((s, p) => s + p.maxCredit, 0);
const thetaTotalRisk = thetaOpen.reduce((s, p) => s + p.totalRisk, 0);
const thetaUnrealized = thetaOpen.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);

const ti = open.reduce((s, p) => s + p.entryValue, 0);
const tu = open.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
const tr = state.stats.totalPnl || 0;
const w = state.stats.wins || 0, l = state.stats.losses || 0;

console.log(`<!DOCTYPE html><html><head><style>
body{background:#2d1b3d;color:#e0d0f0;font-family:"Courier New",monospace;font-size:14px;padding:20px;margin:0}
h2{margin:0 0 12px;font-size:18px}
h3{margin:16px 0 8px;font-size:15px;color:#c0b0e0}
table{border-collapse:collapse;margin-bottom:16px}
th,td{border:1px solid #888;padding:6px 12px;text-align:left;white-space:nowrap}
th{font-weight:bold}.green{color:#4f4}.red{color:#f66}.muted{color:#aaa}
.summary{margin-top:8px;font-size:13px;line-height:1.6}
</style></head><body>
<h2>🐋 Moby Status — ${time}</h2>
<h3>📈 Flow Positions (${open.length}/10)</h3>
<table><tr><th>Position</th><th>Contracts</th><th>Entry</th><th>Last</th><th>Unrealized</th><th>ER Date</th></tr>
${openRows}</table>
<h3>⏳ Theta Condors (${thetaOpen.length}/5)</h3>
<table><tr><th>Ticker</th><th>Short</th><th>Long</th><th>Expiry</th><th>Size</th><th>Credit</th><th>Risk</th><th>Unrealized</th><th>IV Rank</th><th>ER Date</th></tr>
${thetaOpenRows}</table>
${thetaClosedRows ? `<b>Theta Closed: ${tw}W / ${tl}L</b>
<table><tr><th>Ticker</th><th>Strikes</th><th>Credit</th><th>PnL</th><th>Reason</th></tr>
${thetaClosedRows}</table>` : ''}
<h3>📊 Flow Closed: ${w}W / ${l}L</h3>
<table><tr><th>Position</th><th>Entry</th><th>Exit</th><th>PnL</th><th>Reason</th></tr>
${closedRows}</table>
<div class="summary"><b>Flow:</b> $${ti.toLocaleString('en-US', { maximumFractionDigits: 0 })} invested | ${fmt(tu)} unrealized | ${fmt(tr)} realized | ${w}W/${l}L</div>
<div class="summary"><b>Theta:</b> $${Math.round(thetaTotalCredit).toLocaleString('en-US')} credit | $${Math.round(thetaTotalRisk).toLocaleString('en-US')} risk | ${fmt(thetaUnrealized)} unrealized | ${fmt(theta.stats.totalPnl || 0)} realized | ${tw}W/${tl}L</div>
</body></html>`);
