'use strict';
// main.js: walking, zooming, going in and out of buildings, and drawing.
// Everything runs in this browser tab. No network requests, no API keys.

(function () {
  const view = document.getElementById('view');
  const ctx = view.getContext('2d');
  const whereEl = document.getElementById('where');
  const helpEl = document.getElementById('help');

  // World zoom. Art is drawn at 2 art pixels per world pixel, so even zooms
  // keep every art pixel a whole number of screen pixels (crisp).
  const ZOOMS = [1, 2, 4, 6, 8, 10, 12, 16, 20, 24, 32];
  const SPEED = 72; // pixels per second

  const town = buildTown();
  const interiors = {};
  const getInterior = (b) => interiors[b.id] || (interiors[b.id] = buildInterior(b));

  // Characters use 4 rows x 3 frames walking sheets (see characters.js).
  const ROW = { down: 0, right: 1, left: 2, up: 3 };
  const WALK = [0, 1, 2, 1];               // left foot, stand, right foot, stand
  function loadSheet(key) {
    const sheet = { ...CHARACTERS[key], img: new Image(), ready: false };
    sheet.img.onload = () => { sheet.ready = true; };
    sheet.img.src = sheet.src;
    return sheet;
  }
  const sheriffSheet = loadSheet('sheriff');   // the player
  const marshallSheet = loadSheet('marshall'); // the Deputy

  // ---------- the ten townspeople (see townsfolk.js) ----------
  const nav = createNav(town, getInterior);   // where people may walk, and how to get places
  const people = createTownsfolk(town, nav);
  for (const p of people) p.sheet = loadSheet(p.key);
  // ...and their workers (brown horses in beige saddles), one each to start
  const workerSheet = loadSheet('worker');
  for (const w of createWorkers(town, nav, people)) { w.sheet = workerSheet; people.push(w); }
  let occ = new Map();                        // who is standing where (updated every frame)
  // a small name card when the Sheriff is next to someone
  const whoEl = document.createElement('div');
  whoEl.className = 'panel';
  whoEl.style.cssText = 'top:12px;left:50%;transform:translateX(-50%);display:none;text-align:center';
  document.body.appendChild(whoEl);
  const bubbleImg = (() => {
    const { c, g } = makeCanvas(24, 16);
    box(g, 0, 0, 24, 13, PAL.cream);
    rect(g, 1, 1, 22, 1, '#fffaf0');
    rect(g, 9, 12, 5, 2, PAL.cream); rect(g, 10, 14, 3, 1, PAL.cream);
    px(g, 8, 12, PAL.out); px(g, 14, 12, PAL.out); px(g, 9, 14, PAL.out); px(g, 13, 14, PAL.out); px(g, 11, 15, PAL.out);
    return c;
  })();
  const shadowImg = (() => { const { c, g } = makeCanvas(16, 4); paintShadowEllipse(g, 8, 2, 5, 1); return c; })();

  // ---------- Marshall, the Deputy ----------
  // Lives in the town hall: waits beside the clerk's desk until the Sheriff
  // walks up, then follows the Sheriff everywhere, a couple of steps behind,
  // through every door. Plain game code: no AI and no network yet.
  const FOLLOW_GAP = 22;                   // world pixels of path behind the Sheriff
  const hallRoom = getInterior(town.buildings.find(b => b.id === 'hall'));
  const deputy = {
    scene: hallRoom, x: 14 * T + 8, y: 5 * T + 12, dir: 'down',
    moving: false, t: 0, following: false,
    path: [], goal: null, after: null, rng: rng(4242),   // for walking somewhere on their own (meetings)
  };
  const trail = [];                        // where the Sheriff has walked: {scene, x, y, dir}

  function recordTrail() {
    const p = state.player, last = trail[trail.length - 1];
    if (!last || last.scene !== state.scene || Math.hypot(last.x - p.x, last.y - p.y) >= 1)
      trail.push({ scene: state.scene, x: p.x, y: p.y, dir: p.dir });
  }
  const segLen = (a, b) => (a.scene !== b.scene ? 0 : Math.hypot(b.x - a.x, b.y - a.y)); // a door is a step of 0

  function updateDeputy(dt) {
    const d = deputy, p = state.player;
    // walking somewhere on their own (to a meeting, or out front afterwards)
    if (d.goal) {
      if (walk(d, dt, nav, occ, 56) === 'arrived') {
        d.goal = null; d.moving = false; d.dir = 'down';
        if (d.after === 'follow') {                       // pick up following the Sheriff again
          d.following = true;
          trail.length = 0;
          trail.push({ scene: d.scene, x: d.x, y: d.y, dir: d.dir });
          recordTrail();
        }
        d.after = null;
      }
      return;
    }
    if (state.meeting) { d.moving = false; faceToward(d, p); return; }   // stays put during a meeting
    if (!d.following) {
      // the Sheriff walks up to Marshall in the town hall: Marshall joins
      if (state.scene === d.scene && Math.hypot(p.x - d.x, p.y - d.y) < 48) {
        d.following = true;
        trail.length = 0;
        trail.push({ scene: d.scene, x: d.x, y: d.y, dir: d.dir });
        recordTrail();
      } else { d.moving = false; return; }
    }
    let remaining = 0;
    for (let i = 1; i < trail.length; i++) remaining += segLen(trail[i - 1], trail[i]);
    let move = Math.min(SPEED * 1.1 * dt, remaining - FOLLOW_GAP);
    const x0 = d.x, y0 = d.y;
    if (trail.length > 1) {                       // a townsperson is in the way: wait for them to move
      const nxt = trail[1], m = occ.get(nxt.scene);
      const w = m && m.get(Math.floor(nxt.x / T) + ',' + Math.floor((nxt.y - 3) / T));
      if (w && w !== d && w !== p && Math.hypot(nxt.x - d.x, nxt.y - d.y) < 12) move = 0;
    }
    while (move > 0 && trail.length > 1) {
      const a = trail[0], b = trail[1], L = segLen(a, b);
      if (L <= move) { move -= L; trail.shift(); }
      else { const k = move / L; a.x += (b.x - a.x) * k; a.y += (b.y - a.y) * k; move = 0; }
    }
    const here = trail[0];
    d.scene = here.scene; d.x = here.x; d.y = here.y;
    const mx = d.x - x0, my = d.y - y0;
    d.moving = Math.hypot(mx, my) > 0.01;
    if (d.moving) {
      d.t += dt;
      d.dir = Math.abs(mx) > Math.abs(my) ? (mx > 0 ? 'right' : 'left') : (my > 0 ? 'down' : 'up');
    } else if (d.scene === state.scene) {
      // standing still: face the Sheriff
      const fx = p.x - d.x, fy = p.y - d.y;
      if (Math.hypot(fx, fy) > 2) d.dir = Math.abs(fx) > Math.abs(fy) ? (fx > 0 ? 'right' : 'left') : (fy > 0 ? 'down' : 'up');
    }
  }

  const state = {
    scene: town,
    player: { x: town.spawn.x, y: town.spawn.y, dir: town.spawn.dir, moving: false, t: 0, auto: null, path: [], stepTo: null, goal: null, rng: rng(77) },
    meeting: null,   // while a meeting is on: { room, seat(i) }
    workTime: false, // stand-in for real tasks: everyone goes to their desk
    zoom: 4,
    fit: false,
    hero: true,    // town view keeps the Sheriff at 1/8 of the screen height
    fade: 0,       // 0 = clear, 1 = black
    fadeDir: 0,    // +1 fading out, -1 fading in
    pending: null, // scene change waiting for the fade
    keys: {},
  };

  // ---------- talking to people ----------
  // T: talk to whoever is next to you (a townsperson; otherwise Marshall).
  // M: talk to Marshall from anywhere. L: the chat log. Esc / ×: close.
  // The page talks only to the village helper on this same computer, which uses
  // Claude Code with your subscription (see helper/README.md).
  const HELPER = 'http://127.0.0.1:7777';
  const $ = (id) => document.getElementById(id);
  const chatEl = $('chat'), chatTitle = $('chat-title'), chatLines = $('chat-lines'), chatForm = $('chat-form');
  const chatInput = $('chat-input'), chatStatus = $('chat-status'), nextBatchBtn = $('next-batch');
  const logEl = $('log'), logLines = $('log-lines'), brainEl = $('brain');
  let chatWith = null;                       // 'marshall' or a townsperson
  let thinking = null;                       // key of whoever is working out a reply right now
  let pendingBatches = 0;
  const transcripts = new Map();             // key -> lines said in your chats with them
  const keyOf = (w) => (w === 'marshall' ? 'marshall' : w.key);
  const nameOf = (w) => (w === 'marshall' ? 'Marshall' : w.name);
  const byName = new Map(people.map(p => [p.name, p]));

  function addLine(box, who, text, cls, time) {
    const line = document.createElement('p');
    if (cls) line.className = cls;
    if (time) { const t = document.createElement('span'); t.className = 'time'; t.textContent = time; line.appendChild(t); }
    if (who) { const w = document.createElement('span'); w.className = 'who'; w.textContent = who + ': '; line.appendChild(w); }
    if (cls === 'gmailbtn') { line.appendChild(gmailButton(text)); box.appendChild(line); box.scrollTop = box.scrollHeight; return; }
    // Gmail draft links are clickable; everything else is plain text
    for (const [i, part] of text.split(/(https:\/\/mail\.google\.com\/\S+)/).entries()) {
      if (i % 2) { const a = document.createElement('a'); a.href = part; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Open it in Gmail'; line.appendChild(a); }
      else if (part) line.appendChild(document.createTextNode(part));
    }
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }
  // "Save to Gmail drafts": the Sheriff's yes for Rufus to put a finished piece in their Gmail drafts
  function gmailButton(draftId) {
    const b = document.createElement('button');
    b.className = 'btn gmail'; b.textContent = 'Save to Gmail drafts'; b.title = 'Rufus saves it as a draft in your Gmail. Nothing is sent: you check it and press Send yourself.';
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      b.disabled = true; b.textContent = 'Rufus is saving it…';
      try {
        const r = await fetch(HELPER + '/gmail-draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draftId }) });
        const j = await r.json();
        b.textContent = r.ok && j.gmail && j.gmail.status === 'saved' ? 'Saved to your Gmail drafts' : 'Not saved (see the chat log)';
      } catch { b.textContent = "Not saved: the village helper isn't running"; }
      pollTodos();
    });
    return b;
  }
  function sayIn(key, who, text, cls) {
    if (!transcripts.has(key)) transcripts.set(key, []);
    transcripts.get(key).push({ who, text, cls });
    if (chatWith && keyOf(chatWith) === key && !chatEl.classList.contains('hidden')) addLine(chatLines, who, text, cls);
  }
  function showStatus() {
    const key = chatWith && keyOf(chatWith);
    chatStatus.textContent = thinking && thinking === key ? `${nameOf(chatWith)} is thinking…` : '';
    nextBatchBtn.classList.toggle('hidden', !(key === 'marshall' && pendingBatches > 0));
    nextBatchBtn.textContent = `Send next batch (${pendingBatches} waiting)`;
  }
  function openChat(withWho) {
    chatWith = withWho;
    chatTitle.textContent = nameOf(withWho);
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = withWho === 'marshall' ? 'Your Deputy: give orders here' : withWho.area;
    chatTitle.appendChild(sub);
    if (withWho !== 'marshall' && withWho.isCandidate && !transcripts.has(withWho.key)) {
      sayIn(withWho.key, '', `${withWho.name} is a candidate Marshall found to work for ${withWho.boss.name}. Ask them anything, then decide below. Nobody is hired without your yes.`, 'system');
    }
    if (withWho !== 'marshall' && withWho.isWorker && !transcripts.has(withWho.key)) {
      sayIn(withWho.key, '', `${withWho.name} is ${withWho.boss.name}'s worker and takes work only from ${withWho.boss.name.split(' ')[0]}.`, 'system');
    }
    chatLines.innerHTML = '';
    for (const l of transcripts.get(keyOf(withWho)) || []) addLine(chatLines, l.who, l.text, l.cls);
    chatEl.classList.remove('hidden');
    updateHireRow();
    showStatus();
    state.keys = {};
    chatInput.placeholder = withWho === 'marshall' ? 'Give Marshall an order…' : `Say something to ${withWho.name.split(' ')[0]}…`;
    chatInput.focus();
  }
  function closeChat() { chatEl.classList.add('hidden'); chatInput.blur(); }
  function toggleLog() { logEl.classList.toggle('hidden'); if (!logEl.classList.contains('hidden')) logLines.scrollTop = logLines.scrollHeight; }
  function talkToNearest() {
    const me = state.player;
    let near = null, best = 30;
    for (const q of people) {
      if (q.scene !== state.scene) continue;
      const d = Math.hypot(q.x - me.x, q.y - me.y);
      if (d < best) { best = d; near = q; }
    }
    openChat(near || 'marshall');
  }
  $('chat-close').addEventListener('click', closeChat);
  $('log-close').addEventListener('click', () => logEl.classList.add('hidden'));

  async function checkBrain() {
    try {
      const r = await fetch(HELPER + '/hello', { signal: AbortSignal.timeout(1500) });
      const j = await r.json();
      brainEl.textContent = `Village brains: connected (${j.model})`;
      brainEl.classList.add('on');
      return true;
    } catch {
      brainEl.textContent = 'Village brains: not running (see helper/README.md)';
      brainEl.classList.remove('on');
      return false;
    }
  }
  checkBrain();

  chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !chatWith) return;
    const who = chatWith, key = keyOf(who);
    if (thinking === key) return;
    chatInput.value = '';
    sayIn(key, 'Sheriff', text);
    if (who.isWorker) {                        // workers take work only from their townsperson: no call to the helper
      sayIn(key, who.name, `*friendly whinny* (${who.name} takes work only from ${who.boss.name}. To give them a job, tell ${who.boss.name.split(' ')[0]}: "give this to your worker".)`);
      return;
    }
    thinking = key; showStatus();
    try {
      const r = await fetch(HELPER + '/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: key, text }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Something went wrong.');
      sayIn(key, nameOf(who), j.reply);
      if (j.delegated && j.delegated.length) sayIn(key, '', `Handed to ${j.delegated.map(d => d.name).join(', ')}. Marshall will report back here when it's done; follow along in the chat log (L).`, 'note');
      if (j.handedTo) sayIn(key, '', `${who.name.split(' ')[0]} handed it to ${j.handedTo} and will check the work. It's on your to-do list; follow along in the chat log (L).`, 'note');
      if (j.noted) sayIn(key, '', `${who.name.split(' ')[0]} added something to their notes.`, 'note');
      if (typeof j.pending === 'number') pendingBatches = j.pending;
      brainEl.textContent = 'Village brains: connected'; brainEl.classList.add('on');
    } catch (err) {
      const offline = err instanceof TypeError;   // fetch failed: helper not reachable
      sayIn(key, '', offline
        ? `${nameOf(who)} can't hear you: the village helper isn't running on this computer. Start it (see helper/README.md) and try again.`
        : String(err.message || err), 'problem');
      if (offline) checkBrain();
    } finally {
      if (thinking === key) thinking = null;
      showStatus();
    }
  });
  nextBatchBtn.addEventListener('click', async () => {
    nextBatchBtn.blur();
    try {
      const r = await fetch(HELPER + '/next-batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j = await r.json();
      if (j.delegated && j.delegated.length) sayIn('marshall', '', `Next batch handed to ${j.delegated.map(d => d.name).join(', ')}.`, 'note');
      pendingBatches = j.pending || 0;
    } catch { sayIn('marshall', '', "The village helper isn't running.", 'problem'); }
    showStatus();
  });

  // the chat log: Marshall's hand-offs and the townspeople's reports, as they happen
  let lastLogId = 0, firstPoll = true;
  async function pollLog() {
    try {
      const r = await fetch(`${HELPER}/log?since=${lastLogId}`);
      const j = await r.json();
      for (const e of j.entries) {
        lastLogId = Math.max(lastLogId, e.id);
        const time = new Date(e.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        addLine(logLines, `${e.from} → ${e.to}`, e.text, e.kind, time);
        if (e.work) addLine(logLines, '', e.work, 'work');
        // Marshall reporting back: show it in Marshall's chat too (only news since the page opened)
        if (e.chat === 'marshall' && !firstPoll) {
          sayIn('marshall', 'Marshall', e.text, e.kind === 'problem' ? 'problem' : '');
          if (e.work) sayIn('marshall', '', e.work, 'work');
          if (e.draftId) sayIn('marshall', '', e.draftId, 'gmailbtn');
        }
      }
      firstPoll = false;
      // who's busy with a task right now: they walk home and work at their desk
      for (const p of people) p.tasks = j.working && j.working[p.key] ? [j.working[p.key]] : [];
      if (pendingBatches !== j.pending) { pendingBatches = j.pending; showStatus(); }
    } catch { /* helper not running */ }
  }
  setInterval(pollLog, 2000);
  pollLog();

  // ---------- the to-do list ----------
  // Type a task: Marshall hands it to the right townsperson, who gets it done.
  // Done items are crossed off; hover over one to see exactly what was done.
  const todoEl = $('todo'), todoForm = $('todo-form'), todoInput = $('todo-input'), todoList = $('todo-list');
  const todoEmpty = $('todo-empty'), todoTip = $('todo-tip');
  let todos = [], todosShown = '';
  const timeOf = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const first = (n) => String(n || '').split(' ')[0];
  const tries = (a) => a.tries > 1 ? ` (${a.tries} tries)` : '';
  // "Done by Biscuit · checked by Clem", or "Done by Clem" when no worker was used
  const whoDid = (a) => `Done by ${a.doneBy || a.name}${a.checkedBy ? ` · checked by ${first(a.checkedBy)}` : ''}${tries(a)}`;
  function stateLine(t) {
    if (t.status === 'choosing') return 'Marshall is choosing who should do it…';
    if (t.status === 'needs someone') return `Nobody in town fits yet. Marshall: ${t.note || ''}`;
    if (t.status === 'problem') return `Problem: ${t.note || 'something went wrong'}`;
    const by = t.assignments.map(a => a.status === 'done' ? `${a.name}: done`
      : a.status === 'with worker' ? `${a.worker} is working on it${a.tries ? ` (try ${a.tries + 1})` : ''}; ${first(a.name)} will check`
      : a.status === 'checking' ? `${first(a.name)} is checking ${a.worker}'s work`
      : a.status === 'sent back' ? `${first(a.name)} sent it back to ${a.worker} with notes`
      : `${a.name}: ${a.status === 'working' ? 'working on it' : a.status === 'problem' ? 'had a problem' : 'waiting their turn'}`);
    return t.status === 'done' ? t.assignments.map(whoDid).join(' · ') + ` · ${timeOf(t.doneAt)}` : by.join(' · ');
  }
  function tipText(t) {
    const lines = [];
    if (t.status === 'done') lines.push(`<b>What was done</b> (finished ${timeOf(t.doneAt)})`);
    else lines.push(`<b>${t.status === 'choosing' ? 'Marshall is choosing who' : 'Where it stands'}</b>`);
    for (const a of t.assignments) {
      lines.push('');
      lines.push(`<b>${a.name}</b> · ${a.task}`);
      if (a.worker || a.checkedBy) lines.push(`Handed to ${a.worker || a.doneBy}${a.instructions ? ` with these instructions: ${a.instructions}` : ''}`);
      for (const [i, n] of (a.sendBacks || []).entries()) lines.push(`<b>Sent back ${i + 1}:</b> ${n}`);
      if (a.status === 'done') {
        lines.push(`<b>${whoDid(a)}</b>`);
        if (a.work) { lines.push(''); lines.push(a.work); lines.push(''); }
        if (a.checkedBy) lines.push(`<b>${first(a.checkedBy)}'s check:</b> ${a.result || ''}`);
        else lines.push(`${a.result || a.report || ''}`);
      } else lines.push(a.status === 'working' ? 'Working on it now…' : a.status === 'with worker' ? `${a.worker} is working on it now…` : a.status === 'checking' ? `${first(a.name)} is checking it now…` : a.status === 'sent back' ? `Back with ${a.worker} to fix…` : a.status === 'problem' ? `Problem: ${a.result || ''}` : 'Waiting their turn.');
    }
    if (!t.assignments.length && t.note) { lines.push(''); lines.push(`Marshall: ${t.note}`); }
    return lines.map(l => l.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/&lt;(\/?)b&gt;/g, '<$1b>')).join('\n');
  }
  function renderTodos() {
    const shown = JSON.stringify(todos);
    if (shown === todosShown) return;
    todosShown = shown;
    todoList.innerHTML = '';
    for (const t of [...todos].reverse()) {          // newest first
      const li = document.createElement('li');
      li.className = t.status === 'done' ? 'done' : t.status === 'problem' ? 'problem' : '';
      const box = document.createElement('span'); box.className = 'box'; box.textContent = t.status === 'done' ? '☑' : '☐';
      const text = document.createElement('span'); text.className = 'text';
      const label = document.createElement('span'); label.textContent = t.text;
      const st = document.createElement('span'); st.className = 'state'; st.textContent = stateLine(t);
      text.append(label, st);
      for (const a of t.assignments) {
        if (!a.draftId) continue;
        if (a.gmail && a.gmail.status === 'saved') {
          const g = document.createElement(a.gmail.link ? 'a' : 'span'); g.className = 'state';
          g.textContent = 'In your Gmail drafts'; if (a.gmail.link) { g.href = a.gmail.link; g.target = '_blank'; g.rel = 'noopener'; }
          text.append(g);
        } else { const g = gmailButton(a.draftId); g.style.marginTop = '4px'; text.append(g); }
      }
      li.append(box, text);
      li.addEventListener('mouseenter', (e) => { todoTip.innerHTML = tipText(t); todoTip.style.display = 'block'; placeTip(e); });
      li.addEventListener('mousemove', placeTip);
      li.addEventListener('mouseleave', () => { todoTip.style.display = 'none'; });
      todoList.appendChild(li);
    }
    todoEmpty.style.display = todos.length ? 'none' : 'block';
    const open = todos.filter(t => t.status !== 'done').length;
    todoBtn.textContent = open ? `To-Do (${open})` : 'To-Do';
  }
  function placeTip(e) {
    const w = todoTip.offsetWidth, h = todoTip.offsetHeight;
    todoTip.style.left = Math.min(e.clientX + 16, innerWidth - w - 8) + 'px';
    todoTip.style.top = Math.min(e.clientY + 16, innerHeight - h - 8) + 'px';
  }
  function openTodo() { todoEl.classList.remove('hidden'); state.keys = {}; todoInput.focus(); pollTodos(); }
  function closeTodo() { todoEl.classList.add('hidden'); todoInput.blur(); todoTip.style.display = 'none'; }
  function toggleTodo() { todoEl.classList.contains('hidden') ? openTodo() : closeTodo(); }
  $('todo-close').addEventListener('click', closeTodo);
  todoForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = todoInput.value.trim();
    if (!text) return;
    try {
      const r = await fetch(HELPER + '/todos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Something went wrong.');
      todoInput.value = '';
      todos.push(j.todo); renderTodos();
    } catch (err) {
      todoEmpty.style.display = 'block';
      todoEmpty.textContent = err instanceof TypeError ? "Can't add to the list: the village helper isn't running on this computer (see helper/README.md)." : String(err.message || err);
    }
  });
  async function pollTodos() {
    try { const r = await fetch(HELPER + '/todos'); todos = (await r.json()).todos || []; renderTodos(); } catch { /* helper not running */ }
  }
  setInterval(pollTodos, 2000);

  // ---------- input ----------
  const KEYMAP = {
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  };
  addEventListener('keydown', (e) => {
    // while typing, keys go to the chat box, not the Sheriff
    if (document.activeElement === chatInput) { if (e.key === 'Escape') closeChat(); return; }
    if (document.activeElement === todoInput) { if (e.key === 'Escape') closeTodo(); return; }
    if (e.code === 'KeyT') { e.preventDefault(); talkToNearest(); return; }
    if (e.code === 'KeyM') { e.preventDefault(); openChat('marshall'); return; }
    if (e.code === 'KeyL') { toggleLog(); return; }
    if (e.key === 'Escape') { if (!noticesEl.classList.contains('hidden')) closeNotices(); else if (!todoEl.classList.contains('hidden')) closeTodo(); else closeChat(); return; }
    if (e.code === 'KeyN') { toggleNotices(); return; }
    if (KEYMAP[e.code]) { state.keys[KEYMAP[e.code]] = true; e.preventDefault(); return; }
    if (e.key === '+' || e.key === '=') zoomStep(1);
    else if (e.key === '-' || e.key === '_') zoomStep(-1);
    else if (e.code === 'KeyF') { state.fit = !state.fit; }
    else if (e.key === '0') { state.fit = false; state.hero = true; }
    else if (e.code === 'KeyH') helpEl.classList.toggle('hidden');
  });
  addEventListener('keyup', (e) => { if (KEYMAP[e.code]) state.keys[KEYMAP[e.code]] = false; });
  addEventListener('blur', () => { state.keys = {}; });
  view.addEventListener('wheel', (e) => { e.preventDefault(); zoomStep(e.deltaY < 0 ? 1 : -1); }, { passive: false });

  function fitZoom() {
    const S = state.scene;
    return Math.min(innerWidth / (S.w * T), innerHeight / (S.h * T));
  }
  // Same size everywhere: in town the Sheriff is 1/8 of the screen height,
  // exactly as he is inside a room (a room is 8 Sheriffs tall).
  function heroZoom() { return innerHeight / (ROOM_H * T); }
  function currentZoom() { return state.fit ? fitZoom() : state.hero ? heroZoom() : state.zoom; }
  function zoomStep(dir) {
    const cur = currentZoom();
    state.fit = false;
    state.hero = false;
    if (dir > 0) state.zoom = ZOOMS.find(z => z > cur + 0.01) || ZOOMS[ZOOMS.length - 1];
    else state.zoom = [...ZOOMS].reverse().find(z => z < cur - 0.01) || ZOOMS[0];
  }

  // ---------- movement and collisions ----------
  // The Sheriff can't walk through walls, furniture, fences or townspeople.
  // Walking into a townsperson who is standing still: they step aside.
  function bumpsInto(x, y) {
    const p = state.player;
    for (const q of people) {
      if (q.scene !== state.scene) continue;
      const now = Math.hypot(q.x - p.x, q.y - p.y), then = Math.hypot(q.x - x, q.y - y);
      if (then < 10 && then < now) return q;               // moving away from someone is always allowed
    }
    return null;
  }
  function blocked(x, y) {
    const S = state.scene;
    const left = x - 5, right = x + 4, top = y - 5, bottom = y - 1;
    const B = S.bounds; // rooms have thin walls, checked in pixels
    if (B) {
      if (left < B.left || right > B.right || top < B.top) return true;
      if (bottom > B.bottom && !(left > B.doorX0 && right < B.doorX1)) return true;
      if (bottom >= S.h * T) return true;
    }
    for (const [px, py] of [[left, top], [right, top], [left, bottom], [right, bottom]]) {
      if (S.solidAt(Math.floor(px / T), Math.floor(py / T))) return true;
    }
    const q = bumpsInto(x, y);
    if (q) { state.bump = q; return true; }
    return false;
  }
  function tryMove(dx, dy) {
    const p = state.player;
    if (!blocked(p.x + dx, p.y + dy)) { p.x += dx; p.y += dy; return true; }
    return false;
  }

  function changeScene(next, spawn) {
    state.pending = { next, spawn };
    state.fadeDir = 1;
  }

  // ---------- the menu bar ----------
  const menuEl = document.createElement('div');
  menuEl.className = 'panel';
  menuEl.style.cssText = 'top:12px;left:50%;transform:translateX(-50%);padding:6px;display:flex;gap:6px';
  const btnCss = 'font:inherit;color:#f1e6c8;background:#7e4f2c;border:2px solid #2e1d14;padding:4px 12px;cursor:pointer';
  const meetBtn = document.createElement('button');
  meetBtn.textContent = 'Call Meeting';
  meetBtn.style.cssText = btnCss;
  meetBtn.addEventListener('click', () => { state.meeting ? endMeeting() : callMeeting(); meetBtn.blur(); });
  // Work Hours: a stand-in until townspeople have real tasks. While on, everyone works at their desk.
  const workBtn = document.createElement('button');
  workBtn.textContent = 'Work Hours: Off';
  workBtn.title = 'Stand-in until townspeople have real tasks: everyone goes to their desk';
  workBtn.style.cssText = btnCss;
  workBtn.addEventListener('click', () => {
    state.workTime = !state.workTime;
    workBtn.textContent = state.workTime ? 'Work Hours: On' : 'Work Hours: Off';
    workBtn.blur();
  });
  const logBtn = document.createElement('button');
  logBtn.textContent = 'Chat Log'; logBtn.title = 'Shortcut: L'; logBtn.style.cssText = btnCss;
  logBtn.addEventListener('click', () => { toggleLog(); logBtn.blur(); });
  const deputyBtn = document.createElement('button');
  deputyBtn.textContent = 'Deputy'; deputyBtn.title = "Talk to Marshall (shortcut: M)"; deputyBtn.style.cssText = btnCss;
  deputyBtn.addEventListener('click', () => { openChat('marshall'); });
  const todoBtn = document.createElement('button');
  todoBtn.textContent = 'To-Do'; todoBtn.title = 'Your to-do list'; todoBtn.style.cssText = btnCss;
  todoBtn.addEventListener('click', () => { toggleTodo(); });
  const noticeBtn = document.createElement('button');
  noticeBtn.textContent = 'Notices'; noticeBtn.title = 'What Marshall needs you for (shortcut: N)'; noticeBtn.style.cssText = btnCss;
  noticeBtn.addEventListener('click', () => { toggleNotices(); noticeBtn.blur(); });
  menuEl.append(noticeBtn, todoBtn, meetBtn, workBtn, logBtn, deputyBtn);
  document.body.appendChild(menuEl);
  whoEl.style.top = '58px';

  // ---------- town meetings ----------
  // Call Meeting: everyone WALKS to the town hall, the Sheriff too (on autopilot;
  // any arrow key takes back control). End Meeting: the townspeople walk back to
  // their day; the Sheriff and Marshall walk out to the front of the town hall.
  const hallLane = Math.floor(hallRoom.bounds.doorX0 / T);
  const freeInHall = (x, y) => x >= 1 && x <= hallRoom.w - 2 && y >= 1 && y <= hallRoom.h - 2 && !hallRoom.solidAt(x, y) && !(x === hallLane && y >= 5);
  function nearestFree([x, y], taken) {
    for (let r = 0; r < 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const k = (x + dx) + ',' + (y + dy);
      if (freeInHall(x + dx, y + dy) && !taken.has(k)) { taken.add(k); return [x + dx, y + dy]; }
    }
    return [x, y];
  }
  const meetingSpots = (() => {
    const taken = new Set();
    const sheriffSpot = nearestFree([8, 2], taken);          // at the head of the table, by the lectern
    const deputySpot = nearestFree([10, 2], taken);          // Marshall beside the Sheriff
    // the ten seats: the meeting benches and the two chairs at the table (all facing the Sheriff)
    const seats = [];
    for (let y = 1; y < hallRoom.h - 1; y++) for (let x = 1; x < hallRoom.w - 1; x++) {
      if (!hallRoom.solidAt(x, y)) continue;
      const isBench = y === 7 && ((x >= 2 && x <= 5) || (x >= 11 && x <= 14));
      const isChair = y === 5 && (x === 7 || x === 9);
      if (isBench || isChair) seats.push([x, y]);
    }
    return { sheriffSpot, deputySpot, seats };
  })();
  // seats farthest from the door fill first, so nobody squeezes past anyone
  const hallDoor = [hallLane, hallRoom.h - 1];
  const seatOrder = [...meetingSpots.seats].sort((a, b) => Math.hypot(b[0] - hallDoor[0], b[1] - hallDoor[1]) - Math.hypot(a[0] - hallDoor[0], a[1] - hallDoor[1]));
  const hallBuilding = town.buildings.find(b => b.id === 'hall');
  const hallFront = [hallBuilding.door.x, hallBuilding.door.y + 2];   // on the boardwalk out front

  function callMeeting() {
    if (state.meeting) return;
    const claimed = new Set();
    state.meeting = {
      room: hallRoom,
      anySeat: seatOrder[0],
      claim(p) {
        const seat = seatOrder.find(s => !claimed.has(s.join(','))) || seatOrder[seatOrder.length - 1];
        claimed.add(seat.join(','));
        return seat;
      },
    };
    state.player.auto = { scene: hallRoom, tile: meetingSpots.sheriffSpot, face: 'down' };
    Object.assign(deputy, { goal: { scene: hallRoom, tile: meetingSpots.deputySpot }, path: [], after: null, following: false });
    meetBtn.textContent = 'End Meeting';
  }
  function endMeeting() {
    if (!state.meeting) return;
    state.meeting = null;
    state.player.auto = { scene: town, tile: hallFront, face: 'down' };
    Object.assign(deputy, { goal: { scene: town, tile: [hallFront[0] - 1, hallFront[1]] }, path: [], after: 'follow', following: false });
    meetBtn.textContent = 'Call Meeting';
  }

  // ---------- chats between townspeople, and their notes ----------
  // "Today" is the real calendar day on this computer. Each pair talks once a day.
  const today = () => new Date().toLocaleDateString('en-CA');      // YYYY-MM-DD
  const pairKey = (a, b) => [a.key, b.key].sort().join('+');
  const store = {
    get(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable: keep in memory */ } },
  };
  let talked = store.get('aiv-talked', { date: today(), pairs: [] });
  if (talked.date !== today()) talked = { date: today(), pairs: [] };
  let noteQueue = store.get('aiv-note-queue', []);               // notes waiting for Marshall's helper
  function talkedToday(a, b) {
    if (talked.date !== today()) talked = { date: today(), pairs: [] };
    return talked.pairs.includes(pairKey(a, b));
  }
  function recordChat(a, b) {
    talked.pairs.push(pairKey(a, b));
    store.set('aiv-talked', talked);
    const said = (who) => who.tasks.length ? who.tasks.join('; ') : 'nothing assigned yet';
    noteQueue.push({ agent: a.key, text: `Talked with ${b.name} (${b.area}). Asked what they're working on: ${said(b)}.` });
    noteQueue.push({ agent: b.key, text: `Talked with ${a.name} (${a.area}). Asked what they're working on: ${said(a)}.` });
    store.set('aiv-note-queue', noteQueue);
    flushNotes();
  }
  let flushing = false;
  async function flushNotes() {
    if (flushing || !noteQueue.length) return;
    flushing = true;
    try {
      while (noteQueue.length) {
        const n = noteQueue[0];
        const r = await fetch(HELPER + '/note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(n) });
        if (!r.ok) break;
        noteQueue.shift();
        store.set('aiv-note-queue', noteQueue);
      }
    } catch { /* helper not running: try again later */ }
    flushing = false;
  }
  setInterval(flushNotes, 20000);

  // ---------- hiring: candidates at the town hall, and new workers ----------
  // Marshall finds a candidate when a townsperson needs help (or you ask). They walk in
  // on the south road and wait at the town hall. Walk up, press T and interview them;
  // Hire or Not this one. Hired: they walk to their townsperson's yard and start work.
  const hireRow = $('hire-row'), hireBtn = $('hire-yes'), passBtn = $('hire-no'), hireHint = $('hire-hint');
  const deciding = new Set();
  function candidateWaitTile() {
    const avoid = [meetingSpots.sheriffSpot, meetingSpots.deputySpot].map(t => t.join(','));
    for (const t of [[12, 2], [13, 2], [4, 2], [3, 2], [12, 3], [3, 3]]) if (freeInHall(...t) && !avoid.includes(t.join(','))) return t;
    return meetingSpots.deputySpot;
  }
  const townsfolkOnly = () => people.filter(q => !q.isWorker && !q.isCandidate);
  function sendAway(q) { q.leaving = true; q.goal = { scene: town, tile: nav.entry }; q.path = []; }
  async function pollRoster() {
    try {
      const j = await (await fetch(HELPER + '/roster')).json();
      for (const w of j.workers || []) {
        if (people.some(q => q.key === w.key) || !townsfolkOnly().some(t => t.key === w.owner)) continue;
        const a = makeWorker(w, people.length, town, townsfolkOnly(), null, people);
        a.sheet = workerSheet; people.push(a);
      }
      const c = j.candidate;
      if (c && !people.some(q => q.key === c.key) && townsfolkOnly().some(t => t.key === c.owner)) {
        const a = makeCandidate(c, town, nav, hallRoom, candidateWaitTile(), townsfolkOnly());
        a.sheet = workerSheet; people.push(a);
      }
      for (const q of people) if (q.isCandidate && !q.leaving && !deciding.has(q.key) && (!c || c.key !== q.key)) sendAway(q);
    } catch { /* helper not running */ }
  }
  setInterval(pollRoster, 3000);
  pollRoster();
  function updateHireRow() {
    const c = chatWith && chatWith !== 'marshall' && chatWith.isCandidate && !chatWith.leaving ? chatWith : null;
    hireRow.classList.toggle('hidden', !c);
    if (!c) return;
    const here = state.scene === hallRoom && c.scene === hallRoom;
    hireBtn.disabled = passBtn.disabled = !here || deciding.has(c.key);
    hireHint.textContent = here ? `Hire ${c.name} to work for ${c.boss.name.split(' ')[0]}?` : `Interview ${c.name} at the town hall to decide.`;
  }
  async function decideCandidate(hire) {
    const c = chatWith;
    if (!c || !c.isCandidate || deciding.has(c.key)) return;
    deciding.add(c.key); updateHireRow();
    try {
      const r = await fetch(HELPER + '/hire', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: c.key, decision: hire ? 'hire' : 'pass' }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Something went wrong.');
      if (j.hired) {
        // the candidate becomes a worker and walks to their townsperson's yard
        const keep = { scene: c.scene, x: c.x, y: c.y, dir: c.dir, stepTo: c.stepTo };
        Object.assign(c, makeWorker(j.worker, people.length, town, townsfolkOnly(), { scene: c.scene, x: c.x, y: c.y }, people), keep,
          { isCandidate: false, leaving: false, justHired: true, path: [], goal: null });
        sayIn(c.key, '', `Hired! ${c.name} is heading to ${c.boss.name}'s house to start work.`, 'note');
      } else {
        sayIn(c.key, '', `${c.name} wasn't hired and is heading out of town.`, 'note');
        sendAway(c);
      }
    } catch (err) { sayIn(c.key, '', String(err instanceof TypeError ? "The village helper isn't running." : err.message), 'problem'); }
    deciding.delete(c.key); updateHireRow();
  }
  hireBtn.addEventListener('click', () => decideCandidate(true));
  passBtn.addEventListener('click', () => decideCandidate(false));

  // ---------- notices: everything Marshall needs you for ----------
  // A count on the Notices button, a short pop-up for anything new, and a list.
  // Click a notice to go to it. (Mac notifications come from the helper.)
  const noticesEl = $('notices'), noticeList = $('notice-list'), noticeEmpty = $('notice-empty'), toastEl = $('toast'), macBtn = $('mac-toggle');
  let notices = [], lastNoticeId = null, macOn = true, toastTimer = 0;
  const NOTICE_LABEL = { candidate: 'Candidate waiting', draft: 'Gmail draft?', send: 'Ready to send', done: 'Done', batch: 'Your go-ahead', nofit: 'Nobody fits', problem: 'Problem', help: 'Needs help' };
  function openNotices() { noticesEl.classList.remove('hidden'); toastEl.style.display = 'none'; pollNotices(); }
  function closeNotices() { noticesEl.classList.add('hidden'); }
  function toggleNotices() { noticesEl.classList.contains('hidden') ? openNotices() : closeNotices(); }
  $('notices-close').addEventListener('click', closeNotices);
  $('notices-clear').addEventListener('click', async () => { try { await fetch(HELPER + '/notices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dismissAll: true }) }); } catch { /* */ } pollNotices(); });
  macBtn.addEventListener('click', async () => {
    try { const r = await fetch(HELPER + '/notices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mac: !macOn }) }); macOn = (await r.json()).mac; } catch { /* */ }
    renderNotices();
  });
  function goToNotice(n) {
    const ref = n.ref || {};
    closeNotices();
    if (ref.candidate) {
      // walk to the town hall, in front of the candidate (any arrow key takes back control)
      const c = people.find(q => q.key === ref.candidate && q.isCandidate);
      const t = c && c.goal ? [c.goal.tile[0], c.goal.tile[1] + 1] : candidateWaitTile();
      state.player.auto = { scene: hallRoom, tile: freeInHall(...t) ? t : nearestFree(t, new Set()), face: 'up' };
      return;
    }
    if (ref.todo) openTodo(); else if (ref.log) { if (logEl.classList.contains('hidden')) toggleLog(); } else openChat('marshall');
    fetch(HELPER + '/notices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dismiss: n.id }) }).then(pollNotices, () => {});
  }
  function renderNotices() {
    const open = notices.filter(n => n.open);
    noticeBtn.textContent = open.length ? `Notices (${open.length})` : 'Notices';
    noticeBtn.style.background = open.length ? '#b5652a' : '#7e4f2c';
    macBtn.textContent = `Mac notifications: ${macOn ? 'On' : 'Off'}`;
    noticeList.innerHTML = '';
    for (const n of [...notices].reverse()) {
      const li = document.createElement('li');
      if (!n.open) li.className = 'seen';
      const tag = document.createElement('span'); tag.className = 'tag ' + n.kind; tag.textContent = NOTICE_LABEL[n.kind] || 'News';
      const txt = document.createElement('span'); txt.className = 'text'; txt.textContent = n.text;
      const time = document.createElement('span'); time.className = 'time'; time.textContent = timeOf(n.time);
      li.append(tag, txt, time);
      li.addEventListener('click', () => goToNotice(n));
      noticeList.appendChild(li);
    }
    noticeEmpty.style.display = notices.length ? 'none' : 'block';
  }
  function toast(n) {
    toastEl.textContent = /^Marshall\b/.test(n.text) ? n.text : `Marshall: ${n.text}`;
    toastEl.style.display = 'block';
    toastEl.onclick = () => { toastEl.style.display = 'none'; goToNotice(n); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 7000);
  }
  async function pollNotices() {
    try {
      const j = await (await fetch(HELPER + '/notices')).json();
      notices = j.notices || []; macOn = j.mac !== false;
      $('mac-row').style.display = j.macAvailable ? '' : 'none';
      const newest = notices.filter(n => n.open).reduce((m, n) => (n.id > (m ? m.id : 0) ? n : m), null);
      if (lastNoticeId !== null && newest && newest.id > lastNoticeId) toast(newest);
      lastNoticeId = Math.max(lastNoticeId || 0, ...notices.map(n => n.id));
      renderNotices();
    } catch { /* helper not running */ }
  }
  setInterval(pollNotices, 3000);
  pollNotices();

  // ---------- each frame ----------
  function update(dt) {
    state.player.scene = state.scene;
    state.player.isBody = !state.player.auto;   // the Sheriff moves freely (holds every square under their feet), except on autopilot
    deputy.isBody = !deputy.goal;               // so does Marshall while following
    const everyone = [state.player, deputy, ...people];
    nav.everyone = everyone;                    // so walkers keep their distance from everyone
    occ = occupancy(everyone);
    updatePlayer(dt);
    state.player.sinceMoved = state.player.moving ? 0 : (state.player.sinceMoved || 0) + dt;
    occ = occupancy(everyone);
    if (state.fadeDir === 0) updateDeputy(dt);
    const lifeCtx = {
      nav, occ, sheriff: state.player, meeting: state.meeting, workTime: state.workTime,
      sheriffWalking: state.player.sinceMoved < 0.8,
      chattingWith: chatWith && chatWith !== 'marshall' && !chatEl.classList.contains('hidden') ? chatWith : null,
      talkedToday, recordChat,
    };
    people.forEach((person, i) => updateTownsperson(person, i, dt, lifeCtx, people));
    for (let i = people.length - 1; i >= 0; i--) if (people[i].gone) {     // a candidate who walked out of town
      if (chatWith === people[i]) closeChat();
      people.splice(i, 1);
    }
    updateHireRow();

    // the Sheriff walked into someone standing still: they step aside
    if (state.bump && state.bumpFor > 0.4) { stepAside(state.bump); state.bumpFor = 0; }
    state.bumpFor = state.bump ? (state.bumpFor || 0) + dt : 0;
    state.bump = null;

    // what the top-left label says
    const label = state.scene.label + (state.meeting && state.scene === hallRoom ? ' · Meeting' : '');
    if (whereEl.textContent !== label) whereEl.textContent = label;

    // name card for whoever the Sheriff is standing next to
    const me = state.player;
    let near = null, best = 26;
    for (const person of people) {
      if (person.scene !== state.scene) continue;
      const d = Math.hypot(person.x - me.x, person.y - me.y);
      if (d < best) { best = d; near = person; }
    }
    if (near) { whoEl.textContent = `${near.name} · ${near.area}`; whoEl.style.display = 'block'; }
    else whoEl.style.display = 'none';
  }

  function stepAside(q) {
    if (q.seated || q.moving) return;
    const [cx, cy] = [Math.floor(q.x / T), Math.floor((q.y - 3) / T)];
    const pass = nav.passable(q.scene, q);
    const here = occ.get(q.scene) || new Map();
    const p = state.player;
    let best = null, bestD = -1;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (!pass(nx, ny) || here.has(nx + ',' + ny) || nav.doorAtTile.has(nx + ',' + ny)) continue;
      const d = Math.hypot(nx * T + 8 - p.x, ny * T + 12 - p.y);
      if (d > bestD) { bestD = d; best = [nx, ny]; }
    }
    if (best) { q.yieldTo = best; }
  }

  // Arriving in a new place (the Sheriff's autopilot walks through doors itself).
  function enterScene(next) {
    if (next.isRoom && !state.scene.isRoom) { state.townView = { zoom: state.zoom, fit: state.fit, hero: state.hero }; state.fit = true; }
    if (!next.isRoom && state.townView) { Object.assign(state, state.townView); state.townView = null; }
    else if (!next.isRoom && state.scene.isRoom) { state.fit = false; state.hero = true; }
    state.scene = next;
    state.fade = 0.7; state.fadeDir = -1;                  // a quick dip, like stepping through a door
  }

  function updatePlayer(dt) {
    const p = state.player;
    if (state.fadeDir !== 0) {
      state.fade += state.fadeDir * dt * 6;
      if (state.fade >= 1 && state.fadeDir > 0) {
        state.fade = 1;
        const { next, spawn } = state.pending;
        // A room always fills the screen when you walk in; the town keeps your zoom.
        if (next.isRoom && !state.scene.isRoom) { state.townView = { zoom: state.zoom, fit: state.fit, hero: state.hero }; state.fit = true; }
        if (!next.isRoom && state.townView) { Object.assign(state, state.townView); state.townView = null; }
        else if (!next.isRoom && state.scene.isRoom) { state.fit = false; state.hero = true; }
        state.scene = next;
        p.scene = next;
        p.x = spawn.x; p.y = spawn.y; p.dir = spawn.dir;
        if (deputy.following) recordTrail();   // Marshall comes through the same door
        state.pending = null;
        state.fadeDir = -1;
      } else if (state.fade <= 0 && state.fadeDir < 0) {
        state.fade = 0; state.fadeDir = 0;
      }
      return;
    }

    let dx = 0, dy = 0;
    if (state.keys.left) dx -= 1;
    if (state.keys.right) dx += 1;
    if (state.keys.up) dy -= 1;
    if (state.keys.down) dy += 1;
    if (dx || dy) { if (p.auto) { p.auto = null; p.goal = null; p.stepTo = null; p.path = []; } }   // any arrow key takes back control
    else if (p.auto) {
      // autopilot: walk square by square like everyone else, door by door
      p.goal = p.auto;
      const before = p.scene;
      const res = walk(p, dt, nav, occ, 60);
      if (p.scene !== before) enterScene(p.scene);
      if (deputy.following) recordTrail();
      if (res === 'arrived') { p.dir = p.auto.face || 'down'; p.auto = null; p.goal = null; }
      return;
    }
    p.moving = dx !== 0 || dy !== 0;
    if (!p.moving) return;
    if (Math.abs(dy) >= Math.abs(dx)) p.dir = dy < 0 ? 'up' : 'down';
    else p.dir = dx < 0 ? 'left' : 'right';
    const len = Math.hypot(dx, dy);
    const step = SPEED * dt / len;
    const S = state.scene;
    // Walking down near a room's door: line up with the doorway automatically.
    if (S.bounds && dy > 0 && p.y > S.h * T - 40) {
      const cxd = (S.bounds.doorX0 + S.bounds.doorX1) / 2;
      if (Math.abs(p.x - cxd) < 12) p.x += Math.max(-step, Math.min(step, cxd - p.x));
    }
    tryMove(dx * step, 0);
    tryMove(0, dy * step);
    p.t += dt;
    if (deputy.following) recordTrail();

    const tx = Math.floor(p.x / T), ty = Math.floor((p.y - 3) / T);
    const doorId = S.doorAt(tx, ty);
    if (doorId) {
      const b = town.buildings.find(bb => bb.id === doorId);
      const room = getInterior(b);
      changeScene(room, room.spawn);
    } else if (S.exitAt(p.x, p.y)) {
      const b = S.building;
      changeScene(town, { x: b.door.x * T + 8, y: (b.door.y + 1) * T + 12, dir: 'down' });
    }
  }

  // ---------- drawing ----------
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    view.width = Math.round(innerWidth * dpr);
    view.height = Math.round(innerHeight * dpr);
  }
  addEventListener('resize', resize);
  resize();

  function render() {
    const dpr = window.devicePixelRatio || 1;
    const S = state.scene, p = state.player;
    const vw = view.width, vh = view.height;
    const zoom = currentZoom();
    const s = zoom * dpr;
    const ww = S.w * T, wh = S.h * T;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1c120c';
    ctx.fillRect(0, 0, vw, vh);

    let cx = p.x - vw / s / 2, cy = p.y - 8 - vh / s / 2;
    cx = ww * s <= vw ? -(vw / s - ww) / 2 : Math.max(0, Math.min(cx, ww - vw / s));
    cy = wh * s <= vh ? -(vh / s - wh) / 2 : Math.max(0, Math.min(cy, wh - vh / s));
    cx = Math.round(cx * s) / s; cy = Math.round(cy * s) / s;

    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(s, 0, 0, s, -cx * s, -cy * s);
    ctx.drawImage(S.ground, 0, 0, S.w * T, S.h * T);

    // characters: pick the row for the direction and the frame of the walk,
    // and draw them in depth order with the buildings and furniture
    const drawActor = (a, sheet) => {
      const col = a.moving ? WALK[Math.floor(a.t * 7) % 4] : 1;
      const ax = Math.round(a.x * 2) / 2, ay = Math.round(a.y * 2) / 2;
      const fw = sheet.frameW / 2, fh = sheet.frameH / 2; // world size
      const sit = a.seated ? 3 : 0;            // seated at the desk: a little lower, the chair hides the legs
      if (!a.seated) ctx.drawImage(shadowImg, ax - 8, ay - 2);
      if (sheet.ready) ctx.drawImage(sheet.img, col * sheet.frameW, ROW[a.dir] * sheet.frameH, sheet.frameW, sheet.frameH, ax - fw / 2, ay - fh + 1 - sit, fw, fh);
    };
    const actors = [{ a: p, sheet: sheriffSheet }];
    if (deputy.scene === S) actors.push({ a: deputy, sheet: marshallSheet });
    for (const person of people) if (person.scene === S) actors.push({ a: person, sheet: person.sheet });
    actors.sort((u, v) => u.a.y - v.a.y);
    let ai = 0;
    for (const o of S.objects) {
      while (ai < actors.length && o.base > actors[ai].a.y) { drawActor(actors[ai].a, actors[ai].sheet); ai++; }
      ctx.drawImage(o.img, o.x, o.y, o.w, o.h);
    }
    while (ai < actors.length) { drawActor(actors[ai].a, actors[ai].sheet); ai++; }

    // speech bubbles over two townspeople who stopped for a chat (no text)
    for (const person of people) {
      if (!person.chat || person.scene !== S) continue;
      const bx = Math.round(person.x) - 6, by = Math.round(person.y) - person.sheet.frameH / 2 - 9;
      ctx.drawImage(bubbleImg, bx, by, 12, 8);
      ctx.fillStyle = PAL.out;
      const talking = Math.floor(performance.now() / 500) % 2 === (person.key < person.chat.with.key ? 0 : 1);
      if (talking) for (let i = 0; i < 3; i++) ctx.fillRect(bx + 3 + i * 2.5, by + 3, 1.5, 1.5);
      else ctx.fillRect(bx + 3, by + 3.5, 6.5, 0.75);
    }

    // thinking bubbles (no text): over whoever is working out a reply, and anyone working on a task
    const thinkers = [];
    if (thinking === 'marshall' && deputy.scene === S) thinkers.push({ a: deputy, h: marshallSheet.frameH });
    for (const person of people) if (person.scene === S && (thinking === person.key || person.tasks.length)) thinkers.push({ a: person, h: person.sheet.frameH });
    for (const { a, h } of thinkers) {
      const bx = Math.round(a.x) - 6, by = Math.round(a.y) - h / 2 - 9 - (a.seated ? 3 : 0);
      ctx.drawImage(bubbleImg, bx, by, 12, 8);
      const dot = Math.floor(performance.now() / 300) % 3;
      ctx.fillStyle = PAL.out;
      for (let i = 0; i < 3; i++) ctx.fillRect(bx + 3 + i * 2.5, by + 3, 1.5, i <= dot ? 1.5 : 0.75);
    }

    if (state.fade > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgba(28,18,12,${Math.min(1, state.fade)})`;
      ctx.fillRect(0, 0, vw, vh);
    }
  }

  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // Handy for testing from the browser console.
  window.village = {
    state, town, deputy, people,
    enter(id) { const b = town.buildings.find(bb => bb.id === id); const room = getInterior(b); changeScene(room, room.spawn); },
    goto(tx, ty, dir) { state.player.x = tx * T + 8; state.player.y = ty * T + 12; state.player.dir = dir || 'down'; },
  };
})();
