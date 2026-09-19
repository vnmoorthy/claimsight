// Records a backup demo video of the ClaimSight flow against the running app (http://localhost:5176).
//   node scripts/record-demo.mjs   → assets/demo-backup.mp4 (via ffmpeg)
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const APP = process.env.DEMO_APP_URL ?? 'http://localhost:5176';
const OUT = 'assets/demo-backup.mp4';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: 'tmp/video', size: { width: 1440, height: 900 } },
  colorScheme: 'dark',
});
const page = await context.newPage();
const step = (s) => console.log(new Date().toISOString().slice(11, 19), s);

await page.goto(APP, { waitUntil: 'networkidle' });
await page.evaluate(async () => { try { localStorage.clear(); const dbs = await indexedDB.databases(); for (const d of dbs) if (d.name) indexedDB.deleteDatabase(d.name); } catch {} });
await page.evaluate(() => fetch('/seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
await page.reload({ waitUntil: 'networkidle' });
const darkBtn = page.getByRole('button', { name: /Switch to dark theme/i });
if (await darkBtn.count()) { await darkBtn.first().click(); await pause(500); }
step('empty state'); await pause(2500);

// 1. A1042 → refund + Damage Twin
await page.getByRole('button', { name: /^A1042/ }).first().click(); await pause(1200);
await page.getByRole('button', { name: 'File claim' }).click();
await page.getByText('Refund issued').first().waitFor({ timeout: 30000 }); step('refund card');
await pause(2500);
await page.getByText('Refund issued').first().scrollIntoViewIfNeeded(); await pause(1500);
const video = page.locator('video').first();
await video.waitFor({ state: 'visible', timeout: 120000 }); step('twin video visible');
await video.scrollIntoViewIfNeeded(); await pause(7000);

// 2. A1043 → fraud twin → desk → deny
await page.getByRole('button', { name: /^A1043/ }).first().click(); await pause(1200);
await page.getByRole('button', { name: 'File claim' }).click();
await page.getByText('Escalated to a teammate').first().waitFor({ timeout: 30000 }); step('fraud card');
await pause(2000);
await page.getByText('Fraud twin detected').first().scrollIntoViewIfNeeded(); await pause(3500);
const open = page.getByRole('button', { name: /Open in Refund Desk/i });
if (await open.count()) await open.first().click(); else await page.getByRole('tab', { name: /Refund Desk/i }).click();
await pause(3000); step('desk drawer');
const note = page.getByPlaceholder(/Note for the audit trail/i);
if (await note.count()) { await note.first().click(); await note.first().type('Same footage as A1042 from another account. Denied after review.', { delay: 25 }); }
await pause(800);
await page.getByRole('button', { name: 'Deny claim' }).click(); await pause(3500); step('denied');
await page.keyboard.press('Escape'); await pause(1500);

// 3. Lab
await page.getByRole('tab', { name: /^Lab$/ }).click(); await pause(4000); step('lab');
await page.mouse.wheel(0, 600); await pause(3000);
await page.mouse.wheel(0, -600); await pause(1500);
await page.getByRole('tab', { name: /^Chat$/ }).click(); await pause(2500);

const vidPath = await page.video().path();
await context.close(); await browser.close();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
execSync(`ffmpeg -y -loglevel error -i "${vidPath}" -c:v libx264 -pix_fmt yuv420p -crf 22 -movflags +faststart "${OUT}"`);
console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes');
