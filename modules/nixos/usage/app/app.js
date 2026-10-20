import { h, render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import htm from "htm";
import * as D from "./data.js";
import { Meter, Sparkline, TimeChart } from "./chart.js";

const html = htm.bind(h);

const RANGES = [
  ["15m", 900],
  ["1h", 3600],
  ["6h", 21600],
  ["24h", 86400],
  ["7d", 604800],
];
const COLOR = { ram: "var(--s1)", swap: "var(--s2)", cache: "var(--s3)", kernel: "var(--s4)" };
const SLOTS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)"];
const OTHER = "var(--other)";
const MiB = 1024 ** 2;

const ICONS = {
  cpu: "M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM9.5 9.5h5v5h-5z",
  memory: "M4 7h16a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1ZM7 16v3M11 16v3M15 16v3M7 10v3M11 10v3M15 10v3",
  swap: "M7 4 3 8l4 4M3 8h13M17 20l4-4-4-4M21 16H8",
  disk: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3ZM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  pulse: "M3 12h4l3-8 4 16 3-8h4",
  pause: "M8 5v14M16 5v14",
  play: "M7 4.5v15l12-7.5z",
  close: "M6 6l12 12M18 6 6 18",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM21 21l-4.5-4.5",
  warning: "M12 4 2.5 20h19L12 4ZM12 10v4M12 17v.5",
  critical: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 8v5M12 16v.5",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 11v5M12 8v.5",
  chevron: "M9 6l6 6-6 6",
};
const Icon = ({ name, size = 16 }) =>
  html`<svg class="icon" width=${size} height=${size} viewBox="0 0 24 24" aria-hidden="true"><path d=${ICONS[name]} /></svg>`;

// Runs fn now and every ms; keeps the last good data across refetches and errors.
function usePoll(fn, ms, deps, paused) {
  const [state, setState] = useState({ data: null, error: null, at: 0 });
  useEffect(() => {
    if (paused) return undefined;
    let alive = true;
    let timer;
    let ctrl;
    const tick = async () => {
      ctrl = new AbortController();
      try {
        const data = await fn(ctrl.signal);
        if (alive) setState({ data, error: null, at: Date.now() });
      } catch (e) {
        if (alive && e.name !== "AbortError") setState((s) => ({ ...s, error: e }));
      }
      if (alive) timer = setTimeout(tick, document.hidden ? ms * 6 : ms);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
      ctrl?.abort();
    };
  }, [...deps, paused]);
  return state;
}

const withSpan = (range, load) => async (signal) => {
  const w = D.span(range);
  return { w, times: D.times(w), data: await load(w, signal) };
};

function useStored(key, initial) {
  const [value, setValue] = useState(() => JSON.parse(localStorage.getItem(key) ?? "null") ?? initial);
  useEffect(() => localStorage.setItem(key, JSON.stringify(value)), [key, value]);
  return [value, setValue];
}

