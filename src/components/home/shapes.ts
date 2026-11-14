// Procedural 3D objects, sampled as points and shaded into a luminance grid. Original geometry.

export interface AsciiFrame {
  name: string;
  caption: string;
  description: string;
}

export const FRAMES: AsciiFrame[] = [
  { name: "Key", caption: "Key · scoped to one insight", description: "A rotating 3D key with a round bow, a long shaft and two teeth, drawn as a halftone dot pattern." },
  { name: "Hourglass", caption: "Hourglass · expires without a trade, costs nothing", description: "A rotating 3D hourglass with a glass body between two plates and three posts, drawn as a halftone dot pattern." },
  { name: "Candles", caption: "Candles · the reasoning, not the trade", description: "A rotating 3D candlestick chart with five invented candles on a base, drawn as a halftone dot pattern." },
  { name: "Vault", caption: "Vault · your context stays on your machine", description: "A rotating 3D round vault door with a ring, a hub and four handle spokes, drawn as a halftone dot pattern." },
];

// ---------- geometry ----------
interface Pts { x: number[]; y: number[]; z: number[]; nx: number[]; ny: number[]; nz: number[] }
const empty = (): Pts => ({ x: [], y: [], z: [], nx: [], ny: [], nz: [] });
const push = (p: Pts, x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
  p.x.push(x); p.y.push(y); p.z.push(z); p.nx.push(nx); p.ny.push(ny); p.nz.push(nz);
};
const STEP = 0.012;

function box(p: Pts, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
  for (let a = x0; a <= x1; a += STEP) for (let b = y0; b <= y1; b += STEP) { push(p, a, b, z1, 0, 0, 1); push(p, a, b, z0, 0, 0, -1); }
  for (let a = x0; a <= x1; a += STEP) for (let b = z0; b <= z1; b += STEP) { push(p, a, y1, b, 0, 1, 0); push(p, a, y0, b, 0, -1, 0); }
  for (let a = y0; a <= y1; a += STEP) for (let b = z0; b <= z1; b += STEP) { push(p, x1, a, b, 1, 0, 0); push(p, x0, a, b, -1, 0, 0); }
}

/** Cylinder along Y (vertical). */
function cylY(p: Pts, cx: number, cz: number, y0: number, y1: number, r: number, caps = true) {
  const da = STEP / Math.max(r, 0.05);
  for (let a = 0; a < Math.PI * 2; a += da) {
    const c = Math.cos(a), s = Math.sin(a);
    for (let y = y0; y <= y1; y += STEP) push(p, cx + r * c, y, cz + r * s, c, 0, s);
  }
  if (caps) for (let rr = 0; rr <= r; rr += STEP) for (let a = 0; a < Math.PI * 2; a += STEP / Math.max(rr, 0.04)) {
    push(p, cx + rr * Math.cos(a), y1, cz + rr * Math.sin(a), 0, 1, 0);
    push(p, cx + rr * Math.cos(a), y0, cz + rr * Math.sin(a), 0, -1, 0);
  }
}

/** Cylinder along X. */
function cylX(p: Pts, x0: number, x1: number, cy: number, cz: number, r: number) {
  const da = STEP / Math.max(r, 0.05);
  for (let a = 0; a < Math.PI * 2; a += da) {
    const c = Math.cos(a), s = Math.sin(a);
    for (let x = x0; x <= x1; x += STEP) push(p, x, cy + r * c, cz + r * s, 0, c, s);
  }
}

/** Torus lying in the XY plane (axis Z). */
function torusZ(p: Pts, cx: number, cy: number, R: number, r: number) {
  for (let u = 0; u < Math.PI * 2; u += STEP / R) for (let v = 0; v < Math.PI * 2; v += STEP / r) {
    const cu = Math.cos(u), su = Math.sin(u), cv = Math.cos(v), sv = Math.sin(v);
    push(p, cx + (R + r * cv) * cu, cy + (R + r * cv) * su, r * sv, cv * cu, cv * su, sv);
  }
}

/** Disc in the XY plane facing +Z / -Z, with thickness. */
function discZ(p: Pts, cx: number, cy: number, radius: number, z0: number, z1: number, dome = 0, bright = false) {
  for (let rr = 0; rr <= radius; rr += STEP) for (let a = 0; a < Math.PI * 2; a += STEP / Math.max(rr, 0.05)) {
    push(p, cx + rr * Math.cos(a), cy + rr * Math.sin(a), z1, bright ? -0.45 : (rr / radius) * dome * Math.cos(a), bright ? 0.6 : (rr / radius) * dome * Math.sin(a), bright ? 0.65 : 1);
    push(p, cx + rr * Math.cos(a), cy + rr * Math.sin(a), z0, 0, 0, -1);
  }
  for (let a = 0; a < Math.PI * 2; a += STEP / radius) for (let z = z0; z <= z1; z += STEP)
    push(p, cx + radius * Math.cos(a), cy + radius * Math.sin(a), z, Math.cos(a), Math.sin(a), 0);
}

function key(): Pts {
  const p = empty();
  torusZ(p, -0.7, 0, 0.3, 0.13);
  cylX(p, -0.4, 0.95, 0, 0, 0.09);
  box(p, 0.55, 0.72, -0.34, 0, -0.09, 0.09);
  box(p, 0.8, 0.95, -0.24, 0, -0.09, 0.09);
  box(p, 0.32, 0.45, -0.18, 0, -0.09, 0.09);
  return p;
}

