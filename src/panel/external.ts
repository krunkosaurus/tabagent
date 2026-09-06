import { parsePairingCode, type ExternalAction, type ExternalApprovalMode, type ExternalState } from "../shared/external-tools";
import type { PanelRequest } from "../shared/protocol";
import { initChat, renderChat } from "./external-chat";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let current: ExternalState | null = null;
export function externalConnected(): boolean { return !!current?.connected; }

function duration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 0.1) return "<0.1s";
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.floor(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

function ago(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function renderClocks(): void {
  if (!current) return;
  const last = current.actions.at(-1);
  const count = `${current.actionCount} browser action${current.actionCount === 1 ? "" : "s"}`;
  el("external-metrics").textContent = last
    ? `${count} · ${last.finishedAt ? `Last activity ${ago(last.finishedAt)}` : `Current action ${duration(Date.now() - last.startedAt)}`}${current.actionCount > current.actions.length ? " · Showing latest 50" : ""}`
    : current.phase === "connecting" ? "Establishing connection…"
    : current.connected ? `Connected ${ago(current.connectedAt)} · No browser actions received` : "No browser actions received";
  for (const node of document.querySelectorAll<HTMLElement>(".external-action-time")) {
    const started = Number(node.dataset.startedAt);
    const finished = Number(node.dataset.finishedAt) || undefined;
    node.textContent = `${duration((finished ?? Date.now()) - started)}${finished ? ` · ${ago(finished)}` : " elapsed"}`;
  }
}

function actionRow(action: ExternalAction): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "external-action-row";
  row.dataset.actionId = action.id;
  row.dataset.status = action.status;
  row.dataset.tool = action.name;
  const heading = document.createElement("div");
  heading.className = "external-action-heading";
  const title = document.createElement("strong");
  title.textContent = action.summary;
  const badge = document.createElement("span");
  badge.className = "external-action-badge";
  const labels = { running: "Running", waiting: "Needs approval", done: "Done", error: "Failed", cancelled: "Interrupted" };
  badge.textContent = labels[action.status];
  heading.append(title, badge);
  row.append(heading);
  if (action.detail) {
    const detail = document.createElement("p");
    detail.className = "external-action-detail";
    detail.textContent = action.detail;
    row.append(detail);
  }
  if (action.error) {
    const error = document.createElement("p");
    error.className = "external-error";
    error.textContent = action.error;
    row.append(error);
  }
  const time = document.createElement("time");
  time.className = "external-action-time";
  time.dateTime = new Date(action.startedAt).toISOString();
  time.title = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "medium" }).format(action.startedAt) + " PT";
  time.dataset.startedAt = String(action.startedAt);
  if (action.finishedAt) time.dataset.finishedAt = String(action.finishedAt);
  row.append(time);
  return row;
}

function renderActivity(state: ExternalState | null, follow: boolean): void {
  const visible = state !== null;
  el("chat").classList.toggle("external-view", visible);
  el("external-activity").hidden = !visible;
  el("messages").hidden = visible;
  el("chat-composer").hidden = visible;
  if (!state) { el("external-actions").replaceChildren(); return; }
  const scroll = el("external-activity-scroll");
  const last = state.actions.at(-1);
  el("external-agent-name").textContent = state.agent;
  el("external-eyebrow").textContent = state.chat?.attached ? "Connected session" : "Browser activity";
  el("external-activity").dataset.phase = state.phase;
  el("external-activity").dataset.lastStatus = last?.status ?? "";
  el("external-activity").dataset.chatBusy = String(!!state.chat?.attached && !!state.chat.busy);
  const phase = state.phase === "connecting" ? "Connecting to your agent…"
    : state.phase === "waiting" ? "Waiting for your approval"
    : state.phase === "running" ? last?.summary ?? "Running browser action"
    : state.phase === "stopping" ? "Stopping browser access…"
    : state.phase === "disconnected" ? "Sharing ended"
    : state.chat?.attached ? state.chat.busy ? "Pi is working…" : "Ready for your next message"
    : last?.status === "error" ? `Last action failed · waiting for ${state.agent}`
    : `Waiting for ${state.agent}${last ? "’s next browser action" : " to send a browser action"}`;
  el("external-phase").textContent = phase;
  el("external-context").textContent = state.chat?.attached
    ? "Same Pi conversation and tools. You can continue here or in Pi."
    : state.connected
    ? `Browser actions on this tab appear here. Continue the conversation in ${state.agent}.`
    : state.status;
  el("external-waiting").hidden = state.actions.length > 0;
  el("external-waiting-help").textContent = state.connected
    ? `Give ${state.agent} a task in its chat. This view updates when it reads, clicks, types or navigates on this tab.`
    : "This connection ended before any browser actions were received.";
  el("external-back").hidden = state.connected;
  el("external-actions").replaceChildren(...state.actions.map(actionRow));
  renderClocks();
  if (follow) scroll.scrollTop = scroll.scrollHeight;
}

