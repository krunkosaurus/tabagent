import type { ExternalState } from "../shared/external-tools";
import type { ChatRequest } from "../shared/external-chat";
import type { PanelRequest } from "../shared/protocol";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let state: ExternalState | null = null;
let view: "chat" | "activity" = "activity";
let pending = false;
let send: (request: PanelRequest) => Promise<unknown>;

export function renderChat(next: ExternalState | null): void {
  const changed = next?.connectionId !== state?.connectionId;
  if (state?.chat?.attached && !next?.chat?.attached) el<HTMLTextAreaElement>("external-chat-input").value = "";
  if (changed) {
    el<HTMLTextAreaElement>("external-chat-input").value = "";
    el("external-operation-error").textContent = "";
    pending = false;
  }
  if (next?.chat?.attached && (!state?.chat?.attached || changed)) view = "chat";
  state = next;
  const chat = state?.chat;
  const attached = !!chat?.attached && !!state?.connected;
  const enabled = !!state?.connected && !["connecting", "stopping"].includes(state.phase);
  el("external-chat-invite").hidden = !chat || attached || !enabled;
  el("external-views").hidden = !attached;
  el("external-chat-pane").hidden = !attached || view !== "chat";
  el("external-activity-scroll").hidden = attached && view === "chat";
  el("external-activity").classList.toggle("has-chat", attached);
  for (const name of ["chat", "activity"] as const) el(`external-view-${name}`).setAttribute("aria-pressed", String(view === name));
  el("external-chat-title").textContent = chat?.title ?? "";
  el("external-chat-status").textContent = chat?.busy ? "Pi is working…" : "Pi is ready";
  el("external-chat-notice").textContent = chat?.notice ?? "";
  el("external-chat-truncated").hidden = !chat?.truncated;
  el("external-chat-empty").hidden = !!chat?.messages.length;
  el<HTMLButtonElement>("external-chat-attach").disabled = pending || !enabled;
  el<HTMLButtonElement>("external-chat-detach").disabled = pending;
  el<HTMLButtonElement>("external-chat-abort").disabled = pending || !chat?.busy;
  el<HTMLButtonElement>("external-chat-send").disabled = pending || !attached || !enabled || !!chat?.busy;
  el<HTMLTextAreaElement>("external-chat-input").disabled = !attached || !enabled || pending;
  el<HTMLTextAreaElement>("external-chat-input").placeholder = chat?.busy ? "Draft your next message while Pi works…" : "Continue with Pi…";

  const scroll = el("external-chat-scroll");
  const follow = changed || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  const history = el("external-chat-messages");
  const ids = new Set(chat?.messages.map((m) => m.id));
  for (const node of Array.from(history.children)) if (!ids.has((node as HTMLElement).dataset.id!)) node.remove();
  for (const message of chat?.messages ?? []) {
    let row = Array.from(history.children).find((node) => (node as HTMLElement).dataset.id === message.id) as HTMLElement | undefined;
    if (!row) {
      row = document.createElement("li");
      row.dataset.id = message.id;
      row.className = `external-chat-message ${message.role}`;
      const label = document.createElement("strong");
      label.textContent = message.role === "user" ? "You" : "Pi";
      const content = document.createElement("div");
      row.append(label, content);
      history.append(row);
    }
    // Plain text never loads model-supplied URLs, images, HTML or scripts.
    const content = row.lastElementChild!;
    if (content.textContent !== message.text) content.textContent = message.text;
  }
  if (follow) scroll.scrollTop = scroll.scrollHeight;
}

async function request(action: ChatRequest["action"], text?: string): Promise<void> {
  if (!state?.chat || !state.connected || pending) return;
  const connectionId = state.connectionId;
  const sessionId = state.chat.sessionId;
  pending = true;
  el("external-operation-error").textContent = "";
  renderChat(state);
  try {
    await send({ kind: "external_chat", connectionId, request: { type: "chat_request", id: crypto.randomUUID(), sessionId, action, ...(text === undefined ? {} : { text }) } });
    if (action === "send" && state?.connectionId === connectionId) el<HTMLTextAreaElement>("external-chat-input").value = "";
  } catch (error) {
    if (state?.connectionId === connectionId) el("external-operation-error").textContent = (error as Error).message;
  } finally {
    if (state?.connectionId === connectionId) { pending = false; renderChat(state); }
  }
}

export function initChat(sendRequest: (request: PanelRequest) => Promise<unknown>): void {
  send = sendRequest;
  for (const action of ["attach", "detach", "abort"] as const) el(`external-chat-${action}`).addEventListener("click", () => void request(action));
  for (const name of ["chat", "activity"] as const) el(`external-view-${name}`).addEventListener("click", () => { view = name; renderChat(state); });
  el("external-chat-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const text = el<HTMLTextAreaElement>("external-chat-input").value.trim();
    if (text && !el<HTMLButtonElement>("external-chat-send").disabled) void request("send", text);
  });
  el("external-chat-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      el<HTMLFormElement>("external-chat-form").requestSubmit();
    }
  });
}
