/**
 * Game bootstrap and loop. Movement runs on a fixed tick like a game server;
 * rendering runs every animation frame and interpolates between ticks.
 * The world is the procedural Course, the 1v1 Arena or an imported
 * BspWorld; all expose the same interface (see course.js).
 */
import { Arena } from './arena.js';
import { installAssetPack, openAssetPack, removeAssetPack } from './assetPack.js';
import { SoundSystem } from './audio.js';
import { buildBspScene } from './bspScene.js';
import { BspWorld } from './bspWorld.js';
import { worldPoint } from './characters.js';
import { traceLine } from './collision.js';
import { bulletDirections, viewAxes } from './combat.js';
import { CONVARS, MOUSE } from './config.js';
import { Course } from './course.js';
import { Footsteps } from './footsteps.js';
import { parseBsp } from './formats/bsp.js';
import { openVpkSets } from './formats/vpk.js';
import { Hud } from './hud.js';
import { Input } from './input.js';
import { InventoryView } from './inventoryView.js';
import { Match } from './match.js';
import { Menu } from './menu.js';
import { invitedRoom, Netplay } from './netplay.js';
import { playerMove } from './movement.js';
import { Player } from './player.js';
import { randomSeed } from './random.js';
import { Recoil } from './recoil.js';
import { Renderer } from './renderer.js';
import { Sky } from './sky.js';
import { Versus } from './versus.js';
import { add, lerp, scale, sub } from './vector.js';
import { Inventory } from './weapons.js';

const TICK_INTERVAL = 1 / CONVARS.tickrate;
const MAX_FRAME_TIME = 0.25;
const BULLET_RANGE = 8192;
// Keys whose Ctrl shortcuts the browser keeps for itself: Ctrl+W closes the tab.
const BROWSER_RESERVED_KEYS = ['KeyW'];
const SLOT_LABELS = { primary: 'Primary', secondary: 'Secondary', knife: 'Knife', gloves: 'Gloves', agent: 'Agent' };
const DEFAULT_AGENTS = { ct: 'ctm_sas', t: 'tm_phoenix' };
const BOT_WEAPONS = { ct: 'm4a1', t: 'ak47' };

const storage = {
  load(key, fallback) {
    try {
      const stored = localStorage.getItem(key);
      const value = Number(stored);
      return stored !== null && Number.isFinite(value) ? value : fallback;
    } catch {
      return fallback;
    }
  },
  save(key, value) {
    try { localStorage.setItem(key, String(value)); } catch { /* storage unavailable */ }
  },
};

/** Wires a menu checkbox to a setting and remembers it between sessions. */
function bindToggle(id, apply) {
  const checkbox = document.getElementById(id);
  checkbox.checked = storage.load(id, 0) === 1;
  apply(checkbox.checked);
  checkbox.addEventListener('change', () => {
    apply(checkbox.checked);
    storage.save(id, checkbox.checked ? 1 : 0);
  });
}

class Game {
  constructor() {
    this.canvas = document.getElementById('view');
    this.mapStatus = document.getElementById('map-status');
    this.gameStatus = document.getElementById('game-status');
    this.gameArchives = [];
    this.mapFile = null;
    this.mapWorld = null;
    this.manifest = null;
    this.sky = new Sky();
    this.renderer = new Renderer(this.canvas, this.sky);
    this.input = new Input();
    this.hud = new Hud();
    this.player = new Player();
    this.inventory = new Inventory();
    this.recoil = new Recoil();
    this.sounds = new SoundSystem();
    this.footsteps = new Footsteps(this.sounds);
    this.match = null;
    this.bot = null;              // the bot's model, weapon and clips, once loaded
    this.vanity = null;           // the menu character's model, weapon and pose
    this.previewing = false;      // inspecting an item from the inventory
    this.simTime = 0;
    this.bobPhase = 0;
    this.best = storage.load('best', 0);
    this.started = false;
    this.keepDeathVelocity = false;
    this.time = 0;
    this.accumulator = 0;
    this.lastFrame = performance.now();

    this.menu = new Menu({ onGo: (mode) => this.go(mode), onTab: () => this.updateMenuVisibility() });
    this.setupSettings();
    this.setupMapLoading();
    this.setupFriendPlay();
    this.setupAssetPack();
    this.newCourse();
    requestAnimationFrame((now) => this.frame(now));
  }

