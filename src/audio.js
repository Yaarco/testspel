/**
 * Game sounds from the asset pack, played through Web
 * Audio. The manifest lists the files for each weapon action and each
 * footstep surface; one variant is picked at random per play.
 * Files are fetched and decoded the first time they are needed.
 * Sequences such as a reload's are scheduled on the game clock, so they
 * pause with the game and stop when the reload is cut short.
 */
const MASTER_VOLUME = 0.6;   // at a volume setting of 1
const PITCH_VARIATION = 0.04;

/**
 * Map surface properties (from a material's $surfaceprop) to footstep
 * sets. The first rule whose words appear in the surface name wins.
 */
const SURFACE_RULES = [
  [['chainlink'], 'metal_chainlink'],
  [['grate', 'vent'], 'metal_grate'],
  [['metal', 'combine', 'canister', 'computer'], 'metal_solid'],
  [['glass', 'ice'], 'glass'],
  [['tile', 'ceramic', 'porcelain'], 'tile'],
  [['wood', 'crate', 'ladder'], 'wood'],
  [['grass', 'foliage'], 'grass'],
  [['gravel'], 'gravel'],
  [['mud', 'slime'], 'mud'],
  [['sand'], 'sand'],
  [['snow'], 'snow'],
  [['dirt', 'earth'], 'dirt'],
  [['carpet', 'cloth', 'fabric'], 'carpet'],
  [['rubber', 'plastic'], 'rubber'],
];
const DEFAULT_SURFACE = 'concrete_ct';

export function footstepSet(surfaceProp) {
  const name = surfaceProp.toLowerCase();
  return SURFACE_RULES.find(([words]) => words.some((word) => name.includes(word)))?.[1] ?? DEFAULT_SURFACE;
}

export class SoundSystem {
  constructor() {
    this.context = null;
    this.manifest = null;
    this.pack = null;
    this.volume = 1;   // the player's volume setting, 0 to 1
    this.buffers = new Map();
    this.scheduled = [];   // { key, at, files, volume, pan }
  }

  /** Plays `sounds` ({ time, files, volume }) at `start` + each one's time, replacing what `key` had scheduled. */
  schedule(key, sounds, start, { volume = 1, pan = 0 } = {}) {
    this.cancel(key);
    for (const sound of sounds) this.scheduled.push({ key, at: start + sound.time, files: sound.files, volume: sound.volume * volume, pan });
  }

  cancel(key) {
    if (this.scheduled.length) this.scheduled = this.scheduled.filter((sound) => sound.key !== key);
  }

  /** Plays the scheduled sounds that are due by `time`. */
  update(time) {
    if (!this.scheduled.some((sound) => sound.at <= time)) return;
    for (const sound of this.scheduled) if (sound.at <= time) this.play(sound.files, sound.volume, sound.pan);
    this.scheduled = this.scheduled.filter((sound) => sound.at > time);
  }

  /** Audio can only start after a user gesture, so this is called when play starts. */
  resume() {
    this.context ??= new AudioContext();
    if (this.context.state === 'suspended') this.context.resume();
  }

  setManifest(pack, manifest) {
    this.pack = pack;
    this.manifest = manifest;
  }

  /** Plays one random file of a list (paths relative to the asset folder); `pan` from -1 (left) to 1 (right). */
  play(files, volume = 1, pan = 0) {
    if (!this.context || !files?.length) return;
    const file = files[Math.floor(Math.random() * files.length)];
    const rate = 1 + (Math.random() * 2 - 1) * PITCH_VARIATION;
    if (this.volume > 0) this.playFile(file, volume * MASTER_VOLUME * this.volume, rate, pan);
  }

  async playFile(file, volume, rate, pan) {
    if (!this.buffers.has(file)) {
      this.buffers.set(file, this.pack.fetch(file)
        .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(file))))
        .then((bytes) => this.context.decodeAudioData(bytes))
        .catch(() => null));
    }
    const buffer = await this.buffers.get(file);
    if (!buffer) return;
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    gain.gain.value = volume;
    const panner = this.context.createStereoPanner();
    panner.pan.value = pan;
    source.connect(gain).connect(panner).connect(this.context.destination);
    source.start();
  }

  /** A weapon sound; others' weapons are quieter with distance and panned by direction. */
  weapon(id, action, { volume = 1, pan = 0 } = {}) {
    const sound = this.manifest?.weapons[id]?.sounds[action];
    if (sound) this.play(sound.files, sound.volume * volume, pan);
  }

  step(surfaceProp, volume) {
    const set = footstepSet(surfaceProp);
    this.play(this.manifest?.footsteps[set] ?? this.manifest?.footsteps[DEFAULT_SURFACE], volume);
  }

  /** Landing sounds per surface; fall back to a footstep where there are none. */
  land(surfaceProp, volume) {
    const set = footstepSet(surfaceProp);
    const files = this.manifest?.landings[set] ?? this.manifest?.landings[DEFAULT_SURFACE];
    if (files?.length) this.play(files, volume);
    else this.step(surfaceProp, volume);
  }

  jump(volume) {
    this.play(this.manifest?.jump, volume);
  }
}
