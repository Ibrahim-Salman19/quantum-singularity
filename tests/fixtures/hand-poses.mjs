/**
 * Synthetic MediaPipe hand landmark generator.
 *
 * Produces the 21-point hand topology in *world* landmark space (metres, wrist at
 * the origin, y-up) plus a matching normalized/image-space projection, so the
 * gesture classifier can be exercised deterministically without a camera.
 *
 * Landmark indices follow the MediaPipe hand model:
 *   0 wrist
 *   1-4   thumb   (CMC, MCP, IP, TIP)
 *   5-8   index   (MCP, PIP, DIP, TIP)
 *   9-12  middle  (MCP, PIP, DIP, TIP)
 *   13-16 ring    (MCP, PIP, DIP, TIP)
 *   17-20 pinky   (MCP, PIP, DIP, TIP)
 */

// Finger geometry in metres: MCP offset across the palm, and the three bone lengths.
const FINGERS = {
  index:  { idx: [5, 6, 7, 8],     mcpX: -0.030, mcpY: 0.075, bones: [0.040, 0.026, 0.021] },
  middle: { idx: [9, 10, 11, 12],  mcpX: -0.008, mcpY: 0.080, bones: [0.045, 0.029, 0.022] },
  ring:   { idx: [13, 14, 15, 16], mcpX:  0.014, mcpY: 0.076, bones: [0.041, 0.027, 0.021] },
  pinky:  { idx: [17, 18, 19, 20], mcpX:  0.035, mcpY: 0.068, bones: [0.032, 0.020, 0.018] }
};

/**
 * Build one finger.
 * @param {number} curl 0 = fully extended, 1 = fully folded into the palm.
 * @param {number} spread lateral fan angle in radians.
 */
function buildFinger(out, spec, curl, spread) {
  const [mcpI] = spec.idx;
  let x = spec.mcpX, y = spec.mcpY, z = 0;
  out[mcpI] = { x, y, z };

  // Each successive joint bends more, which is how a real finger curls.
  const bendPerJoint = [curl * 1.15, curl * 1.45, curl * 1.25];
  let angle = 0;
  for (let b = 0; b < 3; b++) {
    angle += bendPerJoint[b];
    const len = spec.bones[b];
    // Rotate in the sagittal plane (y forward, z toward the camera) and fan laterally.
    x += Math.sin(spread) * len * Math.cos(angle) * 0.35;
    y += Math.cos(angle) * len;
    z += Math.sin(angle) * len;
    out[spec.idx[b + 1]] = { x, y, z };
  }
}

function buildThumb(out, curl, abduction) {
  // Thumb splays away from the index side (negative x) when open.
  const a = abduction;
  out[1] = { x: -0.028, y: 0.022, z: 0.006 };
  const dirs = [
    { len: 0.034, ax: -0.80 * a - 0.10, ay: 0.55, az: 0.10 + curl * 0.55 },
    { len: 0.031, ax: -0.72 * a - 0.14, ay: 0.48 - curl * 0.30, az: 0.16 + curl * 0.72 },
    { len: 0.024, ax: -0.62 * a - 0.18, ay: 0.40 - curl * 0.42, az: 0.20 + curl * 0.86 }
  ];
  let { x, y, z } = out[1];
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i];
    const n = Math.hypot(d.ax, d.ay, d.az) || 1;
    x += (d.ax / n) * d.len;
    y += (d.ay / n) * d.len;
    z += (d.az / n) * d.len;
    out[2 + i] = { x, y, z };
  }
}

/**
 * @param {object} o
 * @param {number} o.thumb     thumb curl (0 open .. 1 tucked)
 * @param {number} o.index     index curl
 * @param {number} o.middle    middle curl
 * @param {number} o.ring      ring curl
 * @param {number} o.pinky     pinky curl
 * @param {number} [o.spread]  finger fan (radians)
 * @param {number} [o.roll]    rotation about the y axis (turns the palm edge-on)
 * @param {number} [o.tilt]    rotation about the z axis (tips the hand sideways)
 * @param {number} [o.scale]   overall hand size multiplier (distance proxy)
 * @param {number} [o.centerX] image-space centre for the normalized projection
 * @param {number} [o.centerY]
 */
export function makeHand(o) {
  const {
    thumb = 0, index = 0, middle = 0, ring = 0, pinky = 0,
    spread = 0, roll = 0, tilt = 0, scale = 1,
    centerX = 0.5, centerY = 0.5
  } = o;

  const world = new Array(21);
  world[0] = { x: 0, y: 0, z: 0 };
  buildThumb(world, thumb, 1 - thumb);

  const fans = { index: -1.15, middle: -0.35, ring: 0.35, pinky: 1.15 };
  for (const name of ['index', 'middle', 'ring', 'pinky']) {
    buildFinger(world, FINGERS[name], o[name] ?? 0, spread * fans[name]);
  }

  const cr = Math.cos(roll), sr = Math.sin(roll);
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  for (let i = 0; i < 21; i++) {
    let { x, y, z } = world[i];
    x *= scale; y *= scale; z *= scale;
    // Yaw about y, then roll about z.
    let rx = x * cr + z * sr;
    let rz = -x * sr + z * cr;
    const fx = rx * ct - y * st;
    const fy = rx * st + y * ct;
    world[i] = { x: fx, y: fy, z: rz };
  }

  // Normalized/image-space projection. Image y grows downward, hence the sign flip.
  // 0.55 maps a ~0.19m hand span onto a plausible fraction of the frame.
  const normalized = world.map(p => ({
    x: centerX + p.x * 2.2,
    y: centerY - p.y * 2.2,
    z: p.z
  }));

  return { world, normalized };
}

/** Canonical poses used across the gesture specs. */
export const POSES = {
  openPalm:  () => makeHand({ thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0, spread: 0.55 }),
  point:     () => makeHand({ thumb: 0.75, index: 0, middle: 1, ring: 1, pinky: 1 }),
  victory:   () => makeHand({ thumb: 0.8, index: 0, middle: 0, ring: 1, pinky: 1, spread: 1.0 }),
  fist:      () => makeHand({ thumb: 1, index: 1, middle: 1, ring: 1, pinky: 1 }),
  // Two fingers up but held together: must NOT read as a confident Victory.
  twoTogether: () => makeHand({ thumb: 0.8, index: 0, middle: 0, ring: 1, pinky: 1, spread: 0.0 })
};