  get playing() {
    return document.pointerLockElement === this.canvas;
  }

  setupSettings() {
    const sensitivity = document.getElementById('sensitivity');
    sensitivity.value = storage.load('sensitivity', MOUSE.defaultSensitivity);
    this.input.sensitivity = Number(sensitivity.value);
    sensitivity.addEventListener('change', () => {
      this.input.sensitivity = Number(sensitivity.value) || MOUSE.defaultSensitivity;
      storage.save('sensitivity', this.input.sensitivity);
    });
    const volume = document.getElementById('volume');
    volume.value = storage.load('volume', 80);
    this.sounds.volume = Number(volume.value) / 100;
    volume.addEventListener('input', () => {
      this.sounds.volume = Number(volume.value) / 100;
      storage.save('volume', volume.value);
    });
    bindToggle('autohop', (on) => { CONVARS.sv_autobunnyhopping = on; });
    bindToggle('keep-velocity', (on) => { this.keepDeathVelocity = on; });

    this.canvas.addEventListener('click', () => { if (this.started && !this.previewing) this.startPlaying(); });
    document.addEventListener('pointerlockchange', () => {
      this.input.setEnabled(this.playing);
      this.updateMenuVisibility();
    });
    document.getElementById('preview-back').addEventListener('click', () => this.endPreview());
    // Outside play: B opens the inventory, Esc leaves an item preview, F inspects again.
    window.addEventListener('keydown', (event) => {
      if (this.playing || event.repeat || event.target.matches?.('input, select')) return;
      if (event.code === 'Escape' && this.previewing) this.endPreview();
      else if (event.code === 'KeyF' && this.previewing) this.preview(this.inventory.weapon.slot);
      else if (event.code === 'KeyB' && this.manifest) this.openInventory();
    });
    window.addEventListener('contextmenu', (event) => event.preventDefault());
    // Last line of defence where Ctrl+W cannot be blocked: ask before leaving.
    window.addEventListener('beforeunload', (event) => {
      if (this.started) event.preventDefault();
    });
  }

  updateMenuVisibility() {
    this.menu.visible = !this.playing && !this.previewing;
    document.getElementById('preview-bar').hidden = !this.previewing || this.playing;
  }

  /** Maps load from the file picker or by dropping a .bsp anywhere on the page. */
  setupMapLoading() {
    const picker = document.getElementById('map-file');
    picker.addEventListener('change', () => {
      if (picker.files[0]) this.loadMap(picker.files[0]);
      picker.value = '';
    });
    const gamePicker = document.getElementById('game-files');
    gamePicker.addEventListener('change', () => {
      this.addGameFiles([...gamePicker.files]);
      gamePicker.value = '';
    });
    window.addEventListener('dragover', (event) => event.preventDefault());
    window.addEventListener('drop', (event) => {
      event.preventDefault();
      const file = event.dataTransfer.files[0];
      if (file) this.loadMap(file);
    });
  }

  /**
   * Game .vpk files supply stock textures and models that maps do not pack.
   * Only their directory index is read now; files are sliced from disk on demand.
   * Picks add up, so files from several folders can be chosen in turn.
   */
  async addGameFiles(files) {
    try {
      const opened = await openVpkSets(files);
      const names = new Set(opened.map((archive) => archive.name));
      this.gameArchives = [...this.gameArchives.filter((archive) => !names.has(archive.name)), ...opened];
      const total = this.gameArchives.reduce((sum, archive) => sum + archive.entries.size, 0);
      this.gameStatus.textContent = this.gameArchives.length
        ? `Game files: ${this.gameArchives.map((archive) => archive.name).join(', ')} (${total} files indexed).`
        : 'No _dir.vpk file among the picked files.';
      if (this.mapFile && opened.length) await this.loadMap(this.mapFile);
    } catch (error) {
      this.gameStatus.textContent = `Could not read game files: ${error.message}`;
    }
  }

