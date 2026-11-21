'use strict';
// townsfolk.js: how everyone in the village moves.
//
// Movement rules (decided with the Sheriff):
//  - Working: walk home, go inside, sit at your desk.
//  - When the Sheriff walks near you: stop and turn to look at the Sheriff.
//  - Not working: wander the whole town along the paths. If you bump into
//    someone you haven't talked to today, both stop, ask what the other is
//    working on, and both take notes. Already talked today: walk on by.
//  - Stay on the paths, walk around each other, never through walls.
//  - Nobody teleports: to go inside, walk to the door and through it.
//  - Nobody stands on furniture, fences, or on top of anyone else.
// Plain game code: no AI yet.

const TOWNSFOLK = [
  { key: 'clem',     name: 'Clem Pike',      area: 'Prospecting',              house: 'house1' },
  { key: 'augustus', name: 'Augustus Bell',  area: 'Sales',                    house: 'house2' },
  { key: 'jo',       name: 'Jo Wheeler',     area: 'Delivery',                 house: 'house3' },
  { key: 'ezra',     name: 'Ezra Tinsley',   area: 'Product',                  house: 'house4' },
  { key: 'hattie',   name: 'Hattie Bloom',   area: 'Client Success',           house: 'house5' },
  { key: 'rufus',    name: 'Rufus Quill',    area: 'Marketing & Content',      house: 'house6' },
  { key: 'winona',   name: 'Winona Hart',    area: 'Partnerships & Community', house: 'house7' },
  { key: 'mortimer', name: 'Mortimer Penny', area: 'Finance & Admin',          house: 'house8' },
  { key: 'beatrice', name: 'Beatrice Stone', area: 'Legal & Compliance',       house: 'house9' },
  { key: 'silas',    name: 'Silas Tally',    area: 'Operations & Analytics',   house: 'house10' },
];

// Workers: the townspeople's helpers (brown horses in beige saddles). Only ten
// townspeople spots exist; anyone added after that is a worker. Each townsperson
// starts with one. Workers have no tasks and no brain yet.
const WORKERS = [
  { key: 'biscuit',    name: 'Biscuit',    owner: 'clem' },
  { key: 'clover',     name: 'Clover',     owner: 'augustus' },
  { key: 'dusty',      name: 'Dusty',      owner: 'jo' },
  { key: 'hickory',    name: 'Hickory',    owner: 'ezra' },
  { key: 'maple',      name: 'Maple',      owner: 'hattie' },
  { key: 'pepper',     name: 'Pepper',     owner: 'rufus' },
  { key: 'juniper',    name: 'Juniper',    owner: 'winona' },
  { key: 'chestnut',   name: 'Chestnut',   owner: 'mortimer' },
  { key: 'ranger',     name: 'Ranger',     owner: 'beatrice' },
  { key: 'tumbleweed', name: 'Tumbleweed', owner: 'silas' },
];

// Making something real (a website, document, spreadsheet...) is done at a workbench in the General Store.
const MAKER = /\b(website|web ?page|landing page|site|pdf|document|report|one-pager|spreadsheet|csv|flyer|brochure|deck|slides|newsletter|menu|poster|files?)s?\b/i;

const STROLL_SPEED = 34;   // wandering, world pixels per second
const HURRY_SPEED = 52;    // going to work or to a meeting
const NOTICE_SHERIFF = 30; // stop and look when the Sheriff is this close
const RELEASE_SHERIFF = 44;
const CHAT_DISTANCE = 24;  // two wanderers this close can stop for a chat
const CHAT_SECONDS = 4;

const tileKey = (x, y) => x + ',' + y;
const tileOf = (a) => [Math.floor(a.x / T), Math.floor((a.y - 3) / T)];
const centre = ([x, y]) => ({ x: x * T + 8, y: y * T + 12 });

