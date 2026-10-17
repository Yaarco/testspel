/**
 * The main menu: top bar tabs (Play, Inventory, Settings), the
 * game mode picker with its options, the equipped items list and the GO
 * button. It only shows and reports choices; the game acts on them.
 */
import { storage } from './storage.js';

const MODE_KEY = 'mode';

export class Menu {
  /** `onGo(mode)` runs on GO; `onTab(tab)` when the shown page changes. */
  constructor({ onGo, onTab }) {
    this.root = document.getElementById('menu');
    this.onTab = onTab;
    this.tab = 'play';
    this.mode = storage.text(MODE_KEY, 'course');
    for (const button of document.querySelectorAll('[data-tab]')) {
      button.addEventListener('click', () => this.show(button.dataset.tab));
    }
    for (const button of this.root.querySelectorAll('.cs-mode')) {
      button.addEventListener('click', () => this.pickMode(button.dataset.mode));
    }
    document.getElementById('play').addEventListener('click', () => onGo(this.mode));
    this.pickMode(this.mode);
  }

  get visible() {
    return !this.root.hidden;
  }

  set visible(shown) {
    this.root.hidden = !shown;
  }

  show(tab) {
    this.tab = tab;
    for (const button of this.root.querySelectorAll('.cs-tab')) button.setAttribute('aria-pressed', String(button.dataset.tab === tab));
    for (const page of this.root.querySelectorAll('.cs-page')) page.hidden = page.dataset.page !== tab;
    this.onTab?.(tab);
  }

  pickMode(mode) {
    this.mode = mode;
    storage.save(MODE_KEY, mode);
    for (const button of this.root.querySelectorAll('.cs-mode')) button.setAttribute('aria-checked', String(button.dataset.mode === mode));
    for (const options of this.root.querySelectorAll('.cs-mode-options')) options.hidden = options.dataset.for !== mode;
  }

  /** Menu icons from the asset pack (white SVGs), drawn as masks so they take the text color. */
  async setIcons(pack, icons) {
    const holders = [...this.root.querySelectorAll('[data-icon]'), ...this.root.querySelectorAll('.cs-icon-sort')];
    for (const holder of holders) {
      const path = icons[holder.dataset.icon ?? 'sort'];
      if (path) holder.style.setProperty('--icon', `url("${await pack.url(path)}")`);
    }
  }

  /** The equipped items on the play page: [{ name, icon, rarity color, slot label }]. */
  showEquipped(items) {
    const list = document.getElementById('equipped');
    list.replaceChildren(...items.map(({ name, icon, color, label }) => {
      const row = document.createElement('li');
      row.style.setProperty('--rarity', color);
      const image = document.createElement('img');
      image.alt = '';
      icon?.then((url) => { image.src = url; });
      const text = document.createElement('span');
      const slot = document.createElement('small');
      slot.textContent = label;
      text.append(slot, name);
      row.append(image, text);
      return row;
    }));
  }
}
