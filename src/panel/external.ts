import { parsePairingCode, type ExternalState } from "../shared/external-tools";
import type { PanelRequest } from "../shared/protocol";

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let current: ExternalState | null = null;
export function externalConnected(): boolean { return !!current?.connected; }

export function renderExternal(state: ExternalState | null): void {
  current = state;
  const connected = externalConnected();
  el("external-form").hidden = connected;
  el("external-stop").hidden = !connected;
  el("external-status").textContent = state ? `${state.agent}: ${state.status}` : "Ask Codex or Hermes to connect to TabAgent, then paste its pairing code here.";
  el("external-summary").textContent = connected ? `Local agent · ${state!.agent}` : "Local agent";
  if (connected) el<HTMLDetailsElement>("external-panel").open = true;
  el<HTMLButtonElement>("send-btn").disabled = connected;
  el<HTMLTextAreaElement>("composer").disabled = connected;
  for (const id of ["mode-ask", "mode-auto", "autonomy-btn"]) el<HTMLButtonElement>(id).disabled = connected;
  if (connected) el("stop-btn").style.display = "inline-flex";
  else if (["idle", "done", "error", "paused"].includes(el("session-state").getAttribute("data-state") ?? "idle")) el("stop-btn").style.display = "none";
  const pending = state?.pending;
  el("external-approval").hidden = !pending;
  el("external-reason").textContent = pending?.reason ?? "";
  el("external-action").textContent = pending ? `${pending.origin}\n${pending.name}\n${JSON.stringify(pending.input, null, 2)}` : "";
  const log = el("external-actions");
  log.replaceChildren();
  for (const action of state?.actions ?? []) {
    const row = document.createElement("li");
    row.textContent = `${action.name}: ${action.summary}`;
    if (action.error) row.className = "external-error";
    log.append(row);
  }
}

export function initExternal(send: (request: PanelRequest) => Promise<unknown>): void {
  const error = (e: unknown) => { el("external-status").textContent = (e as Error).message; };
  el("external-connect").addEventListener("click", () => {
    const input = el<HTMLInputElement>("external-code");
    const code = input.value.trim();
    try { parsePairingCode(code); } catch (e) { error(e); return; }
    const button = el<HTMLButtonElement>("external-connect");
    button.disabled = true;
    // Chrome requires this call inside the click's user gesture.
    void chrome.permissions.request({ origins: ["http://127.0.0.1/*"] }).then(async (allowed) => {
      if (!allowed) throw new Error("Local connection permission was denied.");
      await send({ kind: "external_connect", code });
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
}
