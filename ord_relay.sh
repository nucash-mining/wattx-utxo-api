#!/bin/bash
# Publishes the local wattx-utxo-api (:3600) on the Oracle box, which
# ord-api.wattxchange.app (nginx 443 → 127.0.0.1:3600) proxies. Mirrors stats_relay.sh.
KEY="$HOME/Downloads/flopcoin/ssh/ssh-key-2026-02-01.key"
HOST="opc@129.153.28.159"
SSH_OPTS=(-i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)

# Free a stale sshd holding 3600 on the box (no ClientAliveInterval there).
ssh "${SSH_OPTS[@]}" "$HOST" '
  pids=$(sudo ss -tlnp 2>/dev/null | grep -E ":3600\b" | grep -oE "pid=[0-9]+" | sort -u | cut -d= -f2)
  for p in $pids; do sudo kill "$p" 2>/dev/null; done
' || true

exec ssh "${SSH_OPTS[@]}" -N -T \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -R 127.0.0.1:3600:127.0.0.1:3600 \
  "$HOST"
