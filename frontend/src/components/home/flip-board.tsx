"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { renderLum } from "./shapes";

/** Which 3D object stands beside the words: the index into the shapes in shapes.ts. */
type Shape = 0 | 1 | 2 | 3; // key, hourglass, candles, vault
interface Message {
  /** What the dot under the board is called for screen readers. */
  label: string;
  /** The big lines beside the 3D object on a roomy board. */
  column: string[];
  /** The big lines on a phone, where there is no room for the object. */
  narrow: string[];
  object: Shape;
  /** One short line under the big words, only on a roomy board. */
  sub: string;
  /** What a screen reader hears when the board changes. */
  caption: string;
}

const MESSAGES: Message[] = [
  {
    label: "title", object: 1,
    column: ["BORROW THE", "REASONING.", "PAY ONLY WHEN", "IT'S USED."],
    narrow: ["BORROW THE", "REASONING.", "PAY ONLY", "WHEN IT'S", "USED."],
    sub: "", caption: "Borrow the reasoning. Pay only when it's used.",
  },
  { label: "borrow", object: 0, column: ["BORROW"], narrow: ["BORROW"], sub: "A key scoped to one insight", caption: "Borrow the reasoning with a key scoped to one insight." },
  { label: "publish", object: 2, column: ["PUBLISH"], narrow: ["PUBLISH"], sub: "The reasoning, not the trade", caption: "Publish the reasoning, not the trade." },
  { label: "expires free", object: 1, column: ["EXPIRES", "FREE"], narrow: ["EXPIRES", "FREE"], sub: "No trade, no charge", caption: "If the thesis expires without a trade, it costs nothing." },
  { label: "stays local", object: 3, column: ["STAYS", "LOCAL"], narrow: ["STAYS", "LOCAL"], sub: "Your context stays with you", caption: "Your context stays on your machine." },
];

const REDUCED = "(prefers-reduced-motion: reduce)";
function watchReducedMotion(onChange: () => void) {
  const mq = window.matchMedia(REDUCED);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

const INTERVAL = 8000; // the title stays up a little longer, since it is the headline
const FLIP_MS = 520;
const SWEEP_MS = 1100; // a message sweeps across the whole board in about this long
const JITTER_MS = 380;
const WIDE_PX = 640; // below this the board is a phone layout: the words stack and there is no 3D object
const OVERLAY_PX = 130; // room kept clear at the bottom for the buttons and dots
const OVERLAY_PX_NARROW = 150;
const SWAY = 0.9; // how far the 3D object turns each way, in radians
const SPEED = 0.0007;
const ROTATE_MS = 66; // the object is redrawn about 15 times a second
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/**
 * Tile levels. 0 is off and 1 to 4 are shades of the object, from dark to light. BRIGHT is the big words and the lit
 * edge of the object. SMALL is the small words, and 7 to 9 are the shades that soften their edges.
 */
const BRIGHT = 5, SMALL = 6;

function hex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** The ten tile colours for the current theme: off, four shades toward the text colour, the text colour, the muted colour and three shades toward it. */
function palette(off: string, text: string, muted: string): string[] {
  const o = hex(off), t = hex(text), m = hex(muted);
  if (!o || !t || !m) return [off, text, text, text, text, text, muted, muted, muted, muted];
  const mix = (to: number[], k: number) => `rgb(${o.map((v, i) => Math.round(v + (to[i] - v) * k)).join(",")})`;
  return [off, mix(t, 0.2), mix(t, 0.4), mix(t, 0.6), mix(t, 0.8), text, muted, mix(m, 0.4), mix(m, 0.65), mix(m, 0.85)];
}

interface Placed { shape: Shape; x: number; y: number; side: number }
interface Layout { mask: Uint8Array; object: Placed | null }

/** The 3D object as tile levels: lit tiles are shaded by the light, and a few steps of dither keep the shading smooth. */
function objectLevels(o: Placed, angle: number): Uint8Array {
  const lum = new Float32Array(o.side * o.side);
  renderLum(o.shape, angle, o.side, o.side, lum);
  const out = new Uint8Array(lum.length);
  for (let y = 0; y < o.side; y++) for (let x = 0; x < o.side; x++) {
    const raw = lum[y * o.side + x];
    if (raw < 0) continue;
    const v = Math.min(1, Math.max(0, (raw - 0.12) / 0.78)); // stretch the shading so the light and dark sides stand apart
    const q = Math.floor(v * 4 + BAYER[(y & 3) * 4 + (x & 3)] / 16 - 0.2 + 0.5);
    out[y * o.side + x] = 1 + Math.max(0, Math.min(4, q));
  }
  return out;
}

/** Breaks text into lines no wider than `max` tiles, measured with the context's current font. */
function wrapText(g: CanvasRenderingContext2D, text: string, max: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && g.measureText(next).width > max) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  return out;
}

