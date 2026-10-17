/**
 * The buy menu (B), laid out like the classic one: columns of pistols,
 * mid-tier guns (SMGs and heavy), rifles, knives and gloves. A number key
 * picks a column and a second one an item, or click an item. Buying puts
 * the item in its loadout slot with the finish last equipped for it in the
 * inventory (see InventoryView.buy) and brings it out. B or a click beside
 * the menu closes it back to the game; Esc closes it to the main menu.
 */
import { element } from './dom.js';
import { categoryOf } from './inventoryView.js';

const COLUMNS = [
  { id: 'pistol', label: 'Pistols' },
  { id: 'midtier', label: 'Mid-Tier' },
  { id: 'rifle', label: 'Rifles' },
  { id: 'knife', label: 'Knives' },
  { id: 'gloves', label: 'Gloves' },
];
const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'];

/** The buyable items per column: { kind: 'weapon' | 'gloves', id, name, icon }. */
function buildColumns(manifest) {
  const columns = Object.fromEntries(COLUMNS.map(({ id }) => [id, []]));
  for (const [id, weapon] of Object.entries(manifest.weapons)) {
    columns[categoryOf(weapon)].push({ kind: 'weapon', id, name: weapon.name, icon: weapon.icon });
  }
  for (const [id, glove] of Object.entries(manifest.gloves ?? {})) {
    if (glove.finishes.length) columns.gloves.push({ kind: 'gloves', id, name: glove.name, icon: glove.finishes[0].icon });
  }
  for (const list of Object.values(columns)) list.sort((a, b) => a.name.localeCompare(b.name));
  // The default knife first, like the free one you spawn with.
  columns.knife.sort((a, b) => Number(b.id === 'knife') - Number(a.id === 'knife'));
  return columns;
}

export class BuyMenu {
  /** `onBuy(kind, id)` buys an item; `onClose(resume)` runs when the menu closes without buying, `resume` to go back to playing. */
  constructor(root, pack, manifest, { onBuy, onClose }) {
    this.root = root;
    this.pack = pack;
    this.onBuy = onBuy;
    this.onClose = onClose;
    this.columns = buildColumns(manifest);
    this.column = null;   // picked by number key
    this.build();
  }

  get visible() {
    return !this.root.hidden;
  }

  open() {
    this.pick(null);
    this.root.hidden = false;
  }

  close(resume) {
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.onClose(resume);
  }

  build() {
    const panel = element('div', 'buy-panel');
    const header = element('header', 'buy-header');
    header.append(element('h2', 'cs-heading', 'Buy menu'), element('span', 'cs-hint', '1–5 pick a column, then an item · B or Esc closes'));
    const body = element('div', 'buy-columns');
    this.columnElements = COLUMNS.map(({ id, label }, c) => {
      const column = element('section', 'buy-column');
      column.append(element('h3', 'buy-column-title', `${c + 1}  ${label}`));
      const list = element('ol', 'buy-list');
      this.columns[id].forEach((item, i) => {
        const button = element('button', 'buy-item');
        button.type = 'button';
        const image = element('img', 'buy-icon');
        image.alt = '';
        image.loading = 'lazy';
        if (item.icon) this.pack.url(item.icon).then((url) => { image.src = url; });
        button.append(element('span', 'buy-key', i < DIGITS.length ? String(i + 1) : ''), image, element('span', 'buy-name', item.name));
        button.addEventListener('click', () => this.buy(item));
        const row = element('li');
        row.append(button);
        list.append(row);
      });
      column.append(list);
      body.append(column);
      return column;
    });
    panel.append(header, body);
    this.root.replaceChildren(panel);
    this.root.addEventListener('click', (event) => { if (event.target === this.root) this.close(true); });
  }

  pick(column) {
    this.column = column;
    this.columnElements.forEach((element, c) => element.classList.toggle('picked', c === column));
  }

  buy(item) {
    this.root.hidden = true;
    this.onBuy(item.kind, item.id);
  }

  /** A key while the menu is open; returns true when the menu used it. */
  key(code) {
    if (code === 'Escape' || code === 'KeyB') {
      this.close(code === 'KeyB');
      return true;
    }
    const digit = DIGITS.indexOf(code);
    if (digit < 0) return false;
    if (this.column === null) {
      if (digit < COLUMNS.length) this.pick(digit);
    } else {
      const item = this.columns[COLUMNS[this.column].id][digit];
      if (item) this.buy(item);
    }
    return true;
  }
}
