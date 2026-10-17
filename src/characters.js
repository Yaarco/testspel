/**
 * Third-person agents: the bot in the 1v1 arena and the character on the
 * main menu. An agent's body is posed by the pack's third-person animations
 * (idle, run and crouch in eight or four directions, in air) picked from its
 * velocity, and holds its weapon the way the first-person arms grip it.
 *
 * Models are glTF (Y up, meters, facing +Z); the game world's is
 * (Z up, inches, X forward), so each model is converted when drawn.
 */
import { STUDIO_LIGHTING } from './modelLighting.js';
import { MuzzleFlash } from './muzzleFlash.js';
import { transformPoint } from './viewmodel.js';
import { clipTracks, invertRigid, multiply, poseNodes } from './skeleton.js';

const METERS_TO_INCHES = 39.37;
const BODY_MESHES = ['thirdperson_body', 'thirdperson_default_gloves'];
const RUN_DIRECTIONS = ['run_n', 'run_ne', 'run_e', 'run_se', 'run_s', 'run_sw', 'run_w', 'run_nw'];
const CROUCH_DIRECTIONS = ['crouch_n', 'crouch_e', 'crouch_s', 'crouch_w'];
const RUN_SPEED = 250;          // the speed the run clips are animated for
const STILL_SPEED = 20;

/** glTF (x, y, z) to game space (z, x, y), scaled to inches, turned by yaw (degrees) and placed at `pos`. */
export function modelMatrix(pos, yaw) {
  const r = yaw * Math.PI / 180;
  const [c, s, k] = [Math.cos(r), Math.sin(r), METERS_TO_INCHES];
  // Columns: where glTF x (left), y (up) and z (forward) end up.
  return [
    -s * k, c * k, 0, 0,
    0, 0, k, 0,
    c * k, s * k, 0, 0,
    pos.x, pos.y, pos.z, 1,
  ];
}

/** The rotation of a model matrix (see modelMatrix), for turning model normals into world directions. */
function normalToWorld(model) {
  const k = 1 / METERS_TO_INCHES;
  return new Float32Array([model[0], model[1], model[2], model[4], model[5], model[6], model[8], model[9], model[10]].map((v) => v * k));
}

/** A point of a posed model (glTF space, meters) in the world. */
export function worldPoint(model, local) {
  return {
    x: model[0] * local[12] + model[4] * local[13] + model[8] * local[14] + model[12],
    y: model[1] * local[12] + model[5] * local[13] + model[9] * local[14] + model[13],
    z: model[2] * local[12] + model[6] * local[13] + model[10] * local[14] + model[14],
  };
}

export class Characters {
  constructor(gl, viewmodels, models = viewmodels.models) {
    this.gl = gl;
    this.models = models;
    this.viewmodels = viewmodels;
    this.manifest = null;
    this.agents = new Map();    // agent id -> Promise of model
    this.clips = new Map();     // clip path -> Promise of clip
    this.weapons = new Map();   // weapon id -> Promise of a held weapon the player does not carry
    this.grips = new WeakMap(); // weapon model -> node matrices relative to the hand
    this.muzzleFlash = new MuzzleFlash(gl);
  }

  setManifest(manifest) {
    this.manifest = manifest;
  }

  agent(id) {
    const data = this.manifest?.agents[id];
    if (!data) return Promise.resolve(null);
    if (!this.agents.has(id)) {
      this.agents.set(id, this.models.load(data.body, BODY_MESHES).then(async (model) => {
        await this.models.loadTextures(model);
        model.head = model.nodes.findIndex((node) => node.name === 'head_0');
        model.hand = model.nodes.findIndex((node) => node.name === 'hand_R');
        return model;
      }));
    }
    return this.agents.get(id);
  }

  /** A body clip without its root motion: the game moves the character, not the clip. */
  clip(path) {
    if (!path) return Promise.resolve(null);
    if (!this.clips.has(path)) {
      this.clips.set(path, this.models.fetchGlb(path).then((glb) => {
        const clip = clipTracks(glb);
        const root = clip.tracks.get('root_motion');
        if (root) delete root.translation;
        return clip;
      }).catch(() => null));
    }
    return this.clips.get(path);
  }

