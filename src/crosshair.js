/**
 * The crosshair and its customizer (Settings → Crosshair), with the classic
 * options: length, thickness, gap, color and alpha, an outline, a center
 * dot, the T style (no top line) and a dynamic style whose gap opens with
 * the gun's current inaccuracy. Sizes are in crosshair units, scaled with
 * the screen height so the crosshair looks the same at any resolution.
 * Settings are remembered; a live preview shows each change.
 */
import { element } from './dom.js';
import { storage } from './storage.js';

const STORAGE_KEY = 'crosshair';
const UNITS_PER_SCREEN = 480;   // one unit is 1/480 of the screen height
const LINES = ['top', 'bottom', 'left', 'right'];
export const CROSSHAIR_DEFAULTS = {
  style: 'static', length: 3, thickness: 1, gap: 1, dot: false, tStyle: false,
  outline: true, outlineThickness: 1, color: '#5ff3ff', alpha: 1,
};
const SLIDERS = [
  { key: 'length', label: 'Length', min: 0, max: 10, step: 0.5 },
  { key: 'thickness', label: 'Thickness', min: 0.5, max: 6, step: 0.5 },
  { key: 'gap', label: 'Gap', min: -2, max: 10, step: 0.5 },
  { key: 'outlineThickness', label: 'Outline thickness', min: 0.5, max: 3, step: 0.5 },
  { key: 'alpha', label: 'Alpha', min: 0.1, max: 1, step: 0.05 },
];
const TOGGLES = [
  { key: 'dot', label: 'Center dot' },
  { key: 'tStyle', label: 'T style' },
  { key: 'outline', label: 'Outline' },
];
const SWATCHES = ['#5ff3ff', '#32ff32', '#ffff00', '#ff3c3c', '#3c78ff', '#ff3cff', '#ffffff'];

/** One drawn crosshair: four lines and a dot, laid out in whole pixels around its element's position. */
class CrosshairView {
  constructor(root) {
    this.root = root;
    this.parts = Object.fromEntries([...LINES, 'dot'].map((name) => {
      const part = element('span', `ch-part ch-${name}`);
      root.append(part);
      return [name, part];
    }));
    this.key = '';
  }

  /** Lays the parts out for `settings` with `spread` extra pixels of gap, at `scale` pixels per unit. */
  draw(settings, spread, scale) {
    const px = (units) => Math.max(1, Math.round(units * scale));
    const thick = px(settings.thickness);
    const length = settings.length > 0 ? px(settings.length) : 0;
    const offset = Math.max(0, Math.round(settings.gap * scale) + Math.ceil(thick / 2)) + Math.round(spread);
    const key = `${thick}/${length}/${offset}`;
    this.root.style.setProperty('--ch-color', settings.color);
    this.root.style.setProperty('--ch-alpha', settings.alpha);
    this.root.style.setProperty('--ch-outline', settings.outline ? `${px(settings.outlineThickness)}px` : '0px');
    this.parts.top.hidden = settings.tStyle || !length;
    for (const name of ['bottom', 'left', 'right']) this.parts[name].hidden = !length;
    this.parts.dot.hidden = !settings.dot;
    if (key === this.key) return;
    this.key = key;
    const half = Math.floor(thick / 2);
    const place = (part, left, top, width, height) => Object.assign(part.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    place(this.parts.top, -half, -offset - length, thick, length);
    place(this.parts.bottom, -half, offset, thick, length);
    place(this.parts.left, -offset - length, -half, length, thick);
    place(this.parts.right, offset, -half, length, thick);
    place(this.parts.dot, -half, -half, thick, thick);
  }
}

export class Crosshair {
  /** `root` is the in-game crosshair; `editor` the Settings section to build the customizer in. */
  constructor(root, editor) {
    this.settings = { ...CROSSHAIR_DEFAULTS, ...storage.json(STORAGE_KEY, {}) };
    this.view = new CrosshairView(root);
    this.spread = 0;
    const preview = element('div', 'ch-preview');
    const previewCrosshair = element('div', 'crosshair');
    preview.append(previewCrosshair);
    this.preview = new CrosshairView(previewCrosshair);
    this.buildEditor(editor, preview);
    this.redraw();
    window.addEventListener('resize', () => this.redraw());
  }

  get dynamic() {
    return this.settings.style === 'dynamic';
  }

  get scale() {
    return window.innerHeight / UNITS_PER_SCREEN;
  }

  /** The dynamic style's extra gap, in pixels; ignored by the static style. */
  setSpread(pixels) {
    const spread = this.dynamic ? Math.round(pixels) : 0;
    if (spread === this.spread) return;
    this.spread = spread;
    this.view.draw(this.settings, spread, this.scale);
  }

  redraw() {
    this.view.draw(this.settings, this.spread, this.scale);
    this.preview.draw(this.settings, 0, this.scale);
  }

  change(key, value) {
    this.settings[key] = value;
    storage.save(STORAGE_KEY, this.settings);
    this.redraw();
  }

  buildEditor(editor, preview) {
    const controls = [];
    const style = element('select');
    style.append(new Option('Static', 'static'), new Option('Dynamic (shows spread)', 'dynamic'));
    style.addEventListener('change', () => this.change('style', style.value));
    controls.push([this.field('Style', style), () => { style.value = this.settings.style; }]);

    for (const { key, label, min, max, step } of SLIDERS) {
      const input = element('input');
      Object.assign(input, { type: 'range', min, max, step });
      const value = element('output', 'ch-value');
      input.addEventListener('input', () => {
        value.textContent = input.value;
        this.change(key, Number(input.value));
      });
      const row = this.field(label, input);
      row.append(value);
      controls.push([row, () => { input.value = this.settings[key]; value.textContent = String(this.settings[key]); }]);
    }
    for (const { key, label } of TOGGLES) {
      const input = element('input');
      input.type = 'checkbox';
      input.addEventListener('change', () => this.change(key, input.checked));
      controls.push([this.field(label, input), () => { input.checked = this.settings[key]; }]);
    }

    const color = element('input');
    color.type = 'color';
    color.addEventListener('input', () => this.change('color', color.value));
    const swatches = element('div', 'ch-swatches');
    for (const swatch of SWATCHES) {
      const button = element('button', 'ch-swatch');
      button.type = 'button';
      button.style.background = swatch;
      button.setAttribute('aria-label', `Color ${swatch}`);
      button.addEventListener('click', () => {
        color.value = swatch;
        this.change('color', swatch);
      });
      swatches.append(button);
    }
    controls.push([this.field('Color', color), () => { color.value = this.settings.color; }]);

    const reset = element('button', 'cs-button', 'Reset to default');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      this.settings = { ...CROSSHAIR_DEFAULTS };
      storage.save(STORAGE_KEY, this.settings);
      sync();
      this.redraw();
    });
    const sync = () => controls.forEach(([, update]) => update());
    sync();
    editor.replaceChildren(preview, ...controls.map(([row]) => row), swatches, reset);
  }

  field(label, input) {
    const row = element('label', 'cs-field');
    row.append(label, input);
    return row;
  }
}
