/**
 * Resolves map materials (.vmt) and their textures (.vtf) through an
 * AssetLibrary. Only files a material actually references are read.
 * Materials that cannot be found fall back to the average color the map
 * compiler stored for them.
 */
import { parseKeyValues } from './formats/keyvalues.js';
import { parseVtf } from './formats/vtf.js';
import { normalizePath } from './formats/zip.js';

const SHADERS = {
  lightmappedgeneric: 'lit',
  lightmappedreflective: 'lit',
  worldvertextransition: 'blend',
  unlitgeneric: 'unlit',
  water: 'water',
  vertexlitgeneric: 'model',
};
const WATER_ALPHA = 0.6;
const DEFAULT_FRAME_RATE = 10;
export const ENV_CUBEMAP = 'env_cubemap';

/** Envmap masks, in the order the engine checks them. */
export const ENVMAP_MASK = { NONE: 0, TEXTURE: 1, BASE_ALPHA: 2, NORMAL_ALPHA: 3 };

const gammaFromLinear = (value) => Math.pow(Math.min(Math.max(value, 0), 1), 1 / 2.2);
const isOn = (value) => value !== undefined && value !== '0';

/** Parses "[0.1 0.2 0.3]" (0..1) or "{25 25 15}" (0..255) into 0..1 RGB. */
function parseColor(text) {
  if (!text) return null;
  const values = text.replace(/[[\]{}]/g, ' ').trim().split(/\s+/).map(Number);
  if (values.length === 1 && !Number.isNaN(values[0])) return [values[0], values[0], values[0]];
  if (values.length < 3 || values.some(Number.isNaN)) return null;
  return text.trim().startsWith('{') ? values.slice(0, 3).map((v) => v / 255) : values.slice(0, 3);
}

export class MaterialLibrary {
  constructor(assets) {
    this.assets = assets;
    this.materials = new Map();
    this.images = new Map();
  }

  /** Loads a .vmt, following "patch" includes. Returns { shader, params } or null. */
  async readVmt(path) {
    const text = await this.assets.readText(path);
    if (!text) return null;
    const { name, body } = parseKeyValues(text);
    if (name !== 'patch') return { shader: name, params: body };

    const included = (await this.readVmt(normalizePath(body.include ?? ''))) ?? { shader: '', params: {} };
    return { shader: included.shader, params: { ...included.params, ...body.insert, ...body.replace } };
  }

  /** Parsed texture for a material path value, cached (as a promise) by file path. */
  image(texturePath) {
    if (!texturePath) return Promise.resolve(null);
    const path = `materials/${normalizePath(texturePath).replace(/\.vtf$/, '')}.vtf`;
    if (!this.images.has(path)) {
      this.images.set(path, this.assets.read(path).then((bytes) => (bytes ? parseVtf(bytes) : null)));
    }
    return this.images.get(path);
  }

  /**
   * A material by name (as in texdata or a model's texture list), cached.
   * `fallbackColor` is linear 0..1 RGB, used when no texture can be found.
   */
  get(name, fallbackColor = [0.5, 0.5, 0.5]) {
    const key = normalizePath(name);
    if (!this.materials.has(key)) this.materials.set(key, this.load(key, fallbackColor));
    return this.materials.get(key);
  }

  async load(key, fallbackColor) {
    const vmt = await this.readVmt(`materials/${key}.vmt`);
    const params = vmt?.params ?? {};
    const shader = SHADERS[vmt?.shader] ?? 'lit';
    const water = shader === 'water';
    const envmapName = params.$envmap ? normalizePath(params.$envmap) : null;

    const [base, base2, bump, envmapMask, detail, envmap] = await Promise.all([
      water ? null : this.image(params.$basetexture),
      shader === 'blend' ? this.image(params.$basetexture2) : null,
      this.image(params.$bumpmap ?? params.$normalmap),
      this.image(params.$envmapmask),
      this.image(params.$detail),
      envmapName && envmapName !== ENV_CUBEMAP ? this.image(envmapName) : null,
    ]);

    let envmapMaskMode = ENVMAP_MASK.NONE;
    if (envmapMask) envmapMaskMode = ENVMAP_MASK.TEXTURE;
    else if (isOn(params.$basealphaenvmapmask)) envmapMaskMode = ENVMAP_MASK.BASE_ALPHA;
    else if (isOn(params.$normalmapalphaenvmapmask) && bump) envmapMaskMode = ENVMAP_MASK.NORMAL_ALPHA;

    const waterColor = parseColor(params.$fogcolor) ?? parseColor(params.$refracttint);
    return {
      key,
      shader,
      base,
      base2,
      bump,
      ssbump: isOn(params.$ssbump),
      // 'env_cubemap' means the nearest cubemap sample, chosen per surface by the scene.
      envmap: envmapName === ENV_CUBEMAP ? ENV_CUBEMAP : envmap,
      envmapTint: parseColor(params.$envmaptint) ?? [1, 1, 1],
      envmapMask,
      envmapMaskMode,
      detail,
      detailScale: Number(params.$detailscale) || 4,
      detailBlend: params.$detailblendfactor !== undefined ? Number(params.$detailblendfactor) : 1,
      selfIllum: isOn(params.$selfillum),
      surfaceProp: (params.$surfaceprop ?? 'default').toLowerCase(),
      color: water && waterColor ? waterColor : fallbackColor.map(gammaFromLinear),
      alphaTest: isOn(params.$alphatest) ? Number(params.$alphatestreference) || 0.5 : 0,
      translucent: isOn(params.$translucent) || water,
      additive: isOn(params.$additive),
      alpha: water ? WATER_ALPHA : Number(params.$alpha ?? 1),
      frameRate: Number(params.proxies?.animatedtexture?.animatedtextureframerate) || DEFAULT_FRAME_RATE,
    };
  }
}
