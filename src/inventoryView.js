/**
 * The inventory: a grid of every item (each gun and
 * knife plain and in every finish, gloves, agents) with category tabs, a
 * search box and sort order, and an item panel to set an item's wear and
 * pattern and equip it. Equipped items carry a marker; choices are
 * remembered between sessions.
 *
 * Item icons come from the asset pack and load only as their tiles
 * scroll into view, so browsing thousands of items stays light.
 */
import { exteriorName } from './exterior.js';

const CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'knife', label: 'Knives' },
  { id: 'gloves', label: 'Gloves' },
  { id: 'pistol', label: 'Pistols' },
  { id: 'midtier', label: 'Mid-Tier' },
  { id: 'rifle', label: 'Rifles' },
  { id: 'agent', label: 'Agents' },
];
const SORTS = [
  { id: 'rarity', label: 'Quality' },
  { id: 'name', label: 'Alphabetical' },
  { id: 'type', label: 'Type' },
  { id: 'collection', label: 'Collection' },
  { id: 'equipped', label: 'Equipped' },
];
const CATEGORY_ORDER = Object.fromEntries(CATEGORIES.map(({ id }, i) => [id, i]));
const STORAGE_KEY = 'loadout';
const DEFAULT_LOADOUT = {
  primary: { id: 'ak47', finish: null, wear: 0, seed: 0 },
  secondary: { id: 'usp_silencer', finish: null, wear: 0, seed: 0 },
  knife: { id: 'knife', finish: null, wear: 0, seed: 0 },
  gloves: null,
  agent: null,
};
const STAR = '★ ';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function categoryOf(weapon) {
  if (weapon.slot === 'knife') return 'knife';
  return { pistol: 'pistol', smg: 'midtier', heavy: 'midtier' }[weapon.type] ?? 'rifle';
}

/** Every item the manifest describes, flattened for the grid. */
function buildItems(manifest) {
  const items = [];
  for (const [weaponId, weapon] of Object.entries(manifest.weapons)) {
    const star = weapon.slot === 'knife' && weapon.rarity !== 'default' ? STAR : '';
    const category = categoryOf(weapon);
    items.push({ key: `w/${weaponId}`, kind: 'weapon', weaponId, finish: null, name: star + weapon.name, icon: weapon.icon, rarity: weapon.rarity, category, collection: null, wear: [0, 0] });
    for (const f of weapon.finishes) {
      const finish = manifest.finishes[f.id];
      items.push({
        key: `w/${weaponId}/${f.id}`, kind: 'weapon', weaponId, finish: f.id, name: `${star}${weapon.name} | ${finish.name}`,
        icon: f.icon, rarity: f.rarity, category, collection: f.collection, wear: finish.wear,
      });
    }
  }
  for (const [gloveId, glove] of Object.entries(manifest.gloves ?? {})) {
    for (const f of glove.finishes) {
      const finish = manifest.gloveFinishes[f.id];
      items.push({
        key: `g/${f.id}`, kind: 'gloves', gloveId, finish: f.id, name: `${STAR}${glove.name} | ${finish.name}`,
        icon: f.icon, rarity: f.rarity, category: 'gloves', collection: null, wear: finish.wear,
      });
    }
  }
  for (const [agentId, agent] of Object.entries(manifest.agents ?? {})) {
    items.push({ key: `a/${agentId}`, kind: 'agent', agentId, name: agent.name, icon: agent.icon, rarity: agent.rarity, category: 'agent', collection: agent.team === 'ct' ? 'Counter-Terrorist' : 'Terrorist', wear: [0, 0] });
  }
  return items;
}

function loadSaved(manifest) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {}; } catch { /* storage unavailable */ }
  const loadout = { ...DEFAULT_LOADOUT };
  for (const slot of ['primary', 'secondary', 'knife']) {
    const entry = saved[slot];
    const weapon = manifest.weapons[entry?.id];
    if (weapon?.slot === slot) loadout[slot] = { id: entry.id, finish: weapon.finishes.some((f) => f.id === entry.finish) ? entry.finish : null, wear: entry.wear ?? 0, seed: entry.seed ?? 0 };
  }
  if (saved.gloves && manifest.gloveFinishes?.[saved.gloves.finish]) loadout.gloves = saved.gloves;
  if (saved.agent && manifest.agents?.[saved.agent.id]) loadout.agent = saved.agent;
  for (const slot of ['primary', 'secondary', 'knife']) {
    if (!manifest.weapons[loadout[slot].id]) loadout[slot] = { ...loadout[slot], id: Object.keys(manifest.weapons).find((id) => manifest.weapons[id].slot === slot) };
  }
  return loadout;
}

