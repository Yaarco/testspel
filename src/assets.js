/**
 * Looks up game files across several archives: the map's own pakfile first
 * (maps may override stock assets), then any game .vpk files the player picked.
 * Reads are async because .vpk contents are sliced from disk on demand.
 */
export class AssetLibrary {
  constructor(archives) {
    this.archives = archives;
  }

  has(path) {
    return this.archives.some((archive) => archive.has(path));
  }

  async read(path) {
    for (const archive of this.archives) {
      if (archive.has(path)) {
        const bytes = await archive.read(path);
        if (bytes) return bytes;
      }
    }
    return null;
  }

  async readText(path) {
    const bytes = await this.read(path);
    return bytes ? new TextDecoder('latin1').decode(bytes) : null;
  }
}
