/**
 * The finish step: converts the extracted textures to WebP, points the
 * models at them, deletes what the game does not read and writes the manifest.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { withoutExtension } from './common.mjs';
import { ALBEDO_STYLES } from './weapons.mjs';
import { zipFolder } from './zip.mjs';

/** Runs jobs with a few at a time in flight. */
async function inParallel(items, job, limit = Math.max(2, cpus().length)) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await job(items[next++]);
  };
  await Promise.all(Array.from({ length: limit }, worker));
}

function pngSize(file) {
  const header = readFileSync(file).subarray(16, 24);
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
}

const run = promisify(execFile);
const COLOR_CHUNKS = new Set(['gAMA', 'cICP', 'iCCP', 'sRGB', 'cHRM']);

/**
 * Drops a PNG's color space chunks. ffmpeg tags maps converted from EXR as
 * linear, and cwebp would then re-encode them to sRGB; they are data, not colors.
 */
function withoutColorSpace(file) {
  const data = readFileSync(file);
  const chunks = [data.subarray(0, 8)];
  for (let at = 8; at < data.length;) {
    const length = data.readUInt32BE(at);
    const end = at + 12 + length;
    if (!COLOR_CHUNKS.has(data.toString('latin1', at + 4, at + 8))) chunks.push(data.subarray(at, end));
    at = end;
  }
  writeFileSync(file, Buffer.concat(chunks));
}

/** Converts one exported texture (.png, or .exr for position maps) to WebP no larger than maxSize. */
async function toWebp(source, target, maxSize, lossless) {
  let png = source;
  if (source.endsWith('.exr')) {
    png = `${withoutExtension(source)}.tmp.png`;
    await run('ffmpeg', ['-v', 'error', '-y', '-i', source, '-pix_fmt', 'rgba', png]);
    withoutColorSpace(png);
  }
  const { width, height } = pngSize(png);
  const scale = Math.min(1, maxSize / Math.max(width, height));
  const args = lossless ? ['-lossless'] : ['-q', '88'];
  if (scale < 1) args.push('-resize', String(Math.round(width * scale)), String(Math.round(height * scale)));
  // -exact keeps color under transparent pixels: masks and position maps store data there.
  await run('cwebp', [...args, '-exact', '-quiet', png, '-o', target]);
  rmSync(png, { force: true });
  if (png !== source) rmSync(source, { force: true });
}

/** Rewrites a .glb's JSON chunk. */
function rewriteGlb(file, edit) {
  const data = readFileSync(file);
  const jsonLength = data.readUInt32LE(12);
  const json = edit(JSON.parse(data.subarray(20, 20 + jsonLength).toString()));
  let text = JSON.stringify(json);
  text += ' '.repeat((4 - (text.length % 4)) % 4);
  const jsonChunk = Buffer.from(text);
  const rest = data.subarray(20 + jsonLength);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + jsonChunk.length + rest.length, 8);
  header.writeUInt32LE(jsonChunk.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  writeFileSync(file, Buffer.concat([header, jsonChunk, rest]));
}

export async function finish(work, out) {
  const { manifest, textures, models } = JSON.parse(readFileSync(join(work, 'plan.json'), 'utf8'));
  const files = () => readdirSync(out, { recursive: true }).map((f) => join(out, f));
  const jobs = [];
  for (const file of files()) if (file.endsWith('_physics.glb')) rmSync(file);

  // Model textures: keep base colors only, as WebP.
  const keep = new Set();
  for (const [model, maxSize] of Object.entries(models)) {
    const file = join(out, model);
    if (!existsSync(file)) continue;
    const folder = dirname(file);
    rewriteGlb(file, (json) => {
      const used = new Set((json.materials ?? []).map((m) => m.pbrMetallicRoughness?.baseColorTexture?.index)
        .filter((index) => index !== undefined).map((index) => json.textures[index].source));
      json.images?.forEach((image, i) => {
        if (!used.has(i)) return;
        const target = join(folder, `${withoutExtension(image.uri)}.webp`);
        const source = join(folder, `${withoutExtension(image.uri)}.png`);
        image.uri = `${withoutExtension(image.uri)}.webp`;
        if (existsSync(source)) jobs.push({ source, target, maxSize, lossless: false });
        keep.add(target);
      });
      return json;
    });
  }

  // Standalone textures: paint inputs, patterns, glove layers, icons.
  for (const [resource, { max, lossless }] of Object.entries(textures)) {
    const base = join(out, withoutExtension(resource));
    const source = [`${base}.png`, `${base}.exr`].find(existsSync);
    keep.add(`${base}.webp`);
    if (source) jobs.push({ source, target: `${base}.webp`, maxSize: max, lossless });
  }

  // A texture several models share is converted once.
  const unique = [...new Map(jobs.map((job) => [job.target, job])).values()];
  jobs.length = 0;
  jobs.push(...unique);
  let done = 0;
  await inParallel(jobs, async ({ source, target, maxSize, lossless }) => {
    await toWebp(source, target, maxSize, lossless);
    if (++done % 250 === 0) console.log(`  ${done}/${jobs.length} textures converted`);
  });

  // Everything else the exports wrote is unused.
  for (const file of files()) {
    if (/\.(png|exr|tga|vsnd|vsvg)$/.test(file) || (file.endsWith('.webp') && !keep.has(file))) rmSync(file);
  }

  writeFileSync(join(out, 'manifest.json'), JSON.stringify(prune(manifest, out)));
  // The asset pack the game asks for when it is not served next to the page.
  const pack = join(dirname(out), 'asset-pack.zip');
  const { files: packed, bytes } = zipFolder(out, pack);
  console.log(`${pack}: ${packed} files, ${(bytes / 1048576).toFixed(0)} MB.`);
  const count = (object) => Object.keys(object).length;
  const pairs = Object.values(manifest.weapons).reduce((sum, w) => sum + w.finishes.length, 0);
  console.log(`manifest.json: ${count(manifest.weapons)} weapons, ${pairs} weapon finishes, ${count(manifest.gloveFinishes)} glove finishes, ${count(manifest.agents)} agents.`);
}

