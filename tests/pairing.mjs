import assert from 'node:assert/strict';
import { request, createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createPairing } from '../mcp/pairing.mjs';
import { createBridge } from '../mcp/bridge.mjs';
import { PAIRING_ALPHABET, PAIRING_PORT_BASE, PAIRING_TTL_MS, PAIRING_MAX_FAILURES, parsePairingCode, pairingCredentials } from '../build/mcp-tools.mjs';
import { extensionOrigin, exchangePairing, redeemPairing } from './pairing-client.mjs';

const leases = [];
const occupied = [];
const credentials = { port: 12345, token: randomBytes(32).toString('hex') };
const deadline = setTimeout(() => { throw new Error('Pairing tests timed out'); }, 30_000);
let bridge;
async function lease(options) {
  const result = await createPairing(credentials, options);
  assert(result, 'a temporary pairing slot is available');
  leases.push(result);
  return result;
}
async function rejected(port, headers = {}, path = '/tabagent/pair') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'c3NhbXBsaW5nLXJldmlldyE=', ...headers,
    } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.on('upgrade', (_res, socket) => { socket.destroy(); reject(new Error('Unexpected upgrade')); });
    req.end();
  });
}
const wrongRequest = (code) => ({ type: 'pair', code: code.slice(0, 4) + (code[4] === 'A' ? 'B' : 'A') });

try {
  const first = await lease();
  assert.equal(first.code.length, 5);
  assert([...first.code].every((c) => PAIRING_ALPHABET.includes(c)));
  const parsed = parsePairingCode(first.code.toLowerCase());
  assert.equal(parsed.code, first.code);
  assert.equal(parsed.port, PAIRING_PORT_BASE + PAIRING_ALPHABET.indexOf(first.code[0]));
  for (const code of ['ABCD', 'ABCDEF', 'A0B1C', 'A!BCD', '00000']) assert.throws(() => parsePairingCode(code));
  for (const headers of [{}, { Origin: 'null' }, { Origin: 'http://localhost:1234' }, { Origin: 'https://evil.example' }, { Origin: extensionOrigin, Host: 'evil.example' }]) {
    assert.equal(await rejected(parsed.port, headers), 403);
  }
  assert.equal(await rejected(parsed.port, { Origin: extensionOrigin }, '/tabagent/pair?code=anything'), 403);
  assert.equal((await fetch(`http://127.0.0.1:${parsed.port}/`)).status, 404);
  assert.deepEqual(await redeemPairing(first.code), credentials, 'only the valid code releases the full random credentials');
  await assert.rejects(redeemPairing(first.code), /unavailable|ECONNREFUSED|Pairing/);
  console.log('PASS: five-character codes, case normalization, exact Host/Origin/path gates, strong credential exchange and single use');

  const limited = await lease();
  for (let i = 0; i < PAIRING_MAX_FAILURES; i++) {
    const result = await exchangePairing(limited.code, { request: wrongRequest(limited.code) });
    assert.deepEqual(result, { type: 'pairing_error', reason: i === PAIRING_MAX_FAILURES - 1 ? 'locked' : 'invalid' });
  }
  await assert.rejects(redeemPairing(limited.code));
  const retry = await lease();
  await exchangePairing(retry.code, { request: wrongRequest(retry.code) });
  assert.deepEqual(await redeemPairing(retry.code), credentials, 'a typing mistake can be corrected');
  let time = Date.now();
  const expired = await lease({ now: () => time });
  assert.equal(expired.expiresAt, time + PAIRING_TTL_MS);
  time += PAIRING_TTL_MS;
  assert.deepEqual(await exchangePairing(expired.code), { type: 'pairing_error', reason: 'expired' });
  const cancelled = await lease();
  cancelled.close();
  await assert.rejects(redeemPairing(cancelled.code));
  console.log('PASS: the five-guess limit spans sockets; expiry and cancellation invalidate the code');

  bridge = await createBridge();
  const issue = async () => JSON.parse((await bridge.call('tabagent_connect')).content[0].text);
  const old = await issue();
  const current = await issue();
  assert.equal(current.expiresInSeconds, 120);
  assert.notEqual(old.pairingCode, current.pairingCode);
  await assert.rejects(redeemPairing(old.pairingCode));
  const active = await redeemPairing(current.pairingCode);
  assert.equal(active.token.length, 64);
  const next = await issue();
  assert.deepEqual(await redeemPairing(next.pairingCode), active, 'refreshing pairing does not rotate established connection credentials');
  const exit = await issue();
  bridge.close();
  await assert.rejects(redeemPairing(exit.pairingCode));
  console.log('PASS: requesting a new code replaces the unused code; agent shutdown revokes outstanding pairing');

  // The original full code is a safe fallback if local apps occupy every slot.
  for (let i = 0; i < PAIRING_ALPHABET.length; i++) {
    const server = createServer();
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PAIRING_PORT_BASE + i, '127.0.0.1', resolve); });
      occupied.push(server);
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  bridge = await createBridge();
  const fallback = await issue();
  assert.match(fallback.pairingCode, /^tabagent:[0-9]+:[a-f0-9]{64}$/);
  assert.equal(fallback.expiresInSeconds, undefined);
  assert.deepEqual(await redeemPairing(fallback.pairingCode), parsePairingCode(fallback.pairingCode));
  for (const value of [{ type: 'paired', ...credentials, port: 65536 }, { type: 'paired', ...credentials, token: 'weak' },
    { type: 'paired', ...credentials, url: 'https://evil.example' }, { type: 'paired', ...credentials, port: '12345' }]) {
    assert.throws(() => pairingCredentials(value));
  }
  console.log('PASS: busy local ports fall back to full codes; credential responses cannot redirect to arbitrary URLs or weaken keys');
} finally {
  clearTimeout(deadline);
  bridge?.close();
  for (const pairing of leases) pairing.close();
  await Promise.all(occupied.map((server) => new Promise((resolve) => server.close(resolve))));
}
