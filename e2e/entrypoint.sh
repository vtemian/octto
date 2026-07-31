#!/usr/bin/env bash
set -euo pipefail

log() { echo "[entrypoint] $*"; }

cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT

log "starting Xvfb on ${DISPLAY}"
Xvfb "${DISPLAY}" -screen 0 1280x1024x24 -nolisten tcp &

for _ in $(seq 1 50); do
  xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && break
  sleep 0.2
done
xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 || { log "Xvfb never came up"; exit 1; }

# Chromium must already be running with CDP open: a later `xdg-open URL` then
# lands as a new tab in this instance, which is what the tests attach to.
log "starting chromium with CDP on ${CDP_PORT}"
"${CHROME_BIN}" \
  --remote-debugging-port="${CDP_PORT}" \
  --remote-debugging-address=127.0.0.1 \
  --remote-allow-origins='*' \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --user-data-dir=/tmp/chrome-profile \
  about:blank >/tmp/chromium.log 2>&1 &

for _ in $(seq 1 100); do
  curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1 || {
  log "chromium CDP never came up"; tail -40 /tmp/chromium.log; exit 1;
}

# Make xdg-open resolve to this chromium, so octto's openBrowser() reaches it.
xdg-settings set default-web-browser octto-chromium.desktop 2>/dev/null \
  || log "xdg-settings failed; relying on xdg-open fallback"

log "ready: $(curl -s "http://127.0.0.1:${CDP_PORT}/json/version" | head -c 120)"

exec "$@"
