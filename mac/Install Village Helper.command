#!/bin/bash
# Install Village Helper: start the village helper (everyone's brains) every time
# you log in to this Mac, quietly in the background, with no Terminal window.
#  - Uses your Claude Pro login: no API key, nothing pay-per-use.
#  - Idle, it uses none of your Claude allowance. Claude only runs when you chat,
#    add a to-do, or work is passed on.
#  - It only answers this computer.
# Double-click again any time to restart it (for example after moving the folder).
# To remove it, double-click "Uninstall Village Helper.command".

cd "$(dirname "$0")/.." || exit 1
VILLAGE="$PWD"
LABEL="com.myaivillage.helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/ai-village-helper.log"
export PATH="$HOME/.local/bin:$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin:$PATH"
finish() { echo; read -r -p "Press Return to close."; exit "$1"; }

NODE="$(command -v node)"
CLAUDE="$(command -v claude)"
[ -n "$NODE" ] || { echo "Node.js isn't installed (see helper/README.md, step 1). Nothing was installed."; finish 1; }
[ -n "$CLAUDE" ] || { echo "Claude Code isn't installed (see helper/README.md, step 2). Nothing was installed."; finish 1; }

# stop an earlier login helper, if there is one
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || launchctl unload "$PLIST" >/dev/null 2>&1
sleep 1
if curl -s -m 1 http://127.0.0.1:7777/hello >/dev/null 2>&1; then
  echo "A village helper is already running in a Terminal window."
  echo "Close that window (or press Ctrl+C in it), then double-click this file again."
  finish 1
fi

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>$(xml "$VILLAGE/helper/marshall-helper.js")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$VILLAGE")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$(dirname "$CLAUDE"):$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin")</string>
    <key>MARSHALL_CLAUDE_BIN</key><string>$(xml "$CLAUDE")</string>
    <key>VILLAGE_LOGIN_ITEM</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG")</string>
</dict>
</plist>
PLISTEOF

launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -s -m 1 http://127.0.0.1:7777/hello >/dev/null 2>&1; then
    echo "Done. The village helper is running, and it will start by itself every time you log in."
    echo "To play, just open index.html (or double-click Start Village.command)."
    echo "What everyone is doing is written to: $LOG"
    echo "Your Mac may show a notice that a background item (node) was added. That's this helper."
    finish 0
  fi
done
echo "It's installed, but the helper didn't answer yet. Check the log for the reason:"
echo "  $LOG"
tail -n 15 "$LOG" 2>/dev/null
finish 1
