/**
 * Reader for VBSP map files (versions 19 to 21).
 * Only the lumps the game needs are decoded. Struct layouts follow bspfile.h
 * from the public SDK; offsets are in bytes, little endian.
 */

const LUMP = {
  ENTITIES: 0, PLANES: 1, TEXDATA: 2, VERTEXES: 3, NODES: 5, TEXINFO: 6, FACES: 7, LIGHTING: 8,
  LEAFS: 10, EDGES: 12, WORLDLIGHTS: 15, WORLDLIGHTS_HDR: 54, SURFEDGES: 13, MODELS: 14, LEAFBRUSHES: 17, BRUSHES: 18,
  BRUSHSIDES: 19, DISPINFO: 26, DISP_VERTS: 33, GAME_LUMP: 35, PAKFILE: 40, CUBEMAPS: 42,
  TEXDATA_STRING_DATA: 43, TEXDATA_STRING_TABLE: 44, LEAF_AMBIENT_INDEX_HDR: 51, LEAF_AMBIENT_INDEX: 52,
  LIGHTING_HDR: 53, LEAF_AMBIENT_LIGHTING_HDR: 55, LEAF_AMBIENT_LIGHTING: 56,
};
const LUMP_COUNT = 64;
const SUPPORTED_VERSIONS = [19, 20, 21];

/** Decodes an array of fixed-size structs from one lump. */
function readStructs(view, lump, size, read) {
  const count = Math.floor(lump.length / size);
  const items = new Array(count);
  for (let i = 0; i < count; i++) items[i] = read(lump.offset + i * size);
  return items;
}

function readVector(view, offset) {
  return {
    x: view.getFloat32(offset, true),
    y: view.getFloat32(offset + 4, true),
    z: view.getFloat32(offset + 8, true),
  };
}

function readLumpTable(view) {
  const lumps = [];
  for (let i = 0; i < LUMP_COUNT; i++) {
    const at = 8 + i * 16;
    lumps.push({
      offset: view.getInt32(at, true),
      length: view.getInt32(at + 4, true),
      version: view.getInt32(at + 8, true),
      compressed: view.getInt32(at + 12, true) !== 0,  // fourCC holds the uncompressed size
    });
  }
  return lumps;
}

/** The game lump is a directory of sub-lumps (static props and so on) keyed by a four-letter id. */
function readGameLumps(view, lump) {
  const lumps = {};
  if (lump.length < 4) return lumps;
  const count = view.getInt32(lump.offset, true);
  for (let i = 0; i < count; i++) {
    const at = lump.offset + 4 + i * 16;
    const id = String.fromCharCode(...[3, 2, 1, 0].map((k) => view.getUint8(at + k)));
    lumps[id] = { version: view.getUint16(at + 6, true), offset: view.getInt32(at + 8, true), length: view.getInt32(at + 12, true) };
  }
  return lumps;
}

/** Entities are plain text: { "key" "value" ... } blocks. */
function parseEntities(text) {
  const entities = [];
  for (const block of text.matchAll(/\{([^{}]*)\}/g)) {
    const entity = {};
    for (const [, key, value] of block[1].matchAll(/"([^"]*)"\s+"([^"]*)"/g)) {
      if (!(key in entity)) entity[key] = value;
    }
    entities.push(entity);
  }
  return entities;
}

function readTextureNames(bytes, view, lumps) {
  const data = lumps[LUMP.TEXDATA_STRING_DATA];
  const table = lumps[LUMP.TEXDATA_STRING_TABLE];
  const decoder = new TextDecoder('latin1');
  return readStructs(view, table, 4, (at) => {
    const start = data.offset + view.getInt32(at, true);
    let end = start;
    while (end < data.offset + data.length && bytes[end] !== 0) end++;
    return decoder.decode(bytes.subarray(start, end));
  });
}

