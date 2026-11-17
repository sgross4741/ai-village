'use strict';
// art.js: every picture in the village is drawn here, pixel by pixel, in code.
// No image files and no network: this runs fully offline in the browser.
// Style rules (see STYLE_GUIDE.md): 16x16 tiles, warm palette, light from the
// upper left (highlights on top-left edges, shade on bottom-right), dark outlines.

const T = 16; // tile size in pixels

const PAL = {
  out: '#2e1d14',
  grass: ['#5f8a34', '#79a33f', '#8db84a', '#a9cd62'],
  dirt: ['#a8733a', '#c48f4c', '#d9a862', '#ebc47e'],
  stone: ['#5f5a52', '#8a847a', '#b4ae9f', '#dcd5c3'],
  water: ['#2f5f8f', '#3f86c0', '#73b6e0', '#c4e6f5'],
  wood: ['#5a3620', '#7e4f2c', '#a8703f', '#c99560', '#e0b47a'],
  leaf: ['#2f5424', '#41702e', '#5a8f3a', '#7bb04c'],
  iron: ['#2e2622', '#4a403a', '#6a5a50'],
  cream: '#f1e6c8',
  gold: '#e8b84a',
  red: '#d8574a',
  shadow: 'rgba(46,29,20,0.30)',
};

const ROOFS = [
  ['#7a2e18', '#a3401f', '#c4572c', '#de7a45'], // terracotta
  ['#4e3020', '#6e4630', '#8e5e3e', '#ae7a52'], // brown shingle
  ['#3d4a2c', '#56663a', '#71834a', '#90a35e'], // moss
  ['#7a5418', '#a3721f', '#c7922e', '#e0b452'], // ochre
  ['#4a2630', '#6a3644', '#8a4a5a', '#a8687a'], // plum
];

const WALLS = [
  ['#5a3620', '#7e4f2c', '#a8703f', '#c99560', '#e0b47a'], // honey plank
  ['#4a3a2c', '#6a5644', '#8c765e', '#ad967a', '#c9b496'], // weathered
  ['#6e604e', '#94846c', '#b9a98c', '#d8cbb0', '#efe4cc'], // whitewash
  ['#5e2418', '#7e3020', '#a3442c', '#c0603e', '#d8845e'], // barn red
];

// ---------- basic helpers ----------

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  return { c, g };
}
function rect(g, x, y, w, h, col) { g.fillStyle = col; g.fillRect(x, y, w, h); }
function px(g, x, y, col) { g.fillStyle = col; g.fillRect(x, y, 1, 1); }
function box(g, x, y, w, h, fill, outline) {
  rect(g, x, y, w, h, outline || PAL.out);
  rect(g, x + 1, y + 1, w - 2, h - 2, fill);
}

