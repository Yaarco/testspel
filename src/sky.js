/**
 * The backdrop at infinity: stars, distant galaxies and the occasional comet.
 * Everything here is a direction, so only camera rotation moves it.
 * This module only creates the data; the renderer draws it.
 */
import { createRng, randomSeed } from './random.js';
import { cross, normalize, scale, add } from './vector.js';

const STAR_COUNT = 4000;
const GALAXY_COUNT = 7;
const GALAXY_TEXTURE_SIZE = 256;
const COMET_INTERVAL = { min: 3, max: 10 };   // seconds between comets
const COMET_TAIL_SECONDS = 0.7;
const COMET_TAIL_POINTS = 40;

const STAR_TINTS = [[1, 1, 1], [0.78, 0.86, 1], [1, 0.9, 0.78], [0.67, 0.78, 1]];

function createStars(rng) {
  return Array.from({ length: STAR_COUNT }, () => {
    const brightness = rng.next() ** 3;
    return {
      dir: rng.unitVector(),
      size: 1.5 + 2.5 * brightness,
      color: [...rng.pick(STAR_TINTS), 0.3 + 0.7 * brightness],
    };
  });
}

/** Paints one spiral galaxy into a square region of the atlas. */
function paintGalaxy(g, rng, offsetX) {
  const size = GALAXY_TEXTURE_SIZE;
  const radius = size * 0.45;
  const cx = offsetX + size / 2;
  const cy = size / 2;

  const hue = rng.range(180, 330);
  const arms = rng.pick([2, 3, 4]);
  const twist = rng.range(3, 6);
  const tilt = rng.range(0.3, 1);

  const core = g.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.35);
  core.addColorStop(0, 'rgb(255 240 220 / 0.9)');
  core.addColorStop(1, 'rgb(255 240 220 / 0)');
  g.fillStyle = core;
  g.fillRect(offsetX, 0, size, size);

  for (let i = 0; i < 3000; i++) {
    const t = rng.next();
    const angle = (i % arms) * (2 * Math.PI / arms) + t * twist + rng.range(-0.4, 0.4) * (1 - t * 0.5);
    const r = t * radius;
    g.fillStyle = `hsl(${hue + t * 60} 80% ${60 + rng.range(0, 30)}% / ${(1 - t) * 0.5})`;
    g.fillRect(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r * tilt, 1.5, 1.5);
  }
}

/** All galaxies share one texture atlas: one tile per galaxy, side by side. */
function createGalaxies(rng) {
  const atlas = document.createElement('canvas');
  atlas.width = GALAXY_TEXTURE_SIZE * GALAXY_COUNT;
  atlas.height = GALAXY_TEXTURE_SIZE;
  const g = atlas.getContext('2d');
  g.globalCompositeOperation = 'lighter';

  const galaxies = Array.from({ length: GALAXY_COUNT }, (_, i) => {
    paintGalaxy(g, rng, i * GALAXY_TEXTURE_SIZE);
    return {
      dir: rng.unitVector(),
      angularSize: rng.range(0.06, 0.22),
      roll: rng.range(0, Math.PI),
      uv: { left: i / GALAXY_COUNT, right: (i + 1) / GALAXY_COUNT },
    };
  });
  return { atlas, galaxies };
}

/** A comet travels along a great circle of the sky. */
function createComet(rng) {
  const start = rng.unitVector();
  return {
    start,
    across: normalize(cross(start, rng.unitVector())),
    angularSpeed: rng.range(0.15, 0.4),
    age: 0,
    life: rng.range(3, 7),
  };
}

function cometDirection(comet, age) {
  const angle = comet.angularSpeed * age;
  return add(scale(comet.start, Math.cos(angle)), scale(comet.across, Math.sin(angle)));
}

export class Sky {
  constructor() {
    this.rng = createRng(randomSeed());
    this.stars = createStars(this.rng);
    ({ atlas: this.galaxyAtlas, galaxies: this.galaxies } = createGalaxies(this.rng));
    this.comets = [];
    this.nextCometIn = this.rng.range(1, COMET_INTERVAL.max);
  }

  update(dt) {
    this.nextCometIn -= dt;
    if (this.nextCometIn <= 0) {
      this.comets.push(createComet(this.rng));
      this.nextCometIn = this.rng.range(COMET_INTERVAL.min, COMET_INTERVAL.max);
    }
    for (const comet of this.comets) comet.age += dt;
    this.comets = this.comets.filter((comet) => comet.age < comet.life);
  }

  /** Comet heads and tails as points that shrink and fade toward the tail tip. */
  cometPoints() {
    const points = [];
    for (const comet of this.comets) {
      const fade = Math.sin(Math.PI * comet.age / comet.life);
      for (let i = 0; i < COMET_TAIL_POINTS; i++) {
        const along = i / (COMET_TAIL_POINTS - 1);   // 0 at the head, 1 at the tip
        points.push({
          dir: cometDirection(comet, comet.age - along * COMET_TAIL_SECONDS),
          size: i === 0 ? 9 : 5 * (1 - along) + 1,
          color: [0.75, 0.9, 1, fade * (1 - along) * (i === 0 ? 1 : 0.6)],
        });
      }
    }
    return points;
  }
}
