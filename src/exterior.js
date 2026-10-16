/** Exterior names by wear (float). */
const EXTERIORS = [[0.07, 'Factory New'], [0.15, 'Minimal Wear'], [0.38, 'Field-Tested'], [0.45, 'Well-Worn'], [1.01, 'Battle-Scarred']];

export function exteriorName(wear) {
  return EXTERIORS.find(([limit]) => wear < limit)[1];
}
