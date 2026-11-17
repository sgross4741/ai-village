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
  ...['send_message', 'reply', 'forward', 'update_draft', 'delete_draft', 'list_drafts', 'get_draft', 'get_thread', 'get_message',
    'search_threads', 'list_labels', 'label_thread', 'unlabel_thread', 'label_message', 'unlabel_message', 'update_message_labels',
    'apply_sensitive_thread_label', 'apply_sensitive_message_label', 'trash_thread', 'trash_message', 'untrash_thread', 'untrash_message',
    'mark_thread_spam', 'mark_message_spam', 'unmark_thread_spam', 'unmark_message_spam', 'create_label', 'update_label', 'delete_label',
    'download_gmail_attachment'].map(t => `mcp__${GMAIL_SERVER}__${t}`)];             // a worker gets at most 2 send-backs; after that the townsperson fixes it
const CLAUDE = process.env.MARSHALL_CLAUDE_BIN || 'claude';
const TIMEOUT_MS = 180000;
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
const MAX_WORKERS = 3;           // workers per townsperson (what fits in a yard)
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
function subscriptionEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}
function runClaude(args) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false, child;
    try {
      child = spawn(CLAUDE, args, { cwd: ROOM, env: subscriptionEnv(), shell: false, windowsHide: true });
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

let noAdvisor = false;          // set if this Claude Code doesn't support the advisor option
let systemPromptFlag = 'replace';

// One message to one agent. Returns the plain text they answered.
// opts.allowTools: the only tools this run may use (default: none at all). Such runs start a
// fresh conversation each time. opts.result receives Claude Code's full answer.
async function ask(agent, systemPrompt, message, opts = {}) {
  const isWorker = !!workerInfo(agent);
  const tools = opts.allowTools || null;
  return limited(async () => {
    const sessions = tools ? {} : readJSON(SESSIONS_FILE, {});
    const version = crypto.createHash('sha1').update(agent === 'marshall' ? systemPrompt : systemPrompt.split('## Your notes')[0]).digest('hex').slice(0, 12);
    let s = sessions[agent] || {};
    if (s.version !== version) s = { version };                 // instructions changed: fresh conversation

    const promptFile = path.join(HOME, `prompt-${agent}${tools ? '-tools' : ''}.md`);
    fs.writeFileSync(promptFile, systemPrompt);
    const build = () => {
      const args = ['-p', message, '--model', opts.model || (isWorker ? WORKER_MODEL : MODEL), '--output-format', 'json',
        ...(tools ? ['--allowedTools', tools.join(','), '--disallowedTools', BLOCKED_TOOLS.join(',')] : ['--disallowedTools', '*']),
        '--permission-mode', 'dontAsk', '--max-turns', tools ? '4' : '2'];
      args.push(...(systemPromptFlag === 'append' ? ['--append-system-prompt-file', promptFile] : ['--system-prompt', systemPrompt]));
      if (agent !== 'marshall' && !isWorker && !opts.model && !noAdvisor && ADVISOR !== 'none') args.push('--advisor', ADVISOR);
      if (s.sessionId) args.push('--resume', s.sessionId);
      return args;
    };
    const started = Date.now();
    let run = await runClaude(build());
    const said = run.out + run.err;
    if (run.code !== 0 && /advisor/i.test(said) && !noAdvisor) {
      noAdvisor = true;
      console.log('  note: this Claude Code does not take the advisor option here; townspeople will run without it.');
      run = await runClaude(build());
    }
    if (run.code !== 0 && /system-prompt/i.test(run.out + run.err) && systemPromptFlag !== 'append') { systemPromptFlag = 'append'; run = await runClaude(build()); }
    if (s.sessionId && run.code !== 0 && /session|resume/i.test(run.out + run.err)) { delete s.sessionId; run = await runClaude(build()); }
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (run.spawnError) throw new Error(`Couldn't start Claude Code ("${CLAUDE}"). Is it installed and on your PATH? (${run.err})`);
    let obj;
    try { obj = JSON.parse(run.out); } catch { throw new Error(`Claude Code didn't answer as expected. ${(run.err || run.out).trim().slice(0, 300)}`); }
    if (opts.result) opts.result(obj);
    if (obj.session_id && !tools) s.sessionId = obj.session_id;
    if (tools) return typeof obj.result === 'string' ? obj.result : '';
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
const FIELDS = 'SAY|NOTE|DONE|TASK|WORKER|INSTRUCTIONS|WORK|VERDICT|CHECK|FIXED|HELP|HIRE|DRAFT|LINK|NAME|PERSONALITY|QUIRK|STRENGTHS|WHY';
function block(text, key) {
  const re = new RegExp('^\\s*\\**\\s*' + key + '\\s*\\**\\s*:[ \\t]*([\\s\\S]*?)(?=^\\s*\\**\\s*(?:' + FIELDS + ')\\b[^\\n:]{0,20}\\**\\s*:|(?![\\s\\S]))', 'im');
  const m = text.match(re);
  return m ? m[1].replace(/\*\*/g, '').replace(/\n{3,}/g, '\n\n').trim() : '';
}
const clip = (t, max) => (t.length <= max ? t : t.slice(0, max).replace(/\s+\S*$/, '') + ' …');
function noteFrom(agent, answer) {
  const note = grab(answer, 'NOTE');
  if (!isNone(note)) addNote(agent, "What I've learned", tidy(note, 300));
  return !isNone(note);
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
  return fs.readFileSync(MARSHALL_PERSONA, 'utf8') + `\n\nThe townspeople you can hand work to (use their key):\n${roster}\n`;
}
const pending = [];             // tasks waiting for the Sheriff's "Send next batch"
const working = new Map();      // agent key -> task they're working on right now

// Marshall's TASK lines -> tasks for known townspeople
function parseTasks(answer, order, extra) {
  const known = new Set(townspeople().map(t => t.key));
  const tasks = [];
  for (const m of answer.matchAll(/^\s*\**\s*TASK\s+([a-z]+)\s*\**\s*:\s*(.+)$/gim)) {
    const key = m[1].toLowerCase(), task = tidy(m[2], 300);
    if (known.has(key) && !isNone(task)) tasks.push({ agent: key, task, order, ...(extra || {}) });
  }
  return tasks;
}

async function talkToMarshall(text) {
  addLog('Sheriff', 'Marshall', text);
  const answer = await ask('marshall', marshallPrompt(), text);
  const reply = sayLine(answer, 320);
  const tasks = parseTasks(answer, text);
  addLog('Marshall', 'Sheriff', reply);
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

function sendBatch() {
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
    addNotice(draft ? 'draft' : 'done', draft ? `To-do done: "${clip(todo.text, 80)}". Want it in your Gmail drafts?` : `To-do done: "${clip(todo.text, 100)}"`, { todo: todo.id, draftId: draft ? draft.draftId : null });
  } else if (todo.assignments.some(x => x.status === 'working' || x.status === 'done')) todo.status = 'working';
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

// ---------- townspeople ----------
function townspersonPrompt(agent) {
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
- You can only think and write: no real-world actions. Nobody in town can send, post, buy, book or contact anyone. If a task asks for that, prepare it and say plainly that the Sheriff needs to send it.

## Answer in exactly these two lines and nothing else
SAY: what you say
NOTE: one short thing worth remembering from this conversation for your notes, or none
(For a task, also the extra lines asked for, which can be longer.)

## Your notes
${notes}`;
}

const wantsWorker = (text, w) => !!w && (/\b(give|hand|pass|send|let|have|get)\b[^.?!]*\b(your )?(worker|horse|intern)s?\b/i.test(text) || workersOf(w.owner).some(x => new RegExp('\\b' + x.name + '\\b', 'i').test(text)));

async function talkToTownsperson(agent, text) {
  const name = shortName(agent), w = pickWorker(agent, text);
  addLog('Sheriff', name, text);
  const handOver = wantsWorker(text, w);
  const answer = await ask(agent, townspersonPrompt(agent), `The Sheriff walks up and says to you: ${text}` + (handOver
    ? `\n\nThe Sheriff wants this given to your worker ${w.name}. Hand it over: after your SAY line, add\nINSTRUCTIONS: clear, complete instructions for ${w.name}: what to make, for whom, the key points, length and tone. You will check ${w.name}'s work before it counts as done.\nThen your NOTE line.` : ''));
  const reply = sayLine(answer, 400);
  const noted = noteFrom(agent, answer);
  addLog(name, 'Sheriff', reply);
  if (!handOver) return { reply, noted };
  // it goes on the Sheriff's to-do list, already with this townsperson, so you can follow it there
  const instructions = block(answer, 'INSTRUCTIONS') || text;
  const todos = loadTodos();
  const todo = { id: todos.reduce((m, x) => Math.max(m, x.id), 0) + 1, text: tidy(text, 200), status: 'working', created: new Date().toISOString(), via: `told ${name} directly`,
    assignments: [{ agent, name, task: tidy(text, 300), status: 'working' }] };
  todos.push(todo); saveTodos(todos);
  const t = { agent, task: tidy(text, 300), order: text, todoId: todo.id, from: 'Sheriff' };
  working.set(agent, t.task);
  (async () => finish(t, await workerLoop(t, w, instructions), reply))().catch(e => {
    addLog(name, 'Sheriff', `(couldn't finish it: ${e.message})`, 'problem');
    working.delete(agent);
    updateAssignment(t, { status: 'problem', result: e.message });
  });
  return { reply, noted, handedTo: w.name, todo: todo.id };
}

const HELP_ASK = `If you need more help (too much work, or your workers can't keep up), add: HELP: why, in one sentence. Otherwise leave it out.`;
const YOURSELF = `WORK: the finished piece itself in full, if the task asks for something written (a letter, email, plan, list); leave this line out otherwise\nDONE: what you did, in up to 80 words, and anything the Sheriff still has to do (for example, send it).`;

async function doTask(t) {
  const name = shortName(t.agent);
  let w = pickWorker(t.agent, t.task);
  const toWorker = wantsWorker(t.task, w);
  const crew = workersOf(t.agent);
  const crewLine = crew.length > 1 ? `Your workers: ${crew.map(x => x.name + (working.has(x.key) ? ' (busy right now)' : '')).join(', ')}. If one should do it, name them on the WORKER line, like "WORKER: yes, ${crew[0].name}".\n` : '';
  const how = !w ? `Do what you can and report back to Marshall. After your SAY line add:\n${YOURSELF}\n${HELP_ASK}`
    : `Your worker ${w.name} (a horse, an intern on Sonnet 5.5) can take on clear, self-contained pieces of work: drafts, lists, summaries, write-ups. You check everything ${w.name} does before it counts as done.\n` + crewLine +
      (toWorker ? `The Sheriff wants this given to ${w.name}: hand it over.\n` : `Decide whether ${w.name} can handle this one.\n`) +
      `If ${w.name} should do it, after your SAY line add:\nWORKER: yes\nINSTRUCTIONS: clear, complete instructions for ${w.name}: what to make, for whom, the key points, length and tone.\n` +
      `If you'll do it yourself, after your SAY line add:\nWORKER: no\n${YOURSELF}\n${HELP_ASK}`;
  const answer = await ask(t.agent, townspersonPrompt(t.agent),
    `Marshall, the Deputy, passes you this task from the Sheriff's ${t.todoId ? 'to-do list' : 'order'} ("${t.order}"): ${t.task}\n${how}`);
  const reply = sayLine(answer, 400);
  noteFrom(t.agent, answer);
  askedForHelp(t.agent, answer);
  const chosen = crew.find(x => new RegExp('\\b' + x.name + '\\b', 'i').test(grab(answer, 'WORKER')));
  if (chosen) w = chosen;
  const instructions = block(answer, 'INSTRUCTIONS') || (toWorker ? t.task : '');
  if (w && instructions && (toWorker || /^\W*yes/i.test(grab(answer, 'WORKER')))) {
    addLog(name, 'Marshall', reply);
    return finish(t, await workerLoop(t, w, instructions), reply);
  }
  addLog(name, 'Marshall', reply, 'report');
  const work = block(answer, 'WORK');
  finish(t, { done: tidy(block(answer, 'DONE') || reply, 900), work: work ? clip(work, 3000) : null, doneBy: name, checkedBy: null, tries: 1, sendBacks: [] }, reply);
}

// The townsperson hands the work to their worker, checks what comes back, and
// sends it back with notes until it's good (at most MAX_TRIES tries in all).
async function workerLoop(t, w, instructions) {
  const boss = shortName(t.agent), first = boss.split(' ')[0];
  const where = t.from === 'Sheriff' ? 'the Sheriff, who told you directly' : `the Sheriff's ${t.todoId ? 'to-do list' : 'order'}`;
  instructions = clip(instructions, 1500);
  const sendBacks = [];
  if (t.todoId) updateAssignment(t, { status: 'with worker', worker: w.name, instructions });
  working.set(w.key, t.task);
  try {
    for (let tries = 1; tries <= MAX_TRIES; tries++) {
      const notes = sendBacks[sendBacks.length - 1];
      addLog(boss, w.name, tries === 1 ? instructions : `Sent back: ${notes}`, tries === 1 ? 'task' : 'sendback');
      if (t.todoId && tries > 1) updateAssignment(t, { status: 'with worker', tries: tries - 1, sendBacks });
      const wAnswer = await ask(w.key, workerPrompt(w.key), tries === 1
        ? `${first} gives you this task (from ${where}: "${t.task}").\nInstructions from ${first}: ${instructions}\n\nDo it now and hand back the finished work.`
        : `${first} checked your work and sent it back. Notes from ${first}: ${notes}\nFix every point and hand back the complete improved version.`);
      const work = clip(block(wAnswer, 'WORK') || wAnswer.trim(), 3000);
      noteFrom(w.key, wAnswer);
      addLog(w.name, boss, `${sayLine(wAnswer, 200)} (handed back${tries > 1 ? `, try ${tries}` : ''})`, 'report');
      if (t.todoId) updateAssignment(t, { status: 'checking', tries });

      const lastRound = tries === MAX_TRIES;
      const cAnswer = await ask(t.agent, townspersonPrompt(t.agent),
        `${w.name} hands back their work${tries > 1 ? ` (try ${tries})` : ''} on: ${t.task}\nYour instructions were: ${instructions}\n\n${w.name}'s work:\n${work}\n\n` +
        `Check it carefully against your instructions and what the Sheriff needs. After your SAY line add:\nVERDICT: approved, or send back\nCHECK: if approved, what you checked and why it's good; if not, exactly what ${w.name} must fix.\n` +
        (lastRound ? `This is the last try: if it still isn't good enough, fix it yourself and add FIXED: the finished version.\n` : '') + `${HELP_ASK}\nThen your NOTE line.`);
      noteFrom(t.agent, cAnswer);
      askedForHelp(t.agent, cAnswer);
      const verdict = grab(cAnswer, 'VERDICT');
      const check = tidy(block(cAnswer, 'CHECK') || sayLine(cAnswer, 300), 700);
      const approved = /approv|good to go|accept|pass/i.test(verdict) && !/send\s*back|not approv|reject/i.test(verdict);
      if (approved) {
        addLog(boss, w.name, `Approved. ${check}`, 'check');
        addLog(boss, t.from || 'Marshall', `${w.name}'s work is checked and done.`, 'report');
        return { done: check, work, doneBy: w.name, checkedBy: boss, tries, sendBacks, instructions };
      }
      if (lastRound) {
        const fixed = block(cAnswer, 'FIXED');
        addLog(boss, w.name, `Still not right, so I fixed it myself. ${check}`, 'check');
        addLog(boss, t.from || 'Marshall', `Done: ${w.name} drafted it and I finished it myself.`, 'report');
        return { done: check, work: fixed ? clip(fixed, 3000) : work, doneBy: fixed ? `${w.name}, finished by ${first}` : w.name, checkedBy: boss, tries, sendBacks: [...sendBacks, check], instructions };
      }
      sendBacks.push(check);
      if (t.todoId) updateAssignment(t, { status: 'sent back', tries, sendBacks });
    }
  } finally { working.delete(w.key); }
}

function finish(t, r, reply) {
  const orders = readJSON(ORDERS_FILE, []);
  const o = [...orders].reverse().find(x => x.to === t.agent && x.task === t.task && x.status === 'handed out');
  const record = { result: r.done, work: r.work || null, doneBy: r.doneBy, checkedBy: r.checkedBy || null, tries: r.tries, sendBacks: r.sendBacks };
  if (r.work && GMAIL_DRAFTERS.has(t.agent)) record.draftId = crypto.randomBytes(6).toString('hex');   // can be saved to Gmail drafts
  if (o) { Object.assign(o, { status: 'done', report: reply }, record); writeJSON(ORDERS_FILE, orders); }
  working.delete(t.agent);
  if (!t.todoId && t.from !== 'Sheriff') reportToSheriff(t, r, record.draftId);
  if (t.todoId) updateAssignment(t, { status: 'done', report: reply, instructions: r.instructions || null, doneAt: new Date().toISOString(), ...record });
}

// Marshall tells the Sheriff an order is done: who did it, who checked it, and the work itself.
const NEEDS_SENDING = /\b(send|sent|e-?mail|mail|post|text|message|deliver|call|book|buy)\b/i;
function reportToSheriff(t, r, draftId) {
  const first = (n) => String(n || '').split(' ')[0];
  const who = r.checkedBy ? `${r.doneBy} did it and ${first(r.checkedBy)} checked it` : `${r.doneBy} did it`;
  let text = `Done: ${t.task} ${who}${r.tries > 1 ? ` (${r.tries} tries)` : ''}. ${r.done || ''}`.trim();
  const kind = draftId ? 'draft' : r.work && NEEDS_SENDING.test(t.order + ' ' + t.task) ? 'send' : 'done';
  addNotice(kind, kind === 'draft' ? `${shortName(t.agent).split(' ')[0]} finished "${clip(t.task, 80)}". Want it in your Gmail drafts?` : kind === 'send' ? `"${clip(t.task, 80)}" is ready for you to send.` : `Done: ${clip(t.task, 100)}`, { chat: 'marshall', draftId: draftId || null });
  if (draftId) text += ` Want it in your Gmail drafts? Press "Save to Gmail drafts" and ${shortName(t.agent).split(' ')[0]} will put it there for you to check and send.`;
  else if (r.work && NEEDS_SENDING.test(t.order + ' ' + t.task)) text += ' Nobody in town can send things, so here it is for you to copy and send.';
  addLog('Marshall', 'Sheriff', text, 'relay', { chat: 'marshall', work: r.work || null, draftId: draftId || null });
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
    { allowTools: [DRAFT_TOOL], result: (o) => { obj = o; } });
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
const NOTICE_TITLES = { candidate: 'A candidate is waiting', draft: 'Ready for your Gmail drafts', send: 'Ready for you to send', done: 'Done', batch: 'Waiting for your go-ahead', nofit: 'Nobody fits', problem: 'A problem', help: 'Asking for help' };
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

## Answer in exactly this format and nothing else
SAY: one short, cheerful line to ${boss} (you're a hard-working horse)
WORK: the finished work itself (as many lines as it needs)
NOTE: one short thing worth remembering for next time, or none

## Your notes
${notes}`;
}

// ---------- tiny web server, this computer only ----------
function allowedOrigin(origin) {
  return !origin || origin === 'null' || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
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
  if (!allowedOrigin(origin)) { res.writeHead(403); return res.end('Only the village page may talk to the village.'); }
  const headers = {
    'Access-Control-Allow-Origin': origin || 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Content-Type': 'application/json',
  };
  const send = (code, body) => { res.writeHead(code, headers); res.end(JSON.stringify(body)); };
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }
  const url = new URL(req.url, 'http://127.0.0.1');

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
    if (agent !== 'marshall' && !isCandidate && !townspeople().some(t => t.key === agent)) return send(400, { error: 'Unknown townsperson.' });
    if (busyAgents.has(agent)) return send(429, { error: 'Still thinking about your last message.' });
    busyAgents.add(agent);
    try {
      send(200, agent === 'marshall' ? await talkToMarshall(text) : isCandidate ? await talkToCandidate(cand, text) : await talkToTownsperson(agent, text));
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
    if (j.dismissAll) resolveNotices(n => n.kind !== 'candidate');
    else if (j.dismiss) resolveNotices(n => n.id === Number(j.dismiss) && n.kind !== 'candidate');
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
if (process.argv.includes('--check')) {
  check();
} else {
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Is the helper already running?` : e.message);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`${new Date().toISOString()} The village helper is running on this computer (127.0.0.1:${PORT}), using ${MODEL} through your Claude subscription.`);
    console.log('Open index.html. Press M to talk to Marshall, or walk up to anyone and press T. Press Ctrl+C here to stop.');
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
