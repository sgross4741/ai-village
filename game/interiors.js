'use strict';
// interiors.js: the inside of every building, drawn in code.
// Room rules (decided with the director):
//  - Scale: a standing person is one EIGHTH of the room's height.
//    The room is 10 tiles (160px) tall and the Sheriff is 20px tall.
//  - The room fills the whole view. The back wall is a thin strip at the top;
//    one door is centred in a thin wall at the bottom. Thin side walls.
//  - Small furniture with open floor between pieces; nothing in front of the door.
//  - No people in the art.
//  - Every room has one desk and chair where its owner will sit.

const ROOM_W = 17, ROOM_H = 10;   // tiles (272 x 160 px)
const WALL_SIDE = 6;              // px: thin side walls
const WALL_BOTTOM = 8;            // px: thin bottom wall
const WALL_TOP = 16;              // px: thin back-wall strip (one tile)

const WALLPAPERS = [
  ['#6a4a3a', '#8a6450', '#b08670', '#cfa88e'], // clay
  ['#4e5a40', '#6a7856', '#8c9a72', '#aebb92'], // sage
  ['#7a5a26', '#a07a36', '#c49a4c', '#ddb86a'], // mustard
  ['#6a3a3a', '#8c5050', '#ad6a66', '#c98a84'], // rose
  ['#3e5450', '#567068', '#728e84', '#93aca0'], // muted teal
];
const FLOORS = FLOORS_ALL; // defined in art.js
const RUGS = [
  ['#7a2e18', '#a3401f', '#e8b84a'],
  ['#2f4f6f', '#3f6f8f', '#e0d0a0'],
  ['#4a5a2c', '#6a7a3a', '#e8c070'],
  ['#6a3644', '#8a4a5a', '#e8b84a'],
];

