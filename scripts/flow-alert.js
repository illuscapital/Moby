#!/usr/bin/env node
// Flow alert scanner with reliable file-based deduplication
// Sends Signal notifications only for new alerts

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_TOKEN = process.env.UW_API_TOKEN;
if (!API_TOKEN) { console.error('UW_API_TOKEN not set'); process.exit(1); }
const DATA_DIR = path.join(__dirname, '..', 'flow-strategy', 'data');
const SEEN_FILE = path.join(DATA_DIR, 'seen-flow-alerts.json');

// Deduplication window: 7 days
const DEDUP_DAYS = 7;

// Minimum premium to report ($100K)
const MIN_PREMIUM = 100000;

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

function loadSeenAlerts() {
  if (!fs.existsSync(SEEN_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveSeenAlerts(seen) {
  // Prune entries older than DEDUP_DAYS
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DEDUP_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  
  const pruned = {};
  for (const [key, date] of Object.entries(seen)) {
    if (date >= cutoffStr) pruned[key] = date;
  }
  
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify(pruned, null, 2));
  return pruned;
}

function makeDedupKey(alert) {
  const ticker = alert.ticker || 'UNKNOWN';
  const strike = alert.strike || '0';
  const type = (alert.type || 'unknown').toUpperCase();
  const expiry = alert.expiry || 'unknown';
  return `${ticker}:${strike}${type}:${expiry}`;
}

function formatPremium(premium) {
  const p = parseFloat(premium || 0);
  if (p >= 1000000) return `$${(p/1000000).toFixed(2)}M`;
  return `$${(p/1000).toFixed(0)}K`;
}

function formatAlert(alert) {
  const ticker = alert.ticker;
  const strike = alert.strike;
  const type = alert.type === 'call' ? 'C' : 'P';
  const expiry = alert.expiry;
  const premium = formatPremium(alert.total_premium);
  const volOi = parseFloat(alert.volume_oi_ratio || 0).toFixed(1);
  const underlying = parseFloat(alert.underlying_price || 0).toFixed(2);
  const otmPct = alert.type === 'call'
    ? ((strike - underlying) / underlying * 100).toFixed(1)
    : ((underlying - strike) / underlying * 100).toFixed(1);
  const sweep = alert.has_sweep ? '🔥 sweep' : '';
  const repeated = alert.repeated_hits > 1 ? `📊 ${alert.repeated_hits}x hits` : '';
  
  // One-liner read
  let read = '';
  if (parseFloat(otmPct) > 20) read = '🚀 Moonshot OTM bet';
  else if (alert.has_sweep) read = '💨 Aggressive accumulation';
  else if (parseFloat(volOi) > 20) read = '⚡ Unusual size vs OI';
  else if (alert.repeated_hits > 2) read = '🎯 Repeated conviction';
  else read = '📈 Directional flow';
  
  // Earnings context
  let erContext = '';
  if (alert.next_earnings_date) {
    const daysToEr = Math.round((new Date(alert.next_earnings_date) - new Date()) / 86400000);
    if (daysToEr <= 5) erContext = ` ⚡ ER in ${daysToEr}d`;
  }
  
  return `**${ticker}** — ${strike}${type} @ ${expiry} — **${premium}**${erContext}
• Stock $${underlying} (${otmPct}% OTM) | Vol/OI ${volOi}x ${sweep} ${repeated}
• ${read}`;
}

function sendSignal(message) {
  const target = process.env.SIGNAL_TARGET_UUID;
  if (!target) { console.error('SIGNAL_TARGET_UUID not set'); return false; }
  const cmd = `openclaw message send --channel signal --target "${target}" --message "${message.replace(/"/g, '\\"')}"`;
  try {
    execSync(cmd, { stdio: 'inherit' });
    return true;
  } catch (e) {
    console.error('Signal send failed:', e.message);
    return false;
  }
}

async function main() {
  console.log('Fetching Unusual Whales flow alerts...');
  
  const url = `https://api.unusualwhales.com/api/option-trades/flow-alerts?min_premium=${MIN_PREMIUM}&is_otm=true&size_greater_oi=true&limit=20`;
  
  let result;
  try {
    result = await fetch(url);
  } catch (e) {
    console.error('API fetch failed:', e.message);
    process.exit(1);
  }
  
  if (!result.data || !result.data.length) {
    console.log('No alerts returned');
    process.exit(0);
  }
  
  const seen = loadSeenAlerts();
  const today = new Date().toISOString().slice(0, 10);
  const newAlerts = [];
  
  for (const alert of result.data) {
    const key = makeDedupKey(alert);
    if (!seen[key]) {
      seen[key] = today;
      newAlerts.push(alert);
    }
  }
  
  // Save updated seen file (with pruning)
  saveSeenAlerts(seen);
  
  console.log(`Fetched ${result.data.length} alerts, ${newAlerts.length} new`);
  
  if (newAlerts.length === 0) {
    console.log('No new alerts to report');
    process.exit(0);
  }
  
  // Format and send
  const lines = newAlerts.map(formatAlert);
  const header = `🐋 **Unusual Whales Flow Alert** — ${newAlerts.length} new trade${newAlerts.length > 1 ? 's' : ''}`;
  const message = header + '\n\n' + lines.join('\n\n');
  
  console.log('\n' + message + '\n');
  
  // Send via Signal
  sendSignal(message);
  
  console.log('Alert sent to Signal');
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