  /**
   * The asset pack: served next to the page, or stored from an earlier
   * visit, or else asked for. Without one the course still plays.
   */
  async setupAssetPack() {
    const dialog = document.getElementById('pack-dialog');
    const status = document.getElementById('pack-status');
    const progress = document.getElementById('pack-progress');
    const picker = document.getElementById('pack-file');
    picker.addEventListener('change', async () => {
      const file = picker.files[0];
      picker.value = '';
      if (!file) return;
      progress.hidden = false;
      status.textContent = `Storing ${file.name}…`;
      try {
        const { pack, stored } = await installAssetPack(file, (fraction) => { progress.value = fraction; });
        dialog.hidden = true;
        await this.useAssetPack(pack);
        if (!stored) document.getElementById('pack-info').textContent += ' The browser had no room to keep it, so it is asked for again next time.';
      } catch (error) {
        status.textContent = error.message;
      }
      progress.hidden = true;
    });
    document.getElementById('pack-skip').addEventListener('click', () => { dialog.hidden = true; });
    document.getElementById('pack-change').addEventListener('click', () => { dialog.hidden = false; });
    document.getElementById('pack-remove').addEventListener('click', async () => {
      await removeAssetPack();
      document.getElementById('pack-info').textContent = 'Stored pack removed; it is asked for on the next launch.';
    });

    const pack = await openAssetPack();
    if (pack) await this.useAssetPack(pack);
    else {
      dialog.hidden = false;
      document.getElementById('weapon-status').textContent = 'No asset pack';
    }
  }

  /** Weapons, finishes, gloves, agents and sounds from an asset pack. */
  async useAssetPack(pack) {
    const status = document.getElementById('weapon-status');
    if (this.manifest) {
      location.reload();   // a different pack: start clean rather than mixing two
      return;
    }
    try {
      const manifest = await (await pack.fetch('manifest.json')).json();
      this.pack = pack;
      this.manifest = manifest;
      this.loadFonts(pack, manifest.ui?.fonts ?? []);
      this.sounds.setManifest(pack, manifest);
      this.inventory.setCatalog(manifest.weapons);
      this.renderer.characters.setManifest(manifest);
      await this.renderer.viewmodels.load(pack, manifest);
      this.inventoryView = new InventoryView(document.getElementById('inventory'), pack, manifest, {
        onChange: (loadout, slot) => this.changeLoadout(loadout, slot),
        onInspect: (slot) => this.startPreview(slot),
      });
      this.menu.setIcons(pack, manifest.ui?.icons ?? {});
      this.showEquipped();
      const pairs = Object.values(manifest.weapons).reduce((sum, weapon) => sum + weapon.finishes.length, 0);
      status.textContent = `${Object.keys(manifest.weapons).length} weapons · ${pairs} skins · ${Object.keys(manifest.agents ?? {}).length} agents`;
      document.getElementById('pack-info').textContent = `Loaded: ${status.textContent}.`;
    } catch (error) {
      status.textContent = `Asset pack unreadable: ${error.message}`;
    }
  }

  /** The menu font from the pack, when it has one. */
  async loadFonts(pack, fonts) {
    for (const path of fonts) {
      try {
        const weight = /bold/.test(path) ? '700' : '400';
        const face = new FontFace('Menu Sans', await (await pack.fetch(path)).arrayBuffer(), { weight });
        document.fonts.add(await face.load());
      } catch { /* the system font stays */ }
    }
  }

  /**
   * Carries the equipped items: only these are loaded, with their finishes
   * painted, and anything unequipped is freed. While previewing, the changed
   * weapon is brought out and inspected.
   */
  changeLoadout(loadout, slot) {
    this.loadout = loadout;
    this.inventory.setLoadout(loadout, this.simTime);
    const weapons = ['primary', 'secondary', 'knife'].map((s) => this.inventory.loadout[s]).filter(Boolean);
    this.loadoutReady = Promise.all([
      this.renderer.viewmodels.setLoadout(weapons),
      this.renderer.viewmodels.setDress(loadout.agent, loadout.gloves),
    ]);
    this.vanity = null;   // reposes with the new loadout
    if (this.match instanceof Versus) this.match.sendAppearance({ agent: loadout.agent?.id ?? null, weapon: this.inventory.current });
    if (this.inventoryView) this.showEquipped();
    if (slot && ['primary', 'secondary', 'knife'].includes(slot) && this.previewing) this.preview(slot);
  }

