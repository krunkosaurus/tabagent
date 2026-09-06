import { WebSocket } from 'ws';
import { parsePairingCode, pairingCredentials } from '../build/mcp-tools.mjs';

export const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
export async function exchangePairing(code, { request, origin = extensionOrigin } = {}) {
  const parsed = parsePairingCode(code);
  if ('token' in parsed) return { type: 'paired', ...parsed };
  const ws = new WebSocket(`ws://127.0.0.1:${parsed.port}/tabagent/pair`, { origin });
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Pairing timed out')), 5000);
      ws.once('error', reject);
      ws.once('close', () => reject(new Error('Pairing unavailable')));
      ws.once('open', () => ws.send(JSON.stringify(request ?? { type: 'pair', code: parsed.code })));
      ws.once('message', (raw) => { try { resolve(JSON.parse(raw)); } catch (error) { reject(error); } });
    });
  } finally { clearTimeout(timer); ws.terminate(); }
}

export async function redeemPairing(code) {
  const response = await exchangePairing(code);
  if (response.type === 'pairing_error') throw new Error(`Pairing ${response.reason}`);
  return pairingCredentials(response);
}
