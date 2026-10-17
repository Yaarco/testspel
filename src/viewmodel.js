/**
 * First-person weapons from the asset pack: the arms
 * skeleton with the weapon's "weapon" bone placed on the arms' "wpn" bone,
 * animated by the pack's viewmodel clips (draw, idle, attacks, inspect,
 * reload), drawn over the world with a viewmodel field of view of 68, plus
 * view bob and the tilt of recoil.
 *
 * The arms are dressed the usual way: the equipped agent's sleeves and the
 * equipped gloves (or the agent's own gloves) follow the arms skeleton bone
 * by bone; with neither, the default bare arms with fingerless gloves show.
 *
 * Weapons load when they enter the loadout and are freed when they leave it.
 * A weapon with a finish shows the mesh the finish was made for (older
 * finishes are painted on the older mesh's UVs) with a painted texture.
 *
 * The exports are glTF: Y up, meters, the view looking down +Z with the
 * right hand toward -X.
 */
import { FinishPainter } from './finishes.js';
import { MuzzleFlash } from './muzzleFlash.js';
import { SkinnedModels } from './skinnedModels.js';
import { clipTracks, findTwistBones, followPose, invertRigid, multiply, poseNodes } from './skeleton.js';
import { reloadClipTime } from './weapons.js';

const HALF_FOV_TAN = Math.tan((68 / 2) * Math.PI / 180) * 0.75;   // viewmodel fov 68, horizontal at 4:3
const NEAR = 0.01;
const FAR = 10;
const INCHES_TO_METERS = 0.0254;
const ATTACH_BONE = 'wpn';      // arms bone that carries the weapon
const WEAPON_BONE = 'weapon';   // weapon bone that goes there
const SLEEVES = ['firstperson_sleeves'];
const AGENT_GLOVES = ['firstperson_default_gloves_arms'];
const GLOVE_MESHES = ['viewmodel'];
const FLASH_SIZE = 0.07;          // meters, half the flash's width
const SILENCED = new Set(['usp_silencer', 'm4a1_silencer', 'mp5sd']);   // smaller flashes

/** A point through a 4x4 column-major matrix. */
export function transformPoint(m, [x, y, z]) {
  return [0, 1, 2].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
}

function perspective(aspect) {
  const f = 1 / HALF_FOV_TAN;
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (FAR + NEAR) / (NEAR - FAR), -1, 0, 0, (2 * FAR * NEAR) / (NEAR - FAR), 0]);
}

/**
 * Viewmodel space (x left, y up, z forward) offset by `t` (meters), into GL
 * eye space, turned about the eye by `tilt` (degrees; positive pitch down, positive yaw left).
 */
function modelView([tx, ty, tz], tilt) {
  const place = new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, -tx, ty, -tz, 1]);
  const pitch = -tilt.pitch * Math.PI / 180;
  const yaw = tilt.yaw * Math.PI / 180;
  const [sp, cp, sy, cy] = [Math.sin(pitch), Math.cos(pitch), Math.sin(yaw), Math.cos(yaw)];
  // Yaw about eye y after pitch about eye x, column-major.
  const turn = new Float32Array([cy, 0, -sy, 0, sy * sp, cp, cy * sp, 0, sy * cp, -sp, cy * cp, 0, 0, 0, 0, 1]);
  return new Float32Array(multiply(turn, place));
}

export class Viewmodels {
  constructor(gl, models = new SkinnedModels(gl)) {
    this.gl = gl;
    this.models = models;
    this.painter = new FinishPainter(gl);
    this.manifest = null;
    this.arms = null;
    this.weapons = new Map();     // id -> Promise of { model, clips, painted, variant } while in the loadout
    this.loaded = new Map();      // id -> the same, once ready to draw
    this.state = null;            // { id, clip, start, loop }
    this.dress = { key: '', parts: [] };   // sleeves and gloves drawn on the arms' pose
    this.muzzleFlash = new MuzzleFlash(gl);
    this.flashAt = -Infinity;
    this.flashSeed = 0;
    this.muzzleTangent = null;    // where the muzzle shows on screen, for tracers (see draw)
  }

  /** A shot: the muzzle flashes. */
  flash(time) {
    this.flashAt = time;
    this.flashSeed = Math.random();
  }

  /** Loads the default arms; weapons and dress load on demand, from the asset pack. */
  async load(pack, manifest) {
    this.models.pack = pack;
    this.painter.pack = pack;
    this.manifest = manifest;
    this.arms = await this.models.load(manifest.arms);
    await this.models.loadTextures(this.arms);
    this.arms.twists = findTwistBones(this.arms.nodes);
  }

