// Prometheus access, unit naming and number formatting.

// Leaf systemd units and docker scopes; user@N.service only nests the user's units.
const LEAF = String.raw`id=~'.+\\.(service|scope)', id!~'.*/user@[0-9]+\\.service'`;

export const quote = (s) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

async function prom(path, params, signal) {
  const res = await fetch(`api/v1/${path}`, { method: "POST", body: new URLSearchParams(params), signal });
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.status !== "success") throw new Error(body?.error || `Prometheus answered ${res.status}`);
  return body.data.result;
}

// One request for many expressions: each result series carries its key in label k.
function batch(exprs, by) {
  return Object.entries(exprs)
    .map(([k, e]) => `label_replace(sum${by ? ` by (${by})` : ""} (${e}), "k", "${k}", "", "")`)
    .join(" or ");
}

function rows(result, keyOf) {
  const out = new Map();
  for (const { metric, value } of result) {
    const key = keyOf(metric);
    const row = out.get(key) || out.set(key, { metric }).get(key);
    if (metric.name && !row.metric.name) row.metric = metric;
    row[metric.k] = Number(value[1]);
  }
  return out;
}

const instant = (exprs, by, signal) => prom("query", { query: batch(exprs, by) }, signal);

export function span(range) {
  const step = Math.max(5, Math.round(range / 240));
  const end = Math.floor(Date.now() / 1000);
  return { start: end - range, end, step, rw: `${Math.max(30, step * 3)}s` };
}

async function ranged(exprs, by, w, signal) {
  const result = await prom("query_range", { query: batch(exprs, by), start: w.start, end: w.end, step: w.step }, signal);
  return result.map(({ metric, values }) => ({ metric, values: grid(values, w) }));
}

// Places samples on the window's step grid; gaps stay null.
function grid(values, w) {
  const n = Math.floor((w.end - w.start) / w.step) + 1;
  const out = new Array(n).fill(null);
  for (const [t, v] of values) {
    const i = Math.round((t - w.start) / w.step);
    if (i >= 0 && i < n) out[i] = Number(v);
  }
  return out;
}

export const times = (w) => Array.from({ length: Math.floor((w.end - w.start) / w.step) + 1 }, (_, i) => w.start + i * w.step);

const HOST = {
  cpu: "1 - rate(node_cpu_seconds_total{mode='idle'}[30s])",
  cores: "count(node_cpu_seconds_total{mode='idle'})",
  memTotal: "node_memory_MemTotal_bytes",
  memAvail: "node_memory_MemAvailable_bytes",
  memFree: "node_memory_MemFree_bytes",
  swapTotal: "node_memory_SwapTotal_bytes",
  swapFree: "node_memory_SwapFree_bytes",
  read: "rate(node_disk_read_bytes_total{device!~'dm-.*'}[30s])",
  write: "rate(node_disk_written_bytes_total{device!~'dm-.*'}[30s])",
  stallCpu: "rate(node_pressure_cpu_waiting_seconds_total[30s])",
  stallMem: "rate(node_pressure_memory_waiting_seconds_total[30s])",
  stallIo: "rate(node_pressure_io_waiting_seconds_total[30s])",
  boot: "node_boot_time_seconds",
};

export async function host(signal) {
  const [values, uname, threads] = await Promise.all([
    instant(HOST, "", signal),
    prom("query", { query: "node_uname_info" }, signal),
    prom("query", { query: "1 - rate(node_cpu_seconds_total{mode='idle'}[30s])" }, signal),
  ]);
  const h = rows(values, () => "host").get("host") || {};
  h.cpu = h.cpu / h.cores;
  h.name = uname[0]?.metric.nodename || "host";
  h.threads = threads.map((r) => [Number(r.metric.cpu), Number(r.value[1])]).sort((a, b) => a[0] - b[0]).map((r) => r[1]);
  return h;
}

export async function hostHistory(w, signal) {
  const series = await ranged(
    {
      cpu: `1 - rate(node_cpu_seconds_total{mode='idle'}[${w.rw}])`,
      cores: "count(node_cpu_seconds_total{mode='idle'})",
      memUsed: "node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes",
      swapUsed: "node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes",
      io: `rate(node_disk_read_bytes_total{device!~'dm-.*'}[${w.rw}]) + rate(node_disk_written_bytes_total{device!~'dm-.*'}[${w.rw}])`,
    },
    "",
    w,
    signal,
  );
  const by = Object.fromEntries(series.map((s) => [s.metric.k, s.values]));
  if (by.cpu && by.cores) by.cpu = by.cpu.map((v, i) => (v == null || !by.cores[i] ? null : v / by.cores[i]));
  return by;
}