/**
 * Draws one message into a cols x rows grid of tile levels, and says where its 3D object goes.
 * Words are drawn as text and each tile takes a shade from how much of it the letter covers, so curves and
 * diagonals are smooth instead of stair-stepped.
 */
function rasterise(m: Message, cols: number, rows: number, font: string, scratch: HTMLCanvasElement, wide: boolean, reserve: number): Layout {
  scratch.width = cols; scratch.height = rows;
  const g = scratch.getContext("2d", { willReadFrequently: true })!;
  const mask = new Uint8Array(cols * rows);
  const blank = () => { g.fillStyle = "#000"; g.fillRect(0, 0, cols, rows); g.fillStyle = "#fff"; g.letterSpacing = "0px"; };
  blank();
  g.textBaseline = "alphabetic"; g.textAlign = "left";

  /** Whatever is drawn on the scratch canvas lights the tiles it covers, shaded by how much of each tile it covers. Big words are bright. */
  const liftBig = () => {
    const px = g.getImageData(0, 0, cols, rows).data;
    for (let i = 0; i < mask.length; i++) {
      const t = px[i * 4] / 255;
      if (t >= 0.2) mask[i] = Math.max(1, Math.min(BRIGHT, Math.round(t * BRIGHT))); // fainter than this is only the overshoot of a round letter
    }
    blank();
  };
  /** Small words use the muted tile colour. They do not overwrite a tile a big word already lit. */
  const liftSmall = () => {
    const px = g.getImageData(0, 0, cols, rows).data;
    for (let i = 0; i < mask.length; i++) {
      const cover = px[i * 4] / 255;
      if (cover < 0.24 || mask[i]) continue; // below this it is only the overshoot of a round letter, which shows as a stray dot
      const t = Math.pow(cover, 0.7); // thin strokes only cover part of a tile, so lift them a little to stay readable
      mask[i] = t < 0.35 ? SMALL + 1 : t < 0.6 ? SMALL + 2 : t < 0.85 ? SMALL + 3 : SMALL;
    }
    blank();
  };

  const usable = rows - reserve;
  const pad = Math.round(usable * 0.05);
  const margin = Math.max(3, Math.round(cols * 0.04));

  // The object stands on the left at full height, and the words fill the column to its right.
  const side = wide ? Math.min(usable - 2 * pad, Math.round(cols * 0.37)) : 0;
  const gap = side ? Math.round(cols * 0.04) : 0;
  const colLeft = margin + (side ? side + gap : 0);
  const room = cols - margin - colLeft;

  // The one short line first, because the big words take whatever height is left.
  const subSize = Math.max(8, Math.min(13, Math.round(Math.min(rows * 0.052, room * 0.085))));
  const subFont = `500 ${subSize}px ${font}`;
  g.font = subFont;
  const track = Math.max(1, Math.round(subSize * 0.12));
  g.letterSpacing = `${track}px`;
  let subLines = wide ? wrapText(g, m.sub.toUpperCase(), room) : []; // on a phone the letters would be too small to read
  const subPitch = Math.round(subSize * 1.55);
  if (subLines.length * subPitch > usable * 0.5) subLines = [];
  const subH = subLines.length ? (subLines.length - 1) * subPitch + subSize : 0;
  const gapY = subLines.length ? Math.round(usable * 0.06) : 0;
  const mainRows = Math.max(14, usable - 2 * pad - subH - gapY);

  const lines = side ? m.column : m.narrow;
  g.letterSpacing = "0px";
  let size = Math.round(lines.length > 1 ? mainRows / (lines.length * 1.12) : Math.min(mainRows * 0.7, rows * 0.3));
  const widest = () => Math.max(...lines.map((l) => g.measureText(l).width));
  for (; size > 8; size--) {
    g.font = `700 ${size}px ${font}`;
    if (widest() <= room) break;
  }
  g.font = `700 ${size}px ${font}`;
  const textW = Math.ceil(widest());
  const left = side ? colLeft : Math.round(colLeft + (room - textW) / 2);
  const cap = size * 0.71; // height of a capital letter
  const pitch = Math.min(mainRows / lines.length, size * 1.12);
  const total = pitch * (lines.length - 1) + cap + (subLines.length ? gapY + subH : 0);
  const top = pad + (usable - 2 * pad - total) / 2;
  lines.forEach((l, i) => g.fillText(l, left, top + cap + pitch * i));
  liftBig();

  if (subLines.length) {
    g.font = subFont; g.letterSpacing = `${track}px`;
    const subTop = top + cap + pitch * (lines.length - 1) + gapY;
    subLines.forEach((l, i) => g.fillText(l, left, subTop + subSize * 0.8 + subPitch * i));
    liftSmall();
  }

  return { mask, object: side ? { shape: m.object, x: margin, y: Math.round(pad + (usable - 2 * pad - side) / 2), side } : null };
}

