/** Writes game status into the HUD elements, touching the DOM only when a value changes. */
const setText = (element, text) => {
  if (element.textContent !== text) element.textContent = text;
};

export class Hud {
  constructor() {
    this.fields = {
      speed: document.getElementById('hud-speed'),
      platform: document.getElementById('hud-platform'),
      best: document.getElementById('hud-best'),
    };
    this.scoreList = document.getElementById('hud-stats');
    this.weapon = document.getElementById('hud-weapon');
    this.ammo = document.getElementById('hud-ammo');
    this.fps = { element: document.getElementById('hud-fps'), frames: 0, since: 0 };
    this.ammoText = '';
    this.match = document.getElementById('hud-match');
    this.vitals = document.getElementById('hud-vitals');
    this.message = document.getElementById('hud-message');
    this.flash = document.getElementById('damage-flash');
    this.messageUntil = 0;
    this.scope = document.getElementById('scope');
    this.crosshair = document.getElementById('crosshair');
    this.scopeMode = null;
  }

  showWeapon(name) {
    setText(this.weapon, name);
  }

  /** Counts a frame (`now` in ms); twice a second shows the frames per second since the last update. */
  countFrame(now) {
    const fps = this.fps;
    fps.frames++;
    if (now - fps.since < 500) return;
    if (fps.since) setText(fps.element, `${Math.round(fps.frames * 1000 / (now - fps.since))} fps`);
    fps.frames = 0;
    fps.since = now;
  }

  /** Starts the count over, after a pause. */
  restartFps() {
    this.fps.frames = 0;
    this.fps.since = 0;
  }

  /** Clip and reserve of the gun in hand ({ clip, reserve }), or nothing for a knife. */
  showAmmo(ammo) {
    const text = ammo ? `${ammo.clip}/${ammo.reserve}` : '';
    if (text === this.ammoText) return;
    this.ammoText = text;
    this.ammo.replaceChildren(...(ammo ? [String(ammo.clip), Object.assign(document.createElement('small'), { textContent: ` / ${ammo.reserve}` })] : []));
    this.ammo.classList.toggle('empty', Boolean(ammo) && ammo.clip === 0);
  }

  /** Platform and best only mean something on the procedural course. */
  showScore(visible) {
    this.scoreList.hidden = !visible;
  }

  update(values) {
    for (const [name, value] of Object.entries(values)) setText(this.fields[name], String(Math.round(value)));
  }

  /** The 1v1 scoreboard and health, or nothing outside a match. */
  showMatch(match) {
    this.match.hidden = this.vitals.hidden = !match;
    if (!match) return;
    setText(document.getElementById('hud-opponent'), match.opponentName ?? 'Bot');
    setText(document.getElementById('hud-score-you'), String(match.score.player));
    setText(document.getElementById('hud-score-bot'), String(match.score.opponent));
    const round = match.score.player + match.score.opponent + (match.overAt === null ? 1 : 0);
    setText(document.getElementById('hud-round'), match.waiting ? 'Waiting for opponent…' : `Round ${round}`);
    setText(document.getElementById('hud-health'), String(Math.max(0, Math.round(match.you.health))));
    setText(document.getElementById('hud-armor'), String(Math.round(match.you.armor)));
  }

  say(text, time, seconds = 2) {
    setText(this.message, text);
    this.messageUntil = time + seconds;
  }

  /** Clears an expired message. */
  tick(time) {
    if (this.messageUntil && time > this.messageUntil) {
      setText(this.message, '');
      this.messageUntil = 0;
    }
  }

  /**
   * Scope view: 'scope' (a sniper's black scope with crosshair lines),
   * 'sight' (a rifle's red-dot aim sight), 'sniper' (unscoped sniper: no
   * crosshair) or null (the normal crosshair).
   */
  showScope(mode) {
    if (this.scopeMode === mode) return;
    this.scopeMode = mode;
    this.scope.dataset.mode = mode ?? '';
    this.scope.hidden = mode !== 'scope' && mode !== 'sight';
    this.crosshair.hidden = mode !== null;
  }

  /** A red edge on the screen that fades, when the player is hit. */
  hurt() {
    this.flash.classList.add('hit');
    requestAnimationFrame(() => requestAnimationFrame(() => this.flash.classList.remove('hit')));
  }
}
