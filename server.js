// WATTx UTXO/ordinals indexer API.
// Address UTXOs + balance (via scantxoutset — works for base58/segwit/taproot
// with no addressindex), raw-tx broadcast, and ordinal inscription content.
// This is the backend the WATTx wallet extension and invoice-minting need.
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ---- wattxd RPC ----
function conf() {
  try {
    const c = fs.readFileSync(path.join(os.homedir(), '.wattx', 'wattx.conf'), 'utf8');
    const g = (k) => (c.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim();
    return { user: g('rpcuser'), pass: g('rpcpassword'), port: g('rpcport') || '3889' };
  } catch { return {}; }
}
const C = conf();
const RPC_URL = process.env.WATTX_RPC || `http://127.0.0.1:${C.port}`;
const AUTH = 'Basic ' + Buffer.from(`${process.env.RPC_USER || C.user}:${process.env.RPC_PASS || C.pass}`).toString('base64');
let rpcId = 0;
async function rpc(method, params = []) {
  const r = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: AUTH },
    body: JSON.stringify({ jsonrpc: '1.0', id: ++rpcId, method, params }),
  });
  const j = await r.json();
  if (j.error) { const e = new Error(j.error.message); e.rpc = j.error; throw e; }
  return j.result;
}

// scantxoutset is heavy (scans the whole UTXO set); cache results briefly per address.
const utxoCache = new Map(); // addr -> { at, utxos }
const TTL = 8000;
async function scanAddress(addr) {
  const hit = utxoCache.get(addr);
  if (hit && Date.now() - hit.at < TTL) return hit.utxos;
  const res = await rpc('scantxoutset', ['start', [`addr(${addr})`]]);
  const utxos = (res.unspents || []).map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: Math.round(u.amount * 1e8),   // satoshis
    height: u.height,
    scriptPubKey: u.scriptPubKey,
  }));
  utxoCache.set(addr, { at: Date.now(), utxos });
  return utxos;
}

// ---- inscription indexer ----
// Scans blocks for ord reveals (a vin[0] witness carrying an "ord" envelope) and
// keeps a light in-memory index so the marketplace can LIST ordinals. Young chain,
// so a full scan on boot is fine; then it follows the tip.
const inscriptions = [];               // newest-first: {id, height, contentType, address, time}
const seen = new Set();
let indexedHeight = 0;

function scanTxForInscription(tx, height, time) {
  const vin = tx.vin && tx.vin[0];
  const wit = vin && vin.txinwitness;
  if (!wit || wit.length < 2) return;
  const script = Buffer.from(wit[1], 'hex');
  const i = script.indexOf(Buffer.from('ord'));
  if (i < 0) return;
  const id = tx.txid + 'i0';
  if (seen.has(id)) return;
  seen.add(id);
  let contentType = 'application/octet-stream';
  try { contentType = parseEnvelope(script, i + 3).contentType || contentType; } catch {}
  const address = (tx.vout[0] && tx.vout[0].scriptPubKey && tx.vout[0].scriptPubKey.address) || null;
  inscriptions.unshift({ id, height, contentType, address, time });
}

async function indexFrom(start, tip) {
  for (let h = start; h <= tip; h++) {
    try {
      const block = await rpc('getblock', [await rpc('getblockhash', [h]), 2]);
      for (const tx of block.tx) scanTxForInscription(tx, h, block.time);
      indexedHeight = h;
    } catch { /* skip */ }
  }
}
const SCAN_WINDOW = parseInt(process.env.SCAN_WINDOW || '1500'); // blocks to scan on boot
async function indexer() {
  try {
    const tip = await rpc('getblockcount');
    if (indexedHeight === 0) indexedHeight = Math.max(0, tip - SCAN_WINDOW); // don't rescan genesis each boot
    if (tip > indexedHeight) await indexFrom(indexedHeight + 1, tip);
  } catch {}
  setTimeout(indexer, 15000);
}

// ---- API ----
const app = express();
app.use(express.json({ limit: '4mb' })); // inscriptions can be large
app.use((_, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'content-type');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  next();
});
app.options('*', (_, res) => res.sendStatus(204));