// Shortest walk over tiles (4 directions). `avoid` holds tiles to keep off
// (other people); the target itself is always allowed.
function findPath(passable, sx, sy, tx, ty, avoid) {
  const prev = new Map([[tileKey(sx, sy), null]]);
  const q = [[sx, sy]];
  for (let head = 0; head < q.length; head++) {
    const [x, y] = q[head];
    if (x === tx && y === ty) {
      const path = [];
      for (let k = tileKey(x, y); k; k = prev.get(k)) path.unshift(k.split(',').map(Number));
      return path;
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = tileKey(nx, ny);
      if (prev.has(k)) continue;
      const isTarget = nx === tx && ny === ty;
      if (!passable(nx, ny, isTarget)) continue;
      if (!isTarget && avoid && avoid.has(k)) continue;
      prev.set(k, tileKey(x, y));
      q.push([nx, ny]);
    }
  }
  return null;
}

// ---------- the map of where people may walk ----------
function createNav(town, getInterior) {
  const rooms = new Map(town.buildings.map(b => [b.id, getInterior(b)]));
  const doorAtTile = new Map(town.buildings.map(b => [tileKey(b.door.x, b.door.y), b]));
  const isWalkway = (x, y) => { const k = town.kindAt(x, y); return k === 'dirt' || k === 'path' || k === 'board'; };
  const inYard = (b, x, y) => b && b.kind === 'house' && x >= b.x + 1 && x <= b.x + 3 && y >= b.y + 4 && y <= b.y + 5;
  const roomDoor = (room) => [Math.floor(room.bounds.doorX0 / T), room.h - 1];

  // can `who` stand on this tile? (`isTarget`: the final tile, e.g. a desk chair to sit on)
  function passable(scene, who) {
    if (scene === town) {
      return (x, y) => {
        const b = doorAtTile.get(tileKey(x, y));
        if (b) return true;                                        // a front door: walk through it
        if (town.solidAt(x, y)) return false;                      // trees, fences, buildings, benches...
        return isWalkway(x, y) || inYard(who && who.building, x, y);  // paths, plus your own yard
      };
    }
    const doorCol = roomDoor(scene)[0];
    return (x, y, isTarget) => {
      if (x < 1 || x > scene.w - 2 || y < 1 || y > scene.h - 1) return false;
      if (y === scene.h - 1 && x !== doorCol) return false;          // the bottom wall: only the door is open
      if (scene.solidAt(x, y)) {
        const seat = (t) => t && t[0] === x && t[1] === y;
        return !!isTarget && !!who && (seat(who.sitTile) || seat(who.meetSeat) || seat(who.storeSeat));   // sitting at your desk or meeting seat
      }
      return true;
    };
  }

  // the next stretch of walking toward a goal {scene, tile}, within the current scene
  function legTarget(actor, goal) {
    if (actor.scene === goal.scene) return goal.tile;
    if (actor.scene !== town) return roomDoor(actor.scene);         // leave this room first
    return [goal.scene.building.door.x, goal.scene.building.door.y]; // walk to the right front door
  }

  // idle spots on the paths: not doors, not the lanes in front of doors
  const idleTown = [];
  for (let y = 0; y < town.h; y++) for (let x = 0; x < town.w; x++) {
    const k = town.kindAt(x, y);
    if ((k === 'dirt' || k === 'board') && !town.solidAt(x, y) && !doorAtTile.has(tileKey(x, y))) {
      const hallFront = town.buildings.some(b => b.kind === 'hall' && x === b.door.x && y > b.door.y && y <= b.door.y + 3);
      if (!hallFront) idleTown.push([x, y]);
    }
  }
  const isDoorway = (scene, x, y) => scene === town ? doorAtTile.has(tileKey(x, y)) : (y >= scene.h - 1);
  // the squares right in front of a door (nobody hangs around there)
  const inFrontOfDoor = (scene, x, y) => {
    if (scene !== town) { const d = roomDoor(scene); return x === d[0] && y >= scene.h - 3; }
    return town.buildings.some(b => x === b.door.x && y > b.door.y && y <= b.door.y + (b.kind === 'hall' ? 3 : 1));
  };
  // where visitors come into town: the walkway on the bottom row nearest the middle
  let entry = [Math.floor(town.w / 2), town.h - 1];
  for (let y = town.h - 1; y > town.h - 6; y--) {
    const row = [];
    for (let x = 0; x < town.w; x++) if (isWalkway(x, y) && !town.solidAt(x, y)) row.push(x);
    if (row.length) { entry = [row.sort((a, b) => Math.abs(a - town.w / 2) - Math.abs(b - town.w / 2))[0], y]; break; }
  }
  return { town, rooms, doorAtTile, passable, legTarget, roomDoor, idleTown, inYard, isDoorway, inFrontOfDoor, entry };
}