  showEquipped() {
    const color = (rarity) => this.manifest.rarities?.[rarity]?.color ?? '#9ba0a8';
    const items = this.inventoryView.equippedItems();
    const order = ['primary', 'secondary', 'knife', 'gloves', 'agent'];
    items.sort((a, b) => order.indexOf(this.inventoryView.slotOf(a)) - order.indexOf(this.inventoryView.slotOf(b)));
    this.menu.showEquipped(items.map((item) => ({
      name: item.name, icon: item.icon ? this.pack.url(item.icon) : null, color: color(item.rarity), label: SLOT_LABELS[this.inventoryView.slotOf(item)],
    })));
  }

  openInventory() {
    if (this.playing) document.exitPointerLock();
    this.previewing = false;
    this.menu.show('inventory');
    this.updateMenuVisibility();
  }

  /** Inspects a slot's weapon on screen, out of the inventory. */
  startPreview(slot) {
    this.previewing = true;
    this.updateMenuVisibility();
    this.preview(slot);
  }

  endPreview() {
    this.previewing = false;
    this.menu.show('inventory');
    this.updateMenuVisibility();
  }

  /** Holds a slot's weapon and plays its inspect animation, once it has loaded. */
  async preview(slot) {
    const entry = this.inventory.loadout[slot];
    if (!entry) return;
    await this.loadoutReady;
    if (this.inventory.loadout[slot] !== entry) return;   // changed again while loading
    this.inventory.select(entry.id, this.simTime, true);
    this.inventory.takeEvents();
    this.renderer.viewmodels.play(entry.id, 'inspect', this.time);
    const weapon = this.manifest.weapons[entry.id];
    const finish = entry.finish && this.manifest.finishes[entry.finish];
    document.getElementById('preview-name').textContent = finish ? `${weapon.name} | ${finish.name}` : weapon.name;
  }

  /**
   * 1v1 with a friend. GO (or "Create invite link") opens a room and puts
   * you in the arena alone, waiting; the link is copied for you to send.
   * Opening a link joins that room and enters the arena on the other side.
   * The first round starts once both players are in.
   */
  setupFriendPlay() {
    const status = document.getElementById('friend-status');
    const link = document.getElementById('friend-link');
    const copy = document.getElementById('friend-copy');
    this.netplay = new Netplay({
      onMessage: (message) => { if (this.match instanceof Versus) this.match.receive(message); },
      onStatus: (text, connected) => {
        status.textContent = text;
        if (!(this.match instanceof Versus)) {
          if (!connected) return;
          this.startVersus();   // a guest enters the arena as soon as it connects
          status.textContent = 'Connected: press GO to play.';
        }
        if (connected) {
          this.match.connected();
          this.match.sendAppearance({ agent: this.loadout?.agent?.id ?? null, weapon: this.inventory.current });
          this.hud.say('Opponent joined', this.time, 2);
        } else if (this.match.waiting === false) {
          this.match.disconnected();
          this.respawn();
          this.hud.say('Opponent left: waiting for them to rejoin', this.time, 4);
        }
      },
    });
    this.inviteLink = async () => {
      if (!this.netplay.isHost || !this.netplay.peer) {
        link.value = await this.netplay.host();
        link.hidden = copy.hidden = false;
      }
      await navigator.clipboard?.writeText(link.value).catch(() => {});
      status.textContent = 'Invite link copied: send it to your friend. You wait in the arena until they join.';
      return link.value;
    };
    document.getElementById('friend-host').addEventListener('click', () => this.inviteLink().catch((error) => { status.textContent = error.message; }));
    copy.addEventListener('click', () => navigator.clipboard?.writeText(link.value).then(() => { status.textContent = 'Link copied.'; }));
    const room = invitedRoom();
    if (room) {
      this.menu.pickMode('friend');
      status.textContent = 'Joining your friend…';
      this.netplay.join(room);
    }
  }