function useSelection() {
  const read = () => {
    const m = /^#\/s\/(.+)$/.exec(location.hash);
    return m ? decodeURIComponent(m[1]) : null;
  };
  const [id, setId] = useState(read);
  const pushed = useRef(false);
  useEffect(() => {
    const on = () => setId(read());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const open = (next) => {
    pushed.current = true;
    location.hash = `#/s/${encodeURIComponent(next)}`;
  };
  const close = () => {
    if (pushed.current) {
      pushed.current = false;
      history.back();
    } else history.replaceState(null, "", location.pathname), setId(null);
  };
  return [id, open, close];
}

function useNow(ms) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const cpuPct = (x) => D.pct(x);
const byDesc = (key) => (a, b) => (b[key] || 0) - (a[key] || 0);

function insights(host, services) {
  const out = [];
  if (!host || !services) return out;
  const swapUsed = host.swapTotal - host.swapFree;
  if (host.swapTotal > 0 && swapUsed / host.swapTotal > 0.8) {
    const top = services.filter((s) => s.swap > 64 * MiB).sort(byDesc("swap")).slice(0, 3);
    out.push({
      level: "warning",
      title: `Swap is ${D.pct(swapUsed / host.swapTotal)} full`,
      text: `${D.bytes(swapUsed)} of ${D.bytes(host.swapTotal)} swapped out`,
      services: top.map((s) => [s, D.bytes(s.swap)]),
    });
  }
  if (host.memAvail / host.memTotal < 0.1)
    out.push({ level: "critical", title: "Memory is almost exhausted", text: `${D.bytes(host.memAvail)} available` });
  if (host.stallMem > 0.05)
    out.push({ level: "warning", title: "Programs are waiting for memory", text: `${D.pct(host.stallMem)} of the time` });
  if (host.stallIo > 0.2) out.push({ level: "warning", title: "Programs are waiting for the disk", text: `${D.pct(host.stallIo)} of the time` });
  for (const s of services.filter((s) => s.ooms >= 1))
    out.push({ level: "critical", title: `${s.name} hit the out-of-memory killer`, text: "in the last hour", services: [[s, ""]] });
  const hot = services.filter((s) => s.cpu > 2).sort(byDesc("cpu"))[0];
  if (hot) out.push({ level: "info", title: `${hot.name} is busy`, text: `using ${hot.cpu.toFixed(1)} cores`, services: [[hot, ""]] });
  return out;
}

function Insights({ items, open }) {
  if (!items.length) return null;
  return html`<div class="insights">
    ${items.map(
      (it) => html`<div class=${`insight ${it.level}`}>
        <${Icon} name=${it.level} size=${18} />
        <div>
          <div class="insight-title">${it.title}</div>
          <div class="insight-text">
            ${it.text}
            ${it.services?.map(
              ([s, v]) => html` <button class="link" onClick=${() => open(s.id)}>${s.name}${v && html` <span class="muted">${v}</span>`}</button>`,
            )}
          </div>
        </div>
      </div>`,
    )}
  </div>`;
}

function TopList({ title, items, value, open }) {
  const max = Math.max(...items.map((s) => s[value[0]] || 0), 1e-9);
  return html`<div class="toplist">
    <div class="toplist-title">${title}</div>
    ${items.map(
      (s) => html`<button class="toprow" onClick=${() => open(s.id)}>
        <span class="toprow-name">${s.name}</span>
        <span class="toprow-bar"><span style=${{ width: `${((s[value[0]] || 0) / max) * 100}%` }}></span></span>
        <span class="toprow-val">${value[1](s[value[0]])}</span>
      </button>`,
    )}
  </div>`;
}

// One column per CPU thread, height = busy share.
function Threads({ values }) {
  if (!values?.length) return html`<div class="threads"></div>`;
  return html`<div class="threads" role="img" aria-label=${`${values.length} CPU threads`}>
    ${values.map((v, i) => html`<span title=${`CPU ${i}: ${D.pct(v)}`}><i style=${{ height: `${Math.max(4, Math.min(1, v) * 100)}%` }}></i></span>`)}
  </div>`;
}

function Stall({ value }) {
  const level = value > 0.2 ? "critical" : value > 0.05 ? "warning" : null;
  return html`<span class=${`stall ${level || ""}`} title="Share of time tasks waited for this resource (PSI)">
    ${level && html`<${Icon} name=${level} size=${13} />`}waiting ${D.pct(value)}
  </span>`;
}

function ResourceCard({ icon, label, value, detail, meter, legend, spark, sparkMax, sparkColor, stall, top }) {
  return html`<div class="card res">
    <div class="res-head"><${Icon} name=${icon} /><span>${label}</span>${stall != null && html`<${Stall} value=${stall} />`}</div>
    <div class="res-value">${value}</div>
    <div class="res-detail">${detail}</div>
    ${meter}
    ${legend && html`<div class="mini-legend">${legend.map(([c, l]) => html`<span><i class="key" style=${{ background: c }}></i>${l}</span>`)}</div>`}
    <${Sparkline} values=${spark} max=${sparkMax} color=${sparkColor} height=${36} />
    ${top}
  </div>`;
}

function Now({ host, hist, services, rangeLabel, open }) {
  const h = host || {};
  const hv = hist?.data || {};
  const svc = services || [];
  const memUsed = h.memTotal - h.memAvail;
  const swapUsed = h.swapTotal - h.swapFree;
  const top = (key, fmt, title, filter = () => true) =>
    html`<${TopList} title=${title} items=${svc.filter(filter).sort(byDesc(key)).slice(0, 3)} value=${[key, fmt]} open=${open} />`;
  return html`<div class="grid-4">
    <${ResourceCard}
      icon="cpu"
      label="CPU"
      value=${D.pct(h.cpu)}
      detail=${`${((h.cpu || 0) * (h.cores || 0)).toFixed(1)} of ${h.cores ?? "–"} threads busy`}
      meter=${html`<${Threads} values=${h.threads} />`}
      spark=${hv.cpu}
      stall=${h.stallCpu}
      top=${top("cpu", cpuPct, "Top now · % of one core")}
    />
    <${ResourceCard}
      icon="memory"
      label="Memory"
      value=${D.bytes(memUsed)}
      detail=${`of ${D.bytes(h.memTotal)} · ${D.bytes(h.memAvail)} available`}
      meter=${html`<${Meter}
        total=${h.memTotal}
        parts=${[
          { value: memUsed, color: COLOR.ram, label: `in use ${D.bytes(memUsed)}` },
          { value: h.memAvail - h.memFree, color: COLOR.cache, label: `reclaimable cache ${D.bytes(h.memAvail - h.memFree)}` },
        ]}
      />`}
      legend=${[
        [COLOR.ram, "In use"],
        [COLOR.cache, "Cache"],
        ["var(--track)", "Free"],
      ]}
      spark=${hv.memUsed}
      sparkMax=${h.memTotal}
      stall=${h.stallMem}
      top=${top("rss", D.bytes, "Top now · RAM")}
    />
    <${ResourceCard}
      icon="swap"
      label="Swap"
      value=${D.bytes(swapUsed)}
      detail=${`of ${D.bytes(h.swapTotal)} · ${D.pct(swapUsed / h.swapTotal)} used`}
      meter=${html`<${Meter} total=${h.swapTotal} parts=${[{ value: swapUsed, color: COLOR.swap, label: "swapped out" }]} />`}
      spark=${hv.swapUsed}
      sparkMax=${h.swapTotal}
      sparkColor=${COLOR.swap}
      top=${top("swap", D.bytes, "Top now · swapped out")}
    />
    <${ResourceCard}
      icon="disk"
      label="Disk"
      value=${D.perSec((h.read || 0) + (h.write || 0))}
      detail=${`read ${D.perSec(h.read)} · write ${D.perSec(h.write)}`}
      spark=${hv.io}
      sparkColor="var(--s3)"
      stall=${h.stallIo}
      top=${top("io", D.perSec, "Top now · read + write", (s) => s.io != null)}
    />
  </div>
  <div class="range-note">Sparklines: last ${rangeLabel}</div>`;
}

function ProcessList({ title, items, value, fmt, services, open }) {
  const max = Math.max(...items.map((p) => p.value), 1e-9);
  return html`<div class="card plist">
    <div class="card-title">${title}</div>
    ${items.length === 0 && html`<div class="empty-row">No process data yet</div>`}
    ${items.map((p) => {
      const svc = services.get(p.cgroup);
      return html`<button class="prow" onClick=${() => open(p.cgroup)} title=${`PID ${p.pid} · ${p.user}`}>
        <span class="prow-name">
          <span class="prow-main">${p.program}${p.comm && p.comm !== p.program && html`<span class="muted"> ${p.comm}</span>`}</span>
          <span class="prow-sub">${svc?.name || p.service.name} · PID ${p.pid}</span>
        </span>
        <span class="toprow-bar"><span style=${{ width: `${(p.value / max) * 100}%`, background: value }}></span></span>
        <span class="prow-val">${fmt(p.value)}</span>
      </button>`;
    })}
  </div>`;
}

const COLUMNS = [
  ["name", "Service"],
  ["mem", "Memory"],
  ["cpu", "CPU"],
  ["swap", "Swap"],
  ["io", "Disk"],
  ["procs", "Procs"],
];

function Services({ services, sparks, open, selected }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("All");
  const [sort, setSort] = useState(["mem", -1]);
  const [all, setAll] = useState(false);
  const search = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "/" && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        search.current?.focus();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  const list = services || [];
  const counts = Object.fromEntries(D.KINDS.map((k) => [k, list.filter((s) => s.kind === k).length]));
  const q = query.trim().toLowerCase();
  const rows = list
    .filter((s) => (kind === "All" || s.kind === kind) && (!q || `${s.name} ${s.unit}`.toLowerCase().includes(q)))
    .sort((a, b) => {
      const [key, dir] = sort;
      if (key === "name") return dir * a.name.localeCompare(b.name);
      return dir * ((a[key] ?? -1) - (b[key] ?? -1));
    });
  const limit = all || q || kind !== "All" ? rows.length : 20;
  const maxMem = Math.max(...list.map((s) => s.mem), 1);
  const sortBy = (key) => setSort(([k, d]) => (k === key ? [key, -d] : [key, key === "name" ? 1 : -1]));
  return html`<div class="card services">
    <div class="toolbar">
      <div class="search"><${Icon} name="search" /><input ref=${search} placeholder="Search services  ( / )" value=${query} onInput=${(e) => setQuery(e.target.value)} /></div>
      <div class="chips">
        ${["All", ...D.KINDS].map(
          (k) =>
            (k === "All" || counts[k] > 0) &&
            html`<button class="chip-btn" aria-pressed=${kind === k} onClick=${() => setKind(k)}>
              ${k}<span class="count">${k === "All" ? list.length : counts[k]}</span>
            </button>`,
        )}
      </div>
    </div>
    <div class="srow shead" role="row">
      ${COLUMNS.map(
        ([key, label]) => html`<button class=${`th ${key === "name" ? "" : "num"}`} onClick=${() => sortBy(key)} aria-sort=${sort[0] === key ? (sort[1] < 0 ? "descending" : "ascending") : "none"}>
          ${label}${sort[0] === key && html`<span class="arrow">${sort[1] < 0 ? "↓" : "↑"}</span>`}
        </button>`,
      )}
    </div>
    ${rows.slice(0, limit).map(
      (s) => html`<button class=${`srow ${selected === s.id ? "selected" : ""}`} key=${s.id} onClick=${() => open(s.id)}>
        <span class="sname">
          <span class="sname-main">${s.name}</span>
          <span class="sname-sub">${s.kind}${s.kind !== "Docker" && s.unit !== `${s.name}.service` ? ` · ${s.unit}` : ""}</span>
        </span>
        <span class="num memcell">
          <span class="memval">${D.bytes(s.mem)}</span>
          <span class="stackbar" title=${`RAM ${D.bytes(s.rss)} · swap ${D.bytes(s.swap)} · cache ${D.bytes(s.cache)}`}>
            <span style=${{ width: `${((s.rss || 0) / maxMem) * 100}%`, background: COLOR.ram }}></span>
            <span style=${{ width: `${((s.swap || 0) / maxMem) * 100}%`, background: COLOR.swap }}></span>
          </span>
        </span>
        <span class="num cpucell"><span>${cpuPct(s.cpu)}</span><${Sparkline} values=${sparks?.get(s.id)} height=${22} /></span>
        <span class="num">${s.swap > 0 ? D.bytes(s.swap) : html`<span class="muted">–</span>`}</span>
        <span class="num">${s.io == null ? html`<span class="muted" title="User units have no I/O controller">–</span>` : D.perSec(s.io)}</span>
        <span class="num">${D.num(s.procs)}</span>
      </button>`,
    )}
    ${rows.length > limit && html`<button class="more" onClick=${() => setAll(true)}>Show all ${rows.length} services</button>`}
    ${rows.length === 0 && html`<div class="empty-row">No services match</div>`}
  </div>`;
}

// Top n series by average plus an "Other" series; colors stay with their service.
function useTopSeries(list, n, fmtKey) {
  const slots = useRef(new Map());
  return useMemo(() => {
    if (!list) return [];
    const avg = (v) => v.reduce((a, b) => a + (b || 0), 0) / (v.length || 1);
    const ranked = [...list].sort((a, b) => avg(b.values) - avg(a.values));
    const head = ranked.slice(0, n);
    const keep = new Set(head.map((s) => s.id));
    for (const id of slots.current.keys()) if (!keep.has(id)) slots.current.delete(id);
    for (const s of head)
      if (!slots.current.has(s.id)) {
        const used = new Set(slots.current.values());
        slots.current.set(s.id, SLOTS.find((c) => !used.has(c)));
      }
    const rest = ranked.slice(n);
    const series = head.map((s) => ({ key: s.id, label: s.name, color: slots.current.get(s.id), values: s.values }));
    if (rest.length) {
      const len = rest[0].values.length;
      const values = Array.from({ length: len }, (_, i) => rest.reduce((a, s) => a + (s.values[i] || 0), 0));
      series.push({ key: "other", label: `Other (${rest.length})`, color: OTHER, values });
    }
    return series;
  }, [list, fmtKey]);
}

function Trends({ trend }) {
  const t = trend?.data;
  const mem = useTopSeries(t?.mem, 6, "mem");
  const cpu = useTopSeries(t?.cpu, 6, "cpu");
  if (!trend) return null;
  return html`<div class="grid-2">
    <div class="card pad">
      <div class="card-title">Memory by service <span class="muted">RAM + swap</span></div>
      <${TimeChart} times=${trend.times} series=${mem} format=${D.bytes} bytesAxis stacked />
    </div>
    <div class="card pad">
      <div class="card-title">CPU by service <span class="muted">% of one core</span></div>
      <${TimeChart} times=${trend.times} series=${cpu} format=${cpuPct} stacked />
    </div>
  </div>`;
}

const PROC_COLUMNS = [
  ["pid", "PID", (p) => p.pid],
  ["program", "Program", (p) => p.program],
  ["comm", "Name", (p) => p.comm],
  ["user", "User", (p) => p.user],
  ["rss", "Memory", (p) => D.bytes(p.rss), "Resident memory (RSS); shared pages count in every process that maps them"],
  ["swap", "Swap", (p) => D.bytes(p.swap)],
  ["cpu", "CPU", (p) => cpuPct(p.cpu)],
  ["threads", "Threads", (p) => D.num(p.threads)],
  ["start", "Started", (p) => D.ago(p.start)],
];

function Processes({ procs }) {
  const [sort, setSort] = useState(["rss", -1]);
  const text = new Set(["program", "comm", "user"]);
  const rows = [...procs].sort((a, b) => {
    const [key, dir] = sort;
    if (text.has(key)) return dir * String(a[key] || "").localeCompare(String(b[key] || ""));
    return dir * ((Number(a[key]) || 0) - (Number(b[key]) || 0));
  });
  const sortBy = (key) => setSort(([k, d]) => (k === key ? [key, -d] : [key, text.has(key) ? 1 : -1]));
  return html`<table class="ptable">
    <thead>
      <tr>
        ${PROC_COLUMNS.map(
          ([key, label, , title]) => html`<th class=${text.has(key) ? "" : "num"} title=${title} aria-sort=${sort[0] === key ? (sort[1] < 0 ? "descending" : "ascending") : "none"}>
            <button onClick=${() => sortBy(key)}>${label}${sort[0] === key && html`<span class="arrow">${sort[1] < 0 ? "↓" : "↑"}</span>`}</button>
          </th>`,
        )}
      </tr>
    </thead>
    <tbody>
      ${rows.map(
        (p) => html`<tr key=${p.pid}>
          ${PROC_COLUMNS.map(([key, , cell]) => html`<td class=${text.has(key) ? key : "num"}>${cell(p)}</td>`)}
        </tr>`,
      )}
    </tbody>
  </table>`;
}

function Programs({ procs }) {
  const groups = new Map();
  for (const p of procs) {
    const g = groups.get(p.program) || { name: p.program, rss: 0, cpu: 0, count: 0 };
    g.rss += p.rss || 0;
    g.cpu += p.cpu || 0;
    g.count += 1;
    groups.set(p.program, g);
  }
  const list = [...groups.values()].sort(byDesc("rss")).slice(0, 8);
  const max = Math.max(...list.map((g) => g.rss), 1);
  return html`<div class="programs">
    ${list.map(
      (g) => html`<div class="program">
        <span class="program-name">${g.name}${g.count > 1 && html`<span class="muted"> ×${g.count}</span>`}</span>
        <span class="toprow-bar"><span style=${{ width: `${(g.rss / max) * 100}%` }}></span></span>
        <span class="num">${D.bytes(g.rss)}</span>
        <span class="num muted">${cpuPct(g.cpu)}</span>
      </div>`,
    )}
  </div>`;
}

function Kpi({ label, value, sub }) {
  return html`<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${sub && html`<div class="kpi-sub">${sub}</div>`}</div>`;
}

function Detail({ id, summary, range, paused, onClose }) {
  const snap = usePoll((s) => D.detail(id, s), 5000, [id], paused);
  const hist = usePoll(withSpan(range, (w, s) => D.detailHistory(id, w, s)), 15000, [id, range], paused);
  const k = snap.data?.kpi || {};
  const procs = snap.data?.procs || [];
  const info = D.describe(id, snap.data?.docker || summary?.docker);
  const hv = hist.data?.data || {};
  const times = hist.data?.times || [];
  const tracked = info.kind === "System" || info.kind === "Docker";
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  const series = (keys) => keys.map(([key, label, color]) => ({ key, label, color, values: hv[key] || [] }));
  return html`<div class="drawer-wrap">
    <div class="backdrop" onClick=${onClose}></div>
    <aside class="drawer" role="dialog" aria-label=${info.name}>
      <div class="drawer-head">
        <div>
          <div class="drawer-title">${info.name}</div>
          <div class="drawer-sub">${info.unit} · ${info.group || "root"}</div>
          <div class="chips">
            <span class="chip">${info.kind}</span>
            ${snap.data?.image && html`<span class="chip" title="Docker image">${snap.data.image}</span>`}
            ${k.start && html`<span class="chip">running ${D.duration(Date.now() / 1000 - k.start)}</span>`}
            <span class="chip">${k.limit > 0 ? `limit ${D.bytes(k.limit)}` : "no memory limit"}</span>
            ${k.ooms > 0 && html`<span class="chip critical"><${Icon} name="critical" size=${13} />${D.num(k.ooms)} OOM kills</span>`}
          </div>
        </div>
        <button class="icon-btn" onClick=${onClose} title="Close (Esc)"><${Icon} name="close" size=${18} /></button>
      </div>
      ${snap.error && html`<div class="banner">${snap.error.message}</div>`}
      <div class="kpis">
        <${Kpi} label="Memory" value=${D.bytes(k.mem)} sub="RAM + swap" />
        <${Kpi} label="RAM" value=${D.bytes(k.rss)} />
        <${Kpi} label="Swap" value=${D.bytes(k.swap)} />
        <${Kpi} label="File cache" value=${D.bytes(k.cache)} />
        <${Kpi} label="CPU" value=${cpuPct(k.cpu)} sub="of one core" />
        <${Kpi} label="Processes" value=${D.num(k.procs)} sub=${`${D.num(k.threads)} threads`} />
        <${Kpi} label="Peak memory" value=${D.bytes(k.peak)} />
        <${Kpi} label="Disk" value=${tracked ? D.perSec((k.read || 0) + (k.write || 0)) : "–"} sub=${tracked ? "read + write" : "not tracked"} />
      </div>
      <div class="grid-2">
        <div class="card pad">
          <div class="card-title">Memory</div>
          <${TimeChart}
            times=${times}
            format=${D.bytes}
            bytesAxis
            stacked
            series=${series([
              ["rss", "RAM", COLOR.ram],
              ["swap", "Swap", COLOR.swap],
              ["cache", "File cache", COLOR.cache],
              ["kernel", "Kernel", COLOR.kernel],
            ])}
          />
        </div>
        <div class="card pad">
          <div class="card-title">CPU <span class="muted">% of one core</span></div>
          <${TimeChart}
            times=${times}
            format=${cpuPct}
            stacked
            series=${series([
              ["user", "User", "var(--s1)"],
              ["system", "System", "var(--s2)"],
            ])}
          />
        </div>
        <div class="card pad">
          <div class="card-title">Disk I/O</div>
          <${TimeChart}
            times=${times}
            format=${D.perSec}
            bytesAxis
            empty=${tracked ? null : "Not tracked: user services have no I/O controller"}
            series=${series([
              ["read", "Read", "var(--s1)"],
              ["write", "Write", "var(--s2)"],
            ])}
          />
        </div>
        <div class="card pad">
          <div class="card-title">Waiting <span class="muted">share of time stalled</span></div>
          <${TimeChart}
            times=${times}
            format=${D.pct}
            series=${series([
              ["stallCpu", "CPU", "var(--s1)"],
              ["stallMem", "Memory", "var(--s2)"],
              ["stallIo", "I/O", "var(--s3)"],
            ])}
          />
        </div>
      </div>
      <div class="card pad">
        <div class="card-title">Programs <span class="muted">by resident memory</span></div>
        ${procs.length ? html`<${Programs} procs=${procs} />` : html`<div class="empty-row">No process data yet</div>`}
      </div>
      <div class="card pad">
        <div class="card-title">Processes <span class="muted">${procs.length}</span></div>
        <${Processes} procs=${procs} />
      </div>
    </aside>
  </div>`;
}

function LiveStatus({ at, error, paused, onToggle }) {
  const now = useNow(1000);
  const age = at ? Math.max(0, Math.round((now - at) / 1000)) : null;
  const state = paused ? "paused" : error ? "error" : "live";
  return html`<button class=${`live ${state}`} onClick=${onToggle} title=${paused ? "Resume updates" : "Pause updates"}>
    <span class="dot"></span>
    ${paused ? "Paused" : error ? "Can't reach Prometheus" : "Live"}
    <span class="muted">${age == null ? "" : age < 2 ? "just now" : `${age}s ago`}</span>
    <${Icon} name=${paused ? "play" : "pause"} size=${13} />
  </button>`;
}

function App() {
  const [range, setRange] = useStored("usage.range", 3600);
  const [paused, setPaused] = useState(false);
  const [selected, open, close] = useSelection();
  const host = usePoll(D.host, 5000, [], paused);
  const svcs = usePoll(D.services, 5000, [], paused);
  const procs = usePoll(D.topProcesses, 5000, [], paused);
  const hist = usePoll(withSpan(range, D.hostHistory), 15000, [range], paused);
  const sparks = usePoll((s) => D.serviceSparks(D.span(range), s), 30000, [range], paused);
  const trend = usePoll(withSpan(range, D.trends), 30000, [range], paused);
  const services = useMemo(() => (svcs.data || []).map((s) => ({ ...s, io: s.read == null && s.write == null ? null : (s.read || 0) + (s.write || 0) })), [svcs.data]);
  const byId = useMemo(() => new Map(services.map((s) => [s.id, s])), [services]);
  const rangeLabel = RANGES.find(([, v]) => v === range)?.[0] || "";
  const h = host.data;

  useEffect(() => {
    document.body.classList.toggle("locked", Boolean(selected));
  }, [selected]);

  return html`
    <header class="top">
      <div class="brand"><${Icon} name="pulse" size=${20} /><span>Usage</span>${h && html`<span class="host">${h.name} · up ${D.duration(Date.now() / 1000 - h.boot)}</span>`}</div>
      <div class="spacer"></div>
      <${LiveStatus} at=${svcs.at} error=${svcs.error || host.error} paused=${paused} onToggle=${() => setPaused((p) => !p)} />
      <div class="seg" role="group" aria-label="History range">
        ${RANGES.map(([label, v]) => html`<button aria-pressed=${range === v} onClick=${() => setRange(v)}>${label}</button>`)}
      </div>
    </header>
    <main class="app">
      ${(host.error || svcs.error) && !h && html`<div class="banner">Can't reach Prometheus: ${(host.error || svcs.error).message}</div>`}
      <${Insights} items=${insights(h, services)} open=${open} />
      <section>
        <h2>Right now</h2>
        <${Now} host=${h} hist=${hist.data} services=${services} rangeLabel=${rangeLabel} open=${open} />
      </section>
      <section>
        <h2>Busy processes</h2>
        <div class="grid-2">
          <${ProcessList} title="CPU" items=${procs.data?.cpu || []} value="var(--s1)" fmt=${cpuPct} services=${byId} open=${open} />
          <${ProcessList} title="Memory" items=${procs.data?.mem || []} value="var(--s1)" fmt=${D.bytes} services=${byId} open=${open} />
        </div>
      </section>
      <section>
        <h2>Services</h2>
        <${Services} services=${svcs.data && services} sparks=${sparks.data} open=${open} selected=${selected} />
      </section>
      <section>
        <h2>Trends <span class="muted">last ${rangeLabel}</span></h2>
        <${Trends} trend=${trend.data} />
      </section>
    </main>
    ${selected && html`<${Detail} key=${selected} id=${selected} summary=${byId.get(selected)} range=${range} paused=${paused} onClose=${close} />`}
  `;
}

render(html`<${App} />`, document.getElementById("app"));
