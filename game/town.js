'use strict';
// town.js: the layout of the Frontier town (70 x 44 tiles).
// Exactly 10 houses plus a town hall around a dirt town square with a fountain.
// In this three-quarter view only the front (south) wall of a building shows,
// so every door is on that wall. Houses on the north row open straight onto
// the main street and square; houses on the west and east sides have a path
// from their yard into the square.

const TOWN_W = 70, TOWN_H = 44;

// The 10 houses, in order. Each gets its own look so they are easy to tell apart.
const HOUSE_SPOTS = [
  { x: 4, y: 6 }, { x: 11, y: 6 }, { x: 18, y: 6 },      // north row, west of the hall
  { x: 36, y: 6 }, { x: 43, y: 6 }, { x: 50, y: 6 },     // north row, east of the hall
  { x: 2, y: 17 }, { x: 2, y: 26 },                      // west side
  { x: 53, y: 17 }, { x: 53, y: 26 },                    // east side
];
const HOUSE_LOOKS = [
  { roof: 0, wall: 0, chimney: true, flowers: true, awning: false },
  { roof: 2, wall: 2, chimney: false, flowers: false, awning: true },
  { roof: 3, wall: 1, chimney: true, flowers: false, awning: false },
  { roof: 4, wall: 0, chimney: false, flowers: true, awning: true },
  { roof: 1, wall: 2, chimney: true, flowers: true, awning: false },
  { roof: 0, wall: 1, chimney: false, flowers: false, awning: true },
  { roof: 2, wall: 3, chimney: true, flowers: true, awning: false },
  { roof: 3, wall: 0, chimney: false, flowers: true, awning: true },
  { roof: 4, wall: 2, chimney: true, flowers: false, awning: false },
  { roof: 1, wall: 3, chimney: false, flowers: true, awning: true },
];

function grid(w, h, v) { return Array.from({ length: h }, () => Array(w).fill(v)); }

function addObj(list, img, tx, ty, wT, hT) {
  list.push({
    img,
    x: tx * T + Math.floor((wT * T - img.width) / 2),
    y: (ty + hT) * T - img.height,
    base: (ty + hT) * T,
  });
}