  /** GO: starts (or returns to) the chosen mode. */
  go(mode) {
    if (mode === 'friend') {
      if (!(this.match instanceof Versus)) {
        // Host: into the arena now (pointer lock needs this click), the room opens meanwhile.
        this.startVersus();
        // A guest still connecting just waits in the arena; anyone else opens a room.
        if (!invitedRoom()) this.inviteLink().catch((error) => { document.getElementById('friend-status').textContent = error.message; });
      }
    } else if (mode === 'arena' && (this.world.kind !== 'arena' || this.match instanceof Versus)) this.startArena();
    else if (mode === 'course' && this.world.kind !== 'course') this.newCourse();
    else if (mode === 'map') {
      if (!this.mapWorld) {
        this.mapStatus.textContent = 'Choose a .bsp file first.';
        return;
      }
      if (this.world !== this.mapWorld) this.setWorld(this.mapWorld);
    }
    this.startPlaying();
  }

  async loadMap(file) {
    this.mapFile = file;
    this.mapStatus.textContent = `Loading ${file.name}…`;
    try {
      const bsp = parseBsp(await file.arrayBuffer());
      // Let the status message paint before the heavy, synchronous collision build.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const world = new BspWorld(bsp, file.name.replace(/\.bsp$/i, ''));
      world.scene = await buildBspScene(bsp, world.collision, this.gameArchives);
      world.surfaceProps = world.scene.surfaceProps;
      this.mapWorld = world;
      this.menu.pickMode('map');
      this.setWorld(world);
      const missing = world.scene.stats.missingTextures.length;
      this.mapStatus.textContent = `${world.name}: ${world.stats.solids} solids, ${world.stats.teleports} teleport volumes`
        + (missing ? `, ${missing} materials not found (load game files).` : ', all materials found.');
    } catch (error) {
      this.mapStatus.textContent = `Could not load ${file.name}: ${error.message}`;
    }
  }

  /**
   * Chromium browsers let a fullscreen page take Ctrl+W through the Keyboard
   * Lock API, so play goes fullscreen there. Firefox has no Keyboard Lock.
   */
  startPlaying() {
    this.started = true;
    this.previewing = false;
    this.sounds.resume();
    this.requestPointerLock();
    if (navigator.keyboard?.lock && !document.fullscreenElement) {
      document.documentElement.requestFullscreen()
        .then(() => navigator.keyboard.lock(BROWSER_RESERVED_KEYS))
        .catch(() => { /* fullscreen refused: the leave prompt still guards Ctrl+W */ });
    }
  }

  /** Raw mouse input when the browser supports it, like m_rawinput 1. */
  requestPointerLock() {
    const request = this.canvas.requestPointerLock({ unadjustedMovement: true });
    request?.catch?.(() => this.canvas.requestPointerLock());
  }

  setWorld(world) {
    this.world = world;
    this.match = null;
    this.renderer.impacts.clear();
    this.hud.showScore(world.score !== null);
    this.hud.showMatch(null);
    this.respawn();
  }

  newCourse() {
    this.setWorld(new Course(randomSeed()));
  }

  /** The arena with a bot of the other team, carrying that team's rifle. */
  startArena() {
    const arena = new Arena();
    this.setWorld(arena);
    const agents = this.manifest?.agents ?? {};
    const playerTeam = agents[this.loadout?.agent?.id]?.team ?? 'ct';
    const team = playerTeam === 'ct' ? 't' : 'ct';
    const agentId = agents[DEFAULT_AGENTS[team]] ? DEFAULT_AGENTS[team] : Object.keys(agents).find((id) => agents[id].team === team);
    const weaponId = this.manifest?.weapons[BOT_WEAPONS[team]] ? BOT_WEAPONS[team] : 'ak47';
    const weapon = this.manifest?.weapons[weaponId] ?? { stats: this.inventory.weapon.stats, sounds: {} };
    const difficulty = document.getElementById('bot-difficulty').value;
    this.match = new Match(arena, { weapon, difficulty });
    this.botWeapon = weaponId;
    this.bot = null;
    if (agentId && this.manifest) this.loadCharacter(agentId, weaponId, weapon.body ?? 'rifle').then((visual) => { this.bot = visual; });
    this.hud.showMatch(this.match);
  }

