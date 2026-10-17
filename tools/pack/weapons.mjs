/**
 * Weapons and weapon finishes: paint inputs, viewmodel clips, sounds and
 * stats of each gun and knife, and the paint parameters of each finish.
 */
import { basename, join } from 'node:path';
import { parseKv3 } from '../kv3.mjs';
import { first, readText } from './common.mjs';
import { CLIPS } from './gameData.mjs';

// Paint styles of the weapon paint shader (F_PAINT_STYLE).
export const STYLE_NAMES = ['solid', 'hydrographic', 'spray', 'anodized', 'anodized multicolor', 'anodized airbrushed', 'custom', 'patina', 'gunsmith'];
export const ALBEDO_STYLES = new Set([6, 7, 8]);   // the pattern is a full color texture laid on the weapon's UVs
// Some finishes have a variant made for one weapon's UVs, named with a suffix.
export const FINISH_VARIANTS = { knife_widowmaker: 'widow', glock: 'glock' };
// Animation folders whose names differ from the weapon id.
export const CLIP_FOLDERS = { ak47: 'rifle/rifle_ak', glock: 'pistol/pistol_glock18', m4a1: 'rifle/rifle_m4a4', usp_silencer: 'pistol/_default_pistol', m4a1_silencer: 'rifle/_default_rifle' };

/** The composite inputs (masks, cavity, surface, position) of every paintable material in a folder. */
export function compositesIn(data, folder) {
  const composites = [];
  for (const [path, material] of data.materials) {
    if (!path.startsWith(folder) || !path.endsWith('_composite_inputs.vmat')) continue;
    const p = material.params;
    if (!p.layer_name_1 || !p.g_tMasks) continue;
    composites.push({
      material: basename(p.layer_name_1.replaceAll('\\', '/'), '.vmat'),
      masks: p.g_tMasks,
      cavity: p.g_tAmbientOcclusion,
      surface: p.g_tSurface,
      position: p.g_tPosition,
      uvScale: p.g_flUvScale1 ?? 1,
      length: p.g_flWeaponLength1 ?? 32,
    });
  }
  return composites;
}

/** Draw, idle, attack and inspect clips from a viewmodel animation folder, falling back to the category default. */
export function pickClips(data, folders, kind, silenced) {
  const listing = (folder) => data.clipFolders.get(folder) ?? [];
  const rules = kind === 'knife'
    ? {
      draw: [/^draw_/],
      idle: [/^idle1_/, /^idle_/],
      attack: [/^light_miss[12]_/],
      attack2: [/^heavy_miss1_/],
      inspect: [/^lookat01_(?!draw|transfix)/],
    }
    : {
      draw: silenced ? [/^draw_silenced_/, /^draw_(?!silenced|\d)/] : [/^draw_(?!silenced|\d)/],
      idle: [/^idle1?_(?!slide|from|left)/],
      attack: [/^shoot1_/, /^shoot_(left|right)1_/],
      inspect: [/^lookat01_(?!draw|transfix)/],
      reload: [/^reload_(?!empty)/],
    };
  const clips = {};
  for (const [name, patterns] of Object.entries(rules)) {
    for (const folder of folders) {
      const files = listing(folder);
      const match = patterns.map((pattern) => files.filter((file) => pattern.test(file))).find((found) => found.length);
      if (match) {
        clips[name] = match.map((file) => `${CLIPS}/${folder}/${file}.glb`);
        break;
      }
    }
  }
  return clips;
}

/** Files and volume of a sound event; some foley is mixed very low, so volumes are kept audible. */
export function eventSound(data, name) {
  const event = name && data.events.get(name.toLowerCase());
  const files = event?.vsnd_files_track_01 ?? event?.vsnd_files;
  if (!files?.length) return null;
  return {
    files: [files].flat().map((file) => file.replace(/\.vsnd$/, '.wav')),
    volume: Math.min(1, Math.max(0.3, event.volume ?? 1)),
  };
}

/** A gun's draw sound is named after its shot sound: Weapon_AK47.Single -> Weapon_AK47.Draw (or Weapon_CZ.Draw for Weapon_CZ75A). */
export function drawSound(data, shot) {
  const prefix = shot?.split('.')[0] ?? '';
  const candidates = [prefix, prefix.replace(/\d+[a-z]*$/i, ''), prefix.replace(/A4$/i, 'A1')];
  return candidates.map((name) => eventSound(data, `${name}.Draw`)).find(Boolean) ?? null;
}

/** A per-mode value ([normal, scoped]) for one mode; plain values serve both. */
const mode = (value, index) => (Array.isArray(value) ? value[index] ?? value[0] : value);