const SERVICE = {
  rss: `container_memory_rss{${LEAF}}`,
  swap: `container_memory_swap{${LEAF}}`,
  cache: `container_memory_cache{${LEAF}}`,
  cpu: `rate(container_cpu_usage_seconds_total{${LEAF}}[30s])`,
  read: `rate(container_fs_reads_bytes_total{${LEAF}}[30s])`,
  write: `rate(container_fs_writes_bytes_total{${LEAF}}[30s])`,
  procs: `container_processes{${LEAF}}`,
  threads: `container_threads{${LEAF}}`,
  stall: `rate(container_pressure_memory_waiting_seconds_total{${LEAF}}[30s])`,
  ooms: `increase(container_oom_events_total{${LEAF}}[1h])`,
};

export async function services(signal) {
  const out = [];
  for (const [id, { metric, ...v }] of rows(await instant(SERVICE, "id, name", signal), (m) => m.id))
    out.push({ id, ...describe(id, metric.name), ...v, mem: (v.rss || 0) + (v.swap || 0) });
  return out;
}

export async function serviceSparks(w, signal) {
  const series = await ranged({ cpu: `rate(container_cpu_usage_seconds_total{${LEAF}}[${w.rw}])` }, "id", w, signal);
  return new Map(series.map((s) => [s.metric.id, s.values]));
}

// Per-service history for the trend charts; the caller picks the top series.
export async function trends(w, signal) {
  const series = await ranged(
    {
      mem: `container_memory_rss{${LEAF}} + container_memory_swap{${LEAF}}`,
      cpu: `rate(container_cpu_usage_seconds_total{${LEAF}}[${w.rw}])`,
    },
    "id, name",
    w,
    signal,
  );
  const out = { mem: [], cpu: [] };
  for (const s of series) out[s.metric.k].push({ id: s.metric.id, ...describe(s.metric.id, s.metric.name), values: s.values });
  return out;
}

const PROC_LABELS = "pid, cgroup, program, comm, user";

function procRows(result) {
  return [...rows(result, (m) => m.pid).values()].map(({ metric: { pid, cgroup, program, comm, user }, ...v }) => ({
    pid,
    cgroup,
    program,
    comm,
    user,
    ...v,
  }));
}

export async function topProcesses(signal) {
  const [cpu, mem] = await Promise.all([
    prom("query", { query: `topk(8, sum by (${PROC_LABELS}) (rate(namedprocess_namegroup_cpu_seconds_total[30s])))` }, signal),
    prom("query", { query: `topk(8, sum by (${PROC_LABELS}) (namedprocess_namegroup_memory_bytes{memtype='resident'}))` }, signal),
  ]);
  const one = (r) => r.map(({ metric, value }) => ({ ...metric, value: Number(value[1]), service: describe(metric.cgroup || "") }));
  return { cpu: one(cpu), mem: one(mem) };
}

export async function detail(id, signal) {
  const sel = `id=${quote(id)}`;
  const procSel = `cgroup=${quote(id)}`;
  const [kpi, procs] = await Promise.all([
    instant(
      {
        rss: `container_memory_rss{${sel}}`,
        swap: `container_memory_swap{${sel}}`,
        cache: `container_memory_cache{${sel}}`,
        kernel: `container_memory_kernel_usage{${sel}}`,
        cpu: `rate(container_cpu_usage_seconds_total{${sel}}[30s])`,
        procs: `container_processes{${sel}}`,
        threads: `container_threads{${sel}}`,
        fds: `container_file_descriptors{${sel}}`,
        peak: `max by (name, image) (container_memory_max_usage_bytes{${sel}})`,
        limit: `max by (name, image) (container_spec_memory_limit_bytes{${sel}})`,
        ooms: `max by (name, image) (container_oom_events_total{${sel}})`,
        start: `max by (name, image) (container_start_time_seconds{${sel}})`,
        read: `rate(container_fs_reads_bytes_total{${sel}}[30s])`,
        write: `rate(container_fs_writes_bytes_total{${sel}}[30s])`,
      },
      "name, image",
      signal,
    ),
    instant(
      {
        rss: `namedprocess_namegroup_memory_bytes{${procSel}, memtype='resident'}`,
        swap: `namedprocess_namegroup_memory_bytes{${procSel}, memtype='swapped'}`,
        cpu: `rate(namedprocess_namegroup_cpu_seconds_total{${procSel}}[30s])`,
        threads: `namedprocess_namegroup_num_threads{${procSel}}`,
        start: `namedprocess_namegroup_oldest_start_time_seconds{${procSel}}`,
      },
      PROC_LABELS,
      signal,
    ),
  ]);
  let k = {};
  for (const row of rows(kpi, () => "k").values()) k = { ...k, ...row };
  k.mem = (k.rss || 0) + (k.swap || 0);
  const labels = kpi.find((r) => r.metric.name)?.metric;
  return { kpi: k, docker: labels?.name, image: labels?.image, procs: procRows(procs) };
}