// Who is where. Everyone holds exactly one square, plus the square they're
// stepping into, so nobody can ever stand on top of anyone else. The Sheriff
// and a following Marshall move freely, so they hold every square under their feet.
function occupancy(actors) {
  const occ = new Map();
  for (const a of actors) {
    if (!a.scene) continue;
    let m = occ.get(a.scene);
    if (!m) occ.set(a.scene, (m = new Map()));
    const put = (x, y) => { const k = tileKey(x, y); if (!m.has(k)) m.set(k, a); };
    if (a.isBody) {
      for (const [px, py] of [[a.x - 5, a.y - 5], [a.x + 4, a.y - 5], [a.x - 5, a.y - 1], [a.x + 4, a.y - 1]]) put(Math.floor(px / T), Math.floor(py / T));
    } else {
      put(...tileOf(a));
      if (a.stepTo) put(...a.stepTo);
    }
  }
  return occ;
}
const isFree = (occ, a, scene, x, y) => { const m = occ.get(scene); const w = m && m.get(tileKey(x, y)); return !w || w === a; };
const claim = (occ, a, scene, x, y) => { let m = occ.get(scene); if (!m) occ.set(scene, (m = new Map())); m.set(tileKey(x, y), a); };

function waitHere(a, dt, why) {
  a.moving = false; a.why = why; a.stuck = (a.stuck || 0) + dt;
  return 'waiting';
}

// Move toward the square being stepped into; returns 'walking'.
function stepMove(a, dt, speed) {
  const g = centre(a.stepTo);
  const dx = g.x - a.x, dy = g.y - a.y, dist = Math.hypot(dx, dy), step = speed * dt;
  if (dist <= step) {
    a.x = g.x; a.y = g.y;
    if (a.path.length && a.path[0][0] === a.stepTo[0] && a.path[0][1] === a.stepTo[1]) a.path.shift();
    a.stepTo = null;
  } else { a.x += dx / dist * step; a.y += dy / dist * step; }
  if (dist > 0.01) a.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
  a.moving = true; a.t += dt; a.stuck = 0; a.why = '';
  return 'walking';
}

// Step aside onto a free neighboring square (never a doorway), away from `from` if given.
function sidestep(a, nav, occ, from) {
  const [cx, cy] = tileOf(a);
  const pass = nav.passable(a.scene, a);
  let best = null, bestD = -1;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = cx + dx, ny = cy + dy;
    if (!pass(nx, ny) || !isFree(occ, a, a.scene, nx, ny) || nav.isDoorway(a.scene, nx, ny)) continue;
    const d = from ? Math.hypot(nx * T + 8 - from.x, ny * T + 12 - from.y) : Math.random();
    if (d > bestD) { bestD = d; best = [nx, ny]; }
  }
  if (!best) return false;
  a.path = [best]; a.stepTo = best; claim(occ, a, a.scene, ...best);
  return true;
}

