#!/bin/bash
# Copy Old Notes: brings everyone's memories from your old village folder into this one.
# Double-click it on your Mac. It copies:
#   - every townsperson's and worker's NOTES.md
#   - Marshall's memory, the chat log and your to-do list (helper/marshall-home)
# Before copying, it backs up whatever is in this folder now, next to it, so nothing is lost.

cd "$(dirname "$0")/.." || exit 1
NEW="$PWD"
here="$(basename "$NEW")"
OLD=""
looks_like_village() { [ -f "$1/helper/marshall-helper.js" ] && [ -d "$1/agents" ] && [ "$(cd "$1" && pwd)" != "$NEW" ]; }
for c in "../ai-village-old" "../ai-village"; do
  if looks_like_village "$c"; then OLD="$(cd "$c" && pwd)"; break; fi
done
if [ -z "$OLD" ]; then
  echo "I couldn't find your old village folder next to this one."
  echo "Drag your OLD ai-village folder into this window, then press Return:"
  read -r OLD
  OLD="${OLD%/}"; OLD="${OLD//\\ / }"; OLD="${OLD%\"}"; OLD="${OLD#\"}"; OLD="${OLD%\'}"; OLD="${OLD#\'}"
  if ! looks_like_village "$OLD"; then echo "That doesn't look like the old village folder. Nothing was copied."; read -r -p "Press Return to close."; exit 1; fi
fi
echo "Old village: $OLD"
echo "This village: $NEW"
echo

BACKUP="$(dirname "$NEW")/ai-village-notes-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
copied=0
cd "$OLD" || exit 1
for f in agents/*/NOTES.md agents/*/workers/*/NOTES.md; do
  [ -f "$f" ] || continue
  if [ -f "$NEW/$f" ]; then mkdir -p "$BACKUP/$(dirname "$f")"; cp -p "$NEW/$f" "$BACKUP/$f"; fi
  mkdir -p "$NEW/$(dirname "$f")"
  cp -p "$f" "$NEW/$f"
  echo "  copied $f"
  copied=$((copied + 1))
done
if [ -d "helper/marshall-home" ]; then
  if [ -d "$NEW/helper/marshall-home" ]; then mkdir -p "$BACKUP/helper"; mv "$NEW/helper/marshall-home" "$BACKUP/helper/marshall-home"; fi
  cp -Rp "helper/marshall-home" "$NEW/helper/marshall-home"
  echo "  copied Marshall's memory, the chat log and your to-do list (helper/marshall-home)"
fi
rmdir "$BACKUP" 2>/dev/null && backup_note="" || backup_note="What was in this folder before is backed up in: $BACKUP"
echo
echo "Done: $copied notes files copied. Anyone without notes (like the new workers) gets a fresh file when the helper starts."
[ -n "$backup_note" ] && echo "$backup_note"
echo "If the helper is running, restart it so it picks everything up."
read -r -p "Press Return to close."