  /**
   * Dresses the arms for an agent ({ id } or null) and gloves
   * ({ id, finish, wear, seed } or null): the agent's sleeves,
   * and the gloves (or else the agent's own gloves).
   */
  async setDress(agentEntry, glovesEntry) {
    if (!this.manifest) return;
    const agent = agentEntry && this.manifest.agents[agentEntry.id];
    const glove = glovesEntry && this.manifest.gloves[glovesEntry.id];
    const finish = glove && this.manifest.gloveFinishes[glovesEntry.finish];
    const key = JSON.stringify([agent?.arms, glove?.model, glovesEntry?.finish, glovesEntry?.wear, glovesEntry?.seed]);
    if (key === this.dress.key) return;
    this.dress.key = key;

    const wanted = [];
    if (agent) wanted.push({ path: agent.arms, meshes: finish ? SLEEVES : [...SLEEVES, ...AGENT_GLOVES] });
    if (finish) wanted.push({ path: glove.model, meshes: GLOVE_MESHES, finish, options: glovesEntry });
    const parts = await Promise.all(wanted.map(async ({ path, meshes, finish: gloveFinish, options }) => {
      const model = await this.models.load(path, meshes);
      await this.models.loadTextures(model);
      const painted = new Map();
      if (gloveFinish) {
        for (const material of this.models.materials(model).filter((name) => !name.startsWith('bare_arm'))) {
          const base = await this.models.baseTexture(model, material);
          if (base) painted.set(material, await this.painter.paintGlove(base, gloveFinish, options));
        }
        await this.models.loadTextures(model, null, painted);
      }
      return { model, painted };
    }));
    if (this.dress.key !== key) {   // dressed differently while this loaded
      parts.forEach(({ model, painted }) => this.models.dispose(model, painted));
      return;
    }
    this.dress.parts.forEach(({ model, painted }) => this.models.dispose(model, painted));
    this.dress.parts = parts;
  }

  /**
   * Makes the weapons of a loadout ready, each with its finish
   * ({ id, finish, wear, seed } per slot), and frees weapons no longer carried.
   */
  async setLoadout(entries) {
    if (!this.manifest) return;
    const ids = new Set(entries.map((entry) => entry.id));
    for (const [id, pending] of this.weapons) {
      if (ids.has(id)) continue;
      this.weapons.delete(id);
      this.loaded.delete(id);
      pending.then((weapon) => this.models.dispose(weapon.model, weapon.painted)).catch(() => {});
    }
    await Promise.all(entries.map((entry) => this.equip(entry).catch((error) => console.warn(`Weapon ${entry.id}:`, error))));
  }

  prepare(id) {
    if (!this.weapons.has(id)) {
      const data = this.manifest.weapons[id];
      const pending = (async () => {
        const clips = {};
        for (const [name, files] of Object.entries(data.clips)) {
          clips[name] = await Promise.all(files.map(async (file) => clipTracks(await this.models.fetchGlb(file))));
        }
        return { model: await this.models.load(data.model), clips, painted: new Map(), variant: null };
      })();
      this.weapons.set(id, pending);
    }
    return this.weapons.get(id);
  }

  /** Loads a weapon if needed and paints its finish (or restores its own look when there is none). */
  async equip({ id, finish: finishId, wear = 0, seed = 0 }) {
    const data = this.manifest?.weapons[id];
    if (!data) return;
    const weapon = await this.prepare(id);
    const finish = finishId ? this.manifest.finishes[finishId] : null;
    const key = finish ? `${finishId}/${wear}/${seed}` : '';
    if (weapon.key === key) return;
    weapon.key = key;

    const variant = finish?.legacy && data.paint.legacy.length ? 'legacy' : 'hd';
    await this.models.loadTextures(weapon.model, variant);
    const painted = new Map();
    if (finish) {
      const shared = { wear: this.manifest.wear, grunge: this.manifest.grunge };
      for (const composite of data.paint[variant]) {
        const base = await this.models.baseTexture(weapon.model, composite.material);
        if (base) painted.set(composite.material, await this.painter.paint(base, composite, finish, { wear, seed, knife: data.slot === 'knife' }, shared));
      }
    }
    if (weapon.key !== key) {   // a newer finish was chosen while this one painted
      painted.forEach(({ texture }) => this.gl.deleteTexture(texture));
      return;
    }
    weapon.painted.forEach(({ texture }) => this.gl.deleteTexture(texture));
    weapon.painted = painted;
    weapon.variant = variant;
    await this.models.loadTextures(weapon.model, variant, painted);   // drops textures no longer drawn
    if (this.weapons.has(id)) this.loaded.set(id, weapon);   // ready to draw
  }

