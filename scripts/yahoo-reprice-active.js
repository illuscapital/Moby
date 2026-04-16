#!/usr/bin/env node
// One-off Yahoo Finance reprice for all active shadow positions.
// Groups by ticker, fetches only needed expiry dates.

const fs = require('fs');
const path = require('path');
const https = require('https');

const STATE_FILE = path.join(__dirname, '..', 'data', 'shadow-state.json');
const SIM_ALLOCATION = 500;

const YAHOO_TICKER_MAP = { 'BRKB': 'BRK-B', 'SPXW': 'SPX' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let crumb = null, cookie = null;

function yahooReq(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)', ...headers },
      timeout: 15000,
    }, res => {
      let d = '';
      const cookies = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, data: d, cookies }));
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

async function ensureCrumb() {
  if (crumb && cookie) return;
  const r1 = await yahooReq('https://fc.yahoo.com');
  cookie = r1.cookies;
  const r2 = await yahooReq('https://query2.finance.yahoo.com/v1/test/getcrumb', { Cookie: cookie });
  crumb = r2.data.trim();
}

async function fetchChain(ticker, neededExpiries) {
  await ensureCrumb();
  const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}?crumb=${encodeURIComponent(crumb)}`;
  let r;
  try { r = await yahooReq(url, { Cookie: cookie }); } catch (e) { return []; }

  let data;
  try { data = JSON.parse(r.data); } catch (e) {
    if (r.data.includes('Invalid Crumb') || r.status === 401) {
      crumb = null; cookie = null;
      await ensureCrumb();
      try {
        r = await yahooReq(`https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}?crumb=${encodeURIComponent(crumb)}`, { Cookie: cookie });
        data = JSON.parse(r.data);
      } catch (e2) { return []; }
    } else { return []; }
  }

  const result = data?.optionChain?.result?.[0];
  if (!result) return [];

  const contracts = [];
  if (result.options?.[0]) {
    const opt = result.options[0];
    if (opt.calls) contracts.push(...opt.calls);
    if (opt.puts) contracts.push(...opt.puts);
  }

  const expirations = result.expirationDates || [];
  for (let i = 1; i < expirations.length; i++) {
    const expDate = new Date(expirations[i] * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (!neededExpiries.has(expDate)) continue;
    await sleep(250);
    try {
      const expUrl = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker)}?date=${expirations[i]}&crumb=${encodeURIComponent(crumb)}`;
      const er = await yahooReq(expUrl, { Cookie: cookie });
      const ed = JSON.parse(er.data);
      const eo = ed?.optionChain?.result?.[0]?.options?.[0];
      if (eo) {
        if (eo.calls) contracts.push(...eo.calls);
        if (eo.puts) contracts.push(...eo.puts);
      }
    } catch (e) { /* skip */ }
  }
  return contracts;
}

async function main() {
  console.log('Loading shadow state...');
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

  // Group active positions by ticker
  const byTicker = {};
  for (const [id, p] of Object.entries(state.positions)) {
    if (p.status !== 'active') continue;
    const yt = YAHOO_TICKER_MAP[p.ticker] || p.ticker;
    if (!byTicker[yt]) byTicker[yt] = { yahooTicker: yt, positions: [] };
    byTicker[yt].positions.push({ id, pos: p });
  }

  const tickers = Object.keys(byTicker);
  console.log(`Active: ${Object.values(byTicker).reduce((s, g) => s + g.positions.length, 0)} positions across ${tickers.length} tickers\n`);

  let totalPriced = 0, totalSkipped = 0, totalNoChain = 0;

  for (let i = 0; i < tickers.length; i++) {
    const yt = tickers[i];
    const group = byTicker[yt];
    const neededExpiries = new Set(group.positions.map(({ pos }) => pos.expiry).filter(Boolean));

    await sleep(300);
    const chain = await fetchChain(yt, neededExpiries);

    if (!chain.length) {
      totalNoChain += group.positions.length;
      if ((i + 1) % 50 === 0) console.log(`[${i + 1}/${tickers.length}] ... ${totalPriced} priced`);
      continue;
    }

    const lookup = {};
    for (const c of chain) {
      if (c.contractSymbol) lookup[c.contractSymbol] = c;
    }

    let tickerPriced = 0;
    for (const { id, pos } of group.positions) {
      const c = lookup[pos.optionSymbol];
      if (!c) { totalSkipped++; continue; }

      const last = c.lastPrice || 0;
      const bid = c.bid || 0;
      const ask = c.ask || 0;
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
      if (last <= 0 && bid <= 0 && ask <= 0) { totalSkipped++; continue; }

      const price = mid > 0 ? mid : (last > 0 ? last : ask);
      pos.lastPrice = price;
      pos.lastBid = bid;
      pos.lastAsk = ask;
      pos.lastUpdated = new Date().toISOString();
      pos.pricingSource = 'yahoo-bulk';
      if (pos.peakPrice === null || price > (pos.peakPrice || 0)) pos.peakPrice = price;

      if (pos.entryPrice > 0 && pos.entryPrice * 100 <= SIM_ALLOCATION) {
        const contracts = Math.max(1, Math.floor(SIM_ALLOCATION / (pos.entryPrice * 100)));
        pos.simulatedPnl = Math.round((price - pos.entryPrice) * 100 * contracts * 100) / 100;
        pos.simulatedPnlPct = Math.round(((price - pos.entryPrice) / pos.entryPrice) * 10000) / 100;
      }
      tickerPriced++;
      totalPriced++;
    }

    if ((i + 1) % 50 === 0 || i === tickers.length - 1) {
      console.log(`[${i + 1}/${tickers.length}] ${yt}: ${tickerPriced}/${group.positions.length} priced | total: ${totalPriced}`);
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Priced: ${totalPriced}`);
  console.log(`No match in chain: ${totalSkipped}`);
  console.log(`No chain data: ${totalNoChain}`);

  // Backup + save
  const backup = STATE_FILE + '.bak-yahoo-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(STATE_FILE, backup);
  console.log(`Backup: ${backup}`);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log('State written.');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