/** Leaves out anything that did not extract, so the game never asks for a missing file. */
function prune(manifest, out) {
  const exists = (path) => Boolean(path) && existsSync(join(out, path));
  const missing = [];
  const check = (path) => exists(path) || (path && missing.push(path), false);
  const orNull = (path) => (check(path) ? path : null);
  // The converter writes each sound in its source format: usually .wav, sometimes .mp3.
  const sound = (path) => (exists(path) ? path : [path.replace(/\.wav$/, '.mp3')].find(exists) ?? (missing.push(path), null));
  const sounds = (list) => list.map(sound).filter(Boolean);

  for (const [id, record] of Object.entries(manifest.finishes)) {
    for (const key of ['pattern', 'masks', 'ramp']) record[key] = orNull(record[key]);
    if (!record.ramp) record.caseHardening = null;
    if (ALBEDO_STYLES.has(record.style) && !record.pattern) delete manifest.finishes[id];
  }
  for (const [id, weapon] of Object.entries(manifest.weapons)) {
    if (!check(weapon.model)) {
      delete manifest.weapons[id];
      continue;
    }
    weapon.icon = orNull(weapon.icon);
    for (const [name, clips] of Object.entries(weapon.clips)) weapon.clips[name] = clips.filter(check);
    for (const s of Object.values(weapon.sounds)) if (s) s.files = sounds(s.files);
    if (weapon.reload) weapon.reload.sounds = weapon.reload.sounds.map((s) => ({ ...s, files: sounds(s.files) })).filter((s) => s.files.length);
    for (const key of Object.keys(weapon.paint)) {
      weapon.paint[key] = weapon.paint[key].filter((c) => ['masks', 'cavity', 'surface', 'position'].every((k) => check(c[k])));
    }
    const paintable = weapon.paint.hd.length || weapon.paint.legacy.length;
    weapon.finishes = paintable ? weapon.finishes.filter((f) => manifest.finishes[f.id]) : [];
    for (const f of weapon.finishes) f.icon = orNull(f.icon);
  }
  for (const [id, record] of Object.entries(manifest.gloveFinishes)) {
    if (!check(record.layerMask)) delete manifest.gloveFinishes[id];
    else {
      record.surface = orNull(record.surface);
      record.details = record.details.map(orNull);
      record.pattern = orNull(record.pattern);
    }
  }
  for (const [id, glove] of Object.entries(manifest.gloves)) {
    glove.finishes = glove.finishes.filter((f) => manifest.gloveFinishes[f.id]);
    for (const f of glove.finishes) f.icon = orNull(f.icon);
    if (!check(glove.model) || !glove.finishes.length) delete manifest.gloves[id];
  }
  for (const [id, agent] of Object.entries(manifest.agents)) {
    if (!check(agent.arms) || !check(agent.body)) delete manifest.agents[id];
    else agent.icon = orNull(agent.icon);
  }
  for (const clips of [...Object.values(manifest.bodyClips), ...Object.values(manifest.menuPoses)]) {
    for (const [name, path] of Object.entries(clips)) if (!check(path)) delete clips[name];
  }
  for (const [name, path] of Object.entries(manifest.ui.icons)) if (!check(path)) delete manifest.ui.icons[name];
  manifest.ui.fonts = manifest.ui.fonts.filter(check);
  for (const sets of [manifest.footsteps, manifest.landings]) for (const [surface, list] of Object.entries(sets)) sets[surface] = sounds(list);
  manifest.jump = sounds(manifest.jump);
  if (missing.length) console.log(`Not extracted (left out): ${missing.length} files, e.g. ${missing.slice(0, 5).join(', ')}`);
  return manifest;
}
