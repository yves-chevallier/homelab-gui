// Demo mode: deterministic, realistic fixtures so the UI can be exercised
// (screenshots, offline demos) without a real Proxmox token or live sources.
// Enabled with DEMO=1.

const GB = 1073741824;

const GUESTS = [
  { type: 'lxc', vmid: 100, name: 'pihole',     status: 'running', cpu: 0.02, cpuMax: 1, mem: 0.12 * GB, memMax: 0.5 * GB, up: 43 },
  { type: 'lxc', vmid: 200, name: 'monitoring', status: 'running', cpu: 0.16, cpuMax: 2, mem: 2.1 * GB,  memMax: 4 * GB,   up: 44 },
  { type: 'lxc', vmid: 201, name: 'nextcloud',  status: 'running', cpu: 0.08, cpuMax: 2, mem: 1.2 * GB,  memMax: 2 * GB,   up: 41 },
  { type: 'lxc', vmid: 202, name: 'gitea',      status: 'running', cpu: 0.03, cpuMax: 1, mem: 0.4 * GB,  memMax: 1 * GB,   up: 41 },
  { type: 'qemu', vmid: 203, name: 'jellyfin',  status: 'running', cpu: 0.42, cpuMax: 4, mem: 3.1 * GB,  memMax: 4 * GB,   up: 12 },
  { type: 'lxc', vmid: 300, name: 'test-lab',   status: 'stopped', cpu: 0,    cpuMax: 1, mem: 0,         memMax: 1 * GB,   up: 0 },
  { type: 'qemu', vmid: 301, name: 'win-vm',    status: 'paused',  cpu: 0,    cpuMax: 2, mem: 2 * GB,    memMax: 4 * GB,   up: 3 },
];

export function demoGrid() {
  const day = 86400;
  const cards = [];

  cards.push({
    id: 'node/pve', kind: 'host', name: 'pve', status: 'running',
    cpu: 0.23, cpuMax: 8, mem: 18.4 * GB, memMax: 32 * GB, uptime: 43 * day,
    load: [0.82, 0.94, 1.05],
  });

  for (const g of GUESTS) {
    cards.push({
      id: `${g.type}/${g.vmid}`, kind: 'guest', type: g.type, vmid: g.vmid,
      name: g.name, status: g.status, cpu: g.cpu, cpuMax: g.cpuMax,
      mem: g.mem, memMax: g.memMax, uptime: g.up * day,
    });
  }

  cards.push({
    id: 'nas', kind: 'external', type: 'nas', name: 'hodor (NAS)', status: 'running',
    cpu: 0.02, cpuMax: 1, mem: 7.9 * GB, memMax: 8.2 * GB, uptime: 44 * day,
    grafana: '/grafana/d/synology?kiosk&theme=dark',
  });
  cards.push({
    id: 'router', kind: 'external', type: 'router', name: 'opnsense (Router)', status: 'running',
    cpu: 0.07, cpuMax: 1, mem: 8.4 * GB, memMax: 34.1 * GB, uptime: 44 * day,
    grafana: '/grafana/d/opnsense?kiosk&theme=dark',
  });

  return { ts: Date.now(), cards, demo: true };
}

// 60 points over the last hour, smooth deterministic curves.
export function demoRrd(seed = 1) {
  const now = Math.floor(Date.now() / 1000);
  const maxmem = 4 * GB;
  const rows = [];
  for (let i = 59; i >= 0; i--) {
    const t = now - i * 60;
    const phase = (i / 59) * Math.PI * 2 * seed;
    const cpu = 0.25 + 0.2 * Math.sin(phase) + 0.05 * Math.sin(phase * 3);
    const memFrac = 0.55 + 0.12 * Math.sin(phase * 0.7 + 1);
    rows.push({
      time: t,
      cpu: Math.max(0.01, cpu),
      mem: Math.round(memFrac * maxmem),
      maxmem,
      netin: Math.round((80 + 60 * Math.abs(Math.sin(phase))) * 1024),
      netout: Math.round((40 + 40 * Math.abs(Math.cos(phase))) * 1024),
    });
  }
  return rows;
}

export function demoLogs(host) {
  const now = Date.now();
  const samples = [
    'level=info msg="request completed" method=GET path=/health status=200 duration=1.2ms',
    'level=info msg="scrape ok" target=node-exporter samples=482',
    'level=warn msg="high memory pressure" used=78%',
    'level=info msg="backup snapshot created" volume=data',
    'level=info msg="connection accepted" peer=192.168.20.14',
    'level=debug msg="cache hit" key=session',
    'level=info msg="tls handshake" cipher=TLS_AES_256_GCM_SHA384',
    'level=info msg="cron job finished" job=prune-logs',
  ];
  const lines = [];
  for (let i = 0; i < 40; i++) {
    lines.push({ ts: now - i * 7000, line: `${host} ${samples[i % samples.length]}` });
  }
  return { query: `{host="${host}"}`, lines };
}
