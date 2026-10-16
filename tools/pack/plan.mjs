/**
 * The plan step: decides everything the game uses and lists the files to
 * extract that are not in the output folder yet (so re-running only fetches
 * what is new or missing):
 *   - every gun and knife with every finish that has an inventory icon,
 *   - gloves with their finishes, agents (first-person sleeves and gloves,
 *     third-person body), third-person and main menu animations,
 *   - inventory icons, menu icons and fonts, weapon and movement sounds.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { compiled, lines, webp, withoutExtension } from './common.mjs';
import { GameData } from './gameData.mjs';
import { readGloveFinish } from './gloves.mjs';
import {
  ALBEDO_STYLES, CLIP_FOLDERS, FINISH_VARIANTS, STYLE_NAMES, compositesIn, drawSound, eventSound, finishLabel,
  finishRecord, pickClips, readFinish, weaponStats,
} from './weapons.mjs';

const FOOTSTEPS = 'sounds/player/footsteps';
const SURFACES = 'concrete_ct|dirt|glass|grass|gravel|metal_solid|metal_grate|metal_chainlink|mud|rubber|sand|snow|tile|wood|carpet';
const WEAR_TEXTURE = 'materials/models/weapons/customization/shared/paint_wear_psd_a2abffd8.vtex';
const GRUNGE_TEXTURE = 'materials/models/weapons/customization/shared/gun_grunge_psd_f3419fed.vtex';
const ARMS = 'weapons/models/shared/arms/weapon_arms.vmdl';
const WORLD_CLIPS = 'animation/anims/world';
const MENU_CLIPS = 'animation/anims/ui_anims/main_menu';
const UI_ICONS = ['play', 'inventory', 'loadout', 'settings', 'power', 'sort', 'search', 'watch', 'news', 'profile', 'bot', 'home'];
const FONTS = ['notosans-regular.ttf', 'notosans-bold.ttf'];

// Texture size limits, in pixels.
export const MAX_SIZE = {
  gunColor: 2048, knifeColor: 1024, armsColor: 1024, agentColor: 1024,
  albedoPattern: 2048, pattern: 1024, input: 1024, icon: 256,
};
const WEAPON_TYPES = {
  WEAPONTYPE_PISTOL: 'pistol', WEAPONTYPE_SUBMACHINEGUN: 'smg', WEAPONTYPE_RIFLE: 'rifle',
  WEAPONTYPE_SNIPER_RIFLE: 'rifle', WEAPONTYPE_SHOTGUN: 'heavy', WEAPONTYPE_MACHINEGUN: 'heavy',
};
// Third-person animations the bot uses, per weapon category.
const BODY_CLIPS = ['idle', 'idle_crouch', 'run_n', 'run_ne', 'run_e', 'run_se', 'run_s', 'run_sw', 'run_w', 'run_nw', 'crouch_n', 'crouch_e', 'crouch_s', 'crouch_w', 'inair_stand'];
// Main menu poses per team and held weapon category.
const MENU_POSES = {
  ct: { knife: 'ct_main_menu_knife_idle', pistol: 'ct_main_menu_pistol01_idle', rifle: 'ct_main_menu_rifle_scar_idle' },
  t: { knife: 't_main_menu_knife_idle', pistol: 't_main_menu_pistol_idle', rifle: 't_main_menu_rifle02_idle' },
};
const STAR_RARITY = 'ancient';   // knives and gloves show as ★ Covert / Extraordinary

/** Output files a source file extracts to; the source is listed only when one of them is missing. */
const missingIn = (out) => (sources, outputs) => sources.filter((source) => outputs(source).some((file) => !existsSync(join(out, file))));

