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
 */
const FALLBACK_WEAPONS = {
  knife: { name: 'Knife', slot: 'knife', stats: { maxSpeed: 250, cycleTime: 0.4, cycleTime2: 1.0, fullAuto: true }, finishes: [] },
};
const SLOTS = ['primary', 'secondary', 'knife'];
const DEPLOY_TIME = 0.5;
const DEFAULT_FOV = 90;
const ZOOM_DELAY = 0.3;   // seconds between zoom clicks

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
    this.events = [];
  }

  /** The zoom data of the weapon in hand, or null. */
  get zoom() {
    return this.weapon.stats.zoom ?? null;
  }

  /** The held weapon's stats, scoped ones while zoomed. */
  get stats() {
    const { stats } = this.weapon;
    return this.zoomLevel && stats.zoom ? { ...stats, ...stats.zoom.scoped } : stats;
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
    this.current = id;
    this.nextAttack = time + DEPLOY_TIME;
    this.events.push({ type: 'deploy', weapon: id });
  }

  /** Applies one tick of weapon input: slot keys, Q (last weapon), F (inspect), mouse buttons. */
  update(cmd, time) {
    if (cmd.slot) {
      const entry = this.loadout[SLOTS[cmd.slot - 1]];
      if (entry) this.select(entry.id, time);
    }
    if (cmd.lastWeapon && this.previous && this.carried.includes(this.previous)) this.select(this.previous, time);
    if (cmd.inspect) this.events.push({ type: 'inspect', weapon: this.current });

    const { stats, slot } = this.weapon;
    if (this.rezoom && time >= this.rezoom.at) {
      this.setZoom(this.rezoom.level);
      this.rezoom = null;
    }
    const canRefire = stats.fullAuto || !this.attackHeld;
    if (cmd.attack && canRefire && time >= this.nextAttack) {
      this.nextAttack = time + stats.cycleTime;
      this.events.push({ type: 'attack', weapon: this.current, stats: this.stats });   // as fired: scoped or not
      if (this.zoomLevel && this.zoom.unzoomsAfterShot) {
        this.rezoom = { level: this.zoomLevel, at: this.nextAttack };
        this.setZoom(0);
      }
    } else if (cmd.attack2 && this.zoom && !this.attack2Held && time >= this.nextZoom && !this.rezoom) {
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
