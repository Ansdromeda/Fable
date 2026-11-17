#!/usr/bin/env node
// Usage: node embed-fonts.cjs "<google fonts css2 url>" [subsets=latin]   -> prints @font-face CSS with woff2 data URIs
// Example: node embed-fonts.cjs "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600&display=swap" latin > fonts.css
const { execFileSync } = require('child_process');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const [url, subsetsArg = 'latin'] = process.argv.slice(2);
if (!url) { console.error('usage: embed-fonts.cjs <css2-url> [latin,latin-ext]'); process.exit(1); }
const want = new Set(subsetsArg.split(','));
const curl = (u, bin) => execFileSync('curl', ['-sS', '-m', '40', '-A', UA, u], { maxBuffer: 64 * 1024 * 1024, encoding: bin ? 'buffer' : 'utf8' });
const css = curl(url);
const blocks = css.split(/\/\*\s*([\w-]+)\s*\*\//).slice(1); // [name, block, name, block...]
let out = '', total = 0;
for (let i = 0; i < blocks.length; i += 2) {
  const name = blocks[i], block = blocks[i + 1];
  if (!want.has(name)) continue;
  const m = block.match(/url\((https:[^)]+\.woff2)\)/);
  if (!m) continue;
  const buf = curl(m[1], true);
  total += buf.length;
  out += block.replace(m[0], `url(data:font/woff2;base64,${buf.toString('base64')})`).replace(/\n\s*\n/g, '\n').trim() + '\n';
}
if (!out) { console.error('no matching subsets found; available: ' + blocks.filter((_, i) => i % 2 === 0).join(',')); process.exit(2); }
process.stdout.write(out.replace(/font-display:\s*swap/g, 'font-display: swap'));
console.error(`embedded ${(total / 1024).toFixed(1)} KB of woff2 (${(total * 4 / 3 / 1024).toFixed(1)} KB as base64)`);
