// Minimal smoke test: boot the server with dummy creds and assert it serves
// its own config endpoint and static frontend. No external services required.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 8123;
const base = `http://127.0.0.1:${PORT}`;

const srv = spawn('node', ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), PVE_TOKEN_ID: 'x', PVE_TOKEN_SECRET: 'y' },
  stdio: ['ignore', 'inherit', 'inherit'],
});

function fail(msg) {
  console.error(`✗ smoke test FAILED: ${msg}`);
  srv.kill('SIGTERM');
  process.exit(1);
}

try {
  // Wait for the server to accept connections.
  let cfg = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const r = await fetch(`${base}/api/config`);
      if (r.ok) { cfg = await r.json(); break; }
    } catch { /* not up yet */ }
  }
  if (!cfg) fail('server did not answer /api/config');
  if (typeof cfg.pollMs !== 'number') fail('/api/config missing pollMs');

  // Static frontend is served.
  const html = await fetch(`${base}/`).then((r) => r.text());
  if (!html.includes('Monitoring cards')) fail('index.html not served');

  console.log('✓ smoke test OK');
} finally {
  srv.kill('SIGTERM');
}