// Deterministic noise, so the town looks the same every time it loads.
function hash(a, b, s) {
  let h = Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(s | 0, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function rng(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function inEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx, dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

// Paint any blob shape with a dark outline, a lit upper-left edge and a shaded
// lower-right edge. cols = [dark, base, light, speck]
function paintShape(g, w, h, inside, cols, seed, speck) {
  const r = rng(seed || 1);
  const ins = (x, y) => x >= 0 && y >= 0 && x < w && y < h && inside(x, y);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (ins(x, y)) {
        let c = cols[1];
        if (!ins(x - 2, y - 2)) c = cols[2];
        else if (!ins(x + 2, y + 2)) c = cols[0];
        else if (speck && r() < speck) c = r() < 0.5 ? cols[0] : (cols[3] || cols[2]);
        px(g, x, y, c);
      } else if (ins(x - 1, y) || ins(x + 1, y) || ins(x, y - 1) || ins(x, y + 1)) {
        px(g, x, y, PAL.out);
      }
    }
  }
}

// ---------- ground tiles ----------

function paintGrassTile(g, x0, y0, tx, ty, yard) {
  rect(g, x0, y0, T, T, PAL.grass[2]);
  for (let i = 0; i < 10; i++) {
    const x = x0 + Math.floor(hash(tx, ty, i + 1) * T);
    const y = y0 + Math.floor(hash(tx, ty, i + 50) * T);
    px(g, x, y, i < 6 ? PAL.grass[1] : PAL.grass[3]);
  }
  if (hash(tx, ty, 99) < 0.35) { // small tuft
    const x = x0 + 3 + Math.floor(hash(tx, ty, 98) * 10);
    const y = y0 + 4 + Math.floor(hash(tx, ty, 97) * 9);
    px(g, x, y, PAL.grass[0]); px(g, x + 1, y, PAL.grass[0]); px(g, x + 2, y, PAL.grass[0]);
    px(g, x + 1, y - 1, PAL.grass[1]); px(g, x, y - 1, PAL.grass[3]);
  }
  if (yard && hash(tx, ty, 77) < 0.5) { // a few flowers in the yards
    const cols = [PAL.cream, PAL.gold, PAL.red];
    for (let i = 0; i < 2; i++) {
      const x = x0 + 2 + Math.floor(hash(tx, ty, 70 + i) * 12);
      const y = y0 + 3 + Math.floor(hash(tx, ty, 80 + i) * 10);
      px(g, x, y + 1, PAL.grass[0]);
      px(g, x, y, cols[Math.floor(hash(tx, ty, 90 + i) * 3)]);
    }
  }
}

function paintDirtTile(g, x0, y0, tx, ty) {
  rect(g, x0, y0, T, T, PAL.dirt[2]);
  for (let i = 0; i < 12; i++) {
    const x = x0 + Math.floor(hash(tx, ty, i + 200) * T);
    const y = y0 + Math.floor(hash(tx, ty, i + 300) * T);
    px(g, x, y, i < 8 ? PAL.dirt[1] : PAL.dirt[3]);
  }
  if (hash(tx, ty, 400) < 0.25) { // pebble
    const x = x0 + 2 + Math.floor(hash(tx, ty, 401) * 11);
    const y = y0 + 2 + Math.floor(hash(tx, ty, 402) * 11);
    rect(g, x, y, 2, 1, PAL.dirt[3]);
    rect(g, x, y + 1, 2, 1, PAL.dirt[0]);
  }
}

function paintBoardTile(g, x0, y0, tx, ty) {
  rect(g, x0, y0, T, T, PAL.wood[3]);
  for (let r = 0; r < 4; r++) {
    const y = y0 + r * 4;
    rect(g, x0, y + 3, T, 1, PAL.wood[1]);
    rect(g, x0, y, T, 1, PAL.wood[4]);
    const j = x0 + 2 + Math.floor(hash(tx, ty, 500 + r) * 12);
    rect(g, j, y, 1, 3, PAL.wood[1]);
    px(g, j - 2, y + 1, PAL.wood[0]); // nail
  }
}

// Ragged grass lip where dirt meets grass. side: 'top'|'bottom'|'left'|'right'
function paintDirtEdge(g, x0, y0, tx, ty, side) {
  for (let i = 0; i < T; i++) {
    const d = Math.floor(hash(tx * 4 + i, ty, side.length * 31) * 3); // 0..2 px of grass
    const lit = side === 'top' || side === 'left' ? PAL.dirt[0] : PAL.dirt[3];
    let gx, gy, lx, ly, w, h;
    if (side === 'top') { gx = x0 + i; gy = y0; w = 1; h = d; lx = gx; ly = y0 + d; }
    if (side === 'bottom') { gx = x0 + i; gy = y0 + T - d; w = 1; h = d; lx = gx; ly = y0 + T - d - 1; }
    if (side === 'left') { gx = x0; gy = y0 + i; w = d; h = 1; lx = x0 + d; ly = gy; }
    if (side === 'right') { gx = x0 + T - d; gy = y0 + i; w = d; h = 1; lx = x0 + T - d - 1; ly = gy; }
    if (d > 0) rect(g, gx, gy, w, h, PAL.grass[2]);
    px(g, lx, ly, lit);
  }
}

function paintShadowEllipse(g, cx, cy, rx, ry) {
  g.fillStyle = PAL.shadow;
  for (let y = -ry; y <= ry; y++) {
    const w = Math.floor(rx * Math.sqrt(Math.max(0, 1 - (y * y) / (ry * ry))));
    g.fillRect(cx - w, cy + y, w * 2 + 1, 1);
  }
}

// ---------- building parts ----------

function paintWindow(g, x, y, Wd, flowers) {
  box(g, x, y, 13, 12, Wd[4]);
  rect(g, x + 2, y + 2, 9, 8, PAL.water[1]);
  rect(g, x + 7, y + 6, 4, 4, PAL.water[0]);
  rect(g, x + 2, y + 2, 4, 1, PAL.water[3]);
  px(g, x + 2, y + 3, PAL.water[3]);
  rect(g, x + 6, y + 2, 1, 8, Wd[4]);
  rect(g, x + 2, y + 5, 9, 1, Wd[4]);
  box(g, x - 1, y + 11, 15, 3, Wd[1]);
  if (flowers) {
    box(g, x, y + 13, 13, 4, PAL.wood[1]);
    for (let i = 0; i < 5; i++) {
      px(g, x + 2 + i * 2, y + 12, i % 2 ? PAL.gold : PAL.red);
      px(g, x + 3 + i * 2, y + 12, PAL.leaf[2]);
    }
  }
}

function paintDoor(g, x, y) {
  rect(g, x - 1, y - 2, 14, 2, PAL.wood[0]);
  box(g, x, y, 12, 21, PAL.wood[1]);
  rect(g, x + 2, y + 3, 8, 6, PAL.wood[0]);
  rect(g, x + 3, y + 4, 6, 4, PAL.wood[1]);
  rect(g, x + 2, y + 11, 8, 7, PAL.wood[0]);
  rect(g, x + 3, y + 12, 6, 5, PAL.wood[1]);
  rect(g, x + 1, y + 1, 1, 19, PAL.wood[2]);
  rect(g, x + 8, y + 10, 2, 2, PAL.gold);
}

// A house: footprint 5x4 tiles (80x64) plus 8px of roof above.
function paintHouse(v) {
  const { c, g } = makeCanvas(80, 72);
  const R = ROOFS[v.roof], Wd = WALLS[v.wall];

  // front wall, horizontal planks
  box(g, 4, 38, 72, 34, Wd[3]);
  for (let y = 43, row = 0; y < 71; y += 4, row++) {
    rect(g, 5, y, 70, 1, Wd[2]);
    for (let x = 12 + (row % 2) * 9; x < 72; x += 18) rect(g, x, y - 3, 1, 3, Wd[2]);
  }
  rect(g, 5, 41, 70, 3, Wd[1]); // shade under the eaves
  box(g, 4, 38, 4, 34, Wd[1]);
  box(g, 72, 38, 4, 34, Wd[1]);
  rect(g, 5, 39, 1, 32, Wd[2]);

  paintWindow(g, 12, 48, Wd, v.flowers);
  paintWindow(g, 55, 48, Wd, v.flowers);
  paintDoor(g, 34, 51);

  // roof: back slope in shade, sunlit ridge, shingled front slope
  box(g, 0, 2, 80, 41, R[2]);
  rect(g, 1, 3, 78, 9, R[0]);
  for (let x = 4; x < 78; x += 7) rect(g, x, 4, 1, 7, R[1]);
  rect(g, 1, 12, 78, 2, R[3]);
  for (let y = 19, row = 0; y < 40; y += 5, row++) {
    rect(g, 1, y, 78, 1, R[1]);
    for (let x = 3 + (row % 2) * 4; x < 78; x += 8) rect(g, x, y - 4, 1, 4, R[1]);
  }
  rect(g, 1, 14, 2, 27, R[3]);
  rect(g, 77, 14, 2, 27, R[1]);
  rect(g, 1, 40, 78, 2, R[0]);

  if (v.chimney) {
    box(g, 56, 1, 9, 12, PAL.stone[2]);
    rect(g, 57, 2, 1, 10, PAL.stone[3]);
    rect(g, 59, 5, 3, 1, PAL.stone[1]); rect(g, 58, 9, 3, 1, PAL.stone[1]);
    box(g, 55, 0, 11, 3, PAL.stone[1]);
  }
  if (v.awning) {
    box(g, 30, 44, 20, 6, R[2]);
    rect(g, 31, 45, 18, 1, R[3]);
    rect(g, 31, 48, 18, 1, R[0]);
  }
  return c;
}

// Town hall: footprint 9x7 tiles (144x112) plus 8px above. Frontier false-front.
function paintHall() {
  const { c, g } = makeCanvas(144, 120);
  const R = ROOFS[0], Wd = WALLS[2];

  // side roofs peeking out behind the false front
  box(g, 0, 22, 144, 34, R[2]);
  rect(g, 1, 23, 142, 8, R[0]);
  rect(g, 1, 31, 142, 2, R[3]);
  for (let y = 38; y < 55; y += 5) rect(g, 1, y, 142, 1, R[1]);

  // false-front facade with stepped top
  const inside = (x, y) =>
    (x >= 12 && x <= 131 && y >= 14) ||
    (x >= 40 && x <= 103 && y >= 6) ||
    (x >= 60 && x <= 83 && y >= 1);
  paintShape(g, 144, 120, inside, [Wd[2], Wd[3], Wd[4]], 3, 0);
  for (let y = 20; y < 118; y += 5) rect(g, 15, y, 114, 1, Wd[2]);
  for (let y = 11; y < 18; y += 5) rect(g, 43, y, 58, 1, Wd[2]);
  // cornice trim
  box(g, 11, 13, 122, 4, PAL.wood[2]);
  box(g, 39, 5, 66, 4, PAL.wood[2]);
  box(g, 59, 0, 26, 4, PAL.wood[2]);
  // round window in the pediment
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
    if (inEllipse(x, y, 5.5, 5.5, 6, 6)) px(g, 66 + x, 7 + y, PAL.out);
    if (inEllipse(x, y, 5.5, 5.5, 4.6, 4.6)) px(g, 66 + x, 7 + y, x + y < 8 ? PAL.water[3] : PAL.water[1]);
  }

  // upper windows
  for (const x of [22, 46, 85, 109]) paintWindow(g, x, 24, Wd, false);

  // porch roof (veranda)
  box(g, 4, 56, 136, 10, R[2]);
  rect(g, 5, 57, 134, 2, R[3]);
  for (let x = 9; x < 138; x += 8) rect(g, x, 59, 1, 5, R[1]);
  rect(g, 5, 63, 134, 2, R[0]);
  rect(g, 13, 66, 118, 4, Wd[1]); // shade under porch roof

  // ground-floor windows and double doors
  for (const x of [22, 41, 90, 109]) paintWindow(g, x, 75, Wd, false);
  box(g, 60, 72, 24, 6, PAL.wood[2]); // transom
  rect(g, 62, 74, 20, 2, PAL.water[2]);
  box(g, 60, 78, 24, 28, PAL.wood[1]);
  rect(g, 71, 79, 2, 26, PAL.wood[0]);
  for (const x of [62, 74]) {
    rect(g, x + 1, 81, 6, 9, PAL.wood[0]); rect(g, x + 2, 82, 4, 7, PAL.wood[2]);
    rect(g, x + 1, 93, 6, 9, PAL.wood[0]); rect(g, x + 2, 94, 4, 7, PAL.wood[2]);
  }
  rect(g, 68, 91, 2, 2, PAL.gold); rect(g, 74, 91, 2, 2, PAL.gold);

  // boardwalk porch floor
  box(g, 4, 104, 136, 16, PAL.wood[3]);
  for (let y = 108; y < 118; y += 4) rect(g, 5, y, 134, 1, PAL.wood[2]);
  rect(g, 5, 105, 134, 1, PAL.wood[4]);
  rect(g, 5, 117, 134, 2, PAL.wood[1]);
  // porch posts
  for (const x of [8, 36, 103, 131]) {
    box(g, x, 64, 5, 42, PAL.wood[2]);
    rect(g, x + 1, 65, 1, 40, PAL.wood[4]);
  }
  // bell on top
  box(g, 68, 0, 8, 2, PAL.wood[1]);
  return c;
}

