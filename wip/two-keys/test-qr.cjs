// Verifies the inlined QR library round-trips a key card code: encode -> rasterise -> decode with jsQR (test-only dependency).
const fs = require('fs'); const jsQR = require('./vendor/node_modules/jsqr');
const src = fs.readFileSync(__dirname + '/vendor/qr.min.js', 'utf8');
const qrcode = new Function(src + '\nreturn qrcode;')();
const code = '4KQ7-9M2X-0ZTB-HJ3C-VV8R-1D5N-PQ6W-AE2S-7FGY-KM4T-3X9B-C0HJ-RW5Z-N8D1-V2Q6-EA7S-GY3F-TK9M';
for (const mode of ['Alphanumeric', 'Byte']) {
  const qr = qrcode(0, 'M'); qr.addData(code, mode); qr.make();
  const n = qr.getModuleCount(), quiet = 4, scale = 4, size = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) { const i = (((r + quiet) * scale + dy) * size + (c + quiet) * scale + dx) * 4; data[i] = data[i + 1] = data[i + 2] = 0; }
  const out = jsQR(data, size, size);
  console.log(mode, 'modules', n, 'decoded ok:', !!out && out.data === code);
  if (!out || out.data !== code) process.exit(1);
}