  /** The arena for a friend match: alone and waiting until the other player is in. */
  startVersus() {
    const arena = new Arena();
    this.world = arena;
    this.renderer.impacts.clear();
    this.hud.showScore(false);
    this.match = new Versus(arena, this.netplay);
    this.bot = null;
    this.friendLook = null;
    this.respawn();
    this.hud.showMatch(this.match);
  }

  /** A third-person agent with a weapon and its body clips. */
  async loadCharacter(agentId, weaponId, category) {
    const characters = this.renderer.characters;
    const [body, weapon, clips] = await Promise.all([characters.agent(agentId), characters.weapon(weaponId), characters.bodyClips(category)]);
    return body ? { body, weapon, clips, animTime: 0 } : null;
  }

  respawn(speed = 0) {
    const { feet, yaw } = (this.match ?? this.world).respawnPoint();
    this.player.placeAt(feet, yaw, speed);
    this.recoil.reset();
  }

  tick() {
    const player = this.player;
    const cmd = this.input.createUserCmd();
    if (cmd.skins) {
      this.openInventory();
      return;
    }
    if (cmd.restart) {
      // R: a fresh course, back to the map's spawn, or a new round.
      if (this.world.kind === 'course') this.newCourse();
      else this.match?.startRound(this.simTime);
      if (this.world.kind !== 'course') this.respawn();
      return;
    }

    this.simTime += TICK_INTERVAL;
    player.previousEye = player.eye();
    player.maxSpeed = this.inventory.stats.maxSpeed;
    const alive = !this.match || this.match.playerAlive;
    if (alive) {
      const before = { wasOnGround: Boolean(player.ground), fallSpeed: -player.vel.z };
      playerMove(player, cmd, this.world.collision);
      this.footsteps.update(player, this.world, before, TICK_INTERVAL);
      this.updateWeapon(cmd);
    }
    this.recoil.update(this.inventory.stats, player.ducked, this.simTime, TICK_INTERVAL);
    if (this.match) this.tickMatch();

    const event = this.world.afterMove(player);
    if (event?.teleport) {
      player.placeAt(event.teleport.feet, event.teleport.yaw);
    } else if (event?.respawn) {
      // Optionally carry the horizontal speed from the fall into the respawn.
      this.respawn(this.keepDeathVelocity ? player.horizontalSpeed : 0);
    }

    if (this.world.score !== null && this.world.score > this.best) {
      this.best = this.world.score;
      storage.save('best', this.best);
    }
  }

  /** The bot's turn, and what came of it: sounds, hits, round ends. */
  tickMatch() {
    const match = this.match;
    match.tick(this.player, this.simTime, TICK_INTERVAL, this.inventory.current);
    for (const event of match.takeEvents()) {
      if (event.type === 'shot') {
        this.sounds.weapon(event.weapon ?? this.botWeapon, 'attack', this.heard(event.from));
        this.opponentFlash = { at: this.time, seed: Math.random() };
      }
      else if (event.type === 'impact') this.renderer.impacts.add(event.point, event.normal, this.time);
      else if (event.type === 'hit' && event.target === 'player') this.hud.hurt();
      else if (event.type === 'kill') this.hud.say(event.winner === 'player' ? 'You win the round' : `${match.opponentName ?? 'The bot'} wins the round`, this.time, 2.5);
      else if (event.type === 'round') {
        this.respawn();
        this.hud.say('Fight', this.time, 1);
      }
    }
  }

  /** Volume and pan of a sound from a point, as heard by the player. */
  heard(from) {
    const offset = sub(from, this.player.pos);
    const distance = Math.hypot(offset.x, offset.y, offset.z);
    const { right } = viewAxes(this.player.yaw, 0);
    const side = distance > 1 ? (offset.x * right.x + offset.y * right.y) / distance : 0;
    return { volume: Math.max(0.15, 1 - distance / 3000), pan: side * 0.8 };
  }