// Fountain with a stone basin: footprint 4x3 (64x48) plus 8px above.
// The General Store (the Workshop): a frontier storefront with a tall false front,
// a striped porch awning, big display windows full of goods, and a picture sign (no text).
function paintStore() {
  const W = 112, H = 76;
  const { c, g } = makeCanvas(W, H);
  const Wd = WALLS[2], trim = WALLS[3];
  // false front: tall flat facade with a stepped top
  box(g, 6, 4, W - 12, 72, Wd[3]);
  box(g, 18, 0, W - 36, 6, Wd[3]);
  rect(g, 19, 1, W - 38, 1, Wd[4]);
  rect(g, 7, 5, W - 14, 1, Wd[4]);
  for (let y = 9, row = 0; y < 74; y += 4, row++) {
    rect(g, 7, y, W - 14, 1, Wd[2]);
    for (let x = 14 + (row % 2) * 9; x < W - 8; x += 18) rect(g, x, y - 3, 1, 3, Wd[2]);
  }
  box(g, 6, 4, 4, 72, Wd[1]); box(g, W - 10, 4, 4, 72, Wd[1]);
  // picture sign: a crate, a jar and a sack on a board (no words)
  box(g, 28, 8, 56, 16, trim[1]);
  rect(g, 30, 10, 52, 12, trim[3]);
  rect(g, 30, 10, 52, 1, trim[4]);
  box(g, 36, 13, 9, 8, PAL.wood[2]); rect(g, 37, 16, 7, 1, PAL.wood[0]); rect(g, 40, 14, 1, 6, PAL.wood[0]);   // crate
  box(g, 51, 12, 8, 9, PAL.water[2]); rect(g, 51, 11, 8, 2, PAL.wood[1]); rect(g, 53, 14, 2, 4, PAL.water[3]); // jar
  box(g, 66, 13, 10, 8, '#d8c79a'); rect(g, 69, 11, 4, 3, '#b9a87a'); rect(g, 67, 17, 8, 1, '#b9a87a');      // sack
  // porch awning, red and cream stripes
  box(g, 2, 30, W - 4, 9, PAL.out);
  for (let x = 3, k = 0; x < W - 3; x += 6, k++) rect(g, x, 31, Math.min(6, W - 3 - x), 7, k % 2 ? PAL.cream : PAL.red);
  for (let x = 3, k = 0; x < W - 3; x += 6, k++) rect(g, x, 37, Math.min(6, W - 3 - x), 1, k % 2 ? '#c9b496' : '#a3442c');
  rect(g, 3, 38, W - 6, 2, 'rgba(46,29,20,0.35)');
  box(g, 8, 39, 3, 37, PAL.wood[1]); box(g, W - 11, 39, 3, 37, PAL.wood[1]);   // porch posts
  // big display windows with goods on shelves
  for (const wx of [16, 66]) {
    box(g, wx, 44, 30, 22, Wd[4]);
    rect(g, wx + 2, 46, 26, 18, PAL.water[1]);
    rect(g, wx + 2, 46, 8, 1, PAL.water[3]);
    rect(g, wx + 2, 54, 26, 1, PAL.wood[1]); rect(g, wx + 2, 62, 26, 2, PAL.wood[1]);
    const goods = ['#c7922e', '#a3401f', '#3f6f8f', '#56663a', '#e8b84a', '#6a3644', PAL.cream];
    for (let i = 0; i < 6; i++) { const col = goods[(i * 3 + wx) % goods.length]; box(g, wx + 3 + i * 4, 49 + (i % 2), 3, 5 - (i % 2), col); }
    for (let i = 0; i < 5; i++) { const col = goods[(i * 5 + wx + 1) % goods.length]; box(g, wx + 4 + i * 5, 57, 4, 5, col); }
    rect(g, wx + 15, 46, 1, 18, Wd[4]);
  }
  paintDoor(g, 50, 55);
  return c;
}
// shelves of goods: jars, tins, sacks and parcels (stand for the things made in the Workshop)
function paintGoodsShelf(seed) {
  const H = 34;
  const { c, g } = makeCanvas(32, H);
  const r = rng(seed);
  box(g, 0, 0, 32, H, PAL.wood[1]);
  rect(g, 1, 1, 30, 1, PAL.wood[3]);
  const cols = ['#c7922e', '#a3401f', '#3f6f8f', '#56663a', '#e8b84a', '#6a3644', PAL.cream, '#73b6e0'];
  for (let k = 0; k < 3; k++) {
    const sy = 2 + k * 10;
    rect(g, 2, sy, 28, 9, PAL.wood[0]);
    let x = 3;
    while (x < 27) {
      const kind = Math.floor(r() * 4), col = cols[Math.floor(r() * cols.length)];
      if (kind === 0) { box(g, x, sy + 3, 4, 6, col); rect(g, x, sy + 2, 4, 1, PAL.wood[3]); x += 5; }        // jar
      else if (kind === 1) { box(g, x, sy + 5, 5, 4, col); rect(g, x + 1, sy + 6, 3, 1, PAL.cream); x += 6; } // tin
      else if (kind === 2) { box(g, x, sy + 4, 5, 5, '#d8c79a'); px(g, x + 2, sy + 3, '#b9a87a'); x += 6; }   // sack
      else { box(g, x, sy + 4, 6, 5, PAL.cream); rect(g, x + 2, sy + 4, 1, 5, PAL.red); x += 7; }             // parcel
    }
    rect(g, 1, sy + 9, 30, 1, PAL.wood[3]);
  }
  return c;
}
// the shop counter, with a brass cash register and a ledger
function paintCounter(wT) {
  const W = wT * 16, H = 26;
  const { c, g } = makeCanvas(W, H);
  box(g, 0, 6, W, H - 6, PAL.wood[2]);
  rect(g, 1, 7, W - 2, 2, PAL.wood[4]);
  for (let x = 6; x < W - 2; x += 10) box(g, x, 12, 7, 10, PAL.wood[1]);
  box(g, W - 18, 0, 13, 10, PAL.gold); rect(g, W - 16, 2, 9, 3, '#fff0b8'); rect(g, W - 17, 7, 11, 1, '#a3721f');
  box(g, 6, 3, 12, 6, PAL.cream); rect(g, 12, 3, 1, 6, PAL.stone[2]);
  return c;
}
// the catalogue board on the back wall: pinned cards (one for each thing made)
function paintCatalogBoard() {
  const { c, g } = makeCanvas(32, 28);
  box(g, 0, 0, 32, 24, PAL.wood[1]);
  rect(g, 2, 2, 28, 20, '#b08a5a');
  const cards = [[4, 4, PAL.cream], [13, 3, '#e0d0a0'], [22, 5, PAL.cream], [5, 13, '#e0d0a0'], [15, 12, PAL.cream], [23, 14, '#e0d0a0']];
  for (const [x, y, col] of cards) { box(g, x, y, 7, 7, col); px(g, x + 3, y, PAL.red); rect(g, x + 1, y + 3, 5, 1, PAL.stone[2]); }
  box(g, 3, 22, 3, 6, PAL.wood[0]); box(g, 26, 22, 3, 6, PAL.wood[0]);
  return c;
}
function paintCrate() {
  const { c, g } = makeCanvas(16, 16);
  box(g, 1, 3, 14, 13, PAL.wood[2]);
  rect(g, 2, 4, 12, 1, PAL.wood[4]);
  rect(g, 2, 9, 12, 1, PAL.wood[1]);
  rect(g, 7, 4, 1, 11, PAL.wood[1]);
  return c;
}
function paintFountain() {
  const { c, g } = makeCanvas(64, 56);
  const S = PAL.stone, Wt = PAL.water;
  paintShape(g, 64, 56, (x, y) => inEllipse(x, y, 31.5, 41, 30, 13), [S[0], S[1], S[2]], 5, 0.04);
  paintShape(g, 64, 56, (x, y) => inEllipse(x, y, 31.5, 36, 30, 13), [S[1], S[2], S[3]], 6, 0.05);
  const inner = (x, y) => inEllipse(x, y, 31.5, 35.5, 25, 9.5);
  const r = rng(9);
  for (let y = 20; y < 50; y++) for (let x = 0; x < 64; x++) {
    if (!inner(x, y)) continue;
    let col = Wt[1];
    if (!inner(x - 2, y - 2)) col = S[0];
    else if (!inner(x + 2, y + 2)) col = Wt[2];
    else if (r() < 0.06) col = Wt[3];
    else if ((x + y * 3) % 11 === 0) col = Wt[2];
    px(g, x, y, col);
  }
  // centre column and top bowl
  box(g, 28, 14, 8, 24, S[2]);
  rect(g, 29, 15, 2, 22, S[3]);
  rect(g, 33, 15, 2, 22, S[1]);
  paintShape(g, 64, 56, (x, y) => inEllipse(x, y, 31.5, 13, 9, 3.5), [S[1], S[2], S[3]], 7, 0);
  // water spout and falling drops
  rect(g, 31, 3, 2, 8, Wt[3]);
  rect(g, 30, 2, 4, 2, Wt[2]);
  for (const [x, y] of [[26, 6], [24, 9], [23, 13], [37, 6], [39, 9], [40, 13], [22, 17], [41, 17]]) {
    px(g, x, y, Wt[2]); px(g, x, y + 1, Wt[3]);
  }
  return c;
}

