/**
 * A 1v1 against a friend over a peer-to-peer connection (netplay.js), in
 * the arena. Each side moves itself and sends its state about 64 times a
 * second; the other side shows it as a character, run ahead along its last
 * velocity for the time since that update (states that arrive out of order
 * are dropped), so a fast bhopper is drawn where they are rather than where
 * they were. Each side traces its own
 * shots against where it sees the opponent and sends the hits, which the
 * hit side applies to its own health (combat.js) and answers with its death.
 * The host keeps the score and starts every round.
 *
 * Starting the mode puts you in the arena alone, waiting. Once the other
 * player has connected and entered the arena too, the host starts the first
 * round; host and guest spawn on opposite sides.
 *
 * It answers the same calls as the bot Match, so the game treats both alike.
 */
import { applyDamage, hitboxes, knifeHit } from './combat.js';

const ROUND_RESTART = 2.5;
const SEND_EVERY = 2;          // ticks between state messages (128 tick / 2 = 64 per second)
const SMOOTHING = 20;          // how fast the shown opponent catches up with where it should be, per second
const MAX_EXTRAPOLATION = 0.1; // seconds the shown opponent is run ahead of its last state, at most
const STALE_WINDOW = 256;      // states numbered this far behind the last are late, not a restart

const fresh = () => ({ health: 100, armor: 100, helmet: true });

export class Versus {
  constructor(world, netplay) {
    this.world = world;
    this.netplay = netplay;
    this.score = { player: 0, opponent: 0 };
    this.you = fresh();
    this.remote = { ...fresh(), state: null, shown: null, appearance: null };
    this.events = [];
    this.overAt = null;
    this.waiting = true;       // until both players are in the arena
    this.headPoint = null;
    this.now = 0;
    this.ticks = 0;
    this.opponentName = 'Friend';
  }

  get isHost() {
    return this.netplay.isHost;
  }

  get playerAlive() {
    return this.you.health > 0;
  }

  get opponentAlive() {
    return !this.waiting && this.netplay.connected && Boolean(this.remote.state?.alive);
  }

  /** Killed this round (rather than gone or not yet joined). */
  get opponentKilled() {
    return !this.waiting && this.netplay.connected && this.remote.state?.alive === false;
  }

  /** The other player connected: the guest says it is in the arena; the host then starts. */
  connected() {
    this.remote.state = null;
    this.remote.shown = null;
    if (!this.isHost) this.netplay.send({ type: 'ready' });
  }

  /** The other player left: back to waiting, with the score kept. */
  disconnected() {
    this.waiting = true;
    this.remote.state = null;
    this.remote.shown = null;
    this.overAt = null;
    Object.assign(this.you, fresh());
  }

  /** Host and guest start on opposite sides. */
  respawnPoint() {
    return this.isHost ? this.world.spawns.player : this.world.spawns.bot;
  }

  startRound(time) {
    if (!this.isHost || !this.netplay.connected) return;   // only the host starts rounds, and only with someone to play
    this.beginRound(time);
    this.netplay.send({ type: 'round', score: { player: this.score.opponent, opponent: this.score.player } });
  }

  beginRound(time) {
    Object.assign(this.you, fresh());
    this.overAt = null;
    this.waiting = false;
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

  /** An older state arriving late; a far older number means the other side started counting again. */
  isStale(seq) {
    const last = this.remote.state?.seq;
    return last !== undefined && seq <= last && last - seq < STALE_WINDOW;
  }

  /** A message from the other side. */
  receive(message) {
    switch (message.type) {
      case 'state':
        if (this.isStale(message.seq)) break;
        this.remote.state = message;
        this.remote.receivedAt = this.now;
        this.remote.shown ??= { pos: { ...message.pos }, yaw: message.yaw };
        break;
      case 'ready':
        if (this.isHost) this.startRound(this.now);
        break;
      case 'hello':
        this.remote.appearance = { agent: message.agent, weapon: message.weapon };
        break;
      case 'shot':
        this.events.push({ type: 'shot', from: message.from, weapon: message.weapon, tracers: message.tracers ?? [] });
        for (const impact of message.impacts ?? []) this.events.push({ type: 'impact', ...impact });
        break;
      case 'hit': {
        if (!this.playerAlive || this.overAt !== null) break;
        const { stats } = message;
        if (!stats) break;
        const lost = applyDamage(this.you, stats, message.group, message.damage);
        this.events.push({ type: 'hit', target: 'player', group: message.group, damage: lost });
        if (!this.playerAlive) {
          this.netplay.send({ type: 'dead' });
          this.endRound('opponent');
        }
        break;
      }
      case 'reload':
        if (this.remote.shown) this.events.push({ type: 'reload', from: { ...this.remote.shown.pos }, weapon: message.weapon, shells: message.shells });
        break;
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

  /** The opponent's hitboxes where we see them while they can be hurt, with the head where its model holds it. */
  targets() {
    const state = this.remote.shown && this.remote.state;
    if (!state || !this.opponentAlive || !this.playerAlive) return [];
    return hitboxes(this.remote.shown.pos, state.ducked, this.headPoint);
  }

  /** Our bullet hit the opponent (`hit` from traceBullet): the other side applies the damage. */
  playerShot(stats, hit) {
    this.sendHit(stats, hit.group, hit.damage);
  }

  playerKnife(origin, direction, stats, heavy) {
    const hit = knifeHit(origin, direction, stats, heavy, this.targets());
    if (hit) this.sendHit(hit.stats, hit.group, hit.damage);
    return hit;
  }

  sendHit({ headshotMultiplier, armorRatio }, group, damage) {
    this.netplay.send({ type: 'hit', stats: { headshotMultiplier, armorRatio }, group, damage });
    this.events.push({ type: 'hit', target: 'opponent', group, damage: null });
  }

  /** Our shot, so the other side hears it and sees where it hit and its tracers' ends. */
  shotFired(from, weaponId, impacts, tracers) {
    this.netplay.send({ type: 'shot', from, weapon: weaponId, impacts, tracers });
  }

  /** Our reload, so the other side hears it. */
  playerReload(weaponId, shells) {
    this.netplay.send({ type: 'reload', weapon: weaponId, shells });
  }

  /** One tick: send our state, ease the shown opponent toward theirs, and (as host) restart rounds. */
  tick(player, time, dt, held) {
    this.now = time;
    if (this.netplay.connected && ++this.ticks % SEND_EVERY === 0) {
      this.netplay.send({
        type: 'state', seq: this.ticks, pos: player.pos, vel: player.vel, yaw: player.yaw, pitch: player.pitch,
        ducked: player.ducked, onGround: Boolean(player.ground), alive: this.playerAlive, weapon: held,
      });
    }
    const { state, shown } = this.remote;
    if (state && shown) {
      const k = 1 - Math.exp(-SMOOTHING * dt);
      const ahead = state.alive ? Math.min(time - this.remote.receivedAt, MAX_EXTRAPOLATION) : 0;
      for (const axis of ['x', 'y', 'z']) {
        const target = state.pos[axis] + (axis === 'z' ? 0 : state.vel[axis] * ahead);
        shown.pos[axis] += (target - shown.pos[axis]) * k;
      }
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
    if (!state || !shown || this.waiting) return null;
    return { pos: shown.pos, yaw: shown.yaw, vel: state.vel, ducked: state.ducked, onGround: state.onGround, alive: state.alive };
  }
}
