# wattx-utxo-api

The WATTx UTXO/ordinals indexer API — the backend the [WATTx wallet extension]
and invoice-based ordinal minting need. Talks to `wattxd`, exposes a small HTTP API.

## Endpoints (CORS-open)
| Method | Path | Returns |
|---|---|---|
| GET | `/health` | `{ok, height}` |
| GET | `/address/:addr/utxo` | `[{txid, vout, value(sat), height, scriptPubKey}]` |
| GET | `/address/:addr/balance` | `{confirmed, unconfirmed, utxoCount}` |
| POST | `/tx` `{hex}` | `{txid}` (broadcast) |
| GET | `/tx/:txid` | decoded raw transaction |
| GET | `/inscription/:id` | the ordinal's file (served with its content-type) |

Works for base58, segwit (`wx1q…`), and taproot (`wx1p…`) addresses.

## How it fetches UTXOs
Via `scantxoutset` — works for **any** address with no `addressindex` (the node's
addressindex is present in config but not populated). Results are cached 8s.

⚠ `scantxoutset` scans the whole UTXO set per query; fine on the young chain,
but for scale, run the node with a working `addressindex`/`-reindex` and switch
to `getaddressutxos`, or put a Blockbook/Esplora indexer behind this API.

## Run
```bash
npm install && npm start          # :3600, reads ~/.wattx/wattx.conf for RPC creds
# env overrides: PORT, WATTX_RPC, RPC_USER, RPC_PASS
```

## Deploy (public)
Point the wallet extension's `UTXO_API` at it. To expose publicly, front it with
nginx/TLS on a subdomain (e.g. `ord-api.wattxchange.app`) the same way the janus
RPC is exposed, and run it under pm2/systemd for reboot-safety.
