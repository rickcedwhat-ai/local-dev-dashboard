#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Ensure Homebrew Node/npm are visible even when launched outside a login shell.
if [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [[ -x /usr/local/bin/brew ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:${PATH:-}"

echo "Starting Local Dev Dashboard on http://localhost:4000..."
exec node server.mjs
