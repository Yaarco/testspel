/**
 * A 1v1 against a friend over a peer-to-peer connection (netplay.js), in
 * the arena. Each side moves itself and sends its state about 64 times a
 * second; the other side shows it as a character. Each side traces its own
 * shots against where it sees the opponent and sends the hits, which the
 * hit side applies to its own health (combat.js) and answers with its death.
 * The host keeps the score and starts every round.
 *
 * It answers the same calls as the bot Match, so the game treats both alike.
 */
import { applyDamage, hitboxes, traceHitboxes } from './combat.js';

const ROUND_RESTART = 2.5;
const SEND_EVERY = 2;          // ticks between state messages (128 tick / 2 = 64 per second)
const SMOOTHING = 20;          // how fast the shown opponent catches up with its last state, per second

const fresh = () => ({ health: 100, armor: 100, helmet: true });

export class Versus {
  /** `weapons` maps weapon ids to manifest weapons, for the damage of the opponent's shots. */
  constructor(world, netplay, weapons) {
    this.world = world;
    this.netplay = netplay;
    this.weapons = weapons;
    this.isHost = netplay.isHost;
    this.score = { player: 0, opponent: 0 };
    this.you = fresh();
    this.remote = { ...fresh(), state: null, shown: null, appearance: null };
    this.events = [];
    this.overAt = null;
    this.headPoint = null;
    this.now = 0;
    this.ticks = 0;
    this.opponentName = 'Friend';
  }

  get playerAlive() {
    return this.you.health > 0;
  }

  get opponentAlive() {
    return Boolean(this.remote.state?.alive);
  }

  /** Host and guest start on opposite sides. */
  respawnPoint() {
    return this.isHost ? this.world.spawns.player : this.world.spawns.bot;
  }

  startRound(time) {
    if (!this.isHost) return;   // only the host starts rounds
    this.beginRound(time);
    this.netplay.send({ type: 'round', score: { player: this.score.opponent, opponent: this.score.player } });
  }

  beginRound(time) {
    Object.assign(this.you, fresh());
    this.overAt = null;
    this.events.push({ type: 'round', time, restart: true });
  }

  takeEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  /** Tells the other side what we look like (agent and held weapon). */
  sendAppearance(appearance) {
    this.netplay.send({ type: 'hello', ...appearance });
  }

  /** A message from the other side. */
  receive(message) {
    switch (message.type) {
      case 'state':
        this.remote.state = message;
        this.remote.shown ??= { pos: { ...message.pos }, yaw: message.yaw };
        break;
      case 'hello':
        this.remote.appearance = { agent: message.agent, weapon: message.weapon };
        break;
      case 'shot':
        this.events.push({ type: 'shot', from: message.from, weapon: message.weapon });
        for (const impact of message.impacts ?? []) this.events.push({ type: 'impact', ...impact });
        break;
      case 'hit': {
        if (!this.playerAlive || this.overAt !== null) break;
        const stats = message.knife ? message.stats : this.weapons[message.weapon]?.stats;
        if (!stats) break;
        const lost = applyDamage(this.you, stats, message.group, message.distance, message.damage);
        this.events.push({ type: 'hit', target: 'player', group: message.group, damage: lost });
        if (!this.playerAlive) {
          this.netplay.send({ type: 'dead' });
          this.endRound('opponent');
        }
        break;
      }
      case 'dead':
        this.endRound('player');
        break;
      case 'round':
        this.score = message.score;
        this.beginRound(this.now);
        break;
      default:
    }
  }

  endRound(winner) {
    if (this.overAt !== null) return;
    if (this.isHost) this.score[winner]++;
    this.overAt = this.now;
    this.events.push({ type: 'kill', winner });
  }

  /** The opponent's hitboxes where we see them, with the head where its model holds it. */
  opponentHitboxes() {
    const state = this.remote.shown && this.remote.state;
    return state ? hitboxes(this.remote.shown.pos, state.ducked, this.headPoint) : [];
  }

  /** Our bullet: on a hit (before `worldDistance`), the other side is told. */
  playerShot(origin, direction, stats, worldDistance, weaponId) {
    if (!this.opponentAlive || !this.playerAlive) return false;
    const hit = traceHitboxes(origin, direction, Math.min(worldDistance, stats.range ?? 8192), this.opponentHitboxes());
    if (!hit) return false;
    this.netplay.send({ type: 'hit', weapon: weaponId, group: hit.group, distance: hit.distance });
    this.events.push({ type: 'hit', target: 'opponent', group: hit.group, damage: null });
    return true;
  }

  playerKnife(origin, direction, stats, heavy) {
    if (!this.opponentAlive || !this.playerAlive) return false;
    const hit = traceHitboxes(origin, direction, heavy ? stats.range2 : stats.range, this.opponentHitboxes());
    if (!hit) return false;
    const knifeStats = { armorRatio: 1.7, rangeModifier: 1, headshotMultiplier: 1 };
    this.netplay.send({ type: 'hit', knife: true, stats: knifeStats, group: hit.group === 'head' ? 'chest' : hit.group, distance: 0, damage: heavy ? stats.damage2 : stats.damage });
    return true;
  }

  /** Our shot, so the other side hears it and sees where it hit. */
  shotFired(from, weaponId, impacts) {
    this.netplay.send({ type: 'shot', from, weapon: weaponId, impacts });
  }

  /** One tick: send our state, ease the shown opponent toward theirs, and (as host) restart rounds. */
  tick(player, time, dt, held) {
    this.now = time;
    if (++this.ticks % SEND_EVERY === 0) {
      this.netplay.send({
        type: 'state', pos: player.pos, vel: player.vel, yaw: player.yaw, pitch: player.pitch,
        ducked: player.ducked, onGround: Boolean(player.ground), alive: this.playerAlive, weapon: held,
      });
    }
    const { state, shown } = this.remote;
    if (state && shown) {
      const k = 1 - Math.exp(-SMOOTHING * dt);
      for (const axis of ['x', 'y', 'z']) shown.pos[axis] += (state.pos[axis] - shown.pos[axis]) * k;
      shown.yaw += (((state.yaw - shown.yaw + 540) % 360) - 180) * k;
    }
    if (this.isHost && this.overAt !== null && time - this.overAt > ROUND_RESTART) {
      this.startRound(time);
      return 'restart';
    }
    return null;
  }

  /** The opponent as a character for drawing. */
  character() {
    const { state, shown } = this.remote;
    if (!state || !shown) return null;
    return { pos: shown.pos, yaw: shown.yaw, vel: state.vel, ducked: state.ducked, onGround: state.onGround, alive: state.alive };
  }
}