/**
 * A full-window wall of tens of thousands of split-flap tiles. The words flip over to change, and beside them a 3D
 * object turns slowly, shaded in tiles. One canvas, and only tiles that changed are repainted, so it stays fast.
 * `children` sit on the board's cleared bottom strip (the buttons), above the dots.
 */
export function FlipBoard({ children }: { children?: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [index, setIndex] = useState(0);
  const reduced = useSyncExternalStore(watchReducedMotion, () => window.matchMedia(REDUCED).matches, () => false);
  const cur = useRef(0);
  const goRef = useRef<(n: number) => void>(() => {});
  const lastSwitch = useRef(0);

  const goTo = useCallback((n: number) => {
    const next = (n + MESSAGES.length) % MESSAGES.length;
    if (next === cur.current) return;
    cur.current = next;
    lastSwitch.current = performance.now();
    setIndex(next);
    goRef.current(next);
  }, []);

  useEffect(() => {
    const el = canvas.current, box = wrap.current;
    if (!el || !box) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const scratch = document.createElement("canvas");
    let cols = 0, rows = 0, cell = 6, gap = 1, offX = 0, offY = 0, dpr = 1, wide = true, reserve = 0, font = "sans-serif";
    let colors = palette("#121216", "#e8eaf0", "#8f96a8");
    let from = new Uint8Array(0), to = new Uint8Array(0), drawn = new Int8Array(0), start = new Float32Array(0);
    let object: Placed | null = null;
    let animating = false;
    const angleAt = (t: number) => (reduced ? 0.5 : SWAY * Math.sin(t * SPEED));

    const readTheme = () => {
      const cs = getComputedStyle(document.documentElement);
      colors = palette(cs.getPropertyValue("--surface-2").trim() || "#121216", cs.getPropertyValue("--text").trim() || "#fff", cs.getPropertyValue("--muted").trim() || "#888");
      font = cs.getPropertyValue("--font-sans-stack").trim() || "system-ui, sans-serif";
    };

    /** Points every tile at message n. Tiles that already match stay put. */
    const aim = (n: number, instant: boolean) => {
      const layout = rasterise(MESSAGES[n], cols, rows, font, scratch, wide, reserve);
      object = layout.object;
      const mask = layout.mask;
      const now = performance.now();
      if (object) {
        const lv = objectLevels(object, angleAt(now));
        for (let y = 0; y < object.side; y++) for (let x = 0; x < object.side; x++) mask[(object.y + y) * cols + object.x + x] = lv[y * object.side + x];
      }
      for (let c = 0; c < cols; c++) {
        for (let r = 0; r < rows; r++) {
          const i = r * cols + c;
          // Whatever a tile is showing right now becomes the side it flips from.
          if (start[i] >= 0) {
            const p = (now - start[i]) / FLIP_MS;
            if (p >= 0.5 || instant) from[i] = to[i];
          }
          to[i] = mask[i];
          start[i] = from[i] === to[i] || instant ? -1 : now + (c / cols) * SWEEP_MS + Math.random() * JITTER_MS;
          if (instant) from[i] = to[i];
        }
      }
      animating = !instant;
      if (instant) draw(now);
    };

    /** Redraws the 3D object at the angle for this moment. Only tiles that are not mid-flip take the new shade. */
    const rotate = (now: number) => {
      if (!object) return;
      const lv = objectLevels(object, angleAt(now));
      for (let y = 0; y < object.side; y++) for (let x = 0; x < object.side; x++) {
        const i = (object.y + y) * cols + object.x + x;
        if (start[i] < 0) from[i] = to[i] = lv[y * object.side + x];
      }
      draw(now);
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = box.clientWidth, h = box.clientHeight;
      el.width = Math.round(w * dpr); el.height = Math.round(h * dpr);
      wide = w >= WIDE_PX;
      // Whole-pixel tiles, so every edge is sharp and a repainted tile leaves nothing behind. Small, so the board is dense: about 360 across.
      cell = wide ? Math.max(4, Math.round(w / 360)) : 4;
      gap = Math.max(1, Math.round(cell * 0.15));
      cols = Math.max(24, Math.floor(w / cell)); rows = Math.max(10, Math.floor(h / cell));
      offX = Math.floor((w - cols * cell) / 2); offY = Math.floor((h - rows * cell) / 2);
      reserve = Math.round((wide ? OVERLAY_PX : OVERLAY_PX_NARROW) / cell);
      from = new Uint8Array(cols * rows); to = new Uint8Array(cols * rows);
      start = new Float32Array(cols * rows).fill(-1); drawn = new Int8Array(cols * rows).fill(-1);
      aim(cur.current, true);
    };

    const draw = (now: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, offX * dpr, offY * dpr);
      const tw = cell - gap, half = Math.floor(tw / 2), seam = tw >= 7; // on small tiles the line would only make the letters look striped
      let active = false;
      for (let i = 0; i < from.length; i++) {
        const s = start[i];
        if (s >= 0) {
          active = true;
          const p = (now - s) / FLIP_MS;
          if (p >= 1) { from[i] = to[i]; start[i] = -1; }
          else if (p > 0) {
            // A turning tile is two halves. The top flap swings down to the middle and shows the new top; then the new bottom flap drops over the old one.
            const x = (i % cols) * cell, y = Math.floor(i / cols) * cell;
            const oldC = colors[from[i]], newC = colors[to[i]];
            ctx.fillStyle = newC; ctx.fillRect(x, y, tw, half);
            ctx.fillStyle = oldC; ctx.fillRect(x, y + half, tw, tw - half);
            const first = p < 0.5;
            const flap = first ? Math.cos(p * Math.PI) : Math.sin((p - 0.5) * Math.PI);
            const fh = Math.round((first ? half : tw - half) * flap);
            const fy = first ? y + half - fh : y + half;
            ctx.fillStyle = first ? oldC : newC; ctx.fillRect(x, fy, tw, fh);
            ctx.fillStyle = `rgba(0,0,0,${0.5 * (1 - flap)})`; ctx.fillRect(x, fy, tw, fh);
            drawn[i] = -1;
            continue;
          }
        }
        // Everything else is only repainted if it changed since it was last painted.
        const level = from[i];
        if (drawn[i] === level) continue;
        const x = (i % cols) * cell, y = Math.floor(i / cols) * cell;
        ctx.fillStyle = colors[level]; ctx.fillRect(x, y, tw, tw);
        if (seam && level > 0) { ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(x, y + half, tw, 1); } // the split across the middle of a split-flap tile
        drawn[i] = level;
      }
      animating = active;
    };

    goRef.current = (n) => aim(n, reduced);

    readTheme(); resize();
    // The first frame may be drawn before the web font is ready, so draw it again once it is.
    let gone = false;
    Promise.all([document.fonts.load(`700 16px ${font}`), document.fonts.load(`500 16px ${font}`)]).then(() => { if (!gone && !animating) aim(cur.current, true); });
    const ro = new ResizeObserver(resize); ro.observe(box);
    const mo = new MutationObserver(() => { readTheme(); ctx.clearRect(0, 0, el.width, el.height); drawn.fill(-1); draw(performance.now()); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    let raf = 0, running = !document.hidden, lastRotate = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (!running) return;
      if (animating) { draw(t); return; }
      if (!reduced && t - lastSwitch.current > INTERVAL) goTo(cur.current + 1);
      else if (!reduced && object && t - lastRotate > ROTATE_MS) { lastRotate = t; rotate(t); }
    };
    lastSwitch.current = performance.now();
    raf = requestAnimationFrame(tick);
    const onVis = () => { running = !document.hidden; lastSwitch.current = performance.now(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { gone = true; cancelAnimationFrame(raf); ro.disconnect(); mo.disconnect(); document.removeEventListener("visibilitychange", onVis); };
  }, [reduced, goTo]);

  const message = MESSAGES[index];
  return (
    <div className="relative h-[calc(100svh-4.1rem)] min-h-[520px] w-full overflow-hidden bg-background">
      <div ref={wrap} className="absolute inset-0">
        <canvas ref={canvas} aria-hidden="true" className="h-full w-full" />
      </div>
      <p className="sr-only" aria-live="polite">{message.caption}</p>
      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 px-4 pb-4">
        {children}
        <div className="flex items-center gap-0.5">
          <button aria-label="Previous message" onClick={() => goTo(index - 1)} className="cursor-pointer p-1 text-muted hover:text-text"><ChevronLeft className="h-4 w-4" /></button>
          {MESSAGES.map((m, i) => (
            <button key={m.label} aria-label={`Show ${m.label}`} aria-current={i === index} onClick={() => goTo(i)} className="cursor-pointer p-1.5">
              <span className={`block h-1.5 w-1.5 rounded-full border border-text ${i === index ? "bg-text" : "bg-transparent"}`} />
            </button>
          ))}
          <button aria-label="Next message" onClick={() => goTo(index + 1)} className="cursor-pointer p-1 text-muted hover:text-text"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>
    </div>
  );
}
