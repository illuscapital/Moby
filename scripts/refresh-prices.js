#!/usr/bin/env node
// One-off: refresh all active shadow prices from UW, fallback to Yahoo
const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const API_TOKEN = process.env.UW_API_TOKEN;
const STATE_FILE = path.join(__dirname, '..', 'data', 'shadow-state.json');
const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

function fetchJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 15000 }, res => {
      if (res.statusCode === 429) return reject(new Error('RATE_LIMITED'));
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
  });
}

// Group active positions by ticker
const tickerGroups = {};
for (const pos of Object.values(state.positions)) {
  if (pos.status !== 'active') continue;
  if (!tickerGroups[pos.ticker]) tickerGroups[pos.ticker] = [];
  tickerGroups[pos.ticker].push(pos);
}

const tickers = Object.keys(tickerGroups);
console.log(`Active positions: ${Object.values(state.positions).filter(p => p.status === 'active').length}`);
console.log(`Tickers to price: ${tickers.length}`);

async function run() {
  let pricedCount = 0, tickersDone = 0, rateLimits = 0;

  for (const ticker of tickers) {
    const positions = tickerGroups[ticker];
    try {
      await sleep(500);
      const url = `https://api.unusualwhales.com/api/stock/${ticker}/option-contracts`;
      const result = await fetchJson(url, { Authorization: 'Bearer ' + API_TOKEN, Accept: 'application/json' });
      const contracts = result?.data || [];

      const lookup = {};
      for (const c of contracts) {
        if (c.option_symbol) lookup[c.option_symbol] = c;
      }

      for (const pos of positions) {
        const c = lookup[pos.optionSymbol];
        if (!c) continue;

        const last = parseFloat(c.last_price) || 0;
        const bid = parseFloat(c.nbbo_bid) || 0;
        const ask = parseFloat(c.nbbo_ask) || 0;
        const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
        if (last <= 0 && bid <= 0 && ask <= 0) continue;

        pos.lastPrice = mid > 0 ? mid : (last > 0 ? last : ask);
        pos.lastBid = bid;
        pos.lastAsk = ask;
        pos.lastUpdated = new Date().toISOString();

        if (!pos.peakPrice || pos.lastPrice > pos.peakPrice) pos.peakPrice = pos.lastPrice;

        if (pos.entryPrice > 0 && pos.entryPrice * 100 <= 5000) {
          const ctrs = Math.floor(5000 / (pos.entryPrice * 100));
          pos.simulatedPnl = (pos.lastPrice - pos.entryPrice) * 100 * ctrs;
          pos.simulatedPnlPct = (pos.lastPrice - pos.entryPrice) / pos.entryPrice * 100;
        }
        pricedCount++;
      }

      tickersDone++;
      if (tickersDone % 100 === 0) {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        console.log(`[${tickersDone}/${tickers.length}] ${pricedCount} priced`);
      }
    } catch (e) {
      if (e.message === 'RATE_LIMITED') {
        rateLimits++;
        console.log(`Rate limited at ticker ${tickersDone}, waiting 3s (total: ${rateLimits})`);
        if (rateLimits > 20) { console.log('Too many rate limits, stopping'); break; }
        await sleep(3000);
        tickersDone--; // retry
      }
    }
  }

  state.lastRun = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`=== DONE === ${tickersDone} tickers, ${pricedCount} positions priced, ${rateLimits} rate limits`);
}

run().catch(e => console.error(e));