function paintTrough() {
  const { c, g } = makeCanvas(32, 20);
  box(g, 1, 3, 30, 13, PAL.wood[2]);
  rect(g, 2, 4, 28, 1, PAL.wood[4]);
  rect(g, 4, 6, 24, 5, PAL.water[1]);
  rect(g, 4, 6, 24, 1, PAL.water[0]);
  rect(g, 6, 8, 6, 1, PAL.water[3]);
  rect(g, 2, 12, 28, 3, PAL.wood[1]);
  box(g, 3, 15, 4, 5, PAL.wood[0]);
  box(g, 25, 15, 4, 5, PAL.wood[0]);
  return c;
}

function paintTree(seed) {
  const { c, g } = makeCanvas(36, 48);
  const r = rng(seed);
  box(g, 14, 30, 8, 18, PAL.wood[1]);
  rect(g, 15, 31, 2, 16, PAL.wood[2]);
  rect(g, 20, 31, 1, 16, PAL.wood[0]);
  px(g, 13, 46, PAL.wood[1]); px(g, 22, 46, PAL.wood[1]);
  const j = () => Math.floor(r() * 3) - 1;
  const blobs = [
    [18 + j(), 18 + j(), 14, 13],
    [10 + j(), 24 + j(), 9, 8],
    [26 + j(), 24 + j(), 9, 8],
    [18 + j(), 9 + j(), 10, 8],
  ];
  paintShape(g, 36, 40, (x, y) => blobs.some(b => inEllipse(x, y, b[0], b[1], b[2], b[3])),
    [PAL.leaf[0], PAL.leaf[1], PAL.leaf[2], PAL.leaf[3]], seed, 0.1);
  return c;
}

