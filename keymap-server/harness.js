'use strict';
// Shared helper for tests: boots a throwaway server on a random port with its own data dir.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createServer, loadConfig } = require('./server');

// extra: config overrides for the test (for example a fake clock: { clock: () => now })
async function withServer(env, fn, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftks-'));
  const server = createServer({ ...loadConfig({ DATA_DIR: dir, ...env }), ...extra });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await fn({ dir, port, base: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Raw request so tests can set Host / Origin freely (fetch treats some of them as forbidden).
function raw(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

module.exports = { withServer, raw };