  /** Weapon switching, attacks and inspecting: each plays its sound and viewmodel animation. */
  updateWeapon(cmd) {
    this.inventory.update(cmd, this.simTime);
    const clips = { deploy: 'draw', attack: 'attack', attack2: 'attack2', inspect: 'inspect' };
    for (const { type, weapon, stats: fired } of this.inventory.takeEvents()) {
      const { slot } = this.inventory.weapon;
      const stats = fired ?? this.inventory.stats;
      if (type === 'deploy') this.recoil.reset();
      if (type === 'attack' && slot !== 'knife') {
        this.fireBullets(stats);
        this.renderer.viewmodels.flash(this.time);
      }
      if ((type === 'attack' || type === 'attack2') && slot === 'knife' && this.match) {
        this.match.playerKnife(this.player.eye(), viewAxes(this.player.yaw, this.player.pitch).forward, stats, type === 'attack2');
      }
      this.sounds.weapon(weapon, type);
      this.renderer.viewmodels.play(weapon, clips[type], this.time);
    }
  }

  /**
   * One shot of a gun: each bullet leaves along the view plus the aim punch,
   * scattered within the current inaccuracy, and hits the bot or marks the
   * wall it reaches. Then the shot kicks the recoil.
   */
  fireBullets(stats) {
    const player = this.player;
    const aim = this.recoil.aimOffset;
    const eye = player.eye();
    const impacts = [];
    for (const direction of bulletDirections(player.yaw + aim.yaw, player.pitch + aim.pitch, stats, this.recoil.inaccuracy(stats, player))) {
      const hit = traceLine(eye, add(eye, scale(direction, BULLET_RANGE)), this.world.collision);
      if (this.match?.playerShot(eye, direction, stats, hit.fraction * BULLET_RANGE, this.inventory.current)) continue;
      if (!hit.solid || hit.solid.sky) continue;
      this.renderer.impacts.add(hit.endPos, hit.normal, this.time);
      impacts.push({ point: hit.endPos, normal: hit.normal });
    }
    this.match?.shotFired?.({ ...player.pos }, this.inventory.current, impacts);
    this.recoil.shoot(stats, this.simTime);
  }

  /**
   * The opponent (bot or friend) posed for this frame; its head becomes the
   * head hitbox. A friend's look loads when they change agent or weapon.
   */
  opponentCharacter(frameTime) {
    const { match } = this;
    if (!match?.opponentAlive) return [];
    if (match instanceof Versus) this.dressFriend(match);
    const { bot } = this;
    const state = match.character();
    if (!state) return [];
    if (!bot) return [{ standIn: state }];   // no asset pack (or still loading): a plain figure
    const characters = this.renderer.characters;
    const clip = characters.pick(bot.clips, state);
    bot.animTime += frameTime * Math.max(0.6, Math.hypot(state.vel.x, state.vel.y) / 250);
    const pose = characters.pose(bot.body, bot.weapon, clip, bot.animTime, state.pos, state.yaw);
    if (bot.body.head >= 0) match.headPoint = worldPoint(pose.matrix, pose.world[bot.body.head]);
    const flash = this.opponentFlash && { age: this.time - this.opponentFlash.at, seed: this.opponentFlash.seed };
    return [{ body: bot.body, weapon: bot.weapon, pose, yaw: state.yaw, flash }];
  }

  dressFriend(match) {
    if (!this.manifest) return;
    const agents = this.manifest.agents ?? {};
    const otherTeam = (team) => Object.keys(agents).find((id) => agents[id].team === team);
    const agentId = agents[match.remote.appearance?.agent] ? match.remote.appearance.agent
      : agents[DEFAULT_AGENTS.t] ? DEFAULT_AGENTS.t : otherTeam(match.isHost ? 't' : 'ct');
    const weaponId = this.manifest.weapons[match.remote.state?.weapon] ? match.remote.state.weapon : 'ak47';
    const key = `${agentId}/${weaponId}`;
    if (!agentId || this.friendLook === key) return;
    this.friendLook = key;
    const weapon = this.manifest.weapons[weaponId];
    this.loadCharacter(agentId, weaponId, weapon.slot === 'knife' ? 'knife' : weapon.body).then((visual) => {
      if (this.friendLook === key) this.bot = visual;
    });
  }

