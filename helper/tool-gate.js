#!/usr/bin/env node
'use strict';
// tool-gate.js: a hard stop on every tool a village agent tries to use.
//
// Claude Code runs this before EVERY tool call in a village run (a PreToolUse
// hook the helper passes in with --settings). It allows only the tools in this
// run's policy, and only with allowed inputs, and blocks everything else,
// whatever any other setting says. Each attempt is written to
// marshall-home/tool-attempts.jsonl so the helper can tell the Sheriff if an
// agent tried something it isn't allowed to.
//
// Usage (by the helper): node tool-gate.js <who> <log file> <policy JSON>
// Policy: { "<tool name>": { rule... }, ... }. Rules (all optional):
//   hostSuffix: [".gov"]        web address must be https and end with one of these
//   calendarIdIn: ["primary"]   calendarId must be missing or one of these
//   maxAttendees: 1             at most this many attendee emails
//   noAttendees: true           no attendees at all

const fs = require('fs');
const [who, logFile, policyText] = process.argv.slice(2);
let policy = {};
try { policy = JSON.parse(policyText || '{}'); } catch { policy = {}; }   // unreadable policy: nothing is allowed

function check(tool, input) {
  if (!tool || !Object.prototype.hasOwnProperty.call(policy, tool)) return `you can't use ${tool || 'that tool'}`;
  const rule = policy[tool] || {};
  if (rule.hostSuffix) {
    let host = '';
    try { const u = new URL(String(input.url || '')); if (u.protocol !== 'https:') return 'only https web addresses'; host = u.hostname.toLowerCase(); } catch { return 'that is not a web address'; }
    if (!rule.hostSuffix.some(s => host === s.replace(/^\./, '') || host.endsWith(s.startsWith('.') ? s : '.' + s))) return `you may only open ${rule.hostSuffix.join(', ')} pages`;
  }
  if (rule.calendarIdIn && input.calendarId !== undefined && input.calendarId !== null && input.calendarId !== '' && !rule.calendarIdIn.includes(String(input.calendarId))) return 'only the primary calendar';
  if (rule.maxAttendees !== undefined && (input.attendeeEmails || input.attendees || []).length > rule.maxAttendees) return 'not other people\'s calendars';
  if (rule.noAttendees && (input.attendees || input.attendeeEmails || []).length) return 'no attendees allowed';
  return '';
}

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let tool = '', toolInput = {};
  try { const j = JSON.parse(input); tool = String(j.tool_name || ''); toolInput = j.tool_input || {}; } catch { /* unreadable: treat as not allowed */ }
  const why = check(tool, toolInput);
  try { fs.appendFileSync(logFile, JSON.stringify({ time: new Date().toISOString(), who, tool, allowed: !why, why: why || undefined }) + '\n'); } catch { /* logging must never open the gate */ }
  if (!why) process.exit(0);
  process.stderr.write(`Blocked in My AI Village: ${why}.`);
  process.exit(2);   // exit code 2 = Claude Code blocks the tool call
});
