#!/usr/bin/env node
// Collects unusual options flow alerts and saves to daily JSONL files
// Run every 30 min during market hours via cron

const https = require('https');
const fs = require('fs');
const path = require('path');

const API_TOKEN = process.env.UW_API_TOKEN;
if (!API_TOKEN) { console.error('Missing UW_API_TOKEN env var'); process.exit(1); }
const DATA_DIR = path.join(__dirname, 'data');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'Authorization': `Bearer ${API_TOKEN}` }
    }, res => {
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

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  await collectFlowAlerts();
  await collectScreener();
}

main().catch(e => console.error('Error:', e.message));