  /**
   * Starts a clip ('draw', 'idle', 'attack', 'inspect', 'reload', ...); one-shot
   * clips return to idle. A reload of several shells repeats the clip's shell part.
   */
  play(id, name, time, shells = 1) {
    const choices = this.loaded.get(id)?.clips[name];
    if (!choices?.length) return;
    const clip = choices[Math.floor(Math.random() * choices.length)];
    const loop = name === 'reload' ? this.manifest.weapons[id].reload?.loop ?? null : null;
    const duration = loop ? clip.duration + (shells - 1) * (loop[1] - loop[0]) : clip.duration;
    this.state = { id, clip, start: time, idle: name === 'idle', loop, shells, duration };
  }

  currentClip(id, time) {
    const state = this.state;
    if (!state || state.id !== id) {
      this.play(id, 'idle', time);
      return this.state && { clip: this.state.clip, time: 0 };
    }
    if (!state.idle && time - state.start >= state.duration) this.play(id, 'idle', time);
    const { clip, start, loop, shells } = this.state;
    const elapsed = time - start;
    if (loop) return { clip, time: Math.min(reloadClipTime(elapsed, loop, shells), clip.duration) };
    return { clip, time: clip.duration > 0 ? elapsed % clip.duration : 0 };
  }

  /**
   * Poses the weapon so its "weapon" bone lands exactly on the arms' "wpn"
   * bone. Both skeletons carry the same axis conversion on that bone, so the
   * weapon's own pose of it is divided out rather than applied twice.
   */
  attach(model, clip, time, wpn) {
    const local = poseNodes(model.nodes, clip, time);
    const bone = local[model.nodes.findIndex((node) => node.name === WEAPON_BONE)];
    const under = multiply(wpn, invertRigid(bone));
    return local.map((matrix) => multiply(under, matrix));
  }

  /**
   * Draws the held weapon once loaded. `view` = { time, bobPhase, bobAmount,
   * tilt, normalToWorld, lighting }: normalToWorld turns viewmodel space into
   * world directions, for the lighting where the player stands (modelLighting.js).
   * Keeps where its muzzle shows as `muzzleTangent`: x right and y up, in
   * units of half the screen height at the viewmodel's field of view.
   */
  draw(id, view, aspect) {
    const weapon = this.loaded.get(id);
    if (!weapon || !this.arms) return;
    const { clip, time } = this.currentClip(id, view.time) ?? {};

    const arms = poseNodes(this.arms.nodes, clip, time, null, this.arms.twists);
    const weaponWorld = this.attach(weapon.model, clip, time, arms[this.arms.nodes.findIndex((node) => node.name === ATTACH_BONE)]);

    // View bob, in inches like the rest of the game, converted to meters.
    const bob = view.bobAmount;
    const offset = [
      Math.sin(view.bobPhase) * 0.4 * bob * INCHES_TO_METERS,
      (Math.sin(view.bobPhase * 2) * 0.25 - 0.6) * bob * INCHES_TO_METERS,
      0,
    ];

    const gl = this.gl;
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    const view3d = modelView(offset, view.tilt ?? { pitch: 0, yaw: 0 });
    this.models.begin(perspective(aspect), view3d, view.normalToWorld, view.lighting);
    if (this.dress.parts.length) {
      for (const { model, painted } of this.dress.parts) {
        this.models.draw(model, followPose(model.nodes, this.arms.nodes, arms), null, painted);
      }
    } else {
      this.models.draw(this.arms, arms);
    }
    this.models.draw(weapon.model, weaponWorld, weapon.variant, weapon.painted);
    const muzzle = this.models.muzzle(weapon.model);
    if (muzzle) {
      const center = transformPoint(weaponWorld[muzzle.node], muzzle.local);
      const size = FLASH_SIZE * (SILENCED.has(id) ? 0.4 : 1);
      const projection = perspective(aspect);
      this.muzzleFlash.draw(projection, view3d, center, size, [projection[0], projection[5]], view.time - this.flashAt, this.flashSeed);
      const [x, y, z] = transformPoint(view3d, center);
      this.muzzleTangent = [x / -z / HALF_FOV_TAN, y / -z / HALF_FOV_TAN];
    }
    gl.disable(gl.DEPTH_TEST);
  }
}
