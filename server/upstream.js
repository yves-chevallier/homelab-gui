import { Agent } from 'undici';
import { config, pveBase, pveAuthHeader } from './config.js';

// Proxmox serves the API over HTTPS with a self-signed certificate.
// This dispatcher is used ONLY for calls to the PVE host.
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

const TIMEOUT_MS = 8000;

function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

/** Call the Proxmox API and return the `data` payload. */
export async function pve(path) {
  const { signal, done } = withTimeout(TIMEOUT_MS);
  try {
    const res = await fetch(`${pveBase}${path}`, {
      headers: { Authorization: pveAuthHeader },
      dispatcher: insecureAgent,
      signal,
    });
    if (!res.ok) throw new Error(`PVE ${path} -> HTTP ${res.status}`);
    const json = await res.json();
    return json.data;
  } finally {
    done();
  }
}

/** Prometheus instant query -> single float value, or null if empty. */
export async function promInstant(query) {
  const { signal, done } = withTimeout(TIMEOUT_MS);
  try {
    const url = new URL('/api/v1/query', config.promUrl);
    url.searchParams.set('query', query);
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Prometheus -> HTTP ${res.status}`);
    const json = await res.json();
    const result = json?.data?.result;
    if (!result || result.length === 0) return null;
    const v = parseFloat(result[0].value[1]);
    return Number.isFinite(v) ? v : null;
  } finally {
    done();
  }
}

/** Loki range query -> array of { ts (ms), line } newest first. */
export async function lokiRange(logql, { limit = 100, hours = 1 } = {}) {
  const { signal, done } = withTimeout(TIMEOUT_MS);
  try {
    const now = Date.now();
    const url = new URL('/loki/api/v1/query_range', config.lokiUrl);
    url.searchParams.set('query', logql);
    url.searchParams.set('start', `${now - hours * 3600 * 1000}000000`);
    url.searchParams.set('end', `${now}000000`);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('direction', 'backward');
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Loki -> HTTP ${res.status}`);
    const json = await res.json();
    const streams = json?.data?.result ?? [];
    const lines = [];
    for (const s of streams) {
      for (const [tsNs, line] of s.values) {
        lines.push({ ts: Math.floor(Number(tsNs) / 1e6), line });
      }
    }
    lines.sort((a, b) => b.ts - a.ts);
    return lines.slice(0, limit);
  } finally {
    done();
  }
}
