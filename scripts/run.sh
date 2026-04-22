#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "Missing .env file. Copy .env.example to .env first." >&2
  exit 1
fi

set -a
source .env
set +a

exec node src/server.js
