/**
 * A 1v1 against a bot in the arena: rounds of one life each, first to see
 * the other alive wins nothing but the round. The bot moves with the same
 * movement code as the player, strafes left and right while it has
 * no shot, stops to shoot once it has seen you for its reaction time, and
 * sprays with its gun's real recoil and inaccuracy. Hits and damage follow
 * the classic rules (combat.js): both start each round with 100 health and kevlar and
 * helmet. The bot reloads when its clip runs out, or early while it has no target.
 */
import { traceLine } from './collision.js';
import { applyDamage, bulletDirections, hitboxes, knifeHit, traceBullet } from './combat.js';
import { CONVARS } from './config.js';
import { playerMove } from './movement.js';
import { Player } from './player.js';
import { Recoil } from './recoil.js';
import { reloadDuration, showsTracer } from './weapons.js';
import { add, sub } from './vector.js';

export const BOT_DIFFICULTIES = {
  // error: degrees of first aim off target, settling at `settle` per second; control: share of recoil pulled down.
  easy: { label: 'Easy', reaction: 0.55, turnSpeed: 160, error: 5, settle: 3, control: 0.3, headshots: 0.15, burst: [2, 4] },
  normal: { label: 'Normal', reaction: 0.35, turnSpeed: 320, error: 3, settle: 5, control: 0.6, headshots: 0.35, burst: [3, 6] },
  hard: { label: 'Hard', reaction: 0.2, turnSpeed: 640, error: 2, settle: 8, control: 0.85, headshots: 0.6, burst: [4, 8] },
};
const ROUND_RESTART = 2.5;    // seconds after a death before the next round
const STRAFE_TIME = [0.3, 0.7];

const randomIn = ([min, max]) => min + Math.random() * (max - min);
const angleDelta = (from, to) => ((to - from + 540) % 360) - 180;

function anglesTo(from, to) {
  const d = sub(to, from);
  return {
    yaw: Math.atan2(d.y, d.x) * 180 / Math.PI,
    pitch: -Math.atan2(d.z, Math.hypot(d.x, d.y)) * 180 / Math.PI,
  };
}

const fresh = () => ({ health: 100, armor: 100, helmet: true });

export class Match {
  /** `bot` = { weapon: manifest weapon (with id), difficulty } */
  constructor(world, { weapon, difficulty = 'normal' }) {
    this.world = world;
    this.weapon = weapon;
    this.skill = BOT_DIFFICULTIES[difficulty] ?? BOT_DIFFICULTIES.normal;
    this.score = { player: 0, opponent: 0 };
    this.bot = { player: new Player(), recoil: new Recoil(), ...fresh() };
    this.you = fresh();
    this.events = [];          // { type: 'shot' | 'hit' | 'kill' | 'round', ... } for sounds and the HUD
    this.overAt = null;        // time the round ended
    this.headPoint = null;     // the bot model's head, set by the renderer each frame
    this.now = 0;
    this.startRound(0);
  }

  get playerAlive() {
    return this.you.health > 0;
  }

  /** Whether the opponent (the bot) is alive. */
  get opponentAlive() {
    return this.bot.health > 0;
  }

  /** Killed this round (rather than not there at all). */
  get opponentKilled() {
    return this.bot.health <= 0;
  }

  startRound(time) {
    Object.assign(this.you, fresh());
    Object.assign(this.bot, fresh());
    const { feet, yaw } = this.world.spawns.bot;
    this.bot.player.placeAt(feet, yaw);
    this.bot.player.maxSpeed = this.weapon.stats.maxSpeed;
    this.bot.recoil.reset();
    this.bot.clip = this.weapon.stats.clip ?? Infinity;
    this.bot.reloadedAt = 0;
    this.ai = { goal: null, repathAt: 0, seenAt: null, lastSeen: null, strafe: 1, strafeUntil: 0, burst: 0, nextShot: time, aimError: { yaw: 0, pitch: 0 }, aimHead: false };
    this.overAt = null;
    this.events.push({ type: 'round', time });
  }

  takeEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  /** Where the player spawns: the arena's player side. */
  respawnPoint() {
    return this.world.spawns.player;
  }

  /** The bot's hitboxes while it can be hurt, with the head where its animated model holds it. */
  targets() {
    if (!this.opponentAlive || !this.playerAlive) return [];
    const bot = this.bot.player;
    return hitboxes(bot.pos, bot.ducked, this.headPoint);
  }

  /** A bullet from the player hit the bot: `hit` from traceBullet. */
  playerShot(stats, hit) {
    this.damageBot(stats, hit.group, hit.damage);
  }

