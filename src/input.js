/**
 * Keyboard and mouse input using the classic default binds (movement, weapon
 * slots 1-3, Q for the last weapon, F to inspect, B for the skin changer, mouse buttons to attack), plus the
 * standard bhop binds: bind mwheelup +jump and bind mwheeldown +jump.
 * Keys are matched by physical position (event.code), so they work on any layout.
 */
import { CONVARS, MOUSE } from './config.js';

const BINDS = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'moveleft',
  KeyD: 'moveright',
  Space: 'jump',
  ControlLeft: 'duck',
  ControlRight: 'duck',
  ShiftLeft: 'speed',
  ShiftRight: 'speed',
  KeyR: 'restart',
  Digit1: 'slot1',
  Digit2: 'slot2',
  Digit3: 'slot3',
  KeyQ: 'lastinv',
  KeyF: 'inspect',
  KeyB: 'skins',
};
const MOUSE_BINDS = { 0: 'attack', 2: 'attack2' };
const ONE_SHOT = new Set(['restart', 'slot1', 'slot2', 'slot3', 'lastinv', 'inspect', 'skins']);

export class Input {
  constructor() {
    this.enabled = false;
    this.sensitivity = MOUSE.defaultSensitivity;
    this.held = new Set();
    this.wheelJump = false;     // a wheel notch presses +jump for exactly one tick
    this.pressed = new Set();   // one-shot commands since the last tick
    this.clicked = new Set();   // mouse buttons pressed since the last tick, so short clicks count
    this.mouse = { dx: 0, dy: 0 };

    window.addEventListener('keydown', (event) => this.onKeyDown(event));
    window.addEventListener('keyup', (event) => this.held.delete(BINDS[event.code]));
    window.addEventListener('wheel', (event) => this.onWheel(event), { passive: false });
    window.addEventListener('blur', () => this.held.clear());
    document.addEventListener('mousemove', (event) => this.onMouseMove(event));
    document.addEventListener('mousedown', (event) => {
      const action = MOUSE_BINDS[event.button];
      if (!this.enabled || !action) return;
      this.held.add(action);
      this.clicked.add(action);
    });
    document.addEventListener('mouseup', (event) => this.held.delete(MOUSE_BINDS[event.button]));
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) this.held.clear();
  }

  onKeyDown(event) {
    if (!this.enabled) return;
    const action = BINDS[event.code];
    // Ctrl is duck, so block browser shortcuts such as Ctrl+D (bookmark) and Ctrl+S (save).
    if (action || event.ctrlKey || event.metaKey) event.preventDefault();
    if (!action) return;

    if (ONE_SHOT.has(action)) {
      if (!event.repeat) this.pressed.add(action);
    } else {
      this.held.add(action);
    }
  }

  onWheel(event) {
    if (!this.enabled) return;
    event.preventDefault();
    this.wheelJump = true;
  }

  onMouseMove(event) {
    if (!this.enabled) return;
    this.mouse.dx += event.movementX;
    this.mouse.dy += event.movementY;
  }

  /**
   * Applies accumulated mouse movement to view angles, scaled by m_yaw and
   * m_pitch; `scale` slows it while scoped (field of view / 90).
   */
  applyMouseLook(player, scale = 1) {
    player.yaw -= this.mouse.dx * this.sensitivity * scale * MOUSE.m_yaw;
    player.pitch += this.mouse.dy * this.sensitivity * scale * MOUSE.m_pitch;
    player.pitch = Math.max(-MOUSE.maxPitch, Math.min(player.pitch, MOUSE.maxPitch));
    player.yaw = ((player.yaw % 360) + 360) % 360;
    this.mouse.dx = 0;
    this.mouse.dy = 0;
  }

  /** Builds the user command for one tick, then releases one-tick presses. */
  createUserCmd() {
    const isHeld = (action) => (this.held.has(action) ? 1 : 0);
    const cmd = {
      forwardmove: (isHeld('forward') - isHeld('back')) * CONVARS.cl_forwardspeed,
      sidemove: (isHeld('moveright') - isHeld('moveleft')) * CONVARS.cl_sidespeed,
      jump: this.held.has('jump') || this.wheelJump,
      duck: this.held.has('duck'),
      walk: this.held.has('speed'),
      attack: this.held.has('attack') || this.clicked.has('attack'),
      attack2: this.held.has('attack2') || this.clicked.has('attack2'),
      slot: [1, 2, 3].find((n) => this.pressed.has(`slot${n}`)) ?? 0,
      lastWeapon: this.pressed.has('lastinv'),
      inspect: this.pressed.has('inspect'),
      skins: this.pressed.has('skins'),
      restart: this.pressed.has('restart'),
    };
    this.wheelJump = false;
    this.pressed.clear();
    this.clicked.clear();
    return cmd;
  }
}
