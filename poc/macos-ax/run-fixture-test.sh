#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

"$SCRIPT_DIR/fixture-app" >/tmp/dp-ax-fixture.log 2>&1 &
FIXTURE_PID=$!
trap 'kill "$FIXTURE_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  if grep -q "FIXTURE_READY" /tmp/dp-ax-fixture.log 2>/dev/null; then
    break
  fi
  sleep 0.1
done
sleep 0.2

"$SCRIPT_DIR/ax-probe" --pid "$FIXTURE_PID" --press-id safe-native-btn
sleep 0.2
echo "--- fixture log ---"
cat /tmp/dp-ax-fixture.log