  /** A knife swing from the player: light (attack) or heavy (attack2). Returns the hit, or null. */
  playerKnife(origin, direction, stats, heavy) {
    const hit = knifeHit(origin, direction, stats, heavy, this.targets());
    if (hit) this.damageBot(hit.stats, hit.group, hit.damage);
    return hit;
  }

  damageBot(stats, group, damage) {
    const lost = applyDamage(this.bot, stats, group, damage);
    this.bot.player.tag();
    this.events.push({ type: 'hit', target: 'opponent', group, damage: lost });
    if (!this.opponentAlive) this.endRound('player');
  }

  endRound(winner) {
    this.score[winner]++;
    this.overAt = this.now;
    this.events.push({ type: 'kill', winner });
  }

  /** One tick of the bot and the round, after the player has moved. */
  tick(player, time, dt) {
    this.now = time;
    if (this.overAt !== null) {
      if (time - this.overAt > ROUND_RESTART) {
        this.startRound(time);
        return 'restart';
      }
      if (this.opponentAlive) this.think(player, time, dt, false);
      return null;
    }
    this.think(player, time, dt, this.playerAlive);
    return null;
  }

  /** Bot AI: look for the player, turn toward them, strafe, stop and shoot. */
  think(player, time, dt, canFight) {
    const bot = this.bot.player;
    const { ai, skill } = this;
    const eye = bot.eye();
    const target = player.eye();
    const aimPoint = ai.aimHead ? { ...target, z: target.z + 1 } : { ...target, z: target.z - 16 };
    const visible = canFight && traceLine(eye, aimPoint, this.world.collision).fraction >= 1;

    if (visible) {
      if (ai.seenAt === null) {
        ai.seenAt = time;
        ai.aimHead = Math.random() < skill.headshots;
        ai.aimError = { yaw: (Math.random() * 2 - 1) * skill.error, pitch: (Math.random() * 2 - 1) * skill.error * 0.6 };
      }
      ai.lastSeen = { ...player.pos };
    } else {
      ai.seenAt = null;
    }

    // Out of sight it heads for a spot with a view of the player, around the cover.
    if (!visible && time >= ai.repathAt) {
      ai.goal = this.peekSpot(bot, target);
      ai.repathAt = time + 0.5;
    }
    const lookAt = visible ? aimPoint : ai.goal ? { ...ai.goal, z: eye.z } : add(player.pos, { x: 0, y: 0, z: 60 });

    // Turn toward the target (or toward where it is going), with an error that settles.
    const wanted = anglesTo(eye, lookAt);
    const settle = Math.exp(-dt * skill.settle);
    ai.aimError.yaw *= settle;
    ai.aimError.pitch *= settle;
    const kick = this.bot.recoil.aimOffset;   // pulled against, like a player controlling a spray
    const goal = {
      yaw: wanted.yaw + ai.aimError.yaw - kick.yaw * skill.control,
      pitch: wanted.pitch + ai.aimError.pitch - kick.pitch * skill.control,
    };
    const step = skill.turnSpeed * dt;
    const dYaw = angleDelta(bot.yaw, goal.yaw);
    const dPitch = goal.pitch - bot.pitch;
    bot.yaw = (bot.yaw + Math.max(-step, Math.min(step, dYaw)) + 360) % 360;
    bot.pitch = Math.max(-89, Math.min(89, bot.pitch + Math.max(-step, Math.min(step, dPitch))));

    const ready = visible && time - ai.seenAt > skill.reaction;
    // It fires once its aim is about on the target (half a body width), however far.
    const tolerance = Math.atan2(16, Math.hypot(aimPoint.x - eye.x, aimPoint.y - eye.y)) * 180 / Math.PI + skill.error * 0.2;
    const aimed = { yaw: bot.yaw + kick.yaw * (1 - skill.control), pitch: bot.pitch + kick.pitch * (1 - skill.control) };
    const onTarget = Math.abs(angleDelta(aimed.yaw, wanted.yaw)) < tolerance && Math.abs(aimed.pitch - wanted.pitch) < tolerance;
    const shooting = ready && onTarget;

    // Strafe while it has no shot; stop dead to shoot (counter-strafing), chase when the player is out of sight.
    const cmd = { forwardmove: 0, sidemove: 0, jump: false, duck: false, walk: false };
    if (!shooting) {
      if (time > ai.strafeUntil) {
        ai.strafe = -ai.strafe;
        ai.strafeUntil = time + randomIn(STRAFE_TIME);
      }
      cmd.sidemove = visible ? ai.strafe * CONVARS.cl_sidespeed : 0;
      if (!visible) cmd.forwardmove = CONVARS.cl_forwardspeed;
    }
    playerMove(bot, cmd, this.world.collision);

    this.bot.recoil.update(this.weapon.stats, bot.ducked, time, dt);
    const { clip } = this.weapon.stats;
    if (this.bot.clip === 0 || (!visible && this.bot.clip < clip / 3)) this.botReload(time);
    const loaded = this.bot.clip > 0 && time >= this.bot.reloadedAt;
    if (shooting && loaded && time >= ai.nextShot && bot.horizontalSpeed < bot.maxSpeed * 0.34) this.botFire(player, time);
    if (!shooting && ai.burst > 0) ai.burst = 0;
  }

