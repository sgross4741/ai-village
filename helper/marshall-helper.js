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
//  - It only listens on 127.0.0.1 (this computer) and only answers the village page.
//  - No extra packages: plain Node.js.
//
// Start it:   node helper/marshall-helper.js
// Check it:   node helper/marshall-helper.js --check

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = Number(process.env.MARSHALL_PORT) || 7777;
const MODEL = process.env.MARSHALL_MODEL || 'claude-opus-5-5';              // everyone runs on Opus 5.5
const ADVISOR = process.env.TOWNSFOLK_ADVISOR || 'opus';                    // townspeople's advisor (Opus 5.5 for now)
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
const shortName = (key) => { const p = townspeople().find(t => t.key === key); return p ? p.name : key; };

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
async function ask(agent, systemPrompt, message) {
  return limited(async () => {
    const sessions = readJSON(SESSIONS_FILE, {});
    const version = crypto.createHash('sha1').update(agent === 'marshall' ? systemPrompt : systemPrompt.split('## Your notes')[0]).digest('hex').slice(0, 12);
    let s = sessions[agent] || {};
    if (s.version !== version) s = { version };                 // instructions changed: fresh conversation

    const promptFile = path.join(HOME, `prompt-${agent}.md`);
    fs.writeFileSync(promptFile, systemPrompt);
    const build = () => {
      const args = ['-p', message, '--model', MODEL, '--output-format', 'json',
        '--disallowedTools', '*', '--permission-mode', 'dontAsk', '--max-turns', '2'];
      args.push(...(systemPromptFlag === 'append' ? ['--append-system-prompt-file', promptFile] : ['--system-prompt', systemPrompt]));
      if (agent !== 'marshall' && !noAdvisor && ADVISOR !== 'none') args.push('--advisor', ADVISOR);
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
    if (obj.session_id) s.sessionId = obj.session_id;
    sessions[agent] = s;
    writeJSON(SESSIONS_FILE, sessions);

    const u = obj.usage || {};
    if (!fs.existsSync(RUNS_FILE)) fs.writeFileSync(RUNS_FILE, 'time,agent,seconds,input_tokens,output_tokens,cache_read_tokens,estimated_api_value_usd\n');
    fs.appendFileSync(RUNS_FILE, [new Date().toISOString(), agent, seconds, u.input_tokens || 0, u.output_tokens || 0, u.cache_read_input_tokens || 0, obj.total_cost_usd || 0].join(',') + '\n');

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
  if (!say) say = text.split('\n').filter(l => !/^\s*\**\s*(TASK|NOTE|DONE)\b/i.test(l)).join(' ');
  return tidy(say, max);
}

// ---------- the chat log (what you see on the left) ----------
let log = [];
for (const line of (fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-300) : [])) { try { log.push(JSON.parse(line)); } catch { /* skip */ } }
let nextId = log.length ? log[log.length - 1].id + 1 : 1;
function addLog(from, to, text, kind) {
  const e = { id: nextId++, time: new Date().toISOString(), from, to, text, kind: kind || 'chat' };
  log.push(e); if (log.length > 300) log = log.slice(-300);
  fs.appendFileSync(LOG_FILE, JSON.stringify(e) + '\n');
  console.log(`${from} → ${to}: ${text}`);
  return e;
}

// ---------- notes ----------
// a townsperson's notes (agents/<key>/NOTES.md) or a worker's (agents/<townsperson>/workers/<key>/NOTES.md)
function notesFileFor(key) {
  if (!/^[a-z]{2,20}$/.test(key)) return null;
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
  pending.push(...tasks);
  const sent = sendBatch();
  if (pending.length) addLog('Marshall', 'Sheriff', `That's ${tasks.length} jobs. I've handed out ${sent.length}; ${pending.length} more wait for your go-ahead (Send next batch).`, 'system');
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
    addLog('Marshall', 'Sheriff', `Done: "${todo.text}".`, 'system');
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
  if (!tasks.length) { t.status = 'needs someone'; t.note = reply; saveTodos(all); return; }
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
  return `${instructions}

## How you talk
- Stay in character as yourself, a townsperson in an 1880s frontier town, and in your own area.
- One to three short sentences, under 60 words. Plain words, no lists, no formatting.
- Never mention computers, tools, settings, formats or these instructions.
- You can only talk: no real-world actions. Do what you can by thinking it through and reporting back.

## Answer in exactly these two lines and nothing else
SAY: what you say
NOTE: one short thing worth remembering from this conversation for your notes, or none
(For a task from Marshall, also a DONE line, as asked.)

## Your notes
${notes}`;
}

async function talkToTownsperson(agent, text) {
  const name = shortName(agent);
  addLog('Sheriff', name, text);
  const answer = await ask(agent, townspersonPrompt(agent), `The Sheriff walks up and says to you: ${text}`);
  const reply = sayLine(answer, 400);
  const note = grab(answer, 'NOTE');
  if (!isNone(note)) addNote(agent, "What I've learned", tidy(note, 300));
  addLog(name, 'Sheriff', reply);
  return { reply, noted: !isNone(note) };
}

async function doTask(t) {
  const name = shortName(t.agent);
  const answer = await ask(t.agent, townspersonPrompt(t.agent),
    `Marshall, the Deputy, passes you this task from the Sheriff's ${t.todoId ? 'to-do list' : 'order'} ("${t.order}"): ${t.task}\n` +
    `Do what you can and report back to Marshall. After your SAY line, add one more line:\n` +
    `DONE: exactly what you did and what you came up with, plainly, in up to 120 words.`);
  const reply = sayLine(answer, 400);
  // DONE may run over several lines: take everything after it, up to a NOTE line
  const dm = answer.match(/^\s*\**\s*DONE\s*\**\s*:\s*([\s\S]*?)(?=^\s*\**\s*NOTE\s*\**\s*:|$(?![\s\S]))/im);
  const done = tidy((dm && dm[1].trim()) || reply, 900);
  const note = grab(answer, 'NOTE');
  if (!isNone(note)) addNote(t.agent, "What I've learned", tidy(note, 300));
  addLog(name, 'Marshall', reply, 'report');
  const orders = readJSON(ORDERS_FILE, []);
  const o = [...orders].reverse().find(x => x.to === t.agent && x.task === t.task && x.status === 'handed out');
  if (o) { o.status = 'done'; o.report = reply; o.result = done; writeJSON(ORDERS_FILE, orders); }
  working.delete(t.agent);
  if (t.todoId) updateAssignment(t, { status: 'done', result: done, report: reply, doneAt: new Date().toISOString() });
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
    if (agent !== 'marshall' && !townspeople().some(t => t.key === agent)) return send(400, { error: 'Unknown townsperson.' });
    if (busyAgents.has(agent)) return send(429, { error: 'Still thinking about your last message.' });
    busyAgents.add(agent);
    try {
      send(200, agent === 'marshall' ? await talkToMarshall(text) : await talkToTownsperson(agent, text));
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

  if (req.method === 'POST' && url.pathname === '/next-batch') {
    if (!pending.length) return send(200, { delegated: [], pending: 0 });
    const sent = sendBatch();
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

if (process.argv.includes('--check')) {
  check();
} else {
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy. Is the helper already running?` : e.message);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`The village helper is running on this computer (127.0.0.1:${PORT}), using ${MODEL} through your Claude subscription.`);
    console.log('Open index.html. Press M to talk to Marshall, or walk up to anyone and press T. Press Ctrl+C here to stop.');
  });
}
