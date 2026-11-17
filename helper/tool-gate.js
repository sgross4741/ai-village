#!/usr/bin/env node
'use strict';
// tool-gate.js: a hard stop on every tool a village agent tries to use.
//
// Claude Code runs this before EVERY tool call in a village run (a PreToolUse
// hook the helper passes in with --settings). It allows only the tools named on
// the command line (for most runs: none at all; for Rufus saving a Gmail draft:
// only the create-draft tool) and blocks everything else, whatever any other
// setting says. Each attempt is written to marshall-home/tool-attempts.jsonl so
// the helper can tell the Sheriff if an agent tried something it isn't allowed.
//
// Usage (by the helper): node tool-gate.js <who> <log file> [allowed tool ...]

const fs = require('fs');
const [who, logFile, ...allowed] = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let tool = '';
  try { tool = String(JSON.parse(input).tool_name || ''); } catch { /* unreadable: treat as not allowed */ }
  const ok = tool !== '' && allowed.includes(tool);
  try { fs.appendFileSync(logFile, JSON.stringify({ time: new Date().toISOString(), who, tool, allowed: ok }) + '\n'); } catch { /* logging must never open the gate */ }
  if (ok) process.exit(0);
  process.stderr.write(`Blocked: in My AI Village you can't use ${tool || 'that tool'}. You can only think and write.`);
  process.exit(2);   // exit code 2 = Claude Code blocks the tool call
});