  /**
   * The nearest spot (from a grid over the arena) that the bot can walk to
   * in a straight line and that sees the player: how it gets around cover.
   */
  peekSpot(bot, target) {
    this.spots ??= this.walkableSpots();
    const from = { ...bot.pos, z: bot.pos.z + 36 };
    let best = null;
    let bestDistance = Infinity;
    for (const spot of this.spots) {
      const distance = Math.hypot(spot.x - bot.pos.x, spot.y - bot.pos.y);
      if (distance >= bestDistance || distance < 48) continue;
      const eye = { ...spot, z: spot.z + 64 };
      if (traceLine(eye, target, this.world.collision).fraction < 1) continue;
      if (traceLine(from, { ...spot, z: spot.z + 36 }, this.world.collision).fraction < 1) continue;
      best = spot;
      bestDistance = distance;
    }
    return best;
  }

  /** Floor points every 96 units where a player fits, clear of cover by half a body. */
  walkableSpots() {
    const spots = [];
    for (let x = -this.world.halfLength + 64; x <= this.world.halfLength - 64; x += 96) {
      for (let y = -this.world.halfWidth + 64; y <= this.world.halfWidth - 64; y += 96) {
        const point = { x, y, z: 1 };
        const clear = [[0, 0], [24, 24], [-24, 24], [24, -24], [-24, -24]]
          .every(([dx, dy]) => traceLine({ x: x + dx, y: y + dy, z: 40 }, { x: x + dx, y: y + dy, z: 1 }, this.world.collision).fraction >= 1);
        if (clear) spots.push(point);
      }
    }
    return spots;
  }

  botReload(time) {
    const { stats } = this.weapon;
    if (time < this.bot.reloadedAt || !stats.clip || this.bot.clip >= stats.clip) return;
    const shells = stats.singleShells ? stats.clip - this.bot.clip : 1;
    this.bot.reloadedAt = time + reloadDuration(this.weapon, shells);
    this.bot.clip = stats.clip;
    this.events.push({ type: 'reload', from: { ...this.bot.player.pos }, shells });
  }

  /** The bot fires one shot of a burst; bursts end with a pause so its recoil can reset. */
  botFire(player, time) {
    const { stats } = this.weapon;
    const bot = this.bot.player;
    const { ai } = this;
    if (ai.burst <= 0) ai.burst = Math.round(randomIn(this.skill.burst));
    const inaccuracy = this.bot.recoil.inaccuracy(stats, bot);
    const aim = this.bot.recoil.aimOffset;
    const eye = bot.eye();
    const boxes = this.playerAlive ? hitboxes(player.pos, player.ducked) : [];
    this.bot.clip--;
    const tracers = [];
    const tracer = showsTracer(stats, this.bot.clip);
    for (const direction of bulletDirections(bot.yaw + aim.yaw, bot.pitch + aim.pitch, stats, inaccuracy)) {
      const { hit, impacts, end } = traceBullet(eye, direction, stats, this.world.collision, boxes);
      if (tracer) tracers.push(end);
      for (const impact of impacts) this.events.push({ type: 'impact', ...impact });
      if (hit && this.playerAlive) {
        const lost = applyDamage(this.you, stats, hit.group, hit.damage);
        this.events.push({ type: 'hit', target: 'player', group: hit.group, damage: lost, from: { ...bot.pos }, point: end, direction });
        if (!this.playerAlive) this.endRound('opponent');
      }
    }
    this.bot.recoil.shoot(stats, time);
    this.events.push({ type: 'shot', from: { ...bot.pos }, tracers });
    ai.burst--;
    ai.nextShot = time + (ai.burst > 0 && stats.fullAuto ? stats.cycleTime : Math.max(stats.cycleTime, 0.35));
  }

  /** The bot as a character for drawing. */
  character() {
    const bot = this.bot.player;
    return { pos: bot.pos, yaw: bot.yaw, vel: bot.vel, ducked: bot.ducked, onGround: Boolean(bot.ground), alive: this.opponentAlive };
  }
}