export class InventoryView {
  /**
   * `root` is the inventory page. `onChange(loadout, slot)` runs whenever
   * something is equipped, with { primary, secondary, knife, gloves, agent };
   * `onInspect(slot)` previews a slot's weapon.
   */
  constructor(root, pack, manifest, { onChange, onInspect }) {
    this.root = root;
    this.pack = pack;
    this.manifest = manifest;
    this.onChange = onChange;
    this.onInspect = onInspect;
    this.items = buildItems(manifest);
    this.loadout = loadSaved(manifest);
    this.category = 'all';
    this.sort = 'rarity';
    this.search = '';
    this.selected = null;
    this.icons = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const image = entry.target;
        this.icons.unobserve(image);
        this.pack.url(image.dataset.icon).then((url) => { image.src = url; });
      }
    }, { root: null, rootMargin: '200px' });
    this.build();
    this.onChange(this.loadout, null);
  }

  build() {
    const root = this.root;
    root.replaceChildren();
    const toolbar = element('div', 'inv-toolbar');
    const tabs = element('nav', 'inv-tabs');
    tabs.setAttribute('aria-label', 'Item categories');
    for (const { id, label } of CATEGORIES) {
      const tab = element('button', 'inv-tab', label);
      tab.type = 'button';
      tab.dataset.category = id;
      tab.addEventListener('click', () => { this.category = id; this.renderGrid(); });
      tabs.append(tab);
    }
    const search = element('input', 'inv-search');
    search.type = 'search';
    search.placeholder = 'Search';
    search.setAttribute('aria-label', 'Search items');
    search.addEventListener('input', () => { this.search = search.value.trim().toLowerCase(); this.renderGrid(); });
    const sortLabel = element('label', 'inv-sort');
    sortLabel.append(element('span', 'cs-icon cs-icon-sort'), element('span', '', 'Sort by'));
    const sort = element('select');
    for (const { id, label } of SORTS) sort.append(new Option(label, id));
    sort.addEventListener('change', () => { this.sort = sort.value; this.renderGrid(); });
    sortLabel.append(sort);
    toolbar.append(tabs, search, sortLabel);

    this.grid = element('div', 'inv-grid');
    this.grid.setAttribute('role', 'list');
    this.detail = element('aside', 'inv-detail');
    this.detail.setAttribute('aria-live', 'polite');
    const body = element('div', 'inv-body');
    body.append(this.grid, this.detail);
    root.append(toolbar, body);
    this.renderGrid();
    this.renderDetail();
  }

  /** The loadout slot an item goes in. */
  slotOf(item) {
    if (item.kind === 'weapon') return this.manifest.weapons[item.weaponId].slot;
    return item.kind === 'gloves' ? 'gloves' : 'agent';
  }

  isEquipped(item) {
    const entry = this.loadout[this.slotOf(item)];
    if (!entry) return false;
    if (item.kind === 'weapon') return entry.id === item.weaponId && (entry.finish ?? null) === item.finish;
    if (item.kind === 'gloves') return entry.finish === item.finish;
    return entry.id === item.agentId;
  }

  visibleItems() {
    const rarity = (item) => this.manifest.rarities?.[item.rarity]?.value ?? 0;
    const list = this.items.filter((item) => (this.category === 'all' || item.category === this.category)
      && (!this.search || item.name.toLowerCase().includes(this.search)));
    const byName = (a, b) => a.name.localeCompare(b.name);
    const compare = {
      rarity: (a, b) => rarity(b) - rarity(a) || byName(a, b),
      name: byName,
      type: (a, b) => CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] || byName(a, b),
      collection: (a, b) => (a.collection ?? '~').localeCompare(b.collection ?? '~') || byName(a, b),
      equipped: (a, b) => Number(this.isEquipped(b)) - Number(this.isEquipped(a)) || rarity(b) - rarity(a) || byName(a, b),
    }[this.sort];
    return list.sort(compare);
  }

  renderGrid() {
    for (const tab of this.root.querySelectorAll('.inv-tab')) tab.setAttribute('aria-pressed', String(tab.dataset.category === this.category));
    this.icons.disconnect();
    const tiles = this.visibleItems().map((item) => this.tile(item));
    this.grid.replaceChildren(...tiles);
    this.grid.scrollTop = 0;
  }

  tile(item) {
    const rarity = this.manifest.rarities?.[item.rarity];
    const tile = element('button', 'inv-tile');
    tile.type = 'button';
    tile.setAttribute('role', 'listitem');
    tile.style.setProperty('--rarity', rarity?.color ?? '#b0c3d9');
    tile.setAttribute('aria-pressed', String(this.selected?.key === item.key));
    if (this.isEquipped(item)) tile.classList.add('equipped');
    const image = element('img', 'inv-icon');
    image.alt = '';
    image.decoding = 'async';
    if (item.icon) {
      image.dataset.icon = item.icon;
      this.icons.observe(image);
    }
    const [weaponName, finishName] = item.name.split(' | ');
    tile.append(image, element('span', 'inv-name', weaponName), element('span', 'inv-finish', finishName ?? ''));
    tile.addEventListener('click', () => this.select(item));
    tile.addEventListener('dblclick', () => this.equip(item));
    return tile;
  }

  select(item) {
    this.selected = item;
    for (const tile of this.grid.querySelectorAll('[aria-pressed="true"]')) tile.setAttribute('aria-pressed', 'false');
    const index = this.visibleItems().findIndex((other) => other.key === item.key);
    this.grid.children[index]?.setAttribute('aria-pressed', 'true');
    const entry = this.loadout[this.slotOf(item)];
    const equipped = this.isEquipped(item);
    this.pending = { wear: equipped ? entry.wear ?? item.wear[0] : item.wear[0], seed: equipped ? entry.seed ?? 0 : 0 };
    this.renderDetail();
  }

  renderDetail() {
    const item = this.selected;
    const detail = this.detail;
    detail.replaceChildren();
    if (!item) {
      detail.append(element('p', 'inv-hint', 'Select an item to see it, set its wear and pattern, and equip it. Double-click equips straight away.'));
      return;
    }
    const rarity = this.manifest.rarities?.[item.rarity];
    detail.style.setProperty('--rarity', rarity?.color ?? '#b0c3d9');
    const image = element('img', 'inv-detail-icon');
    image.alt = '';
    if (item.icon) this.pack.url(item.icon).then((url) => { image.src = url; });
    const kindName = item.kind === 'agent' ? rarity?.character : rarity?.weapon;
    const typeName = { knife: 'Knife', gloves: 'Gloves', pistol: 'Pistol', midtier: 'Mid-Tier', rifle: 'Rifle', agent: 'Agent' }[item.category];
    detail.append(image, element('h3', 'inv-detail-name', item.name), element('p', 'inv-detail-rarity', `${kindName ?? ''} ${typeName}`.trim()));
    if (item.collection) detail.append(element('p', 'inv-detail-collection', item.collection));

    const [min, max] = item.wear;
    if (item.finish) {
      const wearRow = element('label', 'inv-wear');
      const wear = element('input');
      Object.assign(wear, { type: 'range', min, max, step: 0.001, value: this.pending.wear });
      const text = element('output', '', `${Number(this.pending.wear).toFixed(3)} · ${exteriorName(this.pending.wear)}`);
      wear.addEventListener('input', () => {
        this.pending.wear = Number(wear.value);
        text.textContent = `${this.pending.wear.toFixed(3)} · ${exteriorName(this.pending.wear)}`;
      });
      wear.addEventListener('change', () => this.isEquipped(item) && this.equip(item));
      wearRow.append(element('span', '', 'Wear'), wear, text);
      const seedRow = element('div', 'inv-seed');
      const seed = element('input');
      Object.assign(seed, { type: 'number', min: 0, max: 1000, step: 1, value: this.pending.seed });
      seed.setAttribute('aria-label', 'Pattern');
      seed.addEventListener('change', () => {
        this.pending.seed = Math.max(0, Math.min(1000, Math.round(Number(seed.value) || 0)));
        if (this.isEquipped(item)) this.equip(item);
      });
      const random = element('button', 'cs-button', 'Random');
      random.type = 'button';
      random.addEventListener('click', () => {
        this.pending.seed = Math.floor(Math.random() * 1001);
        seed.value = this.pending.seed;
        if (this.isEquipped(item)) this.equip(item);
      });
      seedRow.append(element('span', '', 'Pattern'), seed, random);
      detail.append(wearRow, seedRow);
    }

    const actions = element('div', 'inv-actions');
    const equipped = this.isEquipped(item);
    const equip = element('button', 'cs-button cs-primary', equipped ? 'Equipped' : 'Equip');
    equip.type = 'button';
    equip.disabled = equipped && item.kind === 'agent';
    equip.addEventListener('click', () => this.equip(item));
    actions.append(equip);
    if (equipped && (item.kind === 'gloves' || item.kind === 'agent')) {
      const remove = element('button', 'cs-button', 'Unequip');
      remove.type = 'button';
      remove.addEventListener('click', () => this.unequip(item));
      actions.append(remove);
    }
    if (item.kind === 'weapon') {
      const inspect = element('button', 'cs-button', 'Inspect (F)');
      inspect.type = 'button';
      inspect.addEventListener('click', () => this.onInspect(this.slotOf(item)));
      actions.append(inspect);
    }
    detail.append(actions);
  }

  equip(item) {
    const slot = this.slotOf(item);
    const { wear, seed } = this.pending ?? { wear: item.wear[0], seed: 0 };
    const entry = item.kind === 'weapon' ? { id: item.weaponId, finish: item.finish, wear, seed }
      : item.kind === 'gloves' ? { id: item.gloveId, finish: item.finish, wear, seed }
        : { id: item.agentId };
    this.commit({ ...this.loadout, [slot]: entry }, slot);
  }

  unequip(item) {
    const slot = this.slotOf(item);
    this.commit({ ...this.loadout, [slot]: null }, slot);
  }

  commit(loadout, slot) {
    this.loadout = loadout;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(loadout)); } catch { /* storage unavailable */ }
    for (const tile of this.grid.querySelectorAll('.inv-tile.equipped')) tile.classList.remove('equipped');
    const visible = this.visibleItems();
    visible.forEach((item, i) => { if (this.isEquipped(item)) this.grid.children[i]?.classList.add('equipped'); });
    this.renderDetail();
    this.onChange(loadout, slot);
  }

  /** The equipped items, for the play page: [{ name, icon, rarity }]. */
  equippedItems() {
    return this.items.filter((item) => this.isEquipped(item));
  }
}