export async function detailHistory(id, w, signal) {
  const sel = `id=${quote(id)}`;
  const series = await ranged(
    {
      rss: `container_memory_rss{${sel}}`,
      swap: `container_memory_swap{${sel}}`,
      cache: `container_memory_cache{${sel}}`,
      kernel: `container_memory_kernel_usage{${sel}}`,
      user: `rate(container_cpu_user_seconds_total{${sel}}[${w.rw}])`,
      system: `rate(container_cpu_system_seconds_total{${sel}}[${w.rw}])`,
      read: `rate(container_fs_reads_bytes_total{${sel}}[${w.rw}])`,
      write: `rate(container_fs_writes_bytes_total{${sel}}[${w.rw}])`,
      stallCpu: `rate(container_pressure_cpu_waiting_seconds_total{${sel}}[${w.rw}])`,
      stallMem: `rate(container_pressure_memory_waiting_seconds_total{${sel}}[${w.rw}])`,
      stallIo: `rate(container_pressure_io_waiting_seconds_total{${sel}}[${w.rw}])`,
    },
    "",
    w,
    signal,
  );
  return Object.fromEntries(series.map((s) => [s.metric.k, s.values]));
}

// Display name, kind and group of a cgroup path.
const unescape = (s) => s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

export const KINDS = ["System", "Apps", "Session", "Docker", "Background", "Logins", "Other"];

export function describe(id, docker) {
  const parts = id.split("/").filter(Boolean);
  const unit = unescape(parts.at(-1) || id);
  const parent = unescape(parts.at(-2) || "");
  const under = (slice) => parts.includes(slice);
  const isDocker = Boolean(docker) || /^docker-[0-9a-f]{12,}\.scope$/.test(unit);
  let name = unit.replace(/\.(service|scope)$/, "");
  const app = /^app-(.+?)-[0-9a-f]+$/.exec(name);
  if (isDocker) name = docker || `container ${name.slice(7, 19)}`;
  else if (app) name = app[1].split(".").at(-1);
  else if (name.startsWith("tmux-spawn-")) name = `tmux pane ${name.slice(11, 19)}`;
  else if (name.startsWith("wayland-wm@")) name = "Desktop session";
  const kind = isDocker
    ? "Docker"
    : under("system.slice")
      ? "System"
      : under("app.slice") || app
        ? "Apps"
        : under("session.slice")
          ? "Session"
          : under("background.slice")
            ? "Background"
            : /^session-\d+\.scope$/.test(unit)
              ? "Logins"
              : "Other";
  return { name, unit, group: parent, kind };
}

const IEC = ["B", "KiB", "MiB", "GiB", "TiB"];
export function bytes(n) {
  if (n == null || !Number.isFinite(n)) return "–";
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < IEC.length - 1) {
    v /= 1024;
    i++;
  }
  return `${(Math.sign(n) * v).toFixed(i === 0 || v >= 100 ? 0 : 1)} ${IEC[i]}`;
}
export const perSec = (n) => (n == null || !Number.isFinite(n) ? "–" : `${bytes(n)}/s`);
export function pct(x) {
  if (x == null || !Number.isFinite(x)) return "–";
  const v = x * 100;
  return `${v.toFixed(v >= 100 || v === 0 ? 0 : 1)}%`;
}
export const num = (n) => (n == null || !Number.isFinite(n) ? "–" : Math.round(n).toLocaleString());
export function duration(s) {
  if (s == null || !Number.isFinite(s)) return "–";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min`;
  return `${Math.floor(s)} s`;
}
export const ago = (t) => (t == null ? "–" : `${duration(Date.now() / 1000 - t)} ago`);
