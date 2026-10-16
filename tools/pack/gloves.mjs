/**
 * Glove finishes. Gloves are painted by a layered cloth shader: a layer mask
 * splits the glove into up to four materials (black, red, green, blue), each
 * with a detail texture (leather, fabric, rubber...), and its alpha picks one
 * of eight color tints per texel. An optional pattern replaces one tint with
 * a mix of others. The record keeps those inputs for the game's compositor.
 */
import { parseKv3 } from '../kv3.mjs';
import { readText } from './common.mjs';

const tint = (value) => (Array.isArray(value) ? value.slice(0, 3) : [0.5, 0.5, 0.5]);

/** The glove paint material a glove finish's composite material starts from, with its own variables on top. */
export function readGloveFinish(data, kit) {
  const file = data.gloveMaterials.get(kit.name);
  if (!file) return null;
  const procedure = parseKv3(readText(file)).m_Points?.[0]?.m_vecCompositeMaterialAssemblyProcedures?.[0];
  const containers = procedure?.m_vecCompositeInputContainers ?? [];
  const paintMaterial = containers.find((c) => c.m_strAlias === 'paint')?.m_strSpecificContainerMaterial;
  const material = data.materials.get(paintMaterial);
  if (!material?.params.g_tLayerMask) return null;
  const p = { ...material.params };
  for (const container of containers) {
    for (const v of container.m_vecLooseVariables ?? []) {
      if (v.m_nVariableType === 'LOOSE_VARIABLE_TYPE_FLOAT1') p[v.m_strName] = v.m_flValueFloatX;
    }
  }
  const palette = Array.isArray(p.g_vPatternPaletteIndices) ? p.g_vPatternPaletteIndices.slice(0, 4) : [8, 8, 8, 8];
  return {
    name: data.localize(kit.description_tag) ?? kit.name,
    wear: [Number(kit.wear_remap_min ?? 0.06), Number(kit.wear_remap_max ?? 0.8)],
    layerMask: p.g_tLayerMask,
    surface: p.g_tSurface ?? null,
    details: [1, 2, 3, 4].map((i) => p[`g_tDetail${i}`] ?? null),
    detailScale: [1, 2, 3, 4].map((i) => p[`g_fDetailScale${i}`] ?? 1),
    tints: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => tint(p[`g_vColorTint${i}`])),
    pattern: p.F_PATTERN ? p.g_tPattern ?? null : null,
    palette,
    replaceIndex: p.g_nPatternReplaceIndex ?? 0,
    patternScale: p.g_fPatternTexCoordScale ?? 1,
    patternRotation: p.g_fPatternTexCoordRotation ?? 0,
  };
}