// ---------- walking (townspeople, and Marshall when walking somewhere on their own) ----------
// One square at a time toward a.goal = {scene, tile}, door by door.
// Returns 'arrived', 'walking', or 'waiting'.
function walk(a, dt, nav, occ, speed) {
  if (a.stepTo) return stepMove(a, dt, speed);              // finish the step already started
  if (!a.goal) { a.moving = false; return 'arrived'; }
  const [cx, cy] = tileOf(a);
  const c = centre([cx, cy]);
  if (Math.hypot(c.x - a.x, c.y - a.y) > 0.5) {             // stopped mid-way: back to the middle of my square
    a.stepTo = [cx, cy]; claim(occ, a, a.scene, cx, cy);
    return stepMove(a, dt, speed);
  }
  const [tx, ty] = nav.legTarget(a, a.goal);

  // at the end of this stretch: arrived, or walk through the door
  if (cx === tx && cy === ty) {
    if (a.scene === a.goal.scene) { a.moving = false; a.path = []; a.stuck = 0; return 'arrived'; }
    let toScene, toTile;
    if (a.scene === nav.town) { const room = nav.rooms.get(nav.doorAtTile.get(tileKey(cx, cy)).id); toScene = room; toTile = nav.roomDoor(room); }
    else { const b = a.scene.building; toScene = nav.town; toTile = [b.door.x, b.door.y]; }
    if (!isFree(occ, a, toScene, ...toTile)) {
      // someone is in the doorway on the other side. If they're coming through toward us,
      // whoever is coming IN steps back and lets the one going OUT through first.
      const other = occ.get(toScene).get(tileKey(...toTile));
      const comingThrough = other && other.goal && other.goal.scene !== toScene;
      if (comingThrough && a.scene === nav.town && (a.blockedFor = (a.blockedFor || 0) + dt) > 0.3) { a.blockedFor = 0; sidestep(a, nav, occ, centre([tx, ty])); }
      return waitHere(a, dt, 'doorway busy');
    }
    a.blockedFor = 0;
    Object.assign(a, centre(toTile), { scene: toScene, path: [] });
    claim(occ, a, toScene, ...toTile);
    a.moving = true;
    return 'walking';
  }

  // plan (or re-plan around people) when needed
  const last = a.path[a.path.length - 1];
  if (!a.path.length || !last || last[0] !== tx || last[1] !== ty || a.repath) {
    let avoid = null;
    if (a.repath) {
      avoid = new Set();
      for (const [k, who] of occ.get(a.scene) || []) if (who !== a) avoid.add(k);
    }
    a.repath = false;
    const path = findPath(nav.passable(a.scene, a), cx, cy, tx, ty, avoid);
    if (!path) return waitHere(a, dt, 'no way through');
    a.path = path.slice(1);
    if (!a.path.length) return waitHere(a, dt, 'no way through');
  }

  // step into the next square only if nobody holds it
  const next = a.path[0];
  // (someone leaving town slips past whoever is in the way after a moment: they never get stuck in town)
  if (!isFree(occ, a, a.scene, ...next) && !(a.leaving && (a.blockedFor || 0) > 1.2)) {
    a.blockedFor = (a.blockedFor || 0) + dt;
    if (a.blockedFor > 0.5) a.repath = true;                 // look for a way around
    if (a.blockedFor > 2.5) { a.blockedFor = 0; sidestep(a, nav, occ, null); }   // still stuck: step aside
    return waitHere(a, dt, 'someone in the way');
  }
  a.blockedFor = 0;
  a.stepTo = next; claim(occ, a, a.scene, ...next);
  return stepMove(a, dt, speed);
}

function faceToward(a, b) {
  const fx = b.x - a.x, fy = b.y - a.y;
  if (Math.hypot(fx, fy) > 1) a.dir = Math.abs(fx) > Math.abs(fy) ? (fx > 0 ? 'right' : 'left') : (fy > 0 ? 'down' : 'up');
}

// ---------- the townspeople ----------
function createTownsfolk(town, nav) {
  return TOWNSFOLK.map((info, i) => {
    const b = town.buildings.find(bb => bb.id === info.house);
    const room = nav.rooms.get(b.id);
    const r = rng(9000 + i * 31);
    const lane = nav.roomDoor(room)[0];
    const yardSpots = [];
    for (let y = b.y + 4; y <= b.y + 5; y++) for (let x = b.x + 1; x <= b.x + 3; x++) if (x !== b.door.x && !town.solidAt(x, y)) yardSpots.push([x, y]);
    const roomSpots = [];
    const roomPass = nav.passable(room, null);
    for (let y = 2; y <= room.h - 3; y++) for (let x = 2; x <= room.w - 3; x++) {
      if (!roomPass(x, y) || (x === lane && y >= 4) || nav.inFrontOfDoor(room, x, y)) continue;
      if (findPath(roomPass, lane, room.h - 1, x, y)) roomSpots.push([x, y]);
    }
    const startInside = r() < 0.4;
    const spots = startInside ? roomSpots : yardSpots;
    const spot = spots[Math.floor(r() * spots.length)];
    return {
      ...info, building: b, room, rng: r, yardSpots, roomSpots,
      sitTile: [room.deskChair.x, room.deskChair.y],
      scene: startInside ? room : town, ...centre(spot),
      dir: 'down', moving: false, t: 0, path: [], goal: null,
      mode: 'free', wait: 1 + r() * 3, seated: false, attending: false, chat: null,
      tasks: [],                  // real tasks arrive once townspeople have brains
    };
  });
}

