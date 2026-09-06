import { pairingCredentials, type PairingCredentials, type ShortPairingCode } from '../shared/pairing';

export async function redeemPairingCode(pairing: PairingCredentials | ShortPairingCode, signal: AbortSignal): Promise<PairingCredentials> {
  signal.throwIfAborted();
  if ('token' in pairing) return pairing;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${pairing.port}/tabagent/pair`);
    let settled = false;
    const finish = (error?: Error, credentials?: PairingCredentials) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      ws.close();
      if (error) reject(error); else resolve(credentials!);
    };
    const abort = () => finish(new Error('Pairing stopped. Ask your agent for a fresh code.'));
    const timer = setTimeout(() => finish(new Error('Pairing timed out. Ask your agent for a fresh code.')), 5000);
    signal.addEventListener('abort', abort, { once: true });
    ws.onopen = () => {
      if (signal.aborted) { abort(); return; }
      ws.send(JSON.stringify({ type: 'pair', code: pairing.code }));
    };
    ws.onerror = ws.onclose = () => finish(new Error('Code expired or unavailable. Ask your agent for a fresh code.'));
    ws.onmessage = (event) => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 1024) throw new Error('Invalid pairing response.');
        const message = JSON.parse(event.data);
        if (message?.type === 'pairing_error') throw new Error(message.reason === 'locked'
          ? 'Too many incorrect attempts. Ask your agent for a fresh code.'
          : 'Incorrect or expired code. Ask your agent for a fresh code.');
        finish(undefined, pairingCredentials(message));
      } catch (error) { finish(error as Error); }
    };
    if (signal.aborted) abort();
  });
}
