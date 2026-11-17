#!/usr/bin/env node
// One visual pass: node shot.cjs <src.html> <outdir> [--viewer]
// Screenshots desktop + phone in light + dark (full page), and reports console errors, failed/external requests and horizontal overflow.
// --viewer emulates the artifact viewer (window.claude.use resolves null) so you can see the in-viewer fallbacks.
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs'); const { serve } = require('./serve.cjs');
(async () => {
  const [src, outdir, flag] = process.argv.slice(2);
  fs.mkdirSync(outdir, { recursive: true });
  const s = await serve(path.resolve(src));
  const browser = await chromium.launch();
  const report = [];
  for (const [name, vp, scheme] of [['desktop-light', { width: 1280, height: 900 }, 'light'], ['desktop-dark', { width: 1280, height: 900 }, 'dark'], ['phone-light', { width: 390, height: 844 }, 'light'], ['phone-dark', { width: 390, height: 844 }, 'dark']]) {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    if (flag === '--viewer') await page.addInitScript(() => { window.claude = { use: async () => null }; });
    const errs = [], ext = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push('pageerror: ' + e.message));
    page.on('request', r => { const u = r.url(); if (!u.startsWith(s.url) && !u.startsWith('data:') && !u.startsWith('blob:')) ext.push(u); });
    await page.goto(s.url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, h: document.documentElement.scrollHeight, title: document.title }));
    const file = path.join(outdir, name + '.png');
    await page.screenshot({ path: file, fullPage: true });
    report.push(`${name}: title="${m.title}" height=${m.h} overflowX=${m.sw > m.iw ? 'YES (' + m.sw + ' > ' + m.iw + ')' : 'no'} consoleErrors=${errs.length ? JSON.stringify(errs) : 'none'} externalRequests=${ext.length ? JSON.stringify([...new Set(ext)]) : 'none'} -> ${file}`);
    await ctx.close();
  }
  await browser.close(); await s.close();
  console.log(report.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
