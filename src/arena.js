/**
 * A small symmetric aim arena for 1v1 against the bot: a walled floor with
 * crates and a center wall for cover, floating in space. It is a world like
 * Course and BspWorld (see course.js), with two spawn points facing each
 * other across the middle.
 */
import { SolidGrid } from './collision.js';
import { createOrientedBox } from './solids.js';
import { VIEW } from './config.js';

const HALF_LENGTH = 960;    // along x
const HALF_WIDTH = 768;     // along y
const WALL_HEIGHT = 320;
const WALL = 32;
const COLORS = {
  floor: [0.46, 0.47, 0.5],
  wall: [0.72, 0.66, 0.56],
  crate: [0.55, 0.38, 0.22],
  block: [0.38, 0.45, 0.52],
};

/** Cover on one half of the arena (x > 0); the other half mirrors it through the center. */
const COVER = [
  // [x, y, half length, half width, height, color]
  [480, 220, 32, 32, 128, 'crate'],
  [544, 156, 32, 32, 64, 'crate'],
  [300, -380, 96, 32, 112, 'block'],
  [680, -140, 32, 96, 72, 'block'],
  [260, 440, 40, 40, 80, 'crate'],
  [760, 480, 32, 32, 64, 'crate'],
];
// The center: a wall with room to peek around each end, and crates beside it.
const CENTER = [
  [0, 0, 16, 160, 136, 'block'],
  [0, 360, 32, 32, 64, 'crate'],
  [0, -360, 32, 32, 64, 'crate'],
];

/** An axis-aligned box standing on the floor (or, for the floor, reaching down from z = 0). */
function box(x, y, halfLength, halfWidth, height, color, index) {
  const top = height > 0 ? height : 0;
  const depth = height > 0 ? height : 32;
  return createOrientedBox(
    { top: { x, y, z: top }, heading: 0, halfLength, halfWidth, depth },
    { index, color: COLORS[color], kind: color },
  );
}

export class Arena {
  constructor() {
    this.name = '1v1 Arena';
    this.kind = 'arena';
    this.version = 0;
    this.viewDistance = VIEW.viewDistance;
    this.highlightIndex = -1;
    this.score = null;

    const solids = [];
    const add = (...args) => solids.push(box(...args, solids.length));
    add(0, 0, HALF_LENGTH + WALL, HALF_WIDTH + WALL, 0, 'floor');
    add(HALF_LENGTH + WALL / 2, 0, WALL / 2, HALF_WIDTH + WALL, WALL_HEIGHT, 'wall');
    add(-HALF_LENGTH - WALL / 2, 0, WALL / 2, HALF_WIDTH + WALL, WALL_HEIGHT, 'wall');
    add(0, HALF_WIDTH + WALL / 2, HALF_LENGTH, WALL / 2, WALL_HEIGHT, 'wall');
    add(0, -HALF_WIDTH - WALL / 2, HALF_LENGTH, WALL / 2, WALL_HEIGHT, 'wall');
    for (const [x, y, l, w, h, color] of CENTER) add(x, y, l, w, h, color);
    for (const [x, y, l, w, h, color] of COVER) {
      add(x, y, l, w, h, color);
      add(-x, -y, l, w, h, color);
    }
    this.solids = solids;
    this.halfLength = HALF_LENGTH;
    this.halfWidth = HALF_WIDTH;
    this.collision = new SolidGrid(solids);
    this.faces = solids.flatMap((solid) => solid.faces.map((vertices, f) => ({ vertices, normal: solid.faceNormals[f], color: solid.color })));
    this.spawns = {
      player: { feet: { x: -HALF_LENGTH + 160, y: 0, z: 0 }, yaw: 0 },
      bot: { feet: { x: HALF_LENGTH - 160, y: 0, z: 0 }, yaw: 180 },
    };
  }

  respawnPoint() {
    return this.spawns.player;
  }

  /** Falling out (only possible by noclip-like accidents) respawns. */
  afterMove(player) {
    return player.pos.z < -512 ? { respawn: true } : null;
  }

  surfaceAt() {
    return 'concrete_ct';
  }
}
