#!/bin/sh
set -e

if [ "$AUTO_SEED" != "0" ] && [ ! -f "$VANTAGE_DATA/vantage.db" ]; then
  echo "[entrypoint] seeding (first boot)..."
  node seed.js
fi

exec node server.js
