#!/usr/bin/env node
// Collects unusual options flow alerts and saves to daily JSONL files
// Run every 30 min during market hours via cron

const https = require('https');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const API_TOKEN = process.env.UW_API_TOKEN;
if (!API_TOKEN) { console.error('Missing UW_API_TOKEN env var'); process.exit(1); }
const DATA_DIR = path.join(__dirname, 'data');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'Authorization': `Bearer ${API_TOKEN}` }
    }, res => {
      if (res.statusCode === 429) {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => reject(new Error('RATE_LIMITED')));
        return;
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error(`Parse error: ${d.slice(0,200)}`)); }
      });
    }).on('error', reject);
  });
}

async function collectFlowAlerts() {
  // Pull flow alerts: large premium, OTM, size > OI
  const params = new URLSearchParams({
    limit: '200',
    min_premium: '100000',
    is_otm: 'true',
    size_greater_oi: 'true'
  });

  const url = `https://api.unusualwhales.com/api/option-trades/flow-alerts?${params}`;
  const result = await fetch(url);

  if (!result.data || !result.data.length) {
    console.log('No flow alerts returned');
    return;
  }

  // Load existing IDs to dedupe
  const today = new Date().toISOString().slice(0, 10);
  const outFile = path.join(DATA_DIR, `flow-${today}.jsonl`);

  const existingIds = new Set();
  if (fs.existsSync(outFile)) {
    fs.readFileSync(outFile, 'utf8').trim().split('\n').forEach(line => {
      try {
        const r = JSON.parse(line);
        existingIds.add(r.id);
      } catch (e) {}
    });
  }

  let newCount = 0;
  const fd = fs.openSync(outFile, 'a');
  for (const alert of result.data) {
    if (!existingIds.has(alert.id)) {
      fs.writeSync(fd, JSON.stringify(alert) + '\n');
      existingIds.add(alert.id);
      newCount++;
    }
  }
  fs.closeSync(fd);

  console.log(`Collected ${result.data.length} alerts, ${newCount} new. File: ${outFile}`);
}

// Also collect from screener (different perspective - individual contracts)
async function collectScreener() {
  const params = new URLSearchParams({
    limit: '150',
    min_premium: '200000',
    is_otm: 'true',
    vol_greater_oi: 'true',
    'issue_types[]': 'Common Stock',
    max_dte: '45',
    min_volume_oi_ratio: '3'
  });

  // Calls
  const callUrl = `https://api.unusualwhales.com/api/screener/option-contracts?${params}&type=Calls`;
  const putUrl = `https://api.unusualwhales.com/api/screener/option-contracts?${params}&type=Puts`;

  const [calls, puts] = await Promise.all([fetch(callUrl), fetch(putUrl)]);

  const today = new Date().toISOString().slice(0, 10);
  const outFile = path.join(DATA_DIR, `screener-${today}.jsonl`);

  const existingSymbols = new Set();
  if (fs.existsSync(outFile)) {
    fs.readFileSync(outFile, 'utf8').trim().split('\n').forEach(line => {
      try {
        const r = JSON.parse(line);
        existingSymbols.add(r.option_symbol);
      } catch (e) {}
    });
  }

  let newCount = 0;
  const fd = fs.openSync(outFile, 'a');
  const allData = [...(calls.data || []), ...(puts.data || [])];
  for (const rec of allData) {
    if (!existingSymbols.has(rec.option_symbol)) {
      fs.writeSync(fd, JSON.stringify({ ...rec, collected_at: new Date().toISOString(), type: calls.data?.includes(rec) ? 'call' : 'put' }) + '\n');
      existingSymbols.add(rec.option_symbol);
      newCount++;
    }
  }
  fs.closeSync(fd);

  console.log(`Screener: ${allData.length} contracts, ${newCount} new. File: ${outFile}`);
}

