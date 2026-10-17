/**
 * What the player carries: a loadout of one primary (slot 1), one
 * secondary (slot 2) and a knife (slot 3), each with an optional finish.
 * The weapon in hand sets the player's max speed (the "max player
 * speed"), and its fire rate gates attacks. Weapon data (names, stats,
 * models, finishes) comes from the asset pack's manifest.json; without it the
 * player still has a knife that runs at 250.
 *
 * Scoped weapons zoom with the secondary attack through their zoom levels
 * and back out, and use their scoped stats while zoomed (snipers are only
 * accurate scoped, and walk slower). Bolt-action snipers come out of the
 * scope for each shot and go back in once the bolt is worked.
 *
 * Guns carry a clip and reserve ammo. R reloads, and an empty gun reloads
 * by itself. Most guns swap the magazine and can fire again after their
 * reload time; shotguns load a shell at a time and can fire between shells.
 */
const FALLBACK_WEAPONS = {
  knife: { name: 'Knife', slot: 'knife', stats: { maxSpeed: 250, cycleTime: 0.4, cycleTime2: 1.0, fullAuto: true }, finishes: [] },
};
const SLOTS = ['primary', 'secondary', 'knife'];
const DEPLOY_TIME = 0.5;
const DEFAULT_FOV = 90;
const ZOOM_DELAY = 0.3;   // seconds between zoom clicks
// Wall penetration power by weapon type, for asset packs made before guns carried their own.
const PENETRATION_BY_TYPE = { pistol: 1, smg: 1, heavy: 1, rifle: 2 };
const scopedStats = new WeakMap();   // weapon stats -> the same stats as scoped, made once

/**
 * A reload clip played for `shells` shells: the clip's shell part ([start, end]
 * seconds, `loop`) repeats once per shell. Maps time into the reload to time in the clip.
 */
export function reloadClipTime(time, loop, shells) {
  if (!loop || time < loop[0]) return time;
  const length = loop[1] - loop[0];
  const looped = time - loop[0];
  return looped < shells * length ? loop[0] + (looped % length) : time - (shells - 1) * length;
}

/** The reload's sounds ({ time, files, volume }) in order for `shells` shells, the shell part's sounds once per shell. */
export function reloadSounds(reload, shells) {
  const loop = reload?.loop;
  if (!loop) return reload?.sounds ?? [];
  const length = loop[1] - loop[0];
  return reload.sounds.flatMap((sound) => {
    if (sound.time < loop[0]) return [sound];
    if (sound.time >= loop[1]) return [{ ...sound, time: sound.time + (shells - 1) * length }];
    return Array.from({ length: shells }, (_, shell) => ({ ...sound, time: sound.time + shell * length }));
  });
}

/** Seconds a reload of `shells` shells keeps a gun from firing (a magazine counts as one). */
export function reloadDuration(weapon, shells) {
  const loop = weapon.stats.singleShells && weapon.reload?.loop;
  return loop ? loop[1] + (shells - 1) * (loop[1] - loop[0]) : weapon.stats.reloadTime;
}

/** Whether a shot leaves a tracer: one every `tracerFrequency` rounds, counted by the clip. */
export function showsTracer(stats, clipLeft) {
  return stats.tracerFrequency > 0 && clipLeft % stats.tracerFrequency === 0;
}

export class Inventory {
  constructor() {
    this.catalog = FALLBACK_WEAPONS;
    this.loadout = { primary: null, secondary: null, knife: { id: 'knife', finish: null, wear: 0, seed: 0 } };
    this.current = 'knife';
    this.previous = null;
    this.nextAttack = 0;
    this.attackHeld = false;
    this.zoomLevel = 0;
    this.nextZoom = 0;
    this.rezoom = null;   // { level, at } after a bolt-action shot
    this.ammo = new Map();    // weapon id -> { clip, reserve }
    this.reloading = null;    // { until } or, for shotguns, { nextShell, every }
    this.events = [];
  }

  /** Clip and reserve of a gun, full until first used; null for knives. */
  ammoOf(id) {
    const stats = this.catalog[id]?.stats;
    if (!stats?.clip) return null;
    if (!this.ammo.has(id)) this.ammo.set(id, { clip: stats.clip, reserve: stats.reserve });
    return this.ammo.get(id);
  }

  /** The held gun's ammo, or null. */
  get magazine() {
    return this.ammoOf(this.current);
  }

  /** Full ammo for every gun (a new round or a respawn). */
  refill() {
    this.ammo.clear();
    this.reloading = null;
  }

  startReload(time) {
    const ammo = this.magazine;
    const { stats, reload } = this.weapon;
    if (!ammo || this.reloading || ammo.clip >= stats.clip || ammo.reserve <= 0) return;
    this.rezoom = null;
    this.setZoom(0);
    const shells = Math.min(stats.clip - ammo.clip, ammo.reserve);
    if (stats.singleShells && reload?.loop) {
      const every = reload.loop[1] - reload.loop[0];
      this.reloading = { nextShell: time + reload.loop[1], every };
      this.events.push({ type: 'reload', weapon: this.current, shells });
    } else {
      this.reloading = { until: time + reloadDuration(this.weapon, 1) };
      this.events.push({ type: 'reload', weapon: this.current, shells: 1 });
    }
  }