function paintBush(seed) {
  const { c, g } = makeCanvas(18, 14);
  paintShape(g, 18, 14, (x, y) => inEllipse(x, y, 8.5, 7.5, 7.5, 5.5) || inEllipse(x, y, 5, 6, 4, 4),
    [PAL.leaf[0], PAL.leaf[1], PAL.leaf[2], PAL.leaf[3]], seed, 0.12);
  if (seed % 3 === 0) { px(g, 6, 6, PAL.red); px(g, 11, 8, PAL.red); px(g, 9, 5, PAL.red); }
  return c;
}

function paintFence(kind) {
  const { c, g } = makeCanvas(16, 18);
  if (kind === 'h') {
    box(g, 0, 7, 16, 3, PAL.wood[3]);
    box(g, 0, 12, 16, 3, PAL.wood[3]);
    box(g, 1, 4, 4, 14, PAL.wood[2]); rect(g, 2, 5, 1, 12, PAL.wood[4]);
    box(g, 11, 4, 4, 14, PAL.wood[2]); rect(g, 12, 5, 1, 12, PAL.wood[4]);
  } else if (kind === 'v') {
    box(g, 6, 0, 4, 18, PAL.wood[3]);
    box(g, 5, 5, 6, 13, PAL.wood[2]); rect(g, 6, 6, 1, 11, PAL.wood[4]);
  } else { // corner post
    box(g, 5, 4, 6, 14, PAL.wood[2]); rect(g, 6, 5, 1, 12, PAL.wood[4]);
  }
  return c;
}

