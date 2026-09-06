// The first symbol locates a temporary loopback listener; four random symbols
// authenticate a single exchange. The browser connection keeps its 256-bit key.
export const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const PAIRING_PORT_BASE = 54200;
export const PAIRING_TTL_MS = 120_000;
export const PAIRING_MAX_FAILURES = 5;
export interface PairingCredentials { port: number; token: string }
export interface ShortPairingCode { port: number; code: string }

export function parsePairingCode(value: string): PairingCredentials | ShortPairingCode {
  const text = value.trim();
  const code = text.toUpperCase();
  if (code.length === 5 && [...code].every((c) => PAIRING_ALPHABET.includes(c))) {
    return { port: PAIRING_PORT_BASE + PAIRING_ALPHABET.indexOf(code[0]), code };
  }
  // Existing full codes remain usable, including when all short-code slots are busy.
  const match = /^tabagent:([1-9][0-9]{0,4}):([a-f0-9]{64})$/.exec(text);
  if (!match || Number(match[1]) > 65535) throw new Error("Enter the pairing code from your agent's tabagent_connect tool.");
  return { port: Number(match[1]), token: match[2] };
}

export function pairingCredentials(value: unknown): PairingCredentials {
  const result = value as PairingCredentials & { type: string };
  if (!result || typeof result !== "object" || Array.isArray(result) || result.type !== "paired" ||
      !Number.isInteger(result.port) || result.port < 1 || result.port > 65535 ||
      typeof result.token !== "string" || !/^[a-f0-9]{64}$/.test(result.token) ||
      Object.keys(result).some((key) => !["type", "port", "token"].includes(key))) throw new Error("Invalid pairing response.");
  return { port: result.port, token: result.token };
}
