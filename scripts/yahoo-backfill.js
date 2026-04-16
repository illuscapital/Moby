#!/usr/bin/env node
// One-off Yahoo Finance backfill for unpriced shadow positions
const fs = require('fs');
const path = require('path');
const https = require('https');

const STATE_FILE = path.join(__dirname, '..', 'data', 'shadow-state.json');
const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

const YAHOO_CUTOFF = '2026-03-16'; // Yahoo drops expired options after ~1 week
const unpriced = Object.entries(state.positions)
  .filter(([, p]) => (!p.lastPrice || p.lastPrice === 0) && p.optionSymbol
    && (p.status === 'active' || (p.expiry && p.expiry >= YAHOO_CUTOFF)));

console.log('Unpriced positions to backfill:', unpriced.length);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function yahooQuote(symbol) {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)' }, timeout: 10000 }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 429) return reject(new Error('RATE_LIMITED'));
        if (res.statusCode !== 200) return resolve(null); // 404 etc = not found
        try {
          const parsed = JSON.parse(data);
          const meta = parsed?.chart?.result?.[0]?.meta;
          if (meta && meta.regularMarketPrice > 0) {
            resolve({ price: meta.regularMarketPrice, high: meta.fiftyTwoWeekHigh || 0 });
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
  });
}

async function run() {
  let priced = 0, notFound = 0, errors = 0, rateLimited = 0;
  const SAVE_EVERY = 50;

  for (let i = 0; i < unpriced.length; i++) {
    const [id, pos] = unpriced[i];

    try {
      await sleep(300);
      const q = await yahooQuote(pos.optionSymbol);

      if (!q) { notFound++; }
      else {
        pos.lastPrice = q.price;
        pos.lastUpdated = new Date().toISOString();
        pos.lastSource = 'yahoo';
        if (!pos.peakPrice || q.price > pos.peakPrice) pos.peakPrice = q.price;
        if (q.high > (pos.peakPrice || 0)) pos.peakPrice = q.high;

        if (pos.entryPrice > 0 && pos.entryPrice * 100 <= 5000) {
          const ctrs = Math.floor(5000 / (pos.entryPrice * 100));
          pos.simulatedPnl = (pos.lastPrice - pos.entryPrice) * 100 * ctrs;
          pos.simulatedPnlPct = (pos.lastPrice - pos.entryPrice) / pos.entryPrice * 100;
        }
        priced++;
      }

      if ((i + 1) % SAVE_EVERY === 0) {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        console.log(`[${i + 1}/${unpriced.length}] priced=${priced} notFound=${notFound} errors=${errors} rateLimits=${rateLimited}`);
      }
    } catch (e) {
      if (e.message === 'RATE_LIMITED') {
        rateLimited++;
        console.log(`Rate limited at ${i + 1}, waiting 5s (total: ${rateLimited})`);
        if (rateLimited > 20) { console.log('Too many rate limits, saving and stopping'); break; }
        await sleep(5000);
        i--; // retry
      } else {
        errors++;
      }
    }
  }

  state.lastRun = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  const stillUnpriced = Object.values(state.positions).filter(p => !p.lastPrice || p.lastPrice === 0);
  console.log('=== DONE ===');
  console.log('Priced:', priced, '| Not found:', notFound, '| Errors:', errors, '| Rate limits:', rateLimited);
  console.log('Still unpriced:', stillUnpriced.length);
}

run().catch(e => console.error(e));