function hourglass(): Pts {
  const p = empty();
  const profile = (y: number) => 0.08 + 0.5 * Math.pow(Math.abs(y), 1.5);
  for (let y = -0.95; y <= 0.95; y += STEP) {
    const r = profile(y);
    const dr = (profile(y + 0.001) - profile(y - 0.001)) / 0.002;
    const len = Math.hypot(1, dr);
    for (let a = 0; a < Math.PI * 2; a += STEP / r) push(p, r * Math.cos(a), y, r * Math.sin(a), Math.cos(a) / len, -dr / len, Math.sin(a) / len);
  }
  cylY(p, 0, 0, 0.95, 1.05, 0.66);
  cylY(p, 0, 0, -1.05, -0.95, 0.66);
  for (let k = 0; k < 3; k++) {
    const a = (k * Math.PI * 2) / 3;
    cylY(p, 0.6 * Math.cos(a), 0.6 * Math.sin(a), -0.95, 0.95, 0.035, false);
  }
  return p;
}

function candles(): Pts {
  const p = empty();
  const data: [number, number, number, number][] = [ // [body lo, body hi, wick lo, wick hi]
    [-0.35, -0.05, -0.5, 0.05], [-0.1, 0.25, -0.2, 0.4], [0.05, 0.55, -0.05, 0.7], [0.15, 0.35, 0.0, 0.6], [-0.05, 0.2, -0.3, 0.3],
  ];
  data.forEach(([lo, hi, wl, wh], i) => {
    const x = -0.95 + i * 0.47;
    box(p, x - 0.12, x + 0.12, lo, hi, -0.12, 0.12);
    box(p, x - 0.02, x + 0.02, wl, wh, -0.02, 0.02);
  });
  box(p, -1.2, 1.2, -0.75, -0.68, -0.3, 0.3);
  return p;
}

function vault(): Pts {
  const p = empty();
  discZ(p, 0, 0, 0.95, -0.12, 0.12, 0.7);
  torusZ(p, 0, 0, 0.72, 0.04);
  torusZ(p, 0, 0, 0.5, 0.03);
  discZ(p, 0, 0, 0.17, 0.12, 0.26, 0, true);
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2 + Math.PI / 4;
    const cx = Math.cos(a), cy = Math.sin(a);
    for (let t = 0.17; t <= 0.52; t += STEP) {
      for (let w = -0.03; w <= 0.03; w += STEP) {
        push(p, t * cx - w * cy, t * cy + w * cx, 0.26, -0.45, 0.6, 0.65);
        push(p, t * cx - w * cy, t * cy + w * cx, 0.2, -0.45, 0.6, 0.65);
      }
    }
    discZ(p, 0.58 * cx, 0.58 * cy, 0.07, 0.12, 0.3, 0, true);
  }
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    discZ(p, 0.86 * Math.cos(a), 0.86 * Math.sin(a), 0.04, 0.12, 0.17, 0, true);
  }
  return p;
}

const BUILDERS = [key, hourglass, candles, vault];
const CACHE: (Pts | null)[] = [null, null, null, null];
const geometry = (i: number) => (CACHE[i] ??= BUILDERS[i]());

// ---------- renderer ----------
const LIGHT = (() => { const l = [-0.45, 0.6, 0.65]; const n = Math.hypot(...l); return l.map((v) => v / n); })();
const HALF = (() => { const h = [LIGHT[0], LIGHT[1], LIGHT[2] + 1]; const n = Math.hypot(...h); return h.map((v) => v / n); })();
const ZOOM = [0.95, 0.82, 0.95, 0.88];

/** Fills `lum` (cols x rows, square cells) with 0..1 brightness, or -1 where empty. */
export function renderLum(index: number, angle: number, cols: number, rows: number, lum: Float32Array): void {
  const g = geometry(index);
  const cA = Math.cos(angle), sA = Math.sin(angle);
  const tilt = index === 1 ? 0.2 : 0.14;
  const cT = Math.cos(tilt), sT = Math.sin(tilt);
  const depth = new Float32Array(cols * rows).fill(-Infinity);
  lum.fill(-1);
  const s = (rows / 2.35) * ZOOM[index];
  for (let i = 0; i < g.x.length; i++) {
    const x = g.x[i] * cA + g.z[i] * sA;
    const nx = g.nx[i] * cA + g.nz[i] * sA;
    let z = -g.x[i] * sA + g.z[i] * cA, y = g.y[i];
    let nz = -g.nx[i] * sA + g.nz[i] * cA, ny = g.ny[i];
    const y2 = y * cT - z * sT, z2 = y * sT + z * cT;
    const ny2 = ny * cT - nz * sT, nz2 = ny * sT + nz * cT;
    y = y2; z = z2; ny = ny2; nz = nz2;
    const f = 4 / (4 - z);
    const col = Math.round(cols / 2 + x * s * f), row = Math.round(rows / 2 - y * s * f);
    if (col < 0 || col >= cols || row < 0 || row >= rows) continue;
    const k = row * cols + col;
    if (z <= depth[k]) continue;
    depth[k] = z;
    const d = Math.abs(nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
    const h = Math.abs(nx * HALF[0] + ny * HALF[1] + nz * HALF[2]);
    lum[k] = Math.min(1, 0.14 + d * 0.72 + Math.pow(h, 28) * 0.5);
  }
}
