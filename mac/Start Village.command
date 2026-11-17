#!/bin/bash
# Start Village: double-click to start the village helper and open the village.
# A Terminal window opens and shows what everyone is doing; close it (or press
# Ctrl+C in it) to stop the helper. Uses your Claude Pro login: no API key.

cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin:$PATH"

if curl -s -m 1 http://127.0.0.1:7777/hello >/dev/null 2>&1; then
  echo "The village helper is already running. Opening the village…"
  open index.html
  exit 0
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed (see helper/README.md, step 1)."
  read -r -p "Press Return to close."
  exit 1
fi
(sleep 2; open index.html) &
node helper/marshall-helper.js
