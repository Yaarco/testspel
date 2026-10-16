/**
 * Minimal reader for binary glTF 2.0 (.glb): node hierarchy, meshes,
 * skins and animations, which is what the exported viewmodels use.
 * Accessor data is returned as typed arrays of floats (normalized integers
 * are converted, as the glTF spec defines).
 */
const GLB_MAGIC = 0x46546c67;      // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const TYPED = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
const NORMALIZE = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

function parseChunks(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('Not a .glb file.');
  let json = null;
  let bin = null;
  for (let at = 12; at < buffer.byteLength;) {
    const length = view.getUint32(at, true);
    const type = view.getUint32(at + 4, true);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, at + 8, length)));
    if (type === CHUNK_BIN) bin = new Uint8Array(buffer, at + 8, length);
    at += 8 + length;
  }
  return { json, bin };
}

/** Reads an accessor as a flat array; floats stay floats, integers stay integers unless normalized. */
function readAccessor(json, bin, index) {
  const accessor = json.accessors[index];
  const view = json.bufferViews[accessor.bufferView];
  const Typed = TYPED[accessor.componentType];
  const components = COMPONENTS[accessor.type];
  const elementBytes = Typed.BYTES_PER_ELEMENT * components;
  const stride = view.byteStride || elementBytes;
  const start = bin.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const source = new DataView(bin.buffer);
  const out = accessor.normalized ? new Float32Array(accessor.count * components) : new Typed(accessor.count * components);
  const read = {
    5120: (o) => source.getInt8(o), 5121: (o) => source.getUint8(o), 5122: (o) => source.getInt16(o, true),
    5123: (o) => source.getUint16(o, true), 5125: (o) => source.getUint32(o, true), 5126: (o) => source.getFloat32(o, true),
  }[accessor.componentType];
  const scale = accessor.normalized ? 1 / NORMALIZE[accessor.componentType] : 1;
  for (let i = 0; i < accessor.count; i++) {
    for (let c = 0; c < components; c++) {
      out[i * components + c] = read(start + i * stride + c * Typed.BYTES_PER_ELEMENT) * scale;
    }
  }
  return out;
}

/**
 * Returns { nodes, meshes, animations } where
 *   nodes:  [{ name, parent, translation, rotation, scale, matrix }]
 *   meshes: [{ name, skin, primitives: [{ position, normal, uv, joints, weights, indices, material, image }] }]
 *           with skin = { joints: [node index], inverseBind: Float32Array (16 per joint) }
 *   animations: [{ name, duration, channels: [{ node, path, times, values }] }]
 * `image` is the base color texture file name, relative to the .glb.
 */
export function parseGlb(buffer) {
  const { json, bin } = parseChunks(buffer);
  const accessor = (index) => (index === undefined ? null : readAccessor(json, bin, index));

  const nodes = json.nodes.map((node) => ({
    name: node.name ?? '',
    parent: -1,
    translation: node.translation ?? [0, 0, 0],
    rotation: node.rotation ?? [0, 0, 0, 1],
    scale: node.scale ?? [1, 1, 1],
    matrix: node.matrix ?? null,
  }));
  json.nodes.forEach((node, i) => (node.children ?? []).forEach((child) => { nodes[child].parent = i; }));

  const baseImage = (materialIndex) => {
    const texture = json.materials?.[materialIndex]?.pbrMetallicRoughness?.baseColorTexture;
    return texture ? json.images[json.textures[texture.index].source].uri : null;
  };

  const meshes = [];
  json.nodes.forEach((node) => {
    if (node.mesh === undefined) return;
    const skin = node.skin !== undefined ? json.skins[node.skin] : null;
    meshes.push({
      name: node.name ?? '',
      skin: skin && { joints: skin.joints, inverseBind: accessor(skin.inverseBindMatrices) },
      primitives: json.meshes[node.mesh].primitives.map((primitive) => ({
        position: accessor(primitive.attributes.POSITION),
        normal: accessor(primitive.attributes.NORMAL),
        uv: accessor(primitive.attributes.TEXCOORD_0),
        joints: accessor(primitive.attributes.JOINTS_0),
        weights: accessor(primitive.attributes.WEIGHTS_0),
        indices: accessor(primitive.indices),
        material: json.materials?.[primitive.material]?.name ?? '',
        image: baseImage(primitive.material),
      })),
    });
  });

  const animations = (json.animations ?? []).map((animation) => {
    const channels = animation.channels.map((channel) => {
      const sampler = animation.samplers[channel.sampler];
      return { node: channel.target.node, path: channel.target.path, times: accessor(sampler.input), values: accessor(sampler.output) };
    });
    const duration = Math.max(0, ...channels.map((channel) => channel.times[channel.times.length - 1] ?? 0));
    return { name: animation.name ?? '', duration, channels };
  });

  return { nodes, meshes, animations };
}