// One step of a townsperson's day.
// ctx: { nav, occ, sheriff, meeting: {seat(i)} | null, workTime, talkedToday(a,b), recordChat(a,b) }
function updateTownsperson(p, i, dt, ctx, everyone) {
  const { nav, occ, sheriff } = ctx;
  if (p.vacant) return;                       // an empty seat: nobody there until the Sheriff hires a replacement

  // Let go by the Sheriff: walk out of town on the south road (no stopping to chat)
  if (p.leaving && !p.isCandidate) {
    p.seated = false; p.chat = null; p.attending = false;
    if (walk(p, dt, nav, occ, STROLL_SPEED) === 'arrived') { p.moving = false; p.gone = true; }
    return;
  }

  // 0. The Sheriff walked into them: step aside to a free neighboring tile.
  if (p.yieldTo) {
    const keep = p.goal;
    p.goal = { scene: p.scene, tile: p.yieldTo };
    const res = walk(p, dt, nav, occ, STROLL_SPEED);
    p.goal = keep;
    if (res === 'arrived' || (p.stuck || 0) > 1.5) { p.yieldTo = null; p.path = []; p.stuck = 0; }
    else return;
  }

  // 1. The Sheriff is close by: stop and look at the Sheriff, in case they want to talk.
  // (not on the way to a meeting: they're already walking there with the Sheriff;
  //  and never while standing in a doorway: step through first)
  const [px, py] = tileOf(p);
  const inDoorway = nav.isDoorway(p.scene, px, py) || nav.inFrontOfDoor(p.scene, px, py);
  // ("when I walk near someone": it starts when the Sheriff is walking, and lasts while they stay close)
  // (and while the Sheriff's chat box is open with them, they stay and face the Sheriff)
  const nearSheriff = !ctx.meeting && !inDoorway && (!p.isCandidate || (p.waiting && !p.leaving)) && !p.justHired && p.scene === sheriff.scene && (p.attending || ctx.sheriffWalking || ctx.chattingWith === p) && Math.hypot(p.x - sheriff.x, p.y - sheriff.y);
  const range = ctx.chattingWith === p ? RELEASE_SHERIFF * 2 : (p.attending ? RELEASE_SHERIFF : NOTICE_SHERIFF);
  if (nearSheriff !== false && nearSheriff < range) {
    p.attending = true;
    if (p.stepTo) stepMove(p, dt, STROLL_SPEED);                        // finish the current step, then stop
    else { p.moving = false; faceToward(p, sheriff); }
    return;
  }
  p.attending = false;

  // 2. In the middle of a chat with a neighbor.
  if (p.chat) {
    p.chat.left -= dt;
    if (p.stepTo) { stepMove(p, dt, STROLL_SPEED); return; }          // finish the step, then talk
    p.moving = false;
    faceToward(p, p.chat.with);
    if (p.chat.left <= 0) { p.chat = null; p.wait = 0.5 + p.rng() * 1.5; }
    return;
  }

  // 2b. A candidate: walk to the town hall and wait for the interview (or walk out of town)
  if (p.isCandidate) {
    if (walk(p, dt, nav, occ, STROLL_SPEED) === 'arrived') {
      p.moving = false;
      if (p.leaving) p.gone = true; else { p.dir = 'down'; p.waiting = true; }   // waiting at the town hall
    }
    return;
  }

  // 3. What should they be doing?
  const mode = p.isWorker ? ((ctx.meeting || ctx.workTime || p.tasks.length || p.justHired) ? 'home' : 'free')   // a worker with a task works in the yard; a new hire walks there first
    : ctx.meeting ? 'meeting' : (ctx.workTime || p.tasks.length) ? 'working' : 'free';
  if (mode !== p.mode) {
    if (p.mode === 'meeting') { p.leaveDelay = 2.5 + i * 0.7; p.leftSeat = p.meetSeat; p.meetSeat = null; }   // after a meeting: file out one by one
    p.mode = mode; p.path = []; p.wait = 0;
    p.goal = null;
    if (p.seated) { p.seated = false; }
  }
  if (p.leaveDelay > 0) { p.leaveDelay -= dt; p.moving = false; return; }

  // Making something? Work at a General Store workbench (if one is free), not at home.
  const wantsStore = !!ctx.store && mode !== 'meeting' && p.tasks.length > 0 && p.tasks.some(t => MAKER.test(t));
  if (p.storeSeat && !wantsStore) {                          // done (or called to a meeting): free the workbench and go
    ctx.store.release(p); p.leftStoreSeat = p.storeSeat; p.storeSeat = null;
    p.seated = false; p.goal = null; p.path = [];
  }
  if (wantsStore && !p.storeSeat) {
    const seat = ctx.store.claim(p);
    if (seat) { p.storeSeat = seat; p.seated = false; p.goal = null; p.path = []; }
  }
  if (p.storeSeat) {
    p.goal = { scene: ctx.store.room, tile: p.storeSeat };
    if (p.seated) { p.moving = false; p.dir = 'up'; return; }
    if (walk(p, dt, nav, occ, HURRY_SPEED) === 'arrived') { p.seated = true; p.dir = 'up'; p.moving = false; }
    return;
  }
  if (mode === 'meeting') {
    if (!p.meetSeat && p.scene === ctx.meeting.room) p.meetSeat = ctx.meeting.claim(p);   // pick a seat on arrival
    p.goal = { scene: ctx.meeting.room, tile: p.meetSeat || ctx.meeting.anySeat };
    if (p.seated) { p.moving = false; p.dir = 'up'; return; }
    if (p.meetSeat && walk(p, dt, nav, occ, HURRY_SPEED) === 'arrived') { p.seated = true; p.dir = 'up'; p.moving = false; }
    else if (!p.meetSeat) walk(p, dt, nav, occ, HURRY_SPEED);
    return;
  }
  if (mode === 'home') {                     // a worker waiting in their townsperson's yard
    if (!p.goal || p.goal.scene !== nav.town || !p.yardSpots.some(t => t[0] === p.goal.tile[0] && t[1] === p.goal.tile[1])) {
      const here = occ.get(nav.town) || new Map();
      const open = p.yardSpots.filter(t => !here.has(tileKey(...t)) || here.get(tileKey(...t)) === p);
      p.goal = { scene: nav.town, tile: (open.length ? open : p.yardSpots)[Math.floor(p.rng() * (open.length || p.yardSpots.length))] };
      p.path = [];
    }
    if (walk(p, dt, nav, occ, p.justHired ? STROLL_SPEED : HURRY_SPEED) === 'arrived') { p.moving = false; p.dir = 'down'; p.justHired = false; }
    else if ((p.stuck || 0) > 3) { p.goal = null; p.stuck = 0; }   // that spot is taken: pick another
    return;
  }
  if (mode === 'working') {
    p.goal = { scene: p.room, tile: p.sitTile };
    if (p.seated) { p.moving = false; return; }
    if (walk(p, dt, nav, occ, HURRY_SPEED) === 'arrived') { p.seated = true; p.dir = 'up'; p.moving = false; }
    return;
  }

  // 4. Free time: wander the town along the paths, sometimes home.
  if (!p.goal) {
    p.wait -= dt;
    p.moving = false;
    if (p.wait > 0) return;
    p.goal = pickWanderGoal(p, nav, occ);
    p.path = [];
    if (!p.goal) { p.wait = 1; return; }
  }
  const res = walk(p, dt, nav, occ, STROLL_SPEED);
  if (res === 'arrived' || (p.stuck || 0) > 3) {
    p.goal = null; p.stuck = 0; p.moving = false;
    const [hx, hy] = tileOf(p);
    // never hang around in a doorway or right in front of one: move on straight away
    p.wait = (nav.isDoorway(p.scene, hx, hy) || nav.inFrontOfDoor(p.scene, hx, hy)) ? 0 : 2 + p.rng() * 5;
    p.dir = ['down', 'left', 'right', 'down', 'up'][Math.floor(p.rng() * 5)];
  }

  // 5. Bumped into someone? If you haven't talked today, stop and ask what they're working on.
  if (p.scene === nav.town) {
    for (const q of everyone) {
      if (q === p || q.scene !== p.scene || q.mode !== 'free' || q.chat || q.attending || p.chat) continue;
      if (Math.hypot(q.x - p.x, q.y - p.y) > CHAT_DISTANCE) continue;
      if (ctx.talkedToday(p, q)) continue;                // already talked today: walk on by
      for (const [a, b] of [[p, q], [q, p]]) {
        a.chat = { with: b, left: CHAT_SECONDS };
      }
      ctx.recordChat(p, q);
      break;
    }
  }
}

