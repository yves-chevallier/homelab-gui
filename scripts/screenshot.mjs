// Boot the server in demo mode and capture UI screenshots for the README.
//   node scripts/screenshot.mjs
// Requires the `playwright` dev dependency and its chromium browser.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'docs', 'img');
const PORT = 8124;
const base = `http://127.0.0.1:${PORT}`;

// 1U panel size
const W = 1424, H = 280;

const srv = spawn('node', ['server/index.js'], {
  cwd: join(__dirname, '..'),
  env: { ...process.env, PORT: String(PORT), DEMO: '1', GRAFANA_URL: '' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try { if ((await fetch(`${base}/api/config`)).ok) return; } catch { /* not up */ }
  }
  throw new Error('server did not start');
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await waitForServer();

  const browser = await chromium.launch();
  // The floating "live" connection pill overlaps card titles in a still frame.
  const hidePill = '#conn{display:none!important}';

  // --- 1U grid (1424x280) ---
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: hidePill });
  await page.waitForSelector('.card');
  await sleep(600); // let bars/values settle
  await page.screenshot({ path: join(OUT, 'grid.png') });
  console.log('✓ grid.png');

  // --- 1U detail view (charts) ---
  await page.locator('.card', { hasText: 'jellyfin' }).click();
  await page.waitForSelector('#detail:not(.hidden)');
  await sleep(900); // let canvas charts draw
  await page.screenshot({ path: join(OUT, 'detail.png') });
  console.log('✓ detail.png');
  await ctx.close();

  // --- Responsive (desktop / tablet reflow), cropped to content ---
  const RW = 1180;
  const ctx2 = await browser.newContext({ viewport: { width: RW, height: 700 }, deviceScaleFactor: 2 });
  const page2 = await ctx2.newPage();
  await page2.goto(base, { waitUntil: 'networkidle' });
  await page2.addStyleTag({ content: hidePill });
  await page2.waitForSelector('.card');
  await sleep(600);
  const cards = page2.locator('.card');
  const last = await cards.nth((await cards.count()) - 1).boundingBox();
  const height = Math.min(700, Math.ceil(last.y + last.height + 12));
  await page2.screenshot({ path: join(OUT, 'responsive.png'), clip: { x: 0, y: 0, width: RW, height } });
  console.log('✓ responsive.png');
  await ctx2.close();

  await browser.close();
}

main()
  .then(() => { srv.kill('SIGTERM'); console.log(`\nScreenshots written to ${OUT}`); })
  .catch((e) => { console.error('screenshot failed:', e.message); srv.kill('SIGTERM'); process.exit(1); });
