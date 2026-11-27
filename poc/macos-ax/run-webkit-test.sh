#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

"$SCRIPT_DIR/webkit-fixture" >/tmp/dp-wk-fixture.log 2>&1 &
FIXTURE_PID=$!
trap 'kill "$FIXTURE_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if grep -q "WEBKIT_FIXTURE_READY" /tmp/dp-wk-fixture.log 2>/dev/null; then
    break
  fi
  sleep 0.1
done
sleep 0.2

"$SCRIPT_DIR/ax-probe" --pid "$FIXTURE_PID" --enhanced-ax --press-id wk-btn
cat /tmp/dp-wk-fixture.log
