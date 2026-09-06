/** Small, versioned chat contract over the existing authenticated tab socket. */
export const CHAT_TEXT_LIMIT = 8_000;
export const CHAT_HISTORY_LIMIT = 12_000;
export const CHAT_THINKING_LIMIT = 32_000;
export interface ChatMessage { id: string; role: "user" | "assistant"; text: string }
export interface ChatThinking { id: string; text: string; active: boolean; truncated: boolean }
export interface ExternalChatState {
  sessionId: string;
  revision: number;
  attached: boolean;
  busy: boolean;
  title: string;
  messages: ChatMessage[];
  truncated: boolean;
  notice: string;
  thinking?: ChatThinking;
}
export interface ChatRequest {
  type: "chat_request";
  id: string;
  sessionId: string;
  action: "attach" | "detach" | "send" | "abort";
  text?: string;
}
export function chatId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
}
export function validateChatRequest(value: unknown): ChatRequest {
  const r = value as ChatRequest;
  if (!r || typeof r !== "object" || Array.isArray(r) || r.type !== "chat_request" ||
      !chatId(r.id) || !chatId(r.sessionId) || !["attach", "detach", "send", "abort"].includes(r.action) ||
      Object.keys(r).some((k) => !["type", "id", "sessionId", "action", "text"].includes(k))) throw new Error("Invalid chat request");
  if (r.action === "send" ? typeof r.text !== "string" || !r.text.trim() || r.text.length > CHAT_TEXT_LIMIT : r.text !== undefined) {
    throw new Error("Chat messages must contain 1–8,000 characters");
  }
  return r;
}
export function emptyChat(sessionId: string, revision = 0): ExternalChatState {
  return { sessionId, revision, attached: false, busy: false, title: "", messages: [], truncated: false, notice: "" };
}
export function validateChatState(value: unknown): ExternalChatState {
  const s = value as ExternalChatState;
  if (!s || typeof s !== "object" || !chatId(s.sessionId) || !Number.isSafeInteger(s.revision) || s.revision < 0 ||
      typeof s.attached !== "boolean" || typeof s.busy !== "boolean" || typeof s.truncated !== "boolean" ||
      typeof s.title !== "string" || s.title.length > 80 || typeof s.notice !== "string" || s.notice.length > 300 ||
      !Array.isArray(s.messages) || s.messages.length > 40 ||
      Object.keys(s).some((k) => !["sessionId", "revision", "attached", "busy", "title", "messages", "truncated", "notice", "thinking"].includes(k))) throw new Error("Invalid chat state");
  const thinking = s.thinking;
  if (thinking !== undefined && (!thinking || typeof thinking !== "object" || Array.isArray(thinking) ||
      !chatId(thinking.id) || typeof thinking.text !== "string" || thinking.text.length > CHAT_THINKING_LIMIT ||
      typeof thinking.active !== "boolean" || typeof thinking.truncated !== "boolean" ||
      !s.attached || (thinking.active && !s.busy) ||
      Object.keys(thinking).some((k) => !["id", "text", "active", "truncated"].includes(k)))) throw new Error("Invalid chat thinking");
  let size = 0;
  const ids = new Set<string>();
  for (const m of s.messages) {
    if (!m || !chatId(m.id) || ids.has(m.id) || !["user", "assistant"].includes(m.role) ||
        typeof m.text !== "string" || m.text.length > CHAT_TEXT_LIMIT ||
        Object.keys(m).some((k) => !["id", "role", "text"].includes(k))) throw new Error("Invalid chat message");
    ids.add(m.id);
    size += m.text.length;
  }
  if (size > CHAT_HISTORY_LIMIT || (!s.attached && (s.messages.length || s.title || s.notice || s.busy))) throw new Error("Invalid chat history");
  return s;
}
