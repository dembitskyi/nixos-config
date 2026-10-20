// SVG charts: time series with crosshair tooltip, sparkline, meters.
import { h } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

export function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function niceMax(max, ticks) {
  if (!(max > 0)) return [1, 1];
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) * mag;
  return [step * Math.ceil(max / step), step];
}

// Byte axes step in powers of two of the unit that fits the maximum.
function byteMax(max, ticks) {
  const unit = 1024 ** Math.max(0, Math.floor(Math.log(Math.max(max, 1)) / Math.log(1024)));
  const [top, step] = niceMax(max / unit, ticks);
  return [top * unit, step * unit];
}

const STEPS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
function timeTicks(start, end, width) {
  const step = STEPS.find((s) => (end - start) / s <= width / 90) || 86400;
  const offset = new Date().getTimezoneOffset() * 60;
  const ticks = [];
  for (let t = Math.ceil((start - offset) / step) * step + offset; t <= end; t += step) ticks.push(t);
  return { ticks, day: step >= 86400 };
}
const clock = (t, day) =>
  new Date(t * 1000).toLocaleString([], day ? { weekday: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit" });

function path(points) {
  let d = "";
  let pen = false;
  for (const p of points) {
    if (p == null) pen = false;
    else {
      d += `${pen ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
      pen = true;
    }
  }
  return d;
}

// Closed area between an upper and a lower edge; gaps split it.
function band(upper, lower) {
  let d = "";
  let run = [];
  const flush = () => {
    if (run.length > 1)
      d += `M${run.map((i) => `${upper[i][0].toFixed(1)},${upper[i][1].toFixed(1)}`).join("L")}L${run
        .reverse()
        .map((i) => `${lower[i][0].toFixed(1)},${lower[i][1].toFixed(1)}`)
        .join("L")}Z`;
    run = [];
  };
  upper.forEach((p, i) => (p == null ? flush() : run.push(i)));
  flush();
  return d;
}

const PAD = { left: 56, right: 12, top: 10, bottom: 24 };

// series: [{ key, label, color, values }]; times: unix seconds aligned with values.
export function TimeChart({ times, series, format, axisFormat = format, bytesAxis = false, stacked = false, height = 170, empty }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const [hidden, setHidden] = useState(() => new Set());
  const shown = series.filter((s) => !hidden.has(s.key));
  const n = times.length;
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;

  const stacks = [];
  const base = new Array(n).fill(0);
  for (const s of shown) {
    const lower = base.slice();
    const upper = s.values.map((v, i) => (stacked ? (base[i] += v || 0) : v));
    stacks.push({ ...s, upper, lower });
  }
  let max = 0;
  for (const s of stacks) for (const v of s.upper) if (v != null && v > max) max = v;
  const [top, step] = bytesAxis ? byteMax(max, 4) : niceMax(max, 4);
  const x = (i) => PAD.left + (n > 1 ? (i / (n - 1)) * plotW : 0);
  const y = (v) => PAD.top + plotH - (v / top) * plotH;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  const tt = width ? timeTicks(times[0], times[n - 1], plotW) : { ticks: [] };
  const tx = (t) => PAD.left + ((t - times[0]) / (times[n - 1] - times[0] || 1)) * plotW;
  const hasData = series.some((s) => s.values.some((v) => v != null));

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - PAD.left) / plotW) * (n - 1));
    setHover(i >= 0 && i < n ? i : null);
  };
  const toggle = (key) =>
    setHidden((h) => {
      const next = new Set(h);
      next.has(key) ? next.delete(key) : next.add(key);
      return next.size === series.length ? new Set() : next;
    });
  const last = (vals) => {
    for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) return vals[i];
    return null;
  };

  return html`
    <div class="chart">
      <div class="plot" ref=${ref} style=${{ height: `${height}px` }}>
        ${width > 0 &&
        html`<svg class=${stacked ? "stacked" : ""} width=${width} height=${height} onPointerMove=${onMove} onPointerLeave=${() => setHover(null)}>
          ${ticks.map(
            (v) => html`<line class=${v === 0 ? "axis" : "grid"} x1=${PAD.left} x2=${width - PAD.right} y1=${y(v)} y2=${y(v)} />
              <text class="tick" x=${PAD.left - 8} y=${y(v) + 4} text-anchor="end">${axisFormat(v)}</text>`,
          )}
          ${tt.ticks.map((t) => html`<text class="tick" x=${tx(t)} y=${height - 6} text-anchor="middle">${clock(t, tt.day)}</text>`)}
          ${stacks.map((s) => {
            const up = s.upper.map((v, i) => (v == null ? null : [x(i), y(v)]));
            const low = s.lower.map((v, i) => [x(i), y(stacked ? v : 0)]);
            return html`<g style=${{ "--c": s.color }}>
              <path class="area" d=${band(up, low)} />
              <path class="line" d=${path(up)} />
            </g>`;
          })}
          ${hover != null &&
          html`<line class="cross" x1=${x(hover)} x2=${x(hover)} y1=${PAD.top} y2=${PAD.top + plotH} />
            ${stacks.map((s) => s.upper[hover] != null && html`<circle class="dot" style=${{ "--c": s.color }} cx=${x(hover)} cy=${y(s.upper[hover])} r="4" />`)}`}
        </svg>`}
        ${!hasData && html`<div class="empty">${empty || "No data in this range"}</div>`}
        ${hover != null &&
        html`<div class=${`tip ${x(hover) > width - 220 ? "left" : ""}`} style=${{ left: `${x(hover)}px` }}>
          <div class="tip-time">${new Date(times[hover] * 1000).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
          ${[...shown]
            .reverse()
            .map(
              (s) =>
                html`<div class="tip-row"><i class="key" style=${{ background: s.color }}></i><b>${format(s.values[hover])}</b><span>${s.label}</span></div>`,
            )}
        </div>`}
      </div>
      ${series.length > 1 &&
      html`<div class="legend">
        ${series.map(
          (s) => html`<button class=${`leg ${hidden.has(s.key) ? "off" : ""}`} onClick=${() => toggle(s.key)} title="Show or hide">
            <i class="key" style=${{ background: s.color }}></i>${s.label}<span class="leg-val">${format(last(s.values))}</span>
          </button>`,
        )}
        ${hidden.size > 0 && html`<button class="leg reset" onClick=${() => setHidden(new Set())}>Show all</button>`}
      </div>`}
    </div>
  `;
}

export function Sparkline({ values, max, color = "var(--s1)", height = 28 }) {
  const n = values?.length || 0;
  if (n < 2) return html`<svg class="spark" height=${height}></svg>`;
  let top = max;
  if (!(top > 0)) top = Math.max(...values.map((v) => v || 0)) || 1;
  const pts = values.map((v, i) => (v == null ? null : [(i / (n - 1)) * 100, height - 2 - (Math.min(v, top) / top) * (height - 4)]));
  const low = pts.map((p) => (p ? [p[0], height] : null));
  return html`<svg class="spark" viewBox=${`0 0 100 ${height}`} preserveAspectRatio="none" height=${height} style=${{ "--c": color }}>
    <path class="area" d=${band(pts, low)} />
    <path class="line" d=${path(pts)} vector-effect="non-scaling-stroke" />
  </svg>`;
}

// parts: [{ value, color, label }]; the rest of total is the track.
export function Meter({ parts, total }) {
  return html`<div class="meter" role="img" aria-label=${parts.map((p) => p.label).join(", ")}>
    ${parts.map(
      (p) => p.value > 0 && html`<span style=${{ width: `${Math.min(100, (p.value / total) * 100)}%`, background: p.color }} title=${p.label}></span>`,
    )}
  </div>`;
}
