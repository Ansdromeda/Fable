#!/usr/bin/env node
// Wraps an artifact-format page (no doctype/html/head/body) in the same skeleton the Artifact tool adds at publish time.
// Usage: node wrap.cjs <src.html> <out.html>
const fs = require('fs');
const RESET = ':root{color-scheme:light;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}img{max-width:100%}[hidden]{display:none!important}';
function wrap(src) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>' + RESET + '</style></head><body>' + src + '</body></html>';
}
module.exports = { wrap, RESET };
if (require.main === module) {
  const [src, out] = process.argv.slice(2);
  fs.writeFileSync(out, wrap(fs.readFileSync(src, 'utf8')));
  console.log('wrote', out);
}
