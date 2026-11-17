#!/bin/bash
# Uninstall Village Helper: stop the helper starting at login, and stop it now.
# Your village, notes and Marshall's memory are not touched.
LABEL="com.myaivillage.helper"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || launchctl unload "$PLIST" >/dev/null 2>&1
rm -f "$PLIST"
echo "Done. The village helper no longer starts at login, and it's stopped."
echo "To play without it, double-click Start Village.command (keep its window open)."
echo
read -r -p "Press Return to close."