function paintBarrel() {
  const { c, g } = makeCanvas(14, 18);
  paintShape(g, 14, 18, (x, y) => x >= 1 && x <= 12 && y >= 1 && y <= 16 && !((x <= 1 || x >= 12) && (y <= 2 || y >= 15)),
    [PAL.wood[1], PAL.wood[2], PAL.wood[3]], 11, 0);
  rect(g, 1, 4, 12, 1, PAL.iron[1]); rect(g, 1, 12, 12, 1, PAL.iron[1]);
  rect(g, 3, 2, 8, 2, PAL.wood[1]);
  return c;
}

function paintBenchOutdoor() {
  const { c, g } = makeCanvas(32, 16);
  box(g, 1, 1, 30, 5, PAL.wood[2]);        // backrest
  rect(g, 2, 2, 28, 1, PAL.wood[4]);
  box(g, 1, 6, 30, 6, PAL.wood[3]);        // seat
  rect(g, 2, 7, 28, 1, PAL.wood[4]);
  box(g, 3, 11, 3, 5, PAL.iron[1]);
  box(g, 26, 11, 3, 5, PAL.iron[1]);
  return c;
}

// ---------- interior pieces ----------

function paintFloorTile(g, x0, y0, tx, ty, F) {
  rect(g, x0, y0, T, T, F[3]);
  for (let r = 0; r < 4; r++) {
    const y = y0 + r * 4;
    rect(g, x0, y + 3, T, 1, F[1]);
    if (hash(tx, ty, 600 + r) < 0.5) rect(g, x0, y, T, 1, F[4]);
    const j = x0 + Math.floor(hash(tx, ty + r * 7, 610) * 16);
    rect(g, j, y, 1, 3, F[1]);
  }
}

function paintBed(Q) {
  const { c, g } = makeCanvas(16, 32);
  box(g, 0, 0, 16, 32, PAL.wood[1]);
  rect(g, 1, 1, 14, 2, PAL.wood[3]);
  box(g, 2, 4, 12, 7, PAL.cream);
  rect(g, 3, 5, 4, 1, '#fffaf0');
  box(g, 1, 11, 14, 20, Q[1]);
  for (let y = 13; y < 30; y += 4) for (let x = 3 + ((y >> 2) % 2) * 4; x < 14; x += 8) rect(g, x, y, 3, 3, Q[0]);
  rect(g, 2, 12, 12, 2, PAL.cream);
  rect(g, 2, 14, 1, 16, Q[2]);
  return c;
}

function paintTable(wT, hT, items) {
  const W = wT * 16, H = hT * 16;
  const { c, g } = makeCanvas(W, H);
  box(g, 0, 0, W, H - 4, PAL.wood[3]);
  for (let y = 4; y < H - 6; y += 4) rect(g, 1, y, W - 2, 1, PAL.wood[2]);
  rect(g, 1, 1, W - 2, 1, PAL.wood[4]);
  rect(g, 1, H - 7, W - 2, 3, PAL.wood[1]);
  box(g, 1, H - 5, 3, 5, PAL.wood[0]);
  box(g, W - 4, H - 5, 3, 5, PAL.wood[0]);
  if (items === 'meal') {
    box(g, 5, 3, 7, 5, PAL.cream); rect(g, 7, 5, 3, 1, PAL.dirt[1]);
    box(g, W - 11, 3, 5, 6, PAL.stone[2]);
    box(g, W / 2 - 1, 1, 3, 6, PAL.cream); px(g, W / 2, 0, PAL.gold);
  } else if (items === 'papers') {
    for (let x = 6; x < W - 10; x += 14) { box(g, x, 4, 8, 10, PAL.cream); rect(g, x + 1, 5, 6, 1, '#fffaf0'); }
    box(g, W - 9, 6, 4, 4, PAL.iron[0]);
  }
  return c;
}

function paintChair() {
  const { c, g } = makeCanvas(14, 16);
  box(g, 2, 0, 10, 7, PAL.wood[2]);
  rect(g, 3, 1, 8, 1, PAL.wood[4]);
  box(g, 1, 6, 12, 6, PAL.wood[3]);
  rect(g, 2, 7, 10, 1, PAL.wood[4]);
  box(g, 2, 11, 3, 5, PAL.wood[0]);
  box(g, 9, 11, 3, 5, PAL.wood[0]);
  return c;
}

function paintStove() {
  const { c, g } = makeCanvas(16, 30);
  box(g, 6, 0, 5, 14, PAL.iron[1]);
  rect(g, 7, 1, 1, 12, PAL.iron[2]);
  box(g, 1, 12, 14, 18, PAL.iron[1]);
  rect(g, 2, 13, 12, 3, PAL.iron[0]);
  rect(g, 2, 13, 1, 16, PAL.iron[2]);
  box(g, 4, 18, 8, 7, PAL.iron[0]);
  rect(g, 5, 21, 6, 3, '#d86a3a'); rect(g, 6, 22, 4, 1, PAL.gold);
  return c;
}