/** The stats that change when scoped (index 1) or not (index 0). */
function modeStats(w, i) {
  return {
    maxSpeed: mode(w.m_flMaxSpeed, i),
    recoil: {
      angle: mode(w.m_flRecoilAngle, i) ?? 0,
      angleVariance: mode(w.m_flRecoilAngleVariance, i) ?? 0,
      magnitude: mode(w.m_flRecoilMagnitude, i) ?? 0,
      magnitudeVariance: mode(w.m_flRecoilMagnitudeVariance, i) ?? 0,
      seed: w.m_nRecoilSeed ?? 0,
    },
    spread: mode(w.m_flSpread, i) ?? 0,
    inaccuracy: {
      stand: mode(w.m_flInaccuracyStand, i) ?? 0,
      crouch: mode(w.m_flInaccuracyCrouch, i) ?? 0,
      move: mode(w.m_flInaccuracyMove, i) ?? 0,
      jump: mode(w.m_flInaccuracyJump, i) ?? 0,
      land: mode(w.m_flInaccuracyLand, i) ?? 0,
      fire: mode(w.m_flInaccuracyFire, i) ?? 0,
    },
  };
}

/** Stats of a gun as held (a silencer on is its second mode), or of a knife. */
export function weaponStats(w, melee, silenced = false) {
  // Knife swings by the classic rules: a light slash does 25 (40 from behind), a heavy stab 65 (180 from behind).
  if (melee) return { maxSpeed: first(w.m_flMaxSpeed) ?? 250, cycleTime: 0.4, cycleTime2: 1.0, fullAuto: true, damage: 25, damage2: 65, range: 48, range2: 32 };
  const zoomLevels = w.m_nZoomLevels ?? 0;
  const held = silenced ? 1 : 0;
  const clip = w.m_iMaxClip1 ?? 30;
  return {
    ...modeStats(w, held),
    clip,
    reserve: (w.m_nPrimaryReserveAmmoMax ?? 0) * (w.m_bReserveAmmoAsClips ? clip : 1),
    reloadTime: w.m_flDisallowAttackAfterReloadStartDuration ?? 2.5,
    singleShells: Boolean(w.m_bReloadsSingleShells),
    tracerFrequency: mode(w.m_nTracerFrequency, held) ?? 1,
    penetration: w.m_flPenetration ?? 1,
    cycleTime: first(w.m_flCycleTime),
    fullAuto: Boolean(w.m_bIsFullAuto),
    bullets: w.m_nNumBullets ?? 1,
    damage: w.m_nDamage ?? 30,
    headshotMultiplier: w.m_flHeadshotMultiplier ?? 4,
    armorRatio: w.m_flArmorRatio ?? 1,
    range: w.m_flRange ?? 8192,
    rangeModifier: w.m_flRangeModifier ?? 0.98,
    recoveryTime: { stand: w.m_flRecoveryTimeStand ?? 0.35, crouch: w.m_flRecoveryTimeCrouch ?? 0.3 },
    // Scoping: field of view per zoom level, and how the weapon behaves scoped.
    zoom: zoomLevels ? {
      fov: [w.m_nZoomFOV1, w.m_nZoomFOV2].slice(0, zoomLevels),
      time: [w.m_flZoomTime0 ?? 0.05, w.m_flZoomTime1 ?? 0.05, w.m_flZoomTime2 ?? 0.05],
      unzoomsAfterShot: Boolean(w.m_bUnzoomsAfterShot),
      hidesViewmodel: Boolean(w.m_bHideViewModelWhenZoomed),
      scoped: modeStats(w, 1),
    } : null,
  };
}

const CLIP_FPS = 30;

/**
 * The reload of a gun from its reload clip's events: sounds at their times
 * and, for guns loaded a shell at a time, the part of the clip that repeats
 * per shell. Times are in seconds.
 */
export function reloadEvents(data, clipFile) {
  const doc = parseKv3(readText(join(data.work, clipFile.replace(/\.glb$/, '.vnmclip'))));
  const events = (doc.m_eventTracks ?? []).flatMap((track) => track.m_events ?? []);
  const at = (id) => events.find((event) => event.m_ID === id)?.m_flStartTime;
  const sounds = events
    .filter((event) => event._class === 'CNmClipDocEvent_Sound')
    .map((event) => ({ time: event.m_flStartTime / CLIP_FPS, ...eventSound(data, event.m_name) }))
    .filter((sound) => sound.files);
  const loop = at('WPN_RELOAD_LOOP');
  const outro = at('WPN_RELOAD_OUTRO');
  return { sounds, loop: loop !== undefined && outro !== undefined ? [loop / CLIP_FPS, outro / CLIP_FPS] : null };
}