  /** The menu's character: your agent (or the default CT) holding your weapon, in its main menu pose. */
  vanityCharacter() {
    if (!this.manifest || !this.menu.visible || this.menu.tab !== 'play') return null;
    const agentId = this.loadout?.agent?.id ?? DEFAULT_AGENTS.ct;
    const weaponId = this.inventory.current;
    const key = `${agentId}/${weaponId}`;
    if (this.vanity?.key !== key) {
      this.vanity = { key, ready: null };
      const agent = this.manifest.agents?.[agentId];
      const weapon = this.manifest.weapons[weaponId];
      if (agent && weapon) {
        const category = weapon.slot === 'knife' ? 'knife' : weapon.body;
        Promise.all([
          this.renderer.characters.agent(agentId), this.renderer.characters.weapon(weaponId),
          this.renderer.characters.clip(this.manifest.menuPoses?.[agent.team]?.[category]),
        ]).then(([body, held, clip]) => {
          if (this.vanity?.key === key && body) this.vanity.ready = { body, held, clip };
        });
      }
    }
    const ready = this.vanity.ready;
    if (!ready) return null;
    const pose = this.renderer.characters.pose(ready.body, ready.held, ready.clip, this.time, { x: 0, y: 0, z: 0 }, 180);
    return { body: ready.body, weapon: ready.held, pose, yaw: 180 };
  }

  frame(now) {
    const frameTime = Math.min((now - this.lastFrame) / 1000, MAX_FRAME_TIME);
    this.lastFrame = now;
    this.time += frameTime;
    this.sky.update(frameTime);
    this.hud.tick(this.time);

    if (this.playing) {
      this.input.applyMouseLook(this.player, this.inventory.fov / 90);
      this.accumulator += frameTime;
      while (this.accumulator >= TICK_INTERVAL) {
        this.tick();
        this.accumulator -= TICK_INTERVAL;
      }
    }

    const player = this.player;
    // View bob: the cycle advances with ground speed; in the air the weapon settles.
    const bobAmount = player.ground ? Math.min(player.horizontalSpeed / 250, 1) : 0;
    this.bobPhase += frameTime * Math.PI * 2 * 1.5 * bobAmount;
    const kick = this.recoil.viewOffset;
    const vanity = this.vanityCharacter();
    const fov = this.inventory.fov;
    this.renderer.camera.zoom = Math.tan(fov * Math.PI / 360);   // tan(fov/2) relative to tan(45°)
    this.hud.showScope(this.inventory.scoped ? 'scope' : this.inventory.zoomLevel ? 'sight' : this.inventory.zoom?.hidesViewmodel ? 'sniper' : null);
    const alive = !this.match || this.match.playerAlive;
    this.renderer.render({
      eye: lerp(player.previousEye, player.eye(), this.accumulator / TICK_INTERVAL),
      yaw: player.yaw + kick.yaw,
      pitch: player.pitch + kick.pitch,
      sky: this.sky,
      world: this.world,
      time: this.time,
      characters: this.opponentCharacter(frameTime),
      // Viewmodel animations run on the frame clock, so previews animate while paused.
      viewmodel: alive && !vanity && !this.inventory.scoped ? { id: this.inventory.current, time: this.time, bobPhase: this.bobPhase, bobAmount } : null,
    });
    if (vanity) this.renderer.drawVanity(vanity);
    this.hud.update({ speed: player.horizontalSpeed, platform: this.world.score ?? 0, best: this.best });
    if (this.match) this.hud.showMatch(this.match);
    const entry = this.inventory.entry;
    const finish = entry?.finish && this.manifest?.finishes[entry.finish];
    this.hud.showWeapon(finish ? `${this.inventory.weapon.name} | ${finish.name}` : this.inventory.weapon.name);

    requestAnimationFrame((next) => this.frame(next));
  }
}

try {
  new Game();
} catch (error) {
  document.getElementById('play').disabled = true;
  document.getElementById('play').textContent = error.message;
  throw error;
}