function paintShelf(seed, rows) {
  rows = rows || 3;
  const H = 4 + rows * 10;
  const { c, g } = makeCanvas(32, H);
  const r = rng(seed);
  box(g, 0, 0, 32, H, PAL.wood[1]);
  rect(g, 1, 1, 30, 1, PAL.wood[3]);
  const bookCols = ['#a3401f', '#3f6f8f', '#56663a', '#c7922e', '#6a3644', PAL.cream];
  for (let k = 0; k < rows; k++) {
    const sy = 2 + k * 10;
    rect(g, 2, sy, 28, 9, PAL.wood[0]);
    let x = 3;
    while (x < 28) {
      const w = 2 + Math.floor(r() * 2), h = 5 + Math.floor(r() * 3);
      if (r() < 0.15) { x += 2; continue; }
      const col = bookCols[Math.floor(r() * bookCols.length)];
      rect(g, x, sy + 9 - h, w, h, col);
      px(g, x, sy + 9 - h, '#fffaf0');
      x += w + (r() < 0.3 ? 1 : 0);
    }
    rect(g, 1, sy + 9, 30, 1, PAL.wood[3]);
  }
  return c;
}

// Writing desk (2 tiles wide): the owner's seat goes in front of it.
function paintDesk(seed) {
  const { c, g } = makeCanvas(32, 22);
  const r = rng(seed);
  box(g, 0, 0, 32, 16, PAL.wood[2]);            // desktop
  rect(g, 1, 1, 30, 1, PAL.wood[4]);
  rect(g, 1, 13, 30, 2, PAL.wood[1]);
  box(g, 0, 15, 12, 7, PAL.wood[1]);            // drawer block
  rect(g, 4, 18, 4, 1, PAL.gold);
  box(g, 28, 15, 4, 7, PAL.wood[0]);            // leg
  box(g, 4, 3, 10, 8, PAL.cream);               // open notebook (blank)
  rect(g, 9, 3, 1, 8, PAL.stone[2]);
  box(g, 17, 6, 4, 4, PAL.iron[0]);             // inkwell
  px(g, 20, 3, PAL.cream); px(g, 21, 2, PAL.cream); px(g, 19, 4, PAL.cream); // quill
  if (r() < 0.5) { box(g, 24, 2, 5, 8, PAL.gold); rect(g, 25, 1, 3, 2, '#fffaf0'); } // lamp
  else { box(g, 23, 4, 6, 6, ROOFS[0][2]); px(g, 25, 3, PAL.leaf[2]); px(g, 26, 2, PAL.leaf[3]); }
  return c;
}

// Chair seen from behind (for sitting at a desk that is above it).
function paintChairBack() {
  const { c, g } = makeCanvas(14, 16);
  box(g, 1, 2, 12, 7, PAL.wood[3]);             // seat
  rect(g, 2, 3, 10, 1, PAL.wood[4]);
  box(g, 2, 8, 10, 6, PAL.wood[2]);             // backrest facing us
  rect(g, 3, 9, 8, 1, PAL.wood[4]);
  rect(g, 4, 11, 6, 1, PAL.wood[1]);
  box(g, 2, 13, 3, 3, PAL.wood[0]);
  box(g, 9, 13, 3, 3, PAL.wood[0]);
  return c;
}

function paintArmchair(Q) {
  const { c, g } = makeCanvas(16, 18);
  box(g, 1, 0, 14, 8, Q[1]);
  rect(g, 2, 1, 12, 1, Q[2]);
  box(g, 0, 5, 4, 11, Q[0]); box(g, 12, 5, 4, 11, Q[0]);
  box(g, 3, 7, 10, 8, Q[2]);
  rect(g, 4, 8, 8, 1, PAL.cream);
  box(g, 1, 15, 3, 3, PAL.wood[0]); box(g, 12, 15, 3, 3, PAL.wood[0]);
  return c;
}

function paintWashstand() {
  const { c, g } = makeCanvas(16, 20);
  box(g, 2, 6, 12, 14, PAL.wood[2]);
  rect(g, 3, 7, 1, 12, PAL.wood[4]);
  rect(g, 6, 12, 4, 1, PAL.gold);
  paintShape(g, 16, 10, (x, y) => inEllipse(x, y, 7.5, 5, 6, 3.5), [PAL.stone[1], PAL.stone[3], '#fffaf0'], 13, 0);
  rect(g, 5, 4, 6, 2, PAL.water[2]);
  return c;
}

function paintChest() {
  const { c, g } = makeCanvas(16, 14);
  box(g, 1, 1, 14, 13, PAL.wood[2]);
  rect(g, 2, 2, 12, 1, PAL.wood[4]);
  rect(g, 2, 5, 12, 1, PAL.wood[0]);
  rect(g, 4, 1, 1, 13, PAL.iron[1]); rect(g, 11, 1, 1, 13, PAL.iron[1]);
  box(g, 6, 5, 4, 4, PAL.gold);
  return c;
}

function paintPlant(seed) {
  const { c, g } = makeCanvas(16, 22);
  paintShape(g, 16, 16, (x, y) => inEllipse(x, y, 7.5, 9, 6.5, 6) || inEllipse(x, y, 4, 5, 3, 4) || inEllipse(x, y, 11, 5, 3, 4),
    [PAL.leaf[0], PAL.leaf[1], PAL.leaf[2], PAL.leaf[3]], seed, 0.1);
  box(g, 3, 13, 10, 9, ROOFS[0][2]);
  rect(g, 4, 14, 8, 1, ROOFS[0][3]);
  rect(g, 2, 13, 12, 2, ROOFS[0][1]);
  return c;
}

function paintLectern() {
  const { c, g } = makeCanvas(16, 26);
  box(g, 4, 8, 8, 18, PAL.wood[2]);
  rect(g, 5, 9, 1, 16, PAL.wood[4]);
  box(g, 1, 2, 14, 8, PAL.wood[3]);
  box(g, 3, 3, 10, 5, PAL.cream);
  rect(g, 8, 3, 1, 5, PAL.stone[2]);
  return c;
}