// ---------- the workers ----------
// Each lives in their townsperson's yard (never in front of the door) and roams the whole town.
function createWorkers(town, nav, townsfolk) {
  return WORKERS.map((info, i) => makeWorker(info, i, town, townsfolk, null));
}
// one worker; `at` = {scene, x, y} to start somewhere else (a new hire leaving the town hall)
function makeWorker(info, i, town, townsfolk, at, everyone) {
  const boss = townsfolk.find(t => t.key === info.owner);
  const r = rng(7100 + i * 37);
  const yardSpots = boss.yardSpots.slice();
  const taken = new Set((everyone || [boss]).filter(q => q.scene === town).map(q => tileKey(...tileOf(q))));
  const open = yardSpots.filter(t => !taken.has(tileKey(...t)));
  const spot = (open.length ? open : yardSpots)[Math.floor(r() * (open.length || yardSpots.length))];
  return {
    ...info, isWorker: true, boss, area: `Worker for ${boss.name.split(' ')[0]} (${boss.area})`,
    house: boss.house, building: boss.building, room: null, rng: r, yardSpots, roomSpots: [],
    ...(at || { scene: town, ...centre(spot) }),
    dir: 'down', moving: false, t: 0, path: [], goal: null,
    mode: 'free', wait: 2 + r() * 4, seated: false, attending: false, chat: null,
    tasks: [],                  // tasks come only from their townsperson
  };
}