const ADDR = /^(wx1[a-z0-9]{20,90}|[W][1-9A-HJ-NP-Za-km-z]{25,40})$/; // WATTx bech32 or base58

app.get('/health', async (_, res) => {
  try { res.json({ ok: true, height: await rpc('getblockcount'), chain: 'wattx', rpc: RPC_URL }); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

app.get('/inscriptions', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 60, 200);
  res.json({ total: inscriptions.length, indexedHeight, items: inscriptions.slice(0, limit) });
});

app.get('/address/:addr/utxo', async (req, res) => {
  const { addr } = req.params;
  if (!ADDR.test(addr)) return res.status(400).json({ error: 'invalid WATTx address' });
  try { res.json(await scanAddress(addr)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/address/:addr/balance', async (req, res) => {
  const { addr } = req.params;
  if (!ADDR.test(addr)) return res.status(400).json({ error: 'invalid WATTx address' });
  try {
    const utxos = await scanAddress(addr);
    const confirmed = utxos.reduce((s, u) => s + u.value, 0);
    res.json({ confirmed, unconfirmed: 0, utxoCount: utxos.length });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/tx', async (req, res) => {
  const hex = req.body && req.body.hex;
  if (!hex || !/^[0-9a-fA-F]+$/.test(hex)) return res.status(400).json({ error: 'missing tx hex' });
  try {
    const txid = await rpc('sendrawtransaction', [hex]);
    utxoCache.clear(); // spent inputs are now stale
    res.json({ txid });
  } catch (e) { res.status(400).json({ error: e.message, rpc: e.rpc }); }
});

app.get('/tx/:txid', async (req, res) => {
  try { res.json(await rpc('getrawtransaction', [req.params.txid, 1])); }
  catch (e) { res.status(404).json({ error: e.message }); }
});

// Ordinal inscription content: pull the ord envelope out of a reveal tx's witness.
app.get('/inscription/:id', async (req, res) => {
  const m = req.params.id.match(/^([0-9a-fA-F]{64})i(\d+)$/);
  if (!m) return res.status(400).json({ error: 'bad inscription id (expect <txid>i<n>)' });
  try {
    const tx = await rpc('getrawtransaction', [m[1], 1]);
    const wit = (tx.vin[0] && tx.vin[0].txinwitness) || [];
    if (wit.length < 2) return res.status(404).json({ error: 'no inscription witness' });
    const script = Buffer.from(wit[1], 'hex');
    const i = script.indexOf(Buffer.from('ord'));
    if (i < 0) return res.status(404).json({ error: 'no ord envelope' });
    // parse: "ord" 01 <len><content-type> 00 <len><data...>
    const { contentType, data } = parseEnvelope(script, i + 3);
    res.set('content-type', contentType || 'application/octet-stream');
    res.send(data);
  } catch (e) { res.status(404).json({ error: e.message }); }
});

// minimal pushdata parser for the ord envelope after the "ord" tag
function parseEnvelope(buf, p) {
  const read = () => {
    let op = buf[p++];
    let len = 0;
    if (op <= 0x4b) len = op;
    else if (op === 0x4c) { len = buf[p++]; }
    else if (op === 0x4d) { len = buf[p] | (buf[p + 1] << 8); p += 2; }
    else if (op === 0x4e) { len = buf.readUInt32LE(p); p += 4; }
    else return null; // OP_0 / OP_ENDIF etc.
    const out = buf.subarray(p, p + len); p += len; return out;
  };
  read(); // 01 tag field id
  const contentType = (read() || Buffer.from('')).toString('utf8');
  read(); // 00 body separator
  const chunks = [];
  while (p < buf.length) {
    const op = buf[p];
    if (op === 0x68) break; // OP_ENDIF
    const c = read();
    if (c === null) break;
    chunks.push(c);
  }
  return { contentType, data: Buffer.concat(chunks) };
}

const PORT = process.env.PORT || 3600;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`wattx-utxo-api on :${PORT} → ${RPC_URL}`);
  indexer(); // start scanning blocks for ordinals
});
