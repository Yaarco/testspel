/**
 * Animation sampling and skinning matrices for glTF skeletons. A model's
 * nodes give the rest pose; a clip (from another .glb) overrides nodes with
 * the same name, which is how viewmodel clips drive both the arms and
 * the weapon. Matrices are column-major 4x4 (WebGL order).
 */

function compose(t, q, s) {
  const [x, y, z, w] = q;
  const [sx, sy, sz] = s;
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}

export function multiply(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** Inverse of a rotation-plus-translation matrix (no scale). */
export function invertRigid(m) {
  const [t0, t1, t2] = [m[12], m[13], m[14]];
  return [
    m[0], m[4], m[8], 0,
    m[1], m[5], m[9], 0,
    m[2], m[6], m[10], 0,
    -(m[0] * t0 + m[1] * t1 + m[2] * t2), -(m[4] * t0 + m[5] * t1 + m[6] * t2), -(m[8] * t0 + m[9] * t1 + m[10] * t2), 1,
  ];
}

/** Value of one animation channel at a time, interpolated linearly (quaternions normalized). */
function sample(channel, time) {
  const { times, values } = channel;
  const size = values.length / times.length;
  let k = 0;
  while (k < times.length - 2 && times[k + 1] <= time) k++;
  const span = times[k + 1] - times[k];
  const f = times.length > 1 && span > 0 ? Math.min(Math.max((time - times[k]) / span, 0), 1) : 0;
  const a = Array.from(values.subarray(k * size, k * size + size));
  if (f === 0 || times.length === 1) return a;
  const b = values.subarray((k + 1) * size, (k + 2) * size);
  if (size === 4 && a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0) {
    for (let i = 0; i < 4; i++) a[i] = -a[i];   // take the short way around
  }
  const mixed = a.map((v, i) => v + (b[i] - v) * f);
  if (size !== 4) return mixed;
  const length = Math.hypot(...mixed);
  return mixed.map((v) => v / length);
}

/** Clip tracks keyed by node name, so they can drive any skeleton that shares the names. */
export function clipTracks(clipGlb) {
  const animation = clipGlb.animations[0];
  const tracks = new Map();
  for (const channel of animation?.channels ?? []) {
    const name = clipGlb.nodes[channel.node].name;
    if (!tracks.has(name)) tracks.set(name, {});
    tracks.get(name)[channel.path] = channel;
  }
  return { tracks, duration: animation?.duration ?? 0 };
}

/**
 * Twist bones (arm_lower_L_TWIST, ...) are not animated by the clips; the game
 * drives them from the hand so the forearm skin turns with the wrist instead
 * of wringing at it. Each sits on the line from its parent to the hand and
 * takes the share of the hand's roll about that line given by how far along
 * it sits. Returns [{ bone, driver, axis, share }].
 */
export function findTwistBones(nodes) {
  const length = (v) => Math.hypot(v[0], v[1], v[2]);
  const constraints = [];
  nodes.forEach((node, bone) => {
    if (!/_twist\d*$/i.test(node.name) || node.parent < 0) return;
    const reach = length(node.translation);
    let driver = -1;
    nodes.forEach((other, j) => {
      if (other.parent !== node.parent || j === bone || /_twist\d*$/i.test(other.name)) return;
      const along = length(other.translation);
      const dot = node.translation.reduce((sum, v, k) => sum + v * other.translation[k], 0);
      if (along > reach && dot > 0.99 * reach * along && (driver < 0 || along > length(nodes[driver].translation))) driver = j;
    });
    if (driver < 0) return;
    const along = length(nodes[driver].translation);
    constraints.push({ bone, driver, axis: nodes[driver].translation.map((v) => v / along), share: reach / along });
  });
  return constraints;
}

const conjugate = ([x, y, z, w]) => [-x, -y, -z, w];

function quatMultiply([ax, ay, az, aw], [bx, by, bz, bw]) {
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** The part of rotation q that turns about a unit axis, scaled by `share` (swing-twist decomposition). */
function twistShare(q, axis, share) {
  const sign = q[3] < 0 ? -1 : 1;
  const along = sign * (q[0] * axis[0] + q[1] * axis[1] + q[2] * axis[2]);
  const angle = 2 * Math.atan2(along, sign * q[3]) * share;
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

/**
 * World matrices of every node of a model, with a clip applied at `time`.
 * `under` is a matrix applied above the roots (where the model sits);
 * `twists` comes from findTwistBones.
 */
export function poseNodes(nodes, clip, time, under = null, twists = []) {
  const poses = nodes.map((node) => {
    const track = clip?.tracks.get(node.name);
    if (node.matrix && !track) return { matrix: node.matrix };
    return {
      t: track?.translation ? sample(track.translation, time) : node.translation,
      r: track?.rotation ? sample(track.rotation, time) : node.rotation,
      s: track?.scale ? sample(track.scale, time) : node.scale,
    };
  });
  for (const { bone, driver, axis, share } of twists) {
    if (!poses[driver].r || !poses[bone].r) continue;
    const roll = quatMultiply(poses[driver].r, conjugate(nodes[driver].rotation));   // the hand's turn from rest, in parent space
    poses[bone] = { ...poses[bone], r: quatMultiply(twistShare(roll, axis, share), nodes[bone].rotation) };
  }
  const world = [];
  poses.forEach((pose, i) => {
    const local = pose.matrix ?? compose(pose.t, pose.r, pose.s);
    const parent = nodes[i].parent >= 0 ? world[nodes[i].parent] : under;
    world[i] = parent ? multiply(parent, local) : local;
  });
  return world;
}

/**
 * World matrices for another model's skeleton (sleeves, gloves) taken from
 * a posed skeleton by bone name. Bones the posed skeleton lacks follow their
 * parent at their rest offset.
 */
export function followPose(nodes, sourceNodes, sourceWorld, under = null) {
  const byName = new Map(sourceNodes.map((node, i) => [node.name, sourceWorld[i]]));
  const world = [];
  nodes.forEach((node, i) => {
    const posed = byName.get(node.name);
    if (posed) {
      world[i] = posed;
      return;
    }
    const local = node.matrix ?? compose(node.translation, node.rotation, node.scale);
    const parent = node.parent >= 0 ? world[node.parent] : under;
    world[i] = parent ? multiply(parent, local) : local;
  });
  return world;
}

/** Skinning matrices for a mesh: world(joint) x inverse bind, packed 16 floats per joint. */
export function jointMatrices(world, skin) {
  const out = new Float32Array(skin.joints.length * 16);
  skin.joints.forEach((joint, j) => {
    out.set(multiply(world[joint], Array.from(skin.inverseBind.subarray(j * 16, j * 16 + 16))), j * 16);
  });
  return out;
}
