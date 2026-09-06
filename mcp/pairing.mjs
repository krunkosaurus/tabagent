import { createServer } from 'node:http';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { PAIRING_ALPHABET, PAIRING_PORT_BASE, PAIRING_TTL_MS, PAIRING_MAX_FAILURES } from '../build/mcp-tools.mjs';

/** Temporary rendezvous only: no shared daemon, registry, files or public bind. */
export async function createPairing(credentials, { now = Date.now } = {}) {
  const http = createServer((_req, res) => { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); });
  http.headersTimeout = 5000;
  http.requestTimeout = 5000;
  const first = randomInt(PAIRING_ALPHABET.length);
  let slot;
  for (let offset = 0; offset < PAIRING_ALPHABET.length; offset++) {
    const candidate = (first + offset) % PAIRING_ALPHABET.length;
    try {
      await new Promise((resolve, reject) => {
        const failed = (error) => { http.removeListener('listening', ready); reject(error); };
        const ready = () => { http.removeListener('error', failed); resolve(); };
        http.once('error', failed);
        http.once('listening', ready);
        http.listen(PAIRING_PORT_BASE + candidate, '127.0.0.1');
      });
      slot = candidate;
      break;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  if (slot === undefined) return undefined; // Fall back to the existing full code.
  const port = PAIRING_PORT_BASE + slot;
  const code = PAIRING_ALPHABET[slot] + [...randomBytes(4)].map((b) => PAIRING_ALPHABET[b & 31]).join('');
  const expiresAt = now() + PAIRING_TTL_MS;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 512, perMessageDeflate: false });
  let closed = false;
  let failures = 0;
  const timer = setTimeout(() => close(), PAIRING_TTL_MS);
  timer.unref();
  function close(preserve) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    for (const ws of sockets.clients) if (ws !== preserve) ws.terminate();
    sockets.close();
    http.closeAllConnections();
    http.close();
  }
  http.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    if (closed || req.headers.host !== `127.0.0.1:${port}` || req.url !== '/tabagent/pair' ||
        !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin ?? '') || sockets.clients.size >= 8) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit('connection', ws));
  });
  sockets.on('connection', (ws) => {
    const deadline = setTimeout(() => ws.terminate(), 2000);
    deadline.unref();
    ws.on('error', () => ws.terminate());
    ws.on('close', () => clearTimeout(deadline));
    ws.once('message', (raw, binary) => {
      const end = (message, consume = false) => {
        if (consume) close(ws); // Consume atomically before releasing credentials.
        ws.send(JSON.stringify(message));
        ws.close(1000);
      };
      if (closed || now() >= expiresAt) { end({ type: 'pairing_error', reason: 'expired' }, true); return; }
      let valid = false;
      try {
        const request = JSON.parse(raw.toString());
        const supplied = typeof request?.code === 'string' ? request.code.toUpperCase() : '';
        valid = !binary && request.type === 'pair' && Object.keys(request).length === 2 &&
          /^[A-Z2-9]{5}$/.test(supplied) && timingSafeEqual(Buffer.from(supplied), Buffer.from(code));
      } catch { /* All invalid guesses share one budget, across sockets. */ }
      if (!valid) {
        const locked = ++failures >= PAIRING_MAX_FAILURES;
        end({ type: 'pairing_error', reason: locked ? 'locked' : 'invalid' }, locked);
        return;
      }
      end({ type: 'paired', port: credentials.port, token: credentials.token }, true);
    });
  });
  return { code, expiresAt, close: () => close() };
}