// ─── Enrichment: IV Percentile + Dark Pool per ticker ───
const ENRICHMENT_FILE = path.join(DATA_DIR, 'enrichment-cache.json');
const ENRICHMENT_MAX_AGE_MS = 30 * 60 * 1000; // refresh after 30min
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function loadEnrichmentCache() {
  if (fs.existsSync(ENRICHMENT_FILE)) {
    try { return JSON.parse(fs.readFileSync(ENRICHMENT_FILE, 'utf8')); }
    catch (e) { return {}; }
  }
  return {};
}

function saveEnrichmentCache(cache) {
  fs.writeFileSync(ENRICHMENT_FILE, JSON.stringify(cache, null, 2));
}

async function enrichTickers() {
  // Get unique tickers from today's flow file
  const today = new Date().toISOString().slice(0, 10);
  const flowFile = path.join(DATA_DIR, `flow-${today}.jsonl`);
  if (!fs.existsSync(flowFile)) { console.log('Enrichment: no flow file for today'); return; }

  const tickers = new Set();
  fs.readFileSync(flowFile, 'utf8').trim().split('\n').forEach(line => {
    try { tickers.add(JSON.parse(line).ticker); } catch (e) {}
  });

  // Skip indexes — no options data worth enriching
  const SKIP = new Set(['SPX', 'SPXW', 'SPY', 'QQQ', 'IWM', 'DIA', 'XSP', 'VIX', 'NDX', 'RUT']);
  const toEnrich = [...tickers].filter(t => !SKIP.has(t));

  const cache = loadEnrichmentCache();
  const now = Date.now();
  let fetched = 0, skipped = 0;

  for (const ticker of toEnrich) {
    // Skip if we have fresh data
    if (cache[ticker] && (now - cache[ticker]._fetchedAt) < ENRICHMENT_MAX_AGE_MS) {
      skipped++;
      continue;
    }

    const entry = { _ticker: ticker, _fetchedAt: now };

    // 1. IV Percentile
    try {
      await sleep(550);
      const ivResult = await fetch(`https://api.unusualwhales.com/api/stock/${ticker}/interpolated-iv`);
      const entries = ivResult?.data || [];
      const d30 = entries.find(e => e.days == 30) || {};
      const d365 = entries.find(e => e.days == 365) || {};
      entry._iv30 = parseFloat(d30.volatility || 0);
      entry._ivPctl = parseFloat(d365.percentile || d30.percentile || 0);
      entry._impliedMove = parseFloat(d30.implied_move_perc || 0);
    } catch (e) {
      console.error(`  IV fetch failed for ${ticker}: ${e.message}`);
    }

    // 2. Dark Pool
    try {
      await sleep(550);
      const dpResult = await fetch(`https://api.unusualwhales.com/api/darkpool/${ticker}`);
      const prints = dpResult?.data || [];
      const recent = prints.slice(0, 20); // last 20 prints

      let totalVolume = 0, buyVolume = 0, sellVolume = 0, totalNotional = 0;
      for (const p of recent) {
        const size = parseFloat(p.size || 0);
        const price = parseFloat(p.price || 0);
        totalVolume += size;
        totalNotional += size * price;
        // UW sometimes provides a 'type' or we can infer from price vs NBBO
        // For now just track total volume and count
      }

      entry._dpPrintCount = prints.length;
      entry._dpRecentVolume = totalVolume;
      entry._dpRecentNotional = totalNotional;
      entry._dpAvgPrintSize = recent.length > 0 ? Math.round(totalVolume / recent.length) : 0;
    } catch (e) {
      console.error(`  DP fetch failed for ${ticker}: ${e.message}`);
    }

    // Only cache if we got real data (not rate limited zeros)
    if (entry._iv30 > 0 || entry._dpPrintCount > 0) {
      cache[ticker] = entry;
      fetched++;
    } else {
      console.log(`  SKIP cache for ${ticker} (no data returned — possible rate limit)`);
    }
  }

  saveEnrichmentCache(cache);
  console.log(`Enrichment: ${fetched} tickers fetched, ${skipped} cached, ${toEnrich.length} total`);
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  await collectFlowAlerts();
  await collectScreener();
  await enrichTickers();
}

main().catch(e => console.error('Error:', e.message));