  /** Every body clip of a weapon category (rifle, pistol, knife), by name. */
  async bodyClips(category) {
    const paths = this.manifest?.bodyClips[category] ?? {};
    const entries = await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await this.clip(path)]));
    return Object.fromEntries(entries.filter(([, clip]) => clip));
  }

  /**
   * A weapon as a character holds it: the first-person model (with its
   * finish, when it is one the player carries) posed relative to the right
   * hand the way the first-person idle grips it.
   */
  async weapon(id) {
    const carried = this.viewmodels.loaded.get(id);
    if (carried) return this.held(carried.model, carried.clips.idle?.[0], carried.painted, carried.variant);
    if (!this.weapons.has(id)) {
      this.weapons.set(id, (async () => {
        const data = this.manifest.weapons[id];
        const idle = data?.clips.idle?.[0];
        if (!data || !idle) return null;
        const [model, clip] = await Promise.all([this.models.load(data.model), this.models.fetchGlb(idle).then(clipTracks)]);
        await this.models.loadTextures(model, 'hd');
        return this.held(model, clip, new Map(), 'hd');
      })().catch(() => null));
    }
    return this.weapons.get(id);
  }

  /** The weapon's node matrices relative to the hand, from the first-person idle pose. */
  held(model, idle, painted, variant) {
    const arms = this.viewmodels.arms;
    if (!arms || !idle) return null;
    let relative = this.grips.get(model);
    if (!relative) {
      const posed = poseNodes(arms.nodes, idle, 0);
      const wpn = posed[arms.nodes.findIndex((node) => node.name === 'wpn')];
      const hand = posed[arms.nodes.findIndex((node) => node.name === 'hand_R')];
      relative = this.viewmodels.attach(model, idle, 0, wpn).map((matrix) => multiply(invertRigid(hand), matrix));
      this.grips.set(model, relative);
    }
    return { model, relative, painted, variant };
  }

  /** The clip and its time for a character's movement: { pos, yaw, vel, ducked, onGround, animTime }. */
  pick(clips, character) {
    const { vel, yaw, ducked, onGround } = character;
    const speed = Math.hypot(vel.x, vel.y);
    if (!onGround) return clips.inair_stand ?? clips.idle;
    const r = yaw * Math.PI / 180;
    const forward = vel.x * Math.cos(r) + vel.y * Math.sin(r);
    const right = vel.x * Math.sin(r) - vel.y * Math.cos(r);
    const angle = Math.atan2(right, forward);
    if (ducked) {
      if (speed < STILL_SPEED) return clips.idle_crouch ?? clips.idle;
      return clips[CROUCH_DIRECTIONS[(Math.round(angle / (Math.PI / 2)) + 4) % 4]] ?? clips.idle_crouch;
    }
    if (speed < STILL_SPEED) return clips.idle;
    return clips[RUN_DIRECTIONS[(Math.round(angle / (Math.PI / 4)) + 8) % 8]] ?? clips.idle;
  }

  /**
   * Poses a character: { model, matrix, world, weaponWorld } where world is
   * per node of the agent and weaponWorld per node of the weapon.
   */
  pose(body, weapon, clip, time, pos, yaw) {
    const matrix = modelMatrix(pos, yaw);
    const world = poseNodes(body.nodes, clip, clip?.duration > 0 ? time % clip.duration : 0);
    return { matrix, world, weaponWorld: this.holdWeapon(body, weapon, world) };
  }

  /** The held weapon's node matrices for a body posed as `world`, or null. */
  holdWeapon(body, weapon, world) {
    return weapon && body.hand >= 0 ? weapon.relative.map((relative) => multiply(world[body.hand], relative)) : null;
  }

  /**
   * Draws posed characters ({ body, weapon, pose, flash, lighting }) with the
   * world camera's view-projection; `scale` is its projection's x and y
   * scale, for muzzle flashes ({ age, seed }).
   */
  draw(viewProjection, characters, scale = [1, 1]) {
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    for (const { body, weapon, pose, flash, lighting = STUDIO_LIGHTING } of characters) {
      this.models.begin(viewProjection, pose.matrix, normalToWorld(pose.matrix), lighting);
      this.models.draw(body, pose.world);
      if (weapon && pose.weaponWorld) this.models.draw(weapon.model, pose.weaponWorld, weapon.variant, weapon.painted);
      const muzzle = flash && weapon && pose.weaponWorld && this.models.muzzle(weapon.model);
      if (muzzle) {
        const center = transformPoint(pose.weaponWorld[muzzle.node], muzzle.local);
        this.muzzleFlash.draw(viewProjection, pose.matrix, center, 6, scale, flash.age, flash.seed);
        gl.enable(gl.DEPTH_TEST);
      }
    }
  }
}