export function renderExternal(state: ExternalState | null): void {
  // Boot can deliver buffered events older than the restored connection snapshot.
  if (state && current && (state.connectedAt < current.connectedAt ||
      (state.connectionId === current.connectionId && state.revision < current.revision))) return;
  const scroll = el("external-activity-scroll");
  const follow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  const wasConnected = externalConnected();
  current = state;
  const connected = externalConnected();
  el("external-panel").hidden = connected;
  el("external-form").hidden = connected;
  el("external-stop").hidden = !connected;
  el("external-permissions").hidden = !connected;
  el("external-permissions").textContent = state?.approvalMode === "connection"
    ? "Allowed for this connection · actions and new sites in this tab"
    : "Ask before each action and before reading a new site.";
  const mode = el<HTMLSelectElement>("external-approval-mode");
  if (connected) mode.value = state!.approvalMode;
  else if (wasConnected) mode.value = "ask";
  el("external-status").textContent = state ? `${state.agent}: ${state.status}` : "Ask Codex or Hermes to connect to TabAgent, then paste its pairing code here.";
  el("external-summary").textContent = connected ? `Local agent · ${state!.agent}` : "Local agent";
  if (connected) el<HTMLDetailsElement>("external-panel").open = true;
  else if (wasConnected) el<HTMLDetailsElement>("external-panel").open = false;
  el<HTMLButtonElement>("send-btn").disabled = connected;
  el<HTMLTextAreaElement>("composer").disabled = connected;
  for (const id of ["mode-ask", "mode-auto", "autonomy-btn"]) el<HTMLButtonElement>(id).disabled = connected;
  if (connected) el("stop-btn").style.display = "inline-flex";
  else if (["idle", "done", "error", "paused"].includes(el("session-state").getAttribute("data-state") ?? "idle")) el("stop-btn").style.display = "none";
  const pending = state?.pending;
  el("external-approval").hidden = !pending;
  el("external-reason").textContent = pending?.reason ?? "";
  el("external-action").textContent = pending ? `${pending.origin}\n${pending.name}\n${JSON.stringify(pending.input, null, 2)}` : "";
  renderActivity(state, follow);
  renderChat(state);
}

export function initExternal(send: (request: PanelRequest) => Promise<unknown>): () => void {
  let updates: { port: chrome.runtime.Port; pending: Map<string, (error?: string) => void> } | undefined;
  initChat((request) => new Promise<void>((resolve, reject) => {
    if (request.kind !== "external_chat" || !updates) { reject(new Error("Chat connection ended. Check Pi before sending again.")); return; }
    const active = updates;
    const id = request.request.id;
    const timer = setTimeout(() => active.pending.get(id)?.("No confirmation from Pi. Check Pi before sending again; this message will not be retried."), 12_000);
    active.pending.set(id, (error) => {
      clearTimeout(timer);
      active.pending.delete(id);
      if (error) reject(new Error(error)); else resolve();
    });
    try { active.port.postMessage(request); } catch { active.pending.get(id)?.("Chat connection ended. Check Pi before sending again."); }
  }));
  function connectUpdates(): void {
    const port = chrome.runtime.connect({ name: "tabagent-external" });
    const pending = new Map<string, (error?: string) => void>();
    updates = { port, pending };
    port.onMessage.addListener((message) => {
      if ("external" in message) renderExternal(message.external);
      else if (message.replyTo) pending.get(message.replyTo)?.(message.error);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (updates?.port === port) updates = undefined;
      for (const finish of pending.values()) finish("Chat connection ended. Check Pi before sending again; this message will not be retried.");
      if (current) renderExternal({ ...current, revision: current.revision + 1, connected: false,
        phase: "disconnected", status: "Connection ended. Pair again to continue.", chat: undefined });
      // Reopen only the view's subscription. Never reconnect or replay Pi work.
      setTimeout(connectUpdates, 1000);
    });
  }
  setInterval(renderClocks, 1000);
  el("external-back").addEventListener("click", () => renderExternal(null));
  const error = (e: unknown) => {
    el("external-status").textContent = (e as Error).message;
    el("external-operation-error").textContent = (e as Error).message;
  };
  el("external-connect").addEventListener("click", () => {
    const input = el<HTMLInputElement>("external-code");
    const code = input.value.trim();
    const approvalMode = el<HTMLSelectElement>("external-approval-mode").value as ExternalApprovalMode;
    try { parsePairingCode(code); } catch (e) { error(e); return; }
    const button = el<HTMLButtonElement>("external-connect");
    button.disabled = true;
    // Chrome requires this call inside the click's user gesture.
    void chrome.permissions.request({ origins: ["http://127.0.0.1/*"] }).then(async (allowed) => {
      if (!allowed) throw new Error("Local connection permission was denied.");
      await send({ kind: "external_connect", code, approvalMode });
      input.value = ""; // pairing secret is never stored
    }).catch(error).finally(() => { button.disabled = false; });
  });
  el("external-stop").addEventListener("click", () => void send({ kind: "external_stop" }).catch(error));
  for (const [id, allow] of [["external-allow", true], ["external-deny", false]] as const) {
    el(id).addEventListener("click", () => {
      const pending = current?.pending;
      if (pending) void send({ kind: "external_decision", id: pending.id, allow }).catch(error);
    });
  }
  el("external-allow-connection").addEventListener("click", () => {
    const pending = current?.pending;
    if (pending) void send({ kind: "external_decision", id: pending.id, allow: true, scope: "connection" }).catch(error);
  });
  return connectUpdates;
}