function buildInterior(b) {
  const isHall = b.kind === 'hall', isStore = b.kind === 'store';
  const RW = ROOM_W, RH = ROOM_H, W = RW * T, H = RH * T;
  const doorCol = Math.floor(RW / 2);
  const r = rng(b.index * 101 + 7);
  const wp = WALLPAPERS[isHall ? 2 : b.index % WALLPAPERS.length];
  const fl = FLOORS[isHall ? 0 : b.index % FLOORS.length];
  const rug = RUGS[isHall ? 0 : b.index % RUGS.length];
  const mirror = !isHall && !isStore && b.index % 2 === 1;

  const solid = grid(RW, RH, false);
  const objects = [];
  const mx = (x, w) => (mirror ? RW - 1 - x - (w - 1) : x);
  const place = (img, x, y, w, h) => {
    const X = mx(x, w);
    addObj(objects, img, X, y, w, h);
    for (let j = y; j < y + h; j++) for (let i = X; i < X + w; i++) solid[j][i] = true;
  };

  // ---- room shell ----
  const { c: ground, g } = makeCanvas(W, H);
  for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) paintFloorTile(g, x * T, y * T, x, y, fl);

  // thin back wall: wallpaper strip with small windows and a baseboard
  rect(g, 0, 0, W, WALL_TOP, wp[2]);
  for (let x = 3; x < W; x += 6) rect(g, x, 2, 1, WALL_TOP - 6, wp[1]);
  rect(g, 0, 0, W, 2, PAL.out);
  rect(g, 0, WALL_TOP - 4, W, 2, FLOORS[1][2]);
  rect(g, 0, WALL_TOP - 2, W, 2, FLOORS[1][0]);
  const winCols = [3, 6, 10, 13];
  for (const wx of winCols) {
    const x = wx * T + 2, y = 2;
    box(g, x - 2, y, 2, 10, rug[1]); box(g, x + 12, y, 2, 10, rug[1]);
    box(g, x, y, 12, 10, PAL.wood[4]);
    rect(g, x + 2, y + 2, 8, 6, PAL.water[2]);
    rect(g, x + 2, y + 5, 8, 3, PAL.grass[3]);
    rect(g, x + 2, y + 2, 3, 1, PAL.water[3]);
    rect(g, x + 6, y + 2, 1, 6, PAL.wood[4]);
  }
  // thin side walls (lit edge on the left wall's inner face)
  rect(g, 0, 0, WALL_SIDE, H, PAL.wood[1]);
  rect(g, WALL_SIDE - 1, WALL_TOP, 1, H - WALL_TOP, PAL.wood[3]);
  rect(g, 0, 0, 2, H, PAL.out);
  rect(g, W - WALL_SIDE, 0, WALL_SIDE, H, PAL.wood[0]);
  rect(g, W - WALL_SIDE, WALL_TOP, 1, H - WALL_TOP, PAL.out);
  rect(g, W - 2, 0, 2, H, PAL.out);
  // thin bottom wall with one door in the middle
  rect(g, 0, H - WALL_BOTTOM, W, WALL_BOTTOM, PAL.wood[1]);
  rect(g, 0, H - WALL_BOTTOM, W, 1, PAL.wood[3]);
  rect(g, 0, H - 2, W, 2, PAL.out);
  const dx = doorCol * T;
  box(g, dx + 1, H - WALL_BOTTOM - 2, 14, WALL_BOTTOM + 2, PAL.wood[2]);
  rect(g, dx + 3, H - WALL_BOTTOM, 10, WALL_BOTTOM - 2, PAL.wood[1]);
  rect(g, dx + 7, H - WALL_BOTTOM, 1, WALL_BOTTOM - 2, PAL.wood[0]);
  rect(g, dx + 10, H - 5, 2, 2, PAL.gold);
  // doormat just inside the door
  box(g, dx + 1, H - WALL_BOTTOM - 10, 14, 7, rug[0]);
  rect(g, dx + 3, H - WALL_BOTTOM - 8, 10, 3, rug[2]);

  // ---- furniture (all against walls or on rugs; the door lane stays open) ----
  const chair = paintChair(), chairBack = paintChairBack();
  if (isStore) {
    // the General Store: goods on the back wall, the catalogue board in the middle,
    // four workbenches where townspeople and workers make things, and the counter
    place(paintGoodsShelf(71), 1, 1, 2, 1);
    place(paintGoodsShelf(72), 3, 1, 2, 1);
    place(paintGoodsShelf(73), 5, 1, 2, 1);
    place(paintCatalogBoard(), 8, 1, 1, 1);
    place(paintGoodsShelf(74), 10, 1, 2, 1);
    place(paintGoodsShelf(75), 12, 1, 2, 1);
    place(paintGoodsShelf(76), 14, 1, 2, 1);
    paintRug(g, 1 * T + 4, 3 * T + 4, 6 * T - 8, 3 * T - 6, rug);
    paintRug(g, 10 * T + 4, 3 * T + 4, 6 * T - 8, 3 * T - 6, rug);
    for (const x of [2, 5, 11, 14]) { place(paintDesk(80 + x), x, 4, 2, 1); place(chairBack, x, 5, 1, 1); }
    place(paintCounter(4), 11, 7, 4, 1);
    place(paintBarrel(), 1, 7, 1, 1);
    place(paintCrate(), 2, 8, 1, 1);
    place(paintCrate(), 5, 8, 1, 1);
    place(paintPlant(17), 15, 8, 1, 1);
  } else if (!isHall) {
    const quilt = RUGS[(b.index + 1) % RUGS.length];
    // back wall
    place(paintShelf(b.index + 3, 2), 2, 1, 2, 1);
    place(paintWashstand(), 5, 1, 1, 1);
    place(paintChest(), 11, 1, 1, 1);
    place(paintStove(), 15, 1, 1, 1);
    // bed and chest against the left wall
    place(paintBed(quilt), 1, 3, 1, 2);
    place(paintChest(), 1, 6, 1, 1);
    // the owner's desk and chair, right side
    place(paintDesk(b.index + 9), 13, 4, 2, 1);
    place(chairBack, 13, 5, 1, 1);
    place(paintArmchair(quilt), 14, 2, 1, 1);
    // small dining table on a rug, open floor all round
    paintRug(g, mx(4, 4) * T + 2, 4 * T + 2, 4 * T - 4, 3 * T - 4, rug);
    place(paintTable(2, 1, 'meal'), 5, 5, 2, 1);
    place(chair, 4, 5, 1, 1);
    place(chair, 7, 5, 1, 1);
    // plants in the front corners, one extra piece
    place(paintPlant(b.index + 11), 1, 8, 1, 1);
    place(paintPlant(b.index + 13), 15, 8, 1, 1);
    if (r() < 0.5) place(paintBarrel(), 3, 8, 1, 1);
    else place(paintPlant(b.index + 5), 12, 8, 1, 1);
  } else {
    // speaker's lectern and shelves on the back wall
    place(paintLectern(), 8, 1, 1, 1);
    place(paintShelf(41, 2), 2, 1, 2, 1);
    place(paintShelf(43, 2), 13, 1, 2, 1);
    place(paintPlant(7), 1, 1, 1, 1);
    place(paintPlant(9), 15, 1, 1, 1);
    // meeting table on a rug
    paintRug(g, 5 * T, 2 * T + 4, 7 * T, 4 * T - 4, rug);
    place(paintTable(5, 2, 'papers'), 6, 3, 5, 2);
    // no chairs on the top side: that's where the Sheriff stands to lead a meeting
    for (const x of [7, 9]) place(chairBack, x, 5, 1, 1);
    // the clerk's desk and chair (the owner's seat here)
    place(paintDesk(31), 13, 4, 2, 1);
    place(chairBack, 13, 5, 1, 1);
    // benches for town meetings, aisle down the middle
    place(paintBench(4), 2, 7, 4, 1);
    place(paintBench(4), 11, 7, 4, 1);
    place(paintPlant(11), 1, 8, 1, 1);
    place(paintPlant(13), 15, 8, 1, 1);
  }

  // Safety rule: keep the lane from the door straight up into the room clear.
  for (let y = 5; y < RH; y++) if (solid[y][doorCol]) console.error(b.label + ': furniture is blocking the door lane');

  objects.sort((a, b2) => a.base - b2.base);
  toHiRes(objects);
  const groundHi = fineDetail(scale2x(ground), 1000 + b.index);
  const doorX0 = doorCol * T, doorX1 = doorX0 + T;
  return {
    name: b.id, label: b.label, w: RW, h: RH, ground: groundHi, objects, building: b, isRoom: true,
    // the chair at the owner's desk (where they sit while working)
    deskChair: isHall ? { x: 13, y: 5 } : isStore ? null : { x: mx(13, 1), y: 5 },
    // the General Store's workbench seats (people making things sit here), and where its counter is
    workbenches: isStore ? [[2, 5], [5, 5], [11, 5], [14, 5]] : null,
    counter: isStore ? { x0: 11, x1: 14, y: 7 } : null,
    catalog: isStore ? { x: 8, y: 1 } : null,
    // walls are thin, so they are checked in pixels rather than whole tiles
    bounds: { left: WALL_SIDE + 1, right: W - WALL_SIDE - 1, top: WALL_TOP + 2, bottom: H - WALL_BOTTOM - 1, doorX0, doorX1 },
    solidAt: (x, y) => x < 0 || y < 0 || x >= RW || y >= RH || solid[y][x],
    doorAt: () => null,
    exitAt: (px, py) => py >= H - 3 && px > doorX0 && px < doorX1,
    spawn: { x: doorX0 + 8, y: H - WALL_BOTTOM - 14, dir: 'up' },
  };
}
