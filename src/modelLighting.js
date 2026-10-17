/**
 * Dynamic lighting for models (the viewmodel and characters), the way the
 * engine lights them: an ambient light cube (one color per axis direction)
 * plus a few directional lights, sampled where the model stands.
 *
 * On a map the samples come from the map's own lighting: its leaf ambient
 * cubes and its sun, point and spot lights, each tested for occlusion
 * (bspScene.js). Elsewhere a sky-and-ground cube and a sun that walls and
 * cover can shade. A sample is retaken when the model has moved a little or
 * after a moment, and the shown lighting eases toward it so it never pops.
 * A gun's muzzle flash briefly lights its own model.
 *
 * Packed for the shader (SKINNED_SHADER): the cube as 6 linear colors
 * (+x, -x, +y, -y, +z, -z) and MAX_LIGHTS lights as world directions toward
 * the light and linear colors.
 */
import { traceLine } from './collision.js';
import { normalize } from './vector.js';

export const MAX_LIGHTS = 4;
const MAP_LIGHTS = MAX_LIGHTS - 1;      // the last slot is the muzzle flash
const RESAMPLE_DISTANCE = 24;
const RESAMPLE_TIME = 0.25;
const EASE = 8;                          // per second
export const SUN = normalize({ x: 0.35, y: 0.25, z: 0.9 });   // the arena's sun, which also lights the arena walls (renderer.js)
const SUN_COLOR = [0.85, 0.8, 0.72];
const OPEN_CUBE = [[0.09, 0.09, 0.1], [0.09, 0.09, 0.1], [0.09, 0.09, 0.1], [0.09, 0.09, 0.1], [0.16, 0.18, 0.22], [0.05, 0.045, 0.04]];
const FLASH_TIME = 0.06;
const FLASH_COLOR = [2.2, 1.3, 0.55];
const SUN_REACH = 4000;

/** Lighting for the main menu's character: a fixed studio key and fill. */
export const STUDIO_LIGHTING = pack({ cube: OPEN_CUBE.map((c) => c.map((v) => v * 1.4)), lights: [{ direction: [SUN.x, SUN.y, SUN.z], color: SUN_COLOR }] });

/** A sample ({ cube, lights }) packed into the shader's arrays. */
function pack({ cube, lights }) {
  const out = { cube: new Float32Array(18), directions: new Float32Array(MAX_LIGHTS * 3), colors: new Float32Array(MAX_LIGHTS * 3) };
  (cube ?? OPEN_CUBE).forEach((color, side) => out.cube.set(color, side * 3));
  const strongest = [...lights].sort((a, b) => Math.max(...b.color) - Math.max(...a.color)).slice(0, MAP_LIGHTS);
  strongest.forEach(({ direction, color }, i) => {
    out.directions.set(direction, i * 3);
    out.colors.set(color, i * 3);
  });
  return out;
}

/** The sky-and-sun sample for worlds without baked lighting: the sun only where nothing blocks it. */
function openLighting(world, point) {
  const from = { ...point, z: point.z + 40 };
  const to = { x: from.x + SUN.x * SUN_REACH, y: from.y + SUN.y * SUN_REACH, z: from.z + SUN.z * SUN_REACH };
  const lit = traceLine(from, to, world.collision).fraction >= 1;
  return { cube: OPEN_CUBE, lights: [{ direction: [SUN.x, SUN.y, SUN.z], color: SUN_COLOR.map((c) => (lit ? c : c * 0.15)) }] };
}

const ease = (shown, target, k) => {
  for (let i = 0; i < shown.length; i++) shown[i] += (target[i] - shown[i]) * k;
};

export class ModelLighting {
  constructor() {
    this.world = null;
    this.models = new Map();   // key -> { point, time, target, shown, at }
  }

  /**
   * The packed lighting for the model `key` standing at `point` (its feet)
   * at `time`; `flash` = { age, direction } adds its own muzzle flash.
   */
  at(world, key, point, time, flash = null) {
    if (world !== this.world) {
      this.world = world;
      this.models.clear();
    }
    let model = this.models.get(key);
    const moved = model && Math.hypot(point.x - model.point.x, point.y - model.point.y, point.z - model.point.z);
    if (!model || moved > RESAMPLE_DISTANCE || time - model.time > RESAMPLE_TIME) {
      const target = pack(world.scene?.lightingAt?.(point) ?? openLighting(world, point));
      if (!model || moved > RESAMPLE_DISTANCE * 20) {   // new, or teleported: no easing
        model = { shown: { cube: target.cube.slice(), directions: target.directions.slice(), colors: target.colors.slice() }, at: time };
        this.models.set(key, model);
      }
      Object.assign(model, { point: { ...point }, time, target });
    }
    const k = 1 - Math.exp(-EASE * Math.max(0, time - model.at));
    model.at = time;
    const { shown, target } = model;
    ease(shown.cube, target.cube, k);
    ease(shown.directions, target.directions, k);
    ease(shown.colors, target.colors, k);

    const slot = MAP_LIGHTS * 3;
    const strength = flash && flash.age >= 0 && flash.age < FLASH_TIME ? 1 - flash.age / FLASH_TIME : 0;
    shown.colors.set(FLASH_COLOR.map((c) => c * strength), slot);
    if (strength) shown.directions.set(flash.direction, slot);
    return shown;
  }
}