  /** Finishes a reload that is due: the magazine goes in, or the next shell. */
  updateReload(time) {
    const ammo = this.magazine;
    const { reloading } = this;
    if (!reloading || !ammo) return;
    const { stats } = this.weapon;
    if (reloading.until !== undefined) {
      if (time < reloading.until) return;
      const moved = Math.min(stats.clip - ammo.clip, ammo.reserve);
      ammo.clip += moved;
      ammo.reserve -= moved;
      this.reloading = null;
    } else if (time >= reloading.nextShell) {
      ammo.clip++;
      ammo.reserve--;
      reloading.nextShell += reloading.every;
      if (ammo.clip >= stats.clip || ammo.reserve <= 0) this.reloading = null;
    }
  }

  /** The zoom data of the weapon in hand, or null. */
  get zoom() {
    return this.weapon.stats.zoom ?? null;
  }

  /** The held weapon's stats, scoped ones while zoomed. */
  get stats() {
    const { stats } = this.weapon;
    if (!this.zoomLevel || !stats.zoom) return stats;
    if (!scopedStats.has(stats)) scopedStats.set(stats, { ...stats, ...stats.zoom.scoped });
    return scopedStats.get(stats);
  }

  /** Horizontal field of view (degrees, at 4:3) for the zoom level. */
  get fov() {
    return this.zoomLevel ? this.zoom.fov[this.zoomLevel - 1] : DEFAULT_FOV;
  }

  /** Looking through a full scope: the viewmodel hides and the scope shows. */
  get scoped() {
    return this.zoomLevel > 0 && Boolean(this.zoom?.hidesViewmodel);
  }

  setZoom(level) {
    if (level === this.zoomLevel) return;
    this.zoomLevel = level;
    this.events.push({ type: 'zoom', weapon: this.current, level });
  }

  /** Every weapon id the manifest lists, mapped to its data. */
  setCatalog(weapons) {
    for (const { slot, type, stats } of Object.values(weapons)) {
      if (slot !== 'knife' && stats) stats.penetration ??= PENETRATION_BY_TYPE[type] ?? 1;
    }
    this.catalog = { ...FALLBACK_WEAPONS, ...weapons };
  }

  /** `loadout` maps each slot to { id, finish, wear, seed } (or null for an empty slot). */
  setLoadout(loadout, time) {
    this.loadout = Object.fromEntries(SLOTS.map((slot) => {
      const entry = loadout[slot];
      return [slot, entry && this.catalog[entry.id]?.slot === slot ? entry : null];
    }));
    this.loadout.knife ??= { id: 'knife', finish: null, wear: 0, seed: 0 };
    if (!this.carried.includes(this.current)) this.select(this.loadout.knife.id, time, true);
    else this.events.push({ type: 'deploy', weapon: this.current });
  }

  get carried() {
    return SLOTS.map((slot) => this.loadout[slot]?.id).filter(Boolean);
  }

  get weapon() {
    return this.catalog[this.current];
  }

  /** The loadout entry (finish, wear, seed) of the weapon in hand. */
  get entry() {
    return this.loadout[this.weapon.slot];
  }

  select(id, time, force = false) {
    if (!this.catalog[id] || (id === this.current && !force)) return;
    if (id !== this.current) this.previous = this.current;
    this.zoomLevel = 0;
    this.rezoom = null;
    this.reloading = null;
    this.current = id;
    this.nextAttack = time + DEPLOY_TIME;
    this.events.push({ type: 'deploy', weapon: id });
  }

  /** Applies one tick of weapon input: slot keys, Q (last weapon), F (inspect), R (reload), mouse buttons. */
  update(cmd, time) {
    if (cmd.slot) {
      const entry = this.loadout[SLOTS[cmd.slot - 1]];
      if (entry) this.select(entry.id, time);
    }
    if (cmd.lastWeapon && this.previous && this.carried.includes(this.previous)) this.select(this.previous, time);
    if (cmd.inspect) this.events.push({ type: 'inspect', weapon: this.current });

    const { stats, slot } = this.weapon;
    const ammo = this.magazine;
    this.updateReload(time);
    if (cmd.reload || (ammo && ammo.clip === 0 && time >= this.nextAttack)) this.startReload(time);
    if (this.rezoom && time >= this.rezoom.at) {
      this.setZoom(this.rezoom.level);
      this.rezoom = null;
    }
    // A shotgun's reload stops for a shot once it has a shell in.
    if (cmd.attack && this.reloading?.nextShell && ammo.clip > 0) {
      this.reloading = null;
      this.attackHeld = false;
    }
    const canRefire = stats.fullAuto || !this.attackHeld;
    const loaded = !ammo || (ammo.clip > 0 && !this.reloading);
    if (cmd.attack && canRefire && loaded && time >= this.nextAttack) {
      this.nextAttack = time + stats.cycleTime;
      if (ammo) ammo.clip--;
      // As fired: scoped or not, and whether it shows a tracer.
      this.events.push({ type: 'attack', weapon: this.current, stats: this.stats, tracer: Boolean(ammo && showsTracer(stats, ammo.clip)) });
      if (this.zoomLevel && this.zoom.unzoomsAfterShot) {
        this.rezoom = { level: this.zoomLevel, at: this.nextAttack };
        this.setZoom(0);
      }
    } else if (cmd.attack2 && this.zoom && !this.attack2Held && time >= this.nextZoom && !this.rezoom && !this.reloading) {
      this.nextZoom = time + ZOOM_DELAY;
      this.setZoom((this.zoomLevel + 1) % (this.zoom.fov.length + 1));
    } else if (cmd.attack2 && slot === 'knife' && time >= this.nextAttack) {
      this.nextAttack = time + stats.cycleTime2;
      this.events.push({ type: 'attack2', weapon: this.current });
    }
    this.attackHeld = cmd.attack;
    this.attack2Held = cmd.attack2;
  }

  takeEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }
}
