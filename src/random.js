/** Small seeded random generator (mulberry32) so a course can be replayed from its seed. */
export function createRng(seed) {
  let state = seed >>> 0;

  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    pick: (items) => items[Math.floor(next() * items.length)],
    unitVector() {
      const z = 2 * next() - 1;
      const angle = 2 * Math.PI * next();
      const r = Math.sqrt(1 - z * z);
      return { x: r * Math.cos(angle), y: r * Math.sin(angle), z };
    },
  };
}

export function randomSeed() {
  return Math.floor(Math.random() * 2 ** 32);
}
