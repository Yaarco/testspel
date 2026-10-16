/**
 * Reader for studio models: .mdl (structure and materials),
 * .vvd (vertices) and .vtx (triangle lists). Only the first model of each
 * body part at the highest level of detail is read, which is what static
 * props draw up close.
 */
const VERTEX_SIZE = 48;
const VTX_SUFFIXES = ['.dx90.vtx', '.dx80.vtx', '.sw.vtx', '.vtx'];

function readString(bytes, at) {
  let end = at;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder('latin1').decode(bytes.subarray(at, end));
}

const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function readMdl(bytes) {
  const view = viewOf(bytes);
  const int = (at) => view.getInt32(at, true);
  const version = int(4);

  const textures = [];
  for (let i = 0; i < int(204); i++) {
    const at = int(208) + i * 64;
    textures.push(readString(bytes, at + int(at)));
  }
  const textureDirs = [];
  for (let i = 0; i < int(212); i++) textureDirs.push(readString(bytes, int(int(216) + i * 4)));

  const skinRefs = int(220);
  const skins = [];
  for (let family = 0; family < int(224); family++) {
    const row = [];
    for (let i = 0; i < skinRefs; i++) row.push(view.getInt16(int(228) + (family * skinRefs + i) * 2, true));
    skins.push(row);
  }

  const bodyParts = [];
  for (let b = 0; b < int(232); b++) {
    const partAt = int(236) + b * 16;
    const modelAt = partAt + int(partAt + 12);   // first model of this body part
    const meshes = [];
    for (let k = 0; k < int(modelAt + 72); k++) {
      const meshAt = modelAt + int(modelAt + 76) + k * 116;
      meshes.push({ material: int(meshAt), vertexOffset: int(meshAt + 12) });
    }
    bodyParts.push({ firstVertex: int(modelAt + 84) / VERTEX_SIZE, meshes });
  }
  return { version, textures, textureDirs, skins, bodyParts };
}

/** Vertices for the top level of detail, applying the fixup table when present. */
function readVvd(bytes) {
  const view = viewOf(bytes);
  const int = (at) => view.getInt32(at, true);
  const fixupCount = int(48);
  const dataStart = int(56);
  const readVertex = (index) => {
    const at = dataStart + index * VERTEX_SIZE;
    const f = (o) => view.getFloat32(at + o, true);
    return { position: [f(16), f(20), f(24)], normal: [f(28), f(32), f(36)], uv: [f(40), f(44)] };
  };

  const vertices = [];
  if (fixupCount === 0) {
    for (let i = 0; i < int(16); i++) vertices.push(readVertex(i));
    return vertices;
  }
  for (let i = 0; i < fixupCount; i++) {
    const at = int(52) + i * 12;
    if (int(at) < 0) continue;
    for (let k = 0; k < int(at + 8); k++) vertices.push(readVertex(int(at + 4) + k));
  }
  return vertices;
}

/** Triangle lists per body part and mesh, as each corner's vertex id within its mesh. */
function readVtx(bytes, mdlVersion) {
  const view = viewOf(bytes);
  const int = (at) => view.getInt32(at, true);
  const stripGroupSize = mdlVersion >= 49 ? 33 : 25;

  const bodyParts = [];
  for (let b = 0; b < int(28); b++) {
    const partAt = int(32) + b * 8;
    const modelAt = partAt + int(partAt + 4);
    const lodAt = modelAt + int(modelAt + 4);
    const meshes = [];
    for (let k = 0; k < int(lodAt); k++) {
      const meshAt = lodAt + int(lodAt + 4) + k * 9;
      const triangles = [];
      for (let g = 0; g < int(meshAt); g++) {
        const groupAt = meshAt + int(meshAt + 4) + g * stripGroupSize;
        const vertsAt = groupAt + int(groupAt + 4);
        const indicesAt = groupAt + int(groupAt + 12);
        for (let i = 0; i < int(groupAt + 8); i++) {
          const vertex = view.getUint16(indicesAt + i * 2, true);
          triangles.push(view.getUint16(vertsAt + vertex * 9 + 4, true));  // origMeshVertID
        }
      }
      meshes.push(triangles);
    }
    bodyParts.push(meshes);
  }
  return bodyParts;
}

/**
 * Loads a model through an AssetLibrary. Returns { meshes, materialPaths, skins }
 * where each mesh is { textureIndex, vertices: [{ position, normal, uv }], indices },
 * or null when a file is missing.
 */
export async function loadModel(assets, modelPath) {
  const base = modelPath.replace(/\.mdl$/i, '');
  const vtxPath = VTX_SUFFIXES.map((suffix) => base + suffix).find((path) => assets.has(path));
  const [mdlBytes, vvdBytes, vtxBytes] = await Promise.all(
    [`${base}.mdl`, `${base}.vvd`, vtxPath].map((path) => (path ? assets.read(path) : null)));
  if (!mdlBytes || !vvdBytes || !vtxBytes) return null;

  const mdl = readMdl(mdlBytes);
  const vertices = readVvd(vvdBytes);
  const strips = readVtx(vtxBytes, mdl.version);

  const meshes = [];
  mdl.bodyParts.forEach((part, b) => {
    part.meshes.forEach((mesh, k) => {
      // Share each vertex once and index it, instead of repeating it per triangle.
      const slots = new Map();
      const meshVertices = [];
      const indices = [];
      for (const id of strips[b]?.[k] ?? []) {
        if (!slots.has(id)) {
          // A missing vertex keeps its slot, so the triangle list stays aligned.
          const vertex = vertices[part.firstVertex + mesh.vertexOffset + id] ?? vertices[0];
          slots.set(id, meshVertices.length);
          meshVertices.push(vertex);
        }
        indices.push(slots.get(id));
      }
      if (indices.length) meshes.push({ textureIndex: mesh.material, vertices: meshVertices, indices });
    });
  });

  // A texture is looked up in each of the model's material folders in turn.
  const materialPaths = mdl.textures.map((name) => mdl.textureDirs.map((dir) => `${dir}${name}`));
  return { meshes, materialPaths, skins: mdl.skins };
}