function buildTown() {
  const W = TOWN_W, H = TOWN_H;
  const kind = grid(W, H, 'grass');
  const solid = grid(W, H, false);
  const doors = grid(W, H, null);
  const reserved = grid(W, H, false); // where no trees may grow
  const objects = [];
  const buildings = [];

  const setKind = (x, y, w, h, k) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (i >= 0 && j >= 0 && i < W && j < H) kind[j][i] = k;
  };
  const reserve = (x, y, w, h) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (i >= 0 && j >= 0 && i < W && j < H) reserved[j][i] = true;
  };
  const block = (x, y, w, h) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) solid[j][i] = true;
  };

  // dirt: main street (running east past the General Store and out of town), town square, road out of town to the south
  setKind(2, 13, W - 2, 2, 'dirt');
  setKind(12, 13, 36, 22, 'dirt');
  setKind(28, 35, 4, 9, 'dirt');

  // houses, yards, fences and paths
  const fenceImgs = { h: paintFence('h'), v: paintFence('v'), c: paintFence('c') };
  const fence = (x, y, k) => { addObj(objects, fenceImgs[k], x, y, 1, 1); solid[y][x] = true; };

  HOUSE_SPOTS.forEach((p, i) => {
    const b = {
      id: 'house' + (i + 1), label: 'House ' + (i + 1), kind: 'house', index: i,
      x: p.x, y: p.y, w: 5, h: 4, door: { x: p.x + 2, y: p.y + 3 },
    };
    buildings.push(b);
    addObj(objects, paintHouse(HOUSE_LOOKS[i]), b.x, b.y, b.w, b.h);
    block(b.x, b.y, b.w, b.h);
    solid[b.door.y][b.door.x] = false;
    doors[b.door.y][b.door.x] = b.id;
    reserve(b.x - 1, b.y - 2, b.w + 2, b.h + 2);

    // fenced yard in front, with a gate on the path
    setKind(b.x, b.y + 4, 5, 3, 'yard');
    setKind(b.x + 2, b.y + 4, 1, 3, 'path');
    reserve(b.x - 1, b.y + 4, 7, 4);
    fence(b.x, b.y + 4, 'v'); fence(b.x, b.y + 5, 'v'); fence(b.x, b.y + 6, 'c');
    fence(b.x + 4, b.y + 4, 'v'); fence(b.x + 4, b.y + 5, 'v'); fence(b.x + 4, b.y + 6, 'c');
    fence(b.x + 1, b.y + 6, 'h'); fence(b.x + 3, b.y + 6, 'h');
  });

  // side houses: path from the yard gate into the square
  setKind(4, 24, 8, 1, 'path'); setKind(4, 33, 8, 1, 'path');
  setKind(48, 24, 8, 1, 'path'); setKind(48, 33, 8, 1, 'path');

  // town hall with a boardwalk out front
  const hall = { id: 'hall', label: 'Town Hall', kind: 'hall', index: 10, x: 25, y: 3, w: 9, h: 7, door: { x: 29, y: 9 } };
  buildings.push(hall);
  addObj(objects, paintHall(), hall.x, hall.y, hall.w, hall.h);
  block(hall.x, hall.y, hall.w, hall.h);
  solid[hall.door.y][hall.door.x] = false;
  doors[hall.door.y][hall.door.x] = hall.id;
  reserve(hall.x - 1, hall.y - 2, hall.w + 2, hall.h + 3);
  setKind(27, 10, 5, 3, 'board');

  // the General Store (the Workshop), east of House 6 on the road out of town, with a boardwalk porch
  const store = { id: 'store', label: 'General Store', kind: 'store', index: 11, x: 57, y: 6, w: 7, h: 4, door: { x: 60, y: 9 } };
  buildings.push(store);
  addObj(objects, paintStore(), store.x, store.y, store.w, store.h);
  block(store.x, store.y, store.w, store.h);
  solid[store.door.y][store.door.x] = false;
  doors[store.door.y][store.door.x] = store.id;
  reserve(store.x - 1, store.y - 2, store.w + 2, store.h + 6);
  setKind(store.x, 10, store.w, 1, 'board');
  setKind(store.door.x, 11, 1, 2, 'path');

  // fountain and water trough in the middle of the square
  addObj(objects, paintFountain(), 28, 22, 4, 3);
  block(28, 22, 4, 3);
  addObj(objects, paintTrough(), 33, 24, 2, 1);
  block(33, 24, 2, 1);

  // benches around the square, barrels by the town hall
  const bench = paintBenchOutdoor();
  for (const [x, y] of [[19, 19], [39, 19], [19, 28], [39, 28]]) { addObj(objects, bench, x, y, 2, 1); block(x, y, 2, 1); }
  const barrel = paintBarrel();
  for (const [x, y] of [[25, 11], [33, 11], [24, 11]]) { addObj(objects, barrel, x, y, 1, 1); solid[y][x] = true; }
  reserve(23, 10, 12, 3);

  // keep trees off dirt, paths and their edges
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (kind[y][x] !== 'grass') reserve(x - 1, y - 1, 3, 3);

  // trees: thick at the edges, scattered in between
  const trees = [];
  const treeImgs = [1, 2, 3, 4, 5, 6].map(s => paintTree(s * 17));
  const bushImgs = [1, 2, 3].map(s => paintBush(s * 3));
  const hasTreeNear = (x, y) => trees.some(t => Math.abs(t.x - x) <= 1 && Math.abs(t.y - y) <= 1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (kind[y][x] !== 'grass' || reserved[y][x] || solid[y][x]) continue;
    const edge = Math.min(x, y, W - 1 - x, H - 1 - y);
    const chance = edge < 2 ? 0.7 : edge < 4 ? 0.22 : 0.05;
    const r = hash(x, y, 7);
    if (r < chance && (edge < 2 || !hasTreeNear(x, y))) {
      trees.push({ x, y });
      addObj(objects, treeImgs[Math.floor(hash(x, y, 8) * treeImgs.length)], x, y, 1, 1);
      solid[y][x] = true;
    } else if (edge >= 2 && r > 0.975) {
      addObj(objects, bushImgs[Math.floor(hash(x, y, 9) * bushImgs.length)], x, y, 1, 1);
      solid[y][x] = true;
    }
  }

  // ---- rule: nothing may sit in front of a door ----
  // Each door's lane runs from the door down its path to the street or square.
  // Any tree, bush, bench or other object on a lane (fences excluded, since the
  // gate gap is the lane) is removed and its tile made walkable again.
  const lanes = new Set();
  for (const b of buildings) {
    const q = [[b.door.x, b.door.y + 1]];
    const seen = new Set();
    while (q.length) {
      const [x, y] = q.shift(), k = x + ',' + y;
      if (seen.has(k) || x < 0 || y < 0 || x >= W || y >= H) continue;
      seen.add(k);
      lanes.add(k);
      if (kind[y][x] === 'dirt') continue; // reached the street or square
      for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0]]) {
        const nk = kind[y + dy] && kind[y + dy][x + dx];
        if (nk === 'path' || nk === 'board' || nk === 'dirt') q.push([x + dx, y + dy]);
      }
    }
  }
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (o.img === fenceImgs.h || o.img === fenceImgs.v || o.img === fenceImgs.c) continue;
    if (buildings.some(b => o.base === (b.y + b.h) * T && o.x <= b.x * T + 8 && o.img.width >= 80)) continue;
    const tx0 = Math.floor((o.x + 2) / T), tx1 = Math.floor((o.x + o.img.width - 3) / T), ty = o.base / T - 1;
    let onLane = false;
    for (let x = tx0; x <= tx1; x++) if (lanes.has(x + ',' + ty)) onLane = true;
    if (onLane) {
      objects.splice(i, 1);
      for (let x = tx0; x <= tx1; x++) if (x >= 0 && x < W) solid[ty][x] = false;
      console.warn('Removed an object that was blocking a doorway at', tx0, ty);
    }
  }
  // Double-check: every door must be reachable from the road into town.
  {
    const start = [30, 40], seen = new Set([start.join(',')]), q = [start];
    while (q.length) {
      const [x, y] = q.shift();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, k = nx + ',' + ny;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen.has(k) || solid[ny][nx]) continue;
        seen.add(k); q.push([nx, ny]);
      }
    }
    for (const b of buildings) if (!seen.has(b.door.x + ',' + b.door.y)) console.error(b.label + ': front door cannot be reached!');
  }

  // ---- paint the ground once ----
  const { c: ground, g } = makeCanvas(W * T, H * T);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = kind[y][x];
    if (k === 'grass' || k === 'yard') paintGrassTile(g, x * T, y * T, x, y, k === 'yard');
    else if (k === 'board') paintBoardTile(g, x * T, y * T, x, y);
    else paintDirtTile(g, x * T, y * T, x, y);
  }
  const isGrass = (x, y) => x >= 0 && y >= 0 && x < W && y < H && (kind[y][x] === 'grass' || kind[y][x] === 'yard');
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (kind[y][x] !== 'dirt' && kind[y][x] !== 'path') continue;
    if (isGrass(x, y - 1)) paintDirtEdge(g, x * T, y * T, x, y, 'top');
    if (isGrass(x, y + 1)) paintDirtEdge(g, x * T, y * T, x, y, 'bottom');
    if (isGrass(x - 1, y)) paintDirtEdge(g, x * T, y * T, x, y, 'left');
    if (isGrass(x + 1, y)) paintDirtEdge(g, x * T, y * T, x, y, 'right');
  }
  // shadows fall to the lower right (light from the upper left)
  g.fillStyle = PAL.shadow;
  for (const b of buildings) {
    g.fillRect((b.x + b.w) * T, b.y * T + 2, 6, b.h * T);
    g.fillRect(b.x * T + 6, (b.y + b.h) * T, b.w * T, 3);
  }
  for (const t of trees) paintShadowEllipse(g, t.x * T + 11, t.y * T + 14, 10, 3);
  paintShadowEllipse(g, 30 * T + 4, 25 * T - 2, 30, 5);
  // stone step in front of each house door
  for (const b of buildings) {
    if (b.kind !== 'house') continue;
    box(g, b.door.x * T + 2, (b.door.y + 1) * T, 12, 4, PAL.stone[2]);
    rect(g, b.door.x * T + 3, (b.door.y + 1) * T + 1, 10, 1, PAL.stone[3]);
  }

  objects.sort((a, b) => a.base - b.base);
  toHiRes(objects);
  const groundHi = fineDetail(scale2x(ground), 77);
  return {
    name: 'town', label: 'Town', w: W, h: H, ground: groundHi, objects, buildings,
    solidAt: (x, y) => x < 0 || y < 0 || x >= W || y >= H || solid[y][x],
    // what the ground is: 'grass', 'yard', 'dirt' (street and square), 'path' or 'board' (boardwalk)
    kindAt: (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? null : kind[y][x],
    doorAt: (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? null : doors[y][x],
    exitAt: () => false,
    spawn: { x: 30 * T, y: 40 * T + 8, dir: 'up' },
  };
}