function paintBench(wT) {
  const W = wT * 16;
  const { c, g } = makeCanvas(W, 14);
  box(g, 0, 2, W, 7, PAL.wood[3]);
  rect(g, 1, 3, W - 2, 1, PAL.wood[4]);
  rect(g, 1, 7, W - 2, 1, PAL.wood[1]);
  for (const x of [2, W - 6, Math.floor(W / 2) - 2]) box(g, x, 8, 4, 6, PAL.wood[0]);
  return c;
}

function paintRug(g, x0, y0, w, h, Rg) {
  box(g, x0, y0, w, h, Rg[0]);
  rect(g, x0 + 2, y0 + 2, w - 4, h - 4, Rg[1]);
  for (let y = y0 + 5; y < y0 + h - 5; y += 6)
    for (let x = x0 + 5 + ((y - y0) % 12 ? 3 : 0); x < x0 + w - 5; x += 6) {
      px(g, x, y - 1, Rg[2]); rect(g, x - 1, y, 3, 1, Rg[2]); px(g, x, y + 1, Rg[2]);
    }
  for (let y = y0 + 1; y < y0 + h - 1; y += 2) { px(g, x0 - 1, y, PAL.cream); px(g, x0 + w, y, PAL.cream); }
}

// The visitor: a plain game-piece marker (not one of the agents).
function paintVisitor(dir, bob) {
  const { c, g } = makeCanvas(14, 22);
  paintShadowEllipse(g, 7, 20, 6, 1);
  const oy = bob ? 1 : 0;
  const inside = (x, y) => {
    y -= oy;
    if (inEllipse(x, y, 6.5, 5, 3.6, 3.6)) return true;
    if (y >= 9 && y <= 18) {
      const hw = 2 + (y - 9) * 0.45;
      return Math.abs(x - 6.5) <= hw;
    }
    return false;
  };
  paintShape(g, 14, 20, inside, ['#c9b48a', '#f1e6c8', '#fffaf0'], 21, 0);
  rect(g, 2, 17 + oy, 10, 1, PAL.gold); // gold ring at the base
  if (dir === 'down') { px(g, 5, 5 + oy, PAL.out); px(g, 8, 5 + oy, PAL.out); }
  if (dir === 'left') px(g, 4, 5 + oy, PAL.out);
  if (dir === 'right') px(g, 9, 5 + oy, PAL.out);
  return c;
}

// ---------- double detail ----------
// The world is drawn at 2 art pixels per world pixel, to match the character
// sprites. Scale2x doubles a picture's resolution the classic pixel-art way:
// diagonal edges get finer steps while flat areas and outlines stay crisp.
function scale2x(src) {
  const w = src.width, h = src.height;
  const sd = new Uint32Array(src.getContext('2d').getImageData(0, 0, w, h).data.buffer.slice(0));
  const { c, g } = makeCanvas(w * 2, h * 2);
  const out = g.createImageData(w * 2, h * 2);
  const od = new Uint32Array(out.data.buffer);
  const at = (x, y) => sd[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const P = sd[y * w + x], A = at(x, y - 1), B = at(x + 1, y), C = at(x - 1, y), D = at(x, y + 1);
      let e0 = P, e1 = P, e2 = P, e3 = P;
      if (A !== D && C !== B) {
        if (C === A) e0 = A;
        if (A === B) e1 = B;
        if (D === C) e2 = C;
        if (B === D) e3 = D;
      }
      const o = (y * 2) * (w * 2) + x * 2;
      od[o] = e0; od[o + 1] = e1; od[o + w * 2] = e2; od[o + w * 2 + 1] = e3;
    }
  }
  g.putImageData(out, 0, 0);
  return c;
}

// Fine texture at double detail: scatter single art pixels of a neighbouring
// tone over the big flat colours (grass, dirt, wood floors), seeded so it
// never changes between loads.
function fineDetail(canvas, seed) {
  const g = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const img = g.getImageData(0, 0, w, h);
  const d = new Uint32Array(img.data.buffer);
  const toU32 = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return (0xff << 24 | (n & 0xff) << 16 | (n >> 8 & 0xff) << 8 | n >> 16) >>> 0;
  };
  const swaps = new Map();
  const add = (base, darker, lighter) => swaps.set(toU32(base), [toU32(darker), toU32(lighter)]);
  add(PAL.grass[2], PAL.grass[1], PAL.grass[3]);
  add(PAL.dirt[2], PAL.dirt[1], PAL.dirt[3]);
  for (const F of FLOORS_ALL) add(F[3], F[2], F[4]);
  const r = rng(seed);
  for (let i = 0; i < d.length; i++) {
    const s = swaps.get(d[i] >>> 0);
    if (!s) continue;
    const k = r();
    if (k < 0.035) d[i] = s[0];
    else if (k < 0.05) d[i] = s[1];
  }
  g.putImageData(img, 0, 0);
  return canvas;
}

// Swap every object's picture for its double-detail version (shared pictures
// are converted once). Objects keep their size and place in world pixels.
function toHiRes(objects) {
  const cache = new Map();
  for (const o of objects) {
    if (!cache.has(o.img)) cache.set(o.img, scale2x(o.img));
    o.w = o.img.width; o.h = o.img.height;
    o.img = cache.get(o.img);
  }
}

// Wood floor palettes (also used by interiors.js); listed here so fineDetail knows them.
const FLOORS_ALL = [
  ['#5a3620', '#7e4f2c', '#a8703f', '#c99560', '#e0b47a'],
  ['#3e2616', '#5a3620', '#7e4f2c', '#a0683a', '#bf8650'],
  ['#6a5644', '#8c765e', '#ad967a', '#c9b496', '#e0d0b4'],
];
