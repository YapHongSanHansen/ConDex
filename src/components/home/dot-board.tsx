"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { FRAMES, renderLum } from "./shapes";

const INTERVAL = 5500;
const DURATION = 800;
const SWAY = 0.9;
const SPEED = 0.0007;
const CELL = 7; // css px per halftone cell
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const LEVELS = 6;

/** Large halftone/dither 3D board. Drawn on a canvas, no frame. */
export function DotBoard() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [index, setIndex] = useState(0);
  const [reduced, setReduced] = useState(false);
  const cur = useRef(0);
  const prev = useRef<{ index: number; start: number } | null>(null);
  const lastSwitch = useRef(0);
  const th = useRef<Float32Array>(new Float32Array(0));

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const goTo = useCallback((n: number) => {
    const next = (n + FRAMES.length) % FRAMES.length;
    if (next === cur.current) return;
    prev.current = { index: cur.current, start: performance.now() };
    th.current = new Float32Array(0);
    cur.current = next;
    lastSwitch.current = performance.now();
    setIndex(next);
  }, []);

  useEffect(() => {
    const el = canvas.current, box = wrap.current;
    if (!el || !box) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    let cols = 0, rows = 0, dpr = 1, color = "#fff";
    let a = new Float32Array(0), b = new Float32Array(0);
    const readColor = () => { color = getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#fff"; };
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = box.clientWidth, h = box.clientHeight;
      el.width = Math.round(w * dpr); el.height = Math.round(h * dpr);
      cols = Math.max(20, Math.floor(w / CELL)); rows = Math.max(20, Math.floor(h / CELL));
      a = new Float32Array(cols * rows); b = new Float32Array(cols * rows);
      th.current = new Float32Array(0);
    };
    readColor(); resize();
    const ro = new ResizeObserver(resize); ro.observe(box);
    const mo = new MutationObserver(readColor); mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    const draw = (t: number) => {
      const ang = reduced ? 0.5 : SWAY * Math.sin(t * SPEED);
      renderLum(cur.current, ang, cols, rows, a);
      let out = a;
      if (prev.current) {
        const p = (t - prev.current.start) / DURATION;
        if (p >= 1) prev.current = null;
        else {
          if (th.current.length !== cols * rows) th.current = Float32Array.from({ length: cols * rows }, Math.random);
          renderLum(prev.current.index, ang, cols, rows, b);
          out = new Float32Array(cols * rows);
          for (let i = 0; i < out.length; i++) {
            const r = th.current[i] * 0.6;
            out[i] = p < r ? b[i] : p < r + 0.4 ? Math.max(a[i], b[i]) * (0.4 + Math.random() * 0.6) : a[i];
          }
        }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, el.width, el.height);
      ctx.fillStyle = color;
      const cw = box.clientWidth / cols, ch = box.clientHeight / rows;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const v = out[r * cols + c];
          const x = (c + 0.5) * cw, y = (r + 0.5) * ch;
          ctx.globalAlpha = v < 0 ? 0.16 : 1;
          let rad = 0.7;
          if (v >= 0) {
            // ordered dither into a few dot sizes
            const q = Math.min(LEVELS - 1, Math.floor(v * (LEVELS - 1) + BAYER[(r & 3) * 4 + (c & 3)] / 16 - 0.2 + 0.5));
            rad = 0.6 + (Math.max(0, q) / (LEVELS - 1)) * (Math.min(cw, ch) * 0.5);
          }
          ctx.beginPath();
          ctx.arc(x, y, rad, 0, 6.2832);
          ctx.fill();
        }
      }
    };

    let raf = 0, running = !document.hidden, last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (!running || t - last < 40) return; // ~25fps
      last = t;
      if (!reduced && t - lastSwitch.current > INTERVAL && !prev.current) goTo(cur.current + 1);
      draw(t);
    };
    lastSwitch.current = performance.now();
    if (reduced) draw(0); else raf = requestAnimationFrame(tick);
    const onVis = () => { running = !document.hidden; };
    document.addEventListener("visibilitychange", onVis);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); mo.disconnect(); document.removeEventListener("visibilitychange", onVis); };
  }, [reduced, goTo, index]);

  const frame = FRAMES[index];
  return (
    <div className="relative h-full w-full">
      <div ref={wrap} className="absolute inset-x-0 bottom-12 top-0" style={{ maskImage: "radial-gradient(ellipse 72% 72% at 50% 50%, #000 55%, transparent 100%)" }}>
        <canvas ref={canvas} aria-hidden="true" className="h-full w-full" />
      </div>
      <p className="sr-only">{frame.caption}. {frame.description}</p>
      <div className="absolute bottom-4 left-4 right-4 flex items-center justify-center gap-3">
        <div className="flex items-center gap-0.5">
          <button aria-label="Previous illustration" onClick={() => goTo(index - 1)} className="cursor-pointer p-1 text-muted hover:text-text"><ChevronLeft className="h-4 w-4" /></button>
          {FRAMES.map((f, i) => (
            <button key={f.name} aria-label={`Show ${f.name.toLowerCase()} illustration`} aria-current={i === index} onClick={() => goTo(i)} className="cursor-pointer p-1.5">
              <span className={`block h-1.5 w-1.5 rounded-full border border-text ${i === index ? "bg-text" : "bg-transparent"}`} />
            </button>
          ))}
          <button aria-label="Next illustration" onClick={() => goTo(index + 1)} className="cursor-pointer p-1 text-muted hover:text-text"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>
    </div>
  );
}