/** A model's .glb and the color textures it points at (as extracted, or already converted). */
function modelFiles(out, glb) {
  const file = join(out, glb);
  if (!existsSync(file)) return [glb];
  const data = readFileSync(file);
  const json = JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)).toString());
  const used = new Set((json.materials ?? []).map((m) => m.pbrMetallicRoughness?.baseColorTexture?.index)
    .filter((index) => index !== undefined).map((index) => json.textures[index].source));
  const images = (json.images ?? []).filter((image, i) => used.has(i)).map((image) => join(dirname(glb), image.uri));
  // A converted image counts as present; so does its unconverted original.
  return [glb, ...images.filter((image) => !existsSync(join(out, image)) && !existsSync(join(out, `${withoutExtension(image)}.png`)))];
}

export function plan(work, out) {
  const data = new GameData(work);
  const itemByName = new Map(data.items.map((item) => [item.name, item]));
  const finishes = {};
  const gloveFinishes = {};
  const textures = new Map();   // texture resource -> { max, lossless }
  const models = new Map();     // glb path -> max color texture size
  const needTexture = (resource, max, lossless = false) => {
    if (!resource) return null;
    const known = textures.get(resource);
    textures.set(resource, { max: Math.max(known?.max ?? 0, max), lossless: lossless || Boolean(known?.lossless) });
    return webp(resource);
  };
  const rarityOf = (name) => (data.rarities[name] ? name : 'common');
  // A weapon finish's rarity is the paint kit's, raised by the weapon's own (an AK-47 is uncommon).
  const finishRarity = (kitName, itemRarity) => {
    const values = Object.entries(data.rarities).sort((a, b) => a[1].value - b[1].value);
    const kit = data.rarities[data.kitRarity.get(kitName)]?.value ?? 1;
    const value = Math.min(kit + (data.rarities[itemRarity]?.value ?? 1) - 1, 6);
    return values.find(([, r]) => r.value === value)?.[0] ?? 'common';
  };

  /** Adds a weapon finish, using the weapon's own variant of it when there is one. */
  const addFinish = (kitName, variant) => {
    const kit = data.kits.get(kitName);
    if (!kit) return null;
    const id = (variant && data.compositeMaterials.has(`${kitName}_${variant}`)) ? `${kitName}_${variant}` : kitName;
    if (!(id in finishes)) {
      const file = data.compositeMaterials.get(id);
      const finish = file && readFinish(data, file);
      const record = finish ? finishRecord(data, kit, finish) : null;
      if (record) {
        record.name = finishLabel(record, kitName);
        record.pattern = needTexture(record.pattern, ALBEDO_STYLES.has(record.style) ? MAX_SIZE.albedoPattern : MAX_SIZE.pattern);
        record.masks = needTexture(record.masks, MAX_SIZE.input, true);
        record.ramp = needTexture(record.ramp, MAX_SIZE.input);
      }
      finishes[id] = record;
    }
    return finishes[id] ? id : null;
  };

  const composites = (list) => list.map((c) => ({
    ...c,
    masks: needTexture(c.masks, MAX_SIZE.input, true),
    cavity: needTexture(c.cavity, MAX_SIZE.input),
    surface: needTexture(c.surface, MAX_SIZE.input),
    position: needTexture(c.position, MAX_SIZE.input, true),
  }));

  /** Inventory entries for an item's finishes: { id, icon, rarity, collection }. */
  const finishItems = (itemName, variant, rarity) => data.finishIcons(itemName).map(({ kit, icon }) => {
    const id = addFinish(kit, variant);
    if (!id) return null;
    return {
      id,
      icon: needTexture(icon, MAX_SIZE.icon),
      rarity: rarity ?? finishRarity(kit, itemByName.get(itemName)?.item_rarity),
      collection: data.collections.get(`[${kit}]${itemName}`) ?? null,
    };
  }).filter(Boolean);
  const baseIcon = (itemName) => {
    const icon = `panorama/images/econ/weapons/base_weapons/${itemName}_png.vtex`;
    return data.paths.has(compiled(icon)) ? needTexture(icon, MAX_SIZE.icon) : null;
  };

  const weapons = {};
  // Guns: rifles, SMGs, heavy and snipers in the primary slot, pistols in the secondary slot.
  for (const [itemClass, w] of Object.entries(data.vdata)) {
    const slot = { GEAR_SLOT_RIFLE: 'primary', GEAR_SLOT_PISTOL: 'secondary' }[w.m_GearSlot];
    const item = itemByName.get(itemClass);
    if (!slot || w.m_szName !== itemClass || !item?.model_player) continue;
    const id = itemClass.replace(/^weapon_/, '');
    const model = item.model_player;
    const silenced = (w.m_eSilencerType ?? 'WEAPONSILENCER_NONE') !== 'WEAPONSILENCER_NONE';
    const category = slot === 'secondary' ? 'pistol' : 'rifle';
    const paintName = item.paint_data?.paintablematerial0?.name;
    const shot = silenced ? w.m_aShootSounds?.WEAPON_SOUND_SPECIAL1 : w.m_aShootSounds?.WEAPON_SOUND_SINGLE;
    const glb = `${withoutExtension(model)}.glb`;
    models.set(glb, MAX_SIZE.gunColor);
    weapons[id] = {
      name: data.localize(item.item_name) ?? id,
      slot,
      type: WEAPON_TYPES[w.m_WeaponType] ?? category,
      model: glb,
      icon: baseIcon(itemClass),
      rarity: 'default',
      paint: {
        hd: composites(compositesIn(data, `${dirname(model)}/materials/composite_inputs/`)),
        legacy: paintName ? composites(compositesIn(data, `materials/models/weapons/customization/${paintName}/`)) : [],
      },
      clips: pickClips(data, [CLIP_FOLDERS[id] ?? `${category}/${category}_${id}`, `${category}/_default_${category}`], 'gun', silenced),
      body: category,
      sounds: { attack: eventSound(data, shot), deploy: drawSound(data, shot) },
      stats: weaponStats(w, false),
      finishes: finishItems(itemClass, FINISH_VARIANTS[id]),
    };
  }

  // Knives: the two default knives and every unusual knife.
  const knifeStats = weaponStats(data.vdata.weapon_knife, true);
  const knifeSounds = {
    deploy: eventSound(data, 'Weapon_Knife.Deploy'),
    attack: eventSound(data, 'Weapon_Knife.Swish.Light'),
    attack2: eventSound(data, 'Weapon_Knife.Swish.Heavy'),
  };
  for (const item of data.items) {
    const isKnife = item.name === 'weapon_knife' || item.name === 'weapon_knife_t' || item.prefab === 'melee_unusual';
    if (!isKnife || !item.model_player) continue;
    const id = item.name.replace(/^weapon_/, '');
    const model = item.model_player;
    const folder = basename(dirname(model));
    const glb = `${withoutExtension(model)}.glb`;
    models.set(glb, MAX_SIZE.knifeColor);
    const paint = { hd: composites(compositesIn(data, `${dirname(model)}/materials/composite_inputs/`)), legacy: [] };
    weapons[id] = {
      name: data.localize(item.item_name) ?? id,
      slot: 'knife',
      type: 'knife',
      model: glb,
      icon: baseIcon(item.name),
      rarity: item.prefab === 'melee_unusual' ? STAR_RARITY : 'default',
      paint,
      clips: pickClips(data, [`knife/${folder === 'knife_default_ct' ? '_default_knife' : folder}`, 'knife/_default_knife'], 'knife', false),
      body: 'knife',
      sounds: knifeSounds,
      stats: knifeStats,
      finishes: paint.hd.length ? finishItems(item.name, FINISH_VARIANTS[id], STAR_RARITY) : [],
    };
  }

  // Gloves: the first-person glove model and each finish.
  const gloves = {};
  for (const item of data.items) {
    if (item.prefab !== 'hands_paintable' || !item.model_player) continue;
    const glb = `${withoutExtension(item.model_player)}.glb`;
    models.set(glb, MAX_SIZE.armsColor);
    const items = data.finishIcons(item.name).map(({ kit, icon }) => {
      const id = `${item.name}/${kit}`;
      const record = readGloveFinish(data, data.kits.get(kit));
      if (!record) return null;
      record.layerMask = needTexture(record.layerMask, MAX_SIZE.input, true);
      record.surface = needTexture(record.surface, MAX_SIZE.input);
      record.details = record.details.map((detail) => needTexture(detail, 512));
      record.pattern = needTexture(record.pattern, MAX_SIZE.pattern);
      gloveFinishes[id] = record;
      return { id, icon: needTexture(icon, MAX_SIZE.icon), rarity: STAR_RARITY, collection: null };
    }).filter(Boolean);
    if (!items.length) continue;
    gloves[item.name] = { name: data.localize(item.item_name) ?? item.name, model: glb, finishes: items };
  }

  // Agents: first-person sleeves and default gloves, and the third-person body.
  const agents = {};
  for (const item of data.items) {
    if (item.prefab !== 'customplayertradable' || !item.model_player) continue;
    const base = withoutExtension(item.model_player);
    const icon = `panorama/images/econ/characters/${item.name}_png.vtex`;
    models.set(`${base}_arms.glb`, MAX_SIZE.agentColor);
    models.set(`${base}.glb`, MAX_SIZE.agentColor);
    agents[item.name.replace(/^customplayer_/, '')] = {
      name: data.localize(item.item_name) ?? item.name,
      team: item.used_by_classes?.['counter-terrorists'] ? 'ct' : 't',
      rarity: rarityOf(item.item_rarity),
      icon: data.paths.has(compiled(icon)) ? needTexture(icon, MAX_SIZE.icon) : null,
      arms: `${base}_arms.glb`,
      body: `${base}.glb`,
    };
  }

  // Third-person animations for the bot, and the main menu poses.
  const bodyClips = {};
  for (const category of ['rifle', 'pistol', 'knife']) {
    bodyClips[category] = {};
    for (const name of BODY_CLIPS) {
      const path = `${WORLD_CLIPS}/${category}/_default_${category}/${name}_${category}.vnmclip_c`;
      if (data.paths.has(path)) bodyClips[category][name] = path.replace(/\.vnmclip_c$/, '.glb');
    }
  }
  const menuPoses = {};
  for (const [team, poses] of Object.entries(MENU_POSES)) {
    menuPoses[team] = {};
    for (const [category, name] of Object.entries(poses)) {
      const path = `${MENU_CLIPS}/${team}/${name}.vnmclip_c`;
      if (data.paths.has(path)) menuPoses[team][category] = path.replace(/\.vnmclip_c$/, '.glb');
    }
  }

  // Movement sounds: footsteps and landings per surface, and the jump.
  const stepPattern = new RegExp(`^${FOOTSTEPS}/((${SURFACES})_?[0-9]+|land_(concrete|${SURFACES})_?[0-9]+|jump_launch_01)\\.vsnd_c$`);
  const stepFiles = [...data.paths].filter((path) => stepPattern.test(path)).map((path) => path.replace(/\.vsnd_c$/, '.wav'));
  const footsteps = {};
  const landings = {};
  for (const file of stepFiles) {
    const match = basename(file).match(/^(.*?)_?(\d+)\.wav$/);
    if (!match || match[1].startsWith('jump')) continue;
    const landing = match[1].startsWith('land_');
    const surface = landing ? match[1].slice(5) : match[1];
    ((landing ? landings : footsteps)[surface] ??= []).push(file);
  }
  if (landings.concrete) landings.concrete_ct = landings.concrete;   // landing sets drop the CT suffix

  const uiIcons = Object.fromEntries(UI_ICONS.map((name) => [name, `panorama/images/icons/ui/${name}.svg`])
    .filter(([, path]) => data.paths.has(path.replace(/\.svg$/, '.vsvg_c'))));
  const manifest = {
    arms: `${withoutExtension(ARMS)}.glb`,
    wear: needTexture(WEAR_TEXTURE, MAX_SIZE.input),
    grunge: needTexture(GRUNGE_TEXTURE, MAX_SIZE.input),
    rarities: data.rarities,
    weapons,
    finishes: Object.fromEntries(Object.entries(finishes).filter(([, record]) => record)),
    gloves,
    gloveFinishes,
    agents,
    bodyClips,
    menuPoses,
    ui: { icons: uiIcons, fonts: FONTS.map((font) => `fonts/${font}`) },
    footsteps,
    landings,
    jump: stepFiles.filter((file) => basename(file).startsWith('jump_launch')),
  };
  models.set(manifest.arms, MAX_SIZE.armsColor);

  // The lists of what to extract, leaving out what the output folder already has.
  const missing = missingIn(out);
  const sounds = [...Object.values(weapons).flatMap((w) => Object.values(w.sounds).flatMap((s) => s?.files ?? [])), ...stepFiles];
  const clipFiles = [
    ...Object.values(weapons).flatMap((w) => Object.values(w.clips).flat()),
    ...Object.values(bodyClips).flatMap(Object.values), ...Object.values(menuPoses).flatMap(Object.values),
  ];
  const vtex = [...textures.keys()].filter((resource) => data.paths.has(compiled(resource)));
  const vmdl = (glb) => compiled(`${withoutExtension(glb)}.vmdl`);
  const write = (name, list) => writeFileSync(join(work, name), lines(list));
  const model = (glb) => modelFiles(out, glb);
  write('models.txt', missing([manifest.arms, ...Object.values(weapons).map((w) => w.model)], model).map(vmdl));
  write('gloves.txt', missing(Object.values(gloves).map((g) => g.model), model).map(vmdl));
  write('agents.txt', missing(Object.values(agents), (a) => [...model(a.arms), ...model(a.body)]).map((a) => vmdl(a.body)));
  write('clips.txt', missing(clipFiles, (clip) => [clip]).map((clip) => `${withoutExtension(clip)}.vnmclip_c`));
  // The converter writes each sound in its source format: usually .wav, sometimes .mp3.
  const mp3 = (file) => file.replace(/\.wav$/, '.mp3');
  write('sounds.txt', missing(sounds, (file) => (existsSync(join(out, mp3(file))) ? [] : [file])).map((file) => file.replace(/\.wav$/, '.vsnd_c')));
  const exported = (resource) => ['png', 'exr'].some((type) => existsSync(join(out, `${withoutExtension(resource)}.${type}`)));
  write('textures.txt', missing(vtex, (resource) => (exported(resource) ? [] : [webp(resource)])).map(compiled));
  write('icons.txt', missing(Object.values(uiIcons), (svg) => [svg]).map((svg) => svg.replace(/\.svg$/, '.vsvg_c')));
  writeFileSync(join(work, 'plan.json'), JSON.stringify({
    manifest,
    textures: Object.fromEntries(textures),
    models: Object.fromEntries(models),
  }));

  const count = (object) => Object.keys(object).length;
  const pairs = Object.values(weapons).reduce((sum, w) => sum + w.finishes.length, 0);
  const styles = Object.values(manifest.finishes).reduce((counts, f) => ({ ...counts, [STYLE_NAMES[f.style]]: (counts[STYLE_NAMES[f.style]] ?? 0) + 1 }), {});
  console.log(`Plan: ${count(weapons)} weapons (${pairs} with finishes), ${count(manifest.finishes)} finishes, ${count(gloves)} gloves (${count(gloveFinishes)} finishes), ${count(agents)} agents, ${vtex.length} textures, ${sounds.length} sounds.`);
  console.log(`Finish styles: ${JSON.stringify(styles)}`);
}
