#!/usr/bin/env bash
set -euo pipefail
JAVA21_HOME="$(/usr/libexec/java_home -v 21)"
echo "Using JAVA_HOME=$JAVA21_HOME"
"$JAVA21_HOME/bin/java" -version 2>&1
"$JAVA21_HOME/bin/javac" -d poc/java-a11y poc/java-a11y/SwingJavaFxPoc.java
"$JAVA21_HOME/bin/java" -cp poc/java-a11y SwingJavaFxPoc >/tmp/dp-swing-poc.log 2>&1 &
JPID=$!
trap 'kill "$JPID" 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if grep -q '"swing-gui"' /tmp/dp-swing-poc.log 2>/dev/null; then
    break
  fi
  sleep 0.1
done
sleep 0.4

./poc/macos-ax/ax-probe --pid "$JPID" --enhanced-ax --press-title "Safe Swing Action"
sleep 0.2
cat /tmp/dp-swing-poc.log
