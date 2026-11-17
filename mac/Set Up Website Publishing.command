#!/bin/bash
# Set Up Website Publishing: one time, so the village's Publish button can put a
# finished website on your free GitHub Pages site (https://<your-github-name>.github.io/...).
#  - Uses GitHub's own tool, "gh", to sign in to your GitHub account in your browser.
#  - Creates ONE public repository for your websites: <your-github-name>.github.io
#  - Agents never publish: only the Publish button in the village does, after you confirm.
# It asks before installing or creating anything.

cd "$(dirname "$0")/.." || exit 1
VILLAGE="$PWD"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
finish() { echo; read -r -p "Press Return to close."; exit "$1"; }
ask() { local a; read -r -p "$1 (y/n) " a; [ "$a" = "y" ] || [ "$a" = "Y" ]; }

if ! command -v gh >/dev/null 2>&1; then
  echo "This needs GitHub's command-line tool, \"gh\" (free, from GitHub)."
  if command -v brew >/dev/null 2>&1; then
    ask "Install it now with Homebrew?" || { echo "Nothing was changed."; finish 1; }
    brew install gh || { echo "The install didn't work. Nothing else was changed."; finish 1; }
  else
    echo "Download the macOS installer from https://cli.github.com , install it, then double-click this file again."
    open "https://cli.github.com"
    finish 1
  fi
fi

if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  echo "Next: sign in to GitHub. Your browser will open; enter the code shown here."
  gh auth login --hostname github.com --git-protocol https --web || { echo "Sign-in didn't finish. Nothing else was changed."; finish 1; }
fi
gh auth setup-git --hostname github.com >/dev/null 2>&1   # lets git use that sign-in when publishing

OWNER="$(gh api user --jq .login)" || { echo "Couldn't read your GitHub name."; finish 1; }
REPO="$OWNER/$OWNER.github.io"
URL="https://$OWNER.github.io"

if gh repo view "$REPO" >/dev/null 2>&1; then
  echo "Your website repository already exists: https://github.com/$REPO"
else
  echo "Websites will live in a new PUBLIC repository: https://github.com/$REPO"
  echo "and appear at $URL/<site-name>/ once you press Publish."
  ask "Create it now?" || { echo "Nothing was created."; finish 1; }
  gh repo create "$REPO" --public --description "Websites made in My AI Village" --add-readme || { echo "Couldn't create it."; finish 1; }
fi
# turn on GitHub Pages from the main branch (already on for <name>.github.io repositories)
gh api -X POST "repos/$REPO/pages" -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 || true

mkdir -p "$VILLAGE/helper/marshall-home"
REPO="$REPO" URL="$URL" node -e '
  const fs = require("fs"), f = process.argv[1];
  let s = {}; try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  s.pages = { repo: process.env.REPO, url: process.env.URL };
  fs.writeFileSync(f, JSON.stringify(s, null, 2));
' "$VILLAGE/helper/marshall-home/settings.json" || { echo "Couldn't save the setting."; finish 1; }

echo
echo "Done. Website publishing is set up: $URL"
echo "In the village, press Preview on a finished website, then Publish when you like it."
finish 0
