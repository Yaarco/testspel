/**
 * The game data the asset tools read, decompiled by the converter into a work
 * folder: items_game (items, paint kits, rarities, collections), the English
 * localization, weapons.vdata, weapon sound events, material data dumps and
 * paint composite materials, plus the pak's file list.
 */
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseKeyValueList } from '../../src/formats/keyvalues.js';
import { parseKv3 } from '../kv3.mjs';
import { deepAssign, mergeBlocks, readText, unwrap } from './common.mjs';

export const CLIPS = 'animation/anims/viewmodel';

/** Localized strings ("token" "text" lines; texts may contain escaped quotes), keyed by lowercase token. */
function readLocalization(path) {
  const tokens = {};
  for (const match of readText(path).matchAll(/^\s*"([^"]+)"\s+"((?:[^"\\]|\\.)*)"/gm)) {
    tokens[match[1].toLowerCase()] ??= match[2].replace(/\\(.)/g, '$1');
  }
  return tokens;
}

/** Material data blocks dumped by the converter (-b DATA), keyed by material path without the _c. */
function readMaterials(path) {
  const materials = new Map();
  for (const section of readText(path).split(/^\[\d+\/\d+\] /m).slice(1)) {
    const file = section.slice(0, section.indexOf('\n')).trim();
    const data = section.indexOf('--- Data for block "DATA" ---');
    if (data < 0) continue;
    const kv = parseKv3(section.slice(data));
    const params = {};
    for (const { m_name, m_nValue } of kv.m_intParams ?? []) params[m_name] = m_nValue;
    for (const { m_name, m_flValue } of kv.m_floatParams ?? []) params[m_name] = m_flValue;
    for (const { m_name, m_value } of kv.m_vectorParams ?? []) params[m_name] = m_value;
    for (const { m_name, m_pValue } of kv.m_textureParams ?? []) params[m_name] = m_pValue;
    for (const { m_name, m_value } of kv.m_stringAttributes ?? []) params[m_name] = m_value;
    materials.set(file.replace(/_c$/, ''), { shader: kv.m_shaderName, params });
  }
  return materials;
}

export class GameData {
  constructor(work) {
    this.work = work;
    const game = parseKeyValueList(readText(join(work, 'scripts/items/items_game.txt'))).items_game[0];
    this.prefabs = mergeBlocks(game.prefabs);
    this.items = Object.values(mergeBlocks(game.items)).map((item) => this.resolveItem(unwrap([item])));
    this.kits = new Map(Object.values(mergeBlocks(game.paint_kits)).map((kit) => unwrap([kit])).map((kit) => [kit.name, kit]));
    this.lootLists = (game.client_loot_lists ?? []).flatMap((block) => Object.values(block).map((list) => Object.keys(list[0])));
    this.kitRarity = new Map(Object.entries(mergeBlocks(game.paint_kits_rarity)));
    this.tokens = readLocalization(join(work, 'resource/csgo_english.txt'));
    this.rarities = this.readRarities(mergeBlocks(game.rarities), mergeBlocks(game.colors));
    this.collections = new Map();   // "[kit]item" -> collection name
    for (const set of Object.values(mergeBlocks(game.item_sets)).map((block) => unwrap([block]))) {
      const name = this.localize(set.name);
      for (const key of Object.keys(set.items ?? {})) if (name) this.collections.set(key, name);
    }
    this.vdata = parseKv3(readText(join(work, 'scripts/weapons.vdata')));
    this.events = new Map(Object.entries(parseKv3(readText(join(work, 'soundevents/game_sounds_weapons.vsndevts'))))
      .map(([name, event]) => [name.toLowerCase(), event]));
    this.materials = readMaterials(join(work, 'vmats.txt'));
    this.paths = new Set(readText(join(work, 'paths.txt')).split('\n').map((line) => line.split(' ')[0]).filter(Boolean));
    this.clipFolders = new Map();   // viewmodel animation folder -> clip names
    for (const path of this.paths) {
      if (!path.startsWith(`${CLIPS}/`) || !path.endsWith('.vnmclip_c') || path.includes('+') || path.includes('_lgcy')) continue;
      const folder = dirname(path).slice(CLIPS.length + 1);
      this.clipFolders.set(folder, [...(this.clipFolders.get(folder) ?? []), basename(path, '.vnmclip_c')]);
    }
    this.compositeMaterials = new Map(this.listFiles(join(work, 'weapons/paints'), '.vcompmat')
      .map((file) => [basename(file, '.vcompmat'), file]));
    this.gloveMaterials = new Map(this.listFiles(join(work, 'gloves/paints'), '.vcompmat')
      .map((file) => [basename(file, '.vcompmat'), file]));
    // Every item-finish pair that has an inventory icon: the reliable list of what exists.
    this.icons = [];
    for (const path of this.paths) {
      const match = path.match(/^panorama\/images\/econ\/default_generated\/(.+)_light_png\.vtex_c$/);
      if (match) this.icons.push({ stem: match[1], icon: path.replace(/_c$/, '') });
    }
  }

  /** Rarity name -> { value, color, weapon (e.g. "Covert"), character (e.g. "Master") }. */
  readRarities(rarities, colors) {
    const out = {};
    for (const [name, block] of Object.entries(rarities)) {
      const rarity = unwrap([block]);
      out[name] = {
        value: Number(rarity.value),
        color: unwrap([colors[rarity.color]])?.hex_color ?? '#b0c3d9',
        weapon: this.localize(rarity.loc_key_weapon) ?? name,
        character: this.localize(rarity.loc_key_character) ?? name,
      };
    }
    return out;
  }

  /** Finishes an item has inventory icons for: [{ kit, icon }]. */
  finishIcons(itemName) {
    const prefix = `${itemName}_`;
    return this.icons.filter(({ stem }) => stem.startsWith(prefix) && this.kits.has(stem.slice(prefix.length)))
      .map(({ stem, icon }) => ({ kit: stem.slice(prefix.length), icon }));
  }

  listFiles(folder, extension) {
    if (!existsSync(folder)) return [];
    return readdirSync(folder, { recursive: true }).map((file) => join(folder, file)).filter((file) => file.endsWith(extension));
  }

  /** An item with its prefab chain applied ("prefab" "a b" names several, later ones win). */
  resolveItem(item) {
    const base = {};
    for (const name of (item.prefab ?? '').split(' ').filter(Boolean)) {
      const prefab = this.prefabs[name];
      if (prefab) deepAssign(base, this.resolveItem(unwrap([prefab])));
    }
    return deepAssign(base, item);
  }

  localize(token) {
    return token ? this.tokens[token.replace(/^#/, '').toLowerCase()] ?? null : null;
  }
}

