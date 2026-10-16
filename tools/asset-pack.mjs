/**
 * Decides which game files the asset pack needs, and turns the extracted
 * files into what the browser loads. Run by tools/make-asset-pack.sh in two steps:
 *
 *   node tools/asset-pack.mjs plan <work> <out>
 *     Reads the game data decompiled into <work> and writes the lists of
 *     files to extract (only those <out> does not have yet) and plan.json.
 *
 *   node tools/asset-pack.mjs finish <work> <out>
 *     Converts the extracted textures to WebP (downscaled), points the models
 *     at them, deletes everything the game does not read and writes
 *     <out>/manifest.json.
 *
 * Weapons, knives and gloves come with every finish that has an inventory
 * icon. A finish is stored as the parameters of the paint shaders
 * (style, colors, pattern texture, placement ranges); the game composites
 * it on the GPU.
 */
import { finish } from './pack/finish.mjs';
import { plan } from './pack/plan.mjs';

const [command, work, out] = process.argv.slice(2);
if (command === 'plan') plan(work, out);
else if (command === 'finish') await finish(work, out);
else {
  console.error('Usage: node tools/asset-pack.mjs plan|finish <work> <out>');
  process.exit(1);
}
