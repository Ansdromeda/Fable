// const { serve } = require('<this dir>/serve.cjs');  const s = await serve('/abs/path/page.html');  s.url -> http://127.0.0.1:PORT/ ; await s.close()
// Serves the page wrapped in the publish skeleton on localhost (a secure context, so crypto.subtle and clipboard APIs behave as in production).
const http = require('http'); const fs = require('fs'); const { wrap } = require('./wrap.cjs');
function serve(srcPath) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(wrap(fs.readFileSync(srcPath, 'utf8')));
    });
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(r => server.close(r)) }));
  });
}
module.exports = { serve };
