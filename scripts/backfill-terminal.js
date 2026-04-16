#!/usr/bin/env node
// Backfill expired unpriced shadow positions with terminal intrinsic value.
// For each expired option, fetches the underlying's closing price on expiry day
// from Yahoo Finance, then calculates intrinsic value.
//
// Usage: node scripts/backfill-terminal.js [--dry-run]

const fs = require('fs');
const path = require('path');
const https = require('https');

const STATE_FILE = path.join(__dirname, '..', 'data', 'shadow-state.json');
const DRY_RUN = process.argv.includes('--dry-run');
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// Index ticker → Yahoo symbol mapping
const INDEX_MAP = {
  'SPXW': '^GSPC', 'SPX': '^GSPC', 'XSP': '^GSPC',
  'NDX': '^NDX',
  'RUTW': '^RUT', 'RUT': '^RUT',
  'VIXW': '^VIX', 'VIX': '^VIX',
  'DJX': '^DJI', 'DIA': 'DIA',
  'BRKB': 'BRK-B',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fetch closing price for a ticker on a specific date from Yahoo
function fetchClose(yahooSymbol, date) {
  return new Promise((resolve, reject) => {
    // date is YYYY-MM-DD, need to get that day's close
    // Use period1 = start of that day, period2 = end of next day (UTC)
    const d = new Date(date + 'T00:00:00Z');
    const period1 = Math.floor(d.getTime() / 1000);
    const period2 = period1 + 2 * 86400; // +2 days to ensure we capture the close

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?period1=${period1}&period2=${period2}&interval=1d`;

    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const result = json?.chart?.result?.[0];
          if (!result || !result.timestamp || !result.indicators?.quote?.[0]?.close) {
            resolve(null);
            return;
          }
          // Find the close for the matching date
          const timestamps = result.timestamp;
          const closes = result.indicators.quote[0].close;
          for (let i = 0; i < timestamps.length; i++) {
            const tsDate = new Date(timestamps[i] * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
            if (tsDate === date && closes[i] != null) {
              resolve(closes[i]);
              return;
            }
          }
          // If exact date not found (weekend/holiday), take the last available close before
          for (let i = timestamps.length - 1; i >= 0; i--) {
            const tsDate = new Date(timestamps[i] * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
            if (tsDate <= date && closes[i] != null) {
              resolve(closes[i]);
              return;
            }
          }
          resolve(null);
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function main() {
  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}Loading shadow state...`);
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const positions = state.positions;

  // Find expired unpriced
  const unpriced = Object.entries(positions)
    .filter(([, p]) => p.expiry && p.expiry < TODAY && (!p.lastPrice || p.lastPrice === 0) && p.status === 'expired');

  console.log(`Found ${unpriced.length} expired unpriced positions`);

  // Group by ticker+expiry to minimize API calls
  const groups = new Map(); // key: yahooSymbol|expiry → { yahooSymbol, expiry, positionKeys[] }
  for (const [key, p] of unpriced) {
    const yahooSymbol = INDEX_MAP[p.ticker] || p.ticker;
    const gk = `${yahooSymbol}|${p.expiry}`;
    if (!groups.has(gk)) groups.set(gk, { yahooSymbol, expiry: p.expiry, positionKeys: [] });
    groups.get(gk).positionKeys.push({ key, strike: p.strike, type: p.type, entryPrice: p.entryPrice, ticker: p.ticker });
  }

  console.log(`Need ${groups.size} Yahoo API calls (unique symbol+expiry combos)\n`);

  let filled = 0, failed = 0, worthless = 0, itm = 0;

  let i = 0;
  for (const [gk, group] of groups) {
    i++;
    const close = await fetchClose(group.yahooSymbol, group.expiry);

    if (close === null) {
      console.log(`[${i}/${groups.size}] MISS: ${group.yahooSymbol} on ${group.expiry} — no data (${group.positionKeys.length} positions)`);
      // Mark as expired worthless with unknown source
      for (const pk of group.positionKeys) {
        if (!DRY_RUN) {
          const pos = positions[pk.key];
          pos.lastPrice = 0;
          pos.pricingSource = 'expired-unknown';
          pos.simulatedPnl = -Math.floor((pos.entryPrice || 0) * (Math.floor(500 / (pos.entryPrice || 1)) || 1) * 100) / 100;
          pos.simulatedPnlPct = -100;
        }
        filled++;
      }
      failed += group.positionKeys.length;
      await sleep(300);
      continue;
    }

    // Calculate intrinsic value for each position in this group
    for (const pk of group.positionKeys) {
      let intrinsic;
      if (pk.type === 'call') {
        intrinsic = Math.max(0, close - pk.strike);
      } else {
        intrinsic = Math.max(0, pk.strike - close);
      }
      // Round to 2 decimals
      intrinsic = Math.round(intrinsic * 100) / 100;

      if (!DRY_RUN) {
        const pos = positions[pk.key];
        pos.lastPrice = intrinsic;
        pos.pricingSource = 'terminal-calc';
        pos.terminalUnderlying = Math.round(close * 100) / 100;

        // Calculate simulated PnL: (lastPrice - entryPrice) * contracts
        const entry = pos.entryPrice || pos.entryAsk || 0;
        const contracts = entry > 0 ? Math.floor(500 / entry) : 0;
        if (contracts > 0 && entry > 0) {
          pos.simulatedPnl = Math.round((intrinsic - entry) * contracts * 100) / 100;
          pos.simulatedPnlPct = Math.round(((intrinsic - entry) / entry) * 10000) / 100;
        }
      }

      if (intrinsic === 0) worthless++;
      else itm++;
      filled++;
    }

    if (i % 25 === 0 || i === groups.size) {
      console.log(`[${i}/${groups.size}] ${group.yahooSymbol} ${group.expiry}: close=${close.toFixed(2)} → ${group.positionKeys.length} positions`);
    }

    await sleep(400); // be kind to Yahoo
  }

  console.log(`\n--- Summary ---`);
  console.log(`Filled: ${filled} / ${unpriced.length}`);
  console.log(`  ITM (intrinsic > 0): ${itm}`);
  console.log(`  Worthless (intrinsic = 0): ${worthless}`);
  console.log(`  No data (marked expired-unknown): ${failed}`);

  if (!DRY_RUN) {
    // Backup before writing
    const backup = STATE_FILE + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(STATE_FILE, backup);
    console.log(`\nBackup: ${backup}`);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log('State written.');
  } else {
    console.log('\n[DRY RUN] No changes written.');
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
