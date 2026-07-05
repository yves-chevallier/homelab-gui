// ---- helpers -------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

const STATUS_LABEL = { running: 'running', stopped: 'stopped', paused: 'paused', unknown: 'unknown' };

function fmtBytes(b) {
  if (b == null || !isFinite(b)) return '—';
  const g = b / 1073741824;
  if (g >= 1) return `${g.toFixed(1)} GB`;
  return `${(b / 1048576).toFixed(0)} MB`;
}
function fmtUptime(sec) {
  if (sec == null || sec <= 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function pct(used, max) {
  if (used == null || !max) return null;
  return Math.max(0, Math.min(100, (used / max) * 100));
}

// ---- state ---------------------------------------------------------------
let cfg = { pollMs: 3000, grafanaEnabled: true, node: 'pve' };
const cardEls = new Map(); // id -> { root, refs }
let pollTimer = null;
let openCard = null;       // currently opened card data

// ---- grid rendering ------------------------------------------------------
const grid = $('#grid');
const conn = $('#conn');

function ensureCard(c) {
  let entry = cardEls.get(c.id);
  if (entry) return entry;

  const root = el('div', 'card');
  root.dataset.id = c.id;

  const top = el('div', 'card-top');
  const name = el('div', 'card-name');
  const badge = el('div', 'card-badge');
  top.append(name, badge);

  const status = el('div', 'card-status');

  const rows = el('div', 'card-rows');
  const refs = { name, badge, status, rows, cells: {} };
  for (const [key, label] of [['mem', 'RAM'], ['cpu', 'CPU'], ['uptime', 'Uptime']]) {
    const k = el('span', 'k'); k.textContent = label;
    const v = el('span', 'v');
    rows.append(k, v);
    refs.cells[key] = v;
  }

  const barWrap = el('div', 'bar');
  const barFill = el('i');
  barWrap.append(barFill);
  refs.bar = barWrap; refs.barFill = barFill;

  root.append(top, status, rows, barWrap);
  root.addEventListener('click', () => openDetail(cardEls.get(c.id).data));

  entry = { root, refs, data: c };
  cardEls.set(c.id, entry);
  return entry;
}

function updateCard(c) {
  const { root, refs } = ensureCard(c);
  const entry = cardEls.get(c.id);
  entry.data = c;

  root.dataset.status = ['running', 'stopped', 'paused'].includes(c.status) ? c.status : 'unknown';
  refs.name.textContent = c.name;
  refs.badge.textContent = c.kind === 'guest' ? `${c.type} ${c.vmid}`
    : c.kind === 'host' ? 'PVE' : (c.type || '');
  refs.status.textContent = STATUS_LABEL[c.status] || c.status;

  const memP = pct(c.mem, c.memMax);
  refs.cells.mem.textContent = c.mem != null
    ? `${fmtBytes(c.mem)}${c.memMax ? ` / ${fmtBytes(c.memMax)}` : ''}${memP != null ? ` (${memP.toFixed(0)}%)` : ''}`
    : '—';

  const cpuP = c.cpu != null ? c.cpu * 100 : null;
  refs.cells.cpu.textContent = cpuP != null ? `${cpuP.toFixed(1)} %` : '—';
  refs.cells.uptime.textContent = fmtUptime(c.uptime);

  // load bar tracks CPU utilisation
  const p = cpuP ?? 0;
  refs.barFill.style.width = `${Math.min(100, p)}%`;
  refs.bar.classList.toggle('crit', p >= 90);
  refs.bar.classList.toggle('hot', p >= 70 && p < 90);
}

function renderGrid(cards) {
  const order = [];
  for (const c of cards) {
    updateCard(c);
    order.push(cardEls.get(c.id).root);
  }
  // reorder / remove stale without wiping (no flicker)
  const present = new Set(cards.map((c) => c.id));
  for (const [id, entry] of cardEls) {
    if (!present.has(id)) { entry.root.remove(); cardEls.delete(id); }
  }
  order.forEach((node, i) => {
    if (grid.children[i] !== node) grid.insertBefore(node, grid.children[i] || null);
  });
}

async function poll() {
  try {
    const r = await fetch('/api/grid', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const { cards } = await r.json();
    renderGrid(cards);
    conn.textContent = 'live'; conn.className = 'conn ok';
    // keep open detail's header status fresh
    if (openCard) {
      const fresh = cards.find((c) => c.id === openCard.id);
      if (fresh) { openCard = fresh; syncDetailHeader(fresh); }
    }
  } catch (e) {
    conn.textContent = 'offline'; conn.className = 'conn down';
  }
}

// ---- detail view ---------------------------------------------------------
const detail = $('#detail');
const detailTitle = $('#detail-title');
const detailStatus = $('#detail-status');
const detailMetrics = $('#detail-metrics');
const detailLogs = $('#detail-logs');
const grafanaFrame = $('#grafana-frame');

function syncDetailHeader(c) {
  detailTitle.textContent = c.name;
  detailStatus.textContent = STATUS_LABEL[c.status] || c.status;
  detailStatus.dataset.status = c.status;
}

function openDetail(c) {
  openCard = c;
  syncDetailHeader(c);
  detail.classList.remove('hidden');
  detail.setAttribute('aria-hidden', 'false');
  switchTab('charts');
  renderMetrics(c);
  loadCharts(c);
  loadLogs(c);
  setupGrafana(c);
}

function closeDetail() {
  openCard = null;
  detail.classList.add('hidden');
  detail.setAttribute('aria-hidden', 'true');
  grafanaFrame.src = 'about:blank';
}

$('#back').addEventListener('click', closeDetail);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

// tabs
$('.detail-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab'); if (!b) return;
  switchTab(b.dataset.tab);
});
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab));
}