export function parseBsp(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const ident = new TextDecoder('latin1').decode(bytes.subarray(0, 4));
  const version = view.getInt32(4, true);
  if (ident !== 'VBSP') throw new Error('Not a VBSP .bsp file.');
  if (!SUPPORTED_VERSIONS.includes(version)) throw new Error(`BSP version ${version} is not supported.`);

  const lumps = readLumpTable(view);
  for (const index of Object.values(LUMP)) {
    if (lumps[index].compressed) throw new Error('This map uses compressed lumps, which are not supported.');
  }
  const lump = (index) => lumps[index];
  const leafSize = lump(LUMP.LEAFS).version === 0 ? 56 : 32;

  const textureNames = readTextureNames(bytes, view, lumps);
  const texdata = readStructs(view, lump(LUMP.TEXDATA), 32, (at) => ({
    name: textureNames[view.getInt32(at + 12, true)] ?? '',
    reflectivity: readVector(view, at),
    width: view.getInt32(at + 16, true),
    height: view.getInt32(at + 20, true),
  }));
  const readVec4 = (at) => [0, 4, 8, 12].map((k) => view.getFloat32(at + k, true));
  const sub = (index) => bytes.subarray(lump(index).offset, lump(index).offset + lump(index).length);
  const lighting = lump(LUMP.LIGHTING).length > 0 ? sub(LUMP.LIGHTING) : sub(LUMP.LIGHTING_HDR);

  return {
    version,
    entities: parseEntities(new TextDecoder('latin1').decode(
      bytes.subarray(lump(LUMP.ENTITIES).offset, lump(LUMP.ENTITIES).offset + lump(LUMP.ENTITIES).length))),
    planes: readStructs(view, lump(LUMP.PLANES), 20, (at) => ({
      normal: readVector(view, at),
      dist: view.getFloat32(at + 12, true),
    })),
    texinfo: readStructs(view, lump(LUMP.TEXINFO), 72, (at) => {
      const data = texdata[view.getInt32(at + 68, true)];
      return {
        textureVecs: [readVec4(at), readVec4(at + 16)],
        lightmapVecs: [readVec4(at + 32), readVec4(at + 48)],
        flags: view.getInt32(at + 64, true),
        texture: data?.name ?? '',
        texdata: data,
      };
    }),
    vertices: readStructs(view, lump(LUMP.VERTEXES), 12, (at) => readVector(view, at)),
    edges: readStructs(view, lump(LUMP.EDGES), 4, (at) => [view.getUint16(at, true), view.getUint16(at + 2, true)]),
    surfedges: readStructs(view, lump(LUMP.SURFEDGES), 4, (at) => view.getInt32(at, true)),
    faces: readStructs(view, lump(LUMP.FACES), 56, (at) => ({
      plane: view.getUint16(at, true),
      side: view.getUint8(at + 2),
      firstEdge: view.getInt32(at + 4, true),
      numEdges: view.getInt16(at + 8, true),
      texinfo: view.getInt16(at + 10, true),
      dispinfo: view.getInt16(at + 12, true),
      styles: [0, 1, 2, 3].map((k) => view.getUint8(at + 16 + k)).filter((style) => style !== 255).length,
      lightOffset: view.getInt32(at + 20, true),
      lightmapMins: [view.getInt32(at + 28, true), view.getInt32(at + 32, true)],
      lightmapSize: [view.getInt32(at + 36, true), view.getInt32(at + 40, true)],
    })),
    nodes: readStructs(view, lump(LUMP.NODES), 32, (at) => [view.getInt32(at + 4, true), view.getInt32(at + 8, true)]),
    nodePlanes: readStructs(view, lump(LUMP.NODES), 32, (at) => view.getInt32(at, true)),
    leafs: readStructs(view, lump(LUMP.LEAFS), leafSize, (at) => ({
      firstLeafBrush: view.getUint16(at + 24, true),
      numLeafBrushes: view.getUint16(at + 26, true),
    })),
    leafBrushes: readStructs(view, lump(LUMP.LEAFBRUSHES), 2, (at) => view.getUint16(at, true)),
    models: readStructs(view, lump(LUMP.MODELS), 48, (at) => ({
      min: readVector(view, at),
      max: readVector(view, at + 12),
      headNode: view.getInt32(at + 36, true),
      firstFace: view.getInt32(at + 40, true),
      numFaces: view.getInt32(at + 44, true),
    })),
    brushes: readStructs(view, lump(LUMP.BRUSHES), 12, (at) => ({
      firstSide: view.getInt32(at, true),
      numSides: view.getInt32(at + 4, true),
      contents: view.getInt32(at + 8, true),
    })),
    brushSides: readStructs(view, lump(LUMP.BRUSHSIDES), 8, (at) => ({
      plane: view.getUint16(at, true),
      texinfo: view.getInt16(at + 2, true),
      bevel: view.getUint8(at + 6) !== 0,
    })),
    dispinfos: readStructs(view, lump(LUMP.DISPINFO), 176, (at) => ({
      start: readVector(view, at),
      firstVert: view.getInt32(at + 12, true),
      power: view.getInt32(at + 20, true),
      face: view.getUint16(at + 36, true),
    })),
    dispVerts: readStructs(view, lump(LUMP.DISP_VERTS), 20, (at) => ({
      offset: readVector(view, at),
      dist: view.getFloat32(at + 12, true),
      alpha: view.getFloat32(at + 16, true),
    })),
    lighting,
    worldLights: readStructs(view, lump(lump(LUMP.WORLDLIGHTS).length > 0 ? LUMP.WORLDLIGHTS : LUMP.WORLDLIGHTS_HDR), 88, (at) => ({
      origin: readVector(view, at),
      intensity: readVector(view, at + 12),
      normal: readVector(view, at + 24),
      type: view.getInt32(at + 40, true),
      stopDot: view.getFloat32(at + 52, true),
      stopDot2: view.getFloat32(at + 56, true),
      exponent: view.getFloat32(at + 60, true),
      radius: view.getFloat32(at + 64, true),
      attenuation: [view.getFloat32(at + 68, true), view.getFloat32(at + 72, true), view.getFloat32(at + 76, true)],
    })),
    // Light cubes per leaf, for lighting models. Maps may fill only the LDR or only the HDR set.
    leafAmbient: [
      [LUMP.LEAF_AMBIENT_INDEX, LUMP.LEAF_AMBIENT_LIGHTING],
      [LUMP.LEAF_AMBIENT_INDEX_HDR, LUMP.LEAF_AMBIENT_LIGHTING_HDR],
    ].map(([indexLump, samplesLump]) => ({
      index: readStructs(view, lump(indexLump), 4, (at) => ({
        count: view.getUint16(at, true),
        first: view.getUint16(at + 2, true),
      })),
      samples: readStructs(view, lump(samplesLump), 28, (at) => bytes.subarray(at, at + 24)),
    })),
    pakfile: sub(LUMP.PAKFILE),
    cubemaps: readStructs(view, lump(LUMP.CUBEMAPS), 16, (at) => ({
      x: view.getInt32(at, true), y: view.getInt32(at + 4, true), z: view.getInt32(at + 8, true),
    })),
    gameLumps: readGameLumps(view, lump(LUMP.GAME_LUMP)),
    bytes,
  };
}