// A candidate Marshall found: walks in on the south road to the town hall and waits there
// for the Sheriff's interview. Not hired: walks back out of town.
function makeCandidate(c, town, nav, hall, waitTile, townsfolk) {
  const boss = c.replaces ? null : townsfolk.find(t => t.key === c.owner);
  const entry = nav.entry;
  return {
    key: c.key, name: c.name, owner: c.owner, isCandidate: true, boss, replaces: c.replaces || null, seatArea: c.area,
    area: c.replaces ? `Candidate to take over ${c.area}` : `Candidate to work for ${boss ? boss.name.split(' ')[0] : 'a townsperson'} (${boss ? boss.area : ''})`,
    building: null, room: null, rng: rng(5100 + c.key.length * 13), yardSpots: [], roomSpots: [],
    scene: town, ...centre(entry), dir: 'up', moving: false, t: 0, path: [],
    goal: { scene: hall, tile: waitTile }, mode: 'candidate', seated: false, attending: false, chat: null, tasks: [],
  };
}

function pickWanderGoal(p, nav, occ) {
  const r = p.rng();
  const free = (scene, spots) => {
    const here = occ.get(scene) || new Map();
    const open = spots.filter(s => !here.has(tileKey(...s)));
    return open.length ? open[Math.floor(p.rng() * open.length)] : null;
  };
  let tile;
  if (r < 0.6 && (tile = free(nav.town, nav.idleTown))) return { scene: nav.town, tile };
  if (r < 0.82 && (tile = free(nav.town, p.yardSpots))) return { scene: nav.town, tile };
  if (p.room && (tile = free(p.room, p.roomSpots))) return { scene: p.room, tile };
  if ((tile = free(nav.town, p.yardSpots))) return { scene: nav.town, tile };   // workers stay outdoors
  return null;
}