function renderMetrics(c) {
  const memP = pct(c.mem, c.memMax);
  const items = [
    ['Status', STATUS_LABEL[c.status] || c.status],
    c.vmid != null ? ['VMID', c.vmid] : null,
    ['CPU', c.cpu != null ? `${(c.cpu * 100).toFixed(1)} %${c.cpuMax ? ` / ${c.cpuMax} vCPU` : ''}` : '—'],
    ['RAM', c.mem != null ? `${fmtBytes(c.mem)}${c.memMax ? ` / ${fmtBytes(c.memMax)}` : ''}${memP != null ? ` (${memP.toFixed(0)}%)` : ''}` : '—'],
    ['Uptime', fmtUptime(c.uptime)],
    c.load ? ['Load', c.load.map((n) => n.toFixed(2)).join('  ')] : null,
  ].filter(Boolean);
  detailMetrics.innerHTML = '';
  for (const [k, v] of items) {
    const m = el('div', 'm');
    const kk = el('div', 'k'); kk.textContent = k;
    const vv = el('div', 'v'); vv.textContent = v;
    m.append(kk, vv);
    detailMetrics.append(m);
  }
}

// ---- charts (rrddata -> canvas) -----------------------------------------
async function loadCharts(c) {
  clearCharts();
  let url = null;
  if (c.kind === 'host') url = '/api/rrd/node?timeframe=hour';
  else if (c.kind === 'guest') url = `/api/rrd/${c.type}/${c.vmid}?timeframe=hour`;
  if (!url) return; // external cards have no rrddata -> use Grafana tab

  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const rows = await r.json();
    const t = rows.map((d) => d.time);
    drawChart('cpu', t, rows.map((d) => (d.cpu ?? 0) * 100), { max: 100, color: '#4c9aff' });
    drawChart('mem', t, rows.map((d) => (d.maxmem ? (d.mem / d.maxmem) * 100 : 0)), { max: 100, color: '#2ea44f' });
    drawChart('net', t, rows.map((d) => ((d.netin ?? 0) + (d.netout ?? 0)) / 1024), { color: '#e0912a' });
  } catch (e) {
    // leave charts empty on failure
  }
}

function clearCharts() {
  document.querySelectorAll('canvas[data-chart]').forEach((cv) => {
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
  });
}

function drawChart(which, times, values, { max = null, color = '#4c9aff' } = {}) {
  const cv = document.querySelector(`canvas[data-chart="${which}"]`);
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const pts = values.map((v, i) => [times[i], Number.isFinite(v) ? v : 0]).filter((p) => p[0] != null);
  if (pts.length < 2) return;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y1 = max ?? Math.max(1, ...ys) * 1.1;
  const pad = 4;
  const sx = (x) => pad + ((x - x0) / (x1 - x0 || 1)) * (w - 2 * pad);
  const sy = (y) => h - pad - (Math.min(y, y1) / y1) * (h - 2 * pad);

  // area fill
  ctx.beginPath();
  ctx.moveTo(sx(pts[0][0]), sy(pts[0][1]));
  for (const [x, y] of pts) ctx.lineTo(sx(x), sy(y));
  ctx.lineTo(sx(x1), h - pad); ctx.lineTo(sx(x0), h - pad); ctx.closePath();
  ctx.fillStyle = color + '22'; ctx.fill();

  // line
  ctx.beginPath();
  ctx.moveTo(sx(pts[0][0]), sy(pts[0][1]));
  for (const [x, y] of pts) ctx.lineTo(sx(x), sy(y));
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();

  // last value label
  const last = pts[pts.length - 1][1];
  ctx.fillStyle = '#e6eaf0'; ctx.font = '11px system-ui';
  ctx.textAlign = 'right';
  ctx.fillText(max === 100 ? `${last.toFixed(0)}%` : last.toFixed(0), w - pad, 12);
}

// ---- logs ----------------------------------------------------------------
async function loadLogs(c) {
  detailLogs.textContent = '…';
  const host = c.kind === 'host' ? cfg.node : c.name;
  try {
    const r = await fetch(`/api/logs?host=${encodeURIComponent(host)}&limit=150`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const { lines } = await r.json();
    if (!lines.length) { detailLogs.textContent = `No logs for {host="${host}"}.`; return; }
    detailLogs.textContent = lines
      .map((l) => `${new Date(l.ts).toLocaleTimeString('en-GB')}  ${l.line}`)
      .join('\n');
  } catch (e) {
    detailLogs.textContent = `Logs unavailable (${e.message}).`;
  }
}

// ---- grafana embed -------------------------------------------------------
function setupGrafana(c) {
  const tab = document.querySelector('.tab[data-tab="grafana"]');
  if (c.grafana && cfg.grafanaEnabled) {
    tab.style.display = '';
    grafanaFrame.src = c.grafana;
  } else {
    tab.style.display = 'none';
    grafanaFrame.src = 'about:blank';
  }
}

// ---- swipe-down to close -------------------------------------------------
let touchStartY = null;
detail.addEventListener('touchstart', (e) => {
  const body = $('.detail-body');
  if (body.scrollTop <= 0) touchStartY = e.touches[0].clientY; else touchStartY = null;
}, { passive: true });
detail.addEventListener('touchmove', (e) => {
  if (touchStartY == null) return;
  const dy = e.touches[0].clientY - touchStartY;
  if (dy > 90) { closeDetail(); touchStartY = null; }
}, { passive: true });

// ---- boot ----------------------------------------------------------------
async function boot() {
  try {
    const r = await fetch('/api/config');
    if (r.ok) cfg = { ...cfg, ...(await r.json()) };
  } catch { /* defaults */ }
  await poll();
  pollTimer = setInterval(poll, cfg.pollMs);
}
boot();