/** Value of one composite-material loose variable, plus its random-roll range when it has bounds. */
function looseVariable(v) {
  switch (v.m_nVariableType) {
    case 'LOOSE_VARIABLE_TYPE_FLOAT1':
      return { value: v.m_flValueFloatX, range: v.m_bHasFloatBounds ? [[v.m_flValueFloatX_Min, v.m_flValueFloatX_Max]] : null };
    case 'LOOSE_VARIABLE_TYPE_FLOAT2':
      return {
        value: [v.m_flValueFloatX, v.m_flValueFloatY],
        range: v.m_bHasFloatBounds ? [[v.m_flValueFloatX_Min, v.m_flValueFloatX_Max], [v.m_flValueFloatY_Min, v.m_flValueFloatY_Max]] : null,
      };
    case 'LOOSE_VARIABLE_TYPE_FLOAT3':
    case 'LOOSE_VARIABLE_TYPE_FLOAT4':
      return { value: [v.m_flValueFloatX, v.m_flValueFloatY, v.m_flValueFloatZ, v.m_flValueFloatW].filter((x) => x !== undefined) };
    case 'LOOSE_VARIABLE_TYPE_COLOR4':
      return { value: (v.m_cValueColor4 ?? [255, 255, 255]).slice(0, 3).map((c) => c / 255) };
    case 'LOOSE_VARIABLE_TYPE_BOOLEAN':
      return { value: v.m_bValueBoolean ? 1 : 0 };
    case 'LOOSE_VARIABLE_TYPE_INTEGER1':
      return { value: v.m_nValueIntX };
    case 'LOOSE_VARIABLE_TYPE_RESOURCE_TEXTURE':
      return { value: v.m_strTextureRuntimeResourcePath };
    default:
      return null;
  }
}

/**
 * Reads a paint composite material: the paint shader material it starts from
 * (a template, or a converted older finish), with the finish's own variables on top.
 */
export function readFinish(data, file) {
  const procedure = parseKv3(readText(file)).m_Points?.[0]?.m_vecCompositeMaterialAssemblyProcedures?.[0];
  if (!procedure) return null;
  const containers = procedure.m_vecCompositeInputContainers ?? [];
  const paintMaterial = containers.find((c) => c.m_strAlias === 'paint')?.m_strSpecificContainerMaterial;
  const material = data.materials.get(paintMaterial);
  if (!material) return null;
  const params = { ...material.params };
  const ranges = {};
  for (const container of containers) {
    for (const variable of container.m_vecLooseVariables ?? []) {
      const parsed = looseVariable(variable);
      if (!parsed) continue;
      params[variable.m_strName] = parsed.value;
      if (parsed.range) ranges[variable.m_strName] = parsed.range;
    }
  }
  return { params, ranges };
}

const PLACEHOLDER = /^(materials\/default|workshop\/paintkits\/templates)\//;   // template stand-ins, not part of a finish
const color = (value, fallback) => (Array.isArray(value) ? value.slice(0, 3) : fallback);
const range = (ranges, name, value) => ranges[name]?.[0] ?? [value ?? 0, value ?? 0];

/** A finish as the game's compositor reads it. */
export function finishRecord(data, kit, finish) {
  const { params: p, ranges } = finish;
  const style = p.F_PAINT_STYLE ?? 0;
  const offset = p.g_vPatternTexCoordOffset ?? [0, 0];
  const masks = p.g_bOverrideDefaultMasks || p.g_bOverrideMasks ? p.g_tPaintByNumberMasks : null;
  return {
    name: data.localize(kit.description_tag) ?? kit.name,
    style,
    legacy: kit.use_legacy_model === '1',
    wear: [Number(kit.wear_remap_min ?? 0), Number(kit.wear_remap_max ?? 1)],
    colors: [0, 1, 2, 3].map((i) => color(p[`g_vColor${i}`], [1, 1, 1])),
    pattern: p.g_tPattern && !PLACEHOLDER.test(p.g_tPattern) ? p.g_tPattern : null,
    masks: masks && !PLACEHOLDER.test(masks) ? masks : null,
    ramp: p.g_tCaseHardeningColorRamp ?? null,
    caseHardening: p.g_tCaseHardeningColorRamp ? {
      pattern: p.g_flCaseHardeningPatternInfluence ?? 1,
      geometric: p.g_flCaseHardeningGeometricInfluence ?? 0,
      offset: p.g_flCaseHardeningRampOffset ?? 0,
    } : null,
    scale: p.g_flPatternTexCoordScale ?? 1,
    rotation: range(ranges, 'g_flPatternTexCoordRotation', p.g_flPatternTexCoordRotation),
    offset: [ranges.g_vPatternTexCoordOffset?.[0] ?? [offset[0], offset[0]], ranges.g_vPatternTexCoordOffset?.[1] ?? [offset[1], offset[1]]],
    ignoreSize: Boolean(p.g_bIgnoreWeaponSizeScale),
    sprayMasks: style === 2 ? Boolean(p.g_bUsePaintByNumberMasks) : false,
  };
}

/** Readable labels for finishes that share a name, like the Doppler phases. */
export function finishLabel(record, kitName) {
  const phase = kitName.match(/phase(\d)/);
  if (phase) return `${record.name} (Phase ${phase[1]})`;
  const gem = kitName.match(/(ruby|sapphire|blackpearl|emerald)/);
  if (gem) return `${record.name} (${{ ruby: 'Ruby', sapphire: 'Sapphire', blackpearl: 'Black Pearl', emerald: 'Emerald' }[gem[1]]})`;
  return record.name;
}

