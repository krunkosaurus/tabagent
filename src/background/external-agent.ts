/** External agents receive only browser tools on explicitly shared tabs.
 * Ownership, approvals and revocation live here, inside the extension, so an
 * MCP client cannot bypass them. Never reconnect or replay a cancelled action.
 */
import { createBrowserToolRegistry } from "../tools/browser-tools";
import { sendCommandOnce } from "../tools/cdp";
import { webURL } from "../core/security";
import { EXTERNAL_TOOLS, parsePairingCode, validateExternalTool, type ExternalAction, type ExternalApprovalMode, type ExternalApprovalScope, type ExternalState } from "../shared/external-tools";

interface Decision { allow: boolean; scope: ExternalApprovalScope }

interface Connection {
  state: ExternalState;
  ws: WebSocket;
  controller: AbortController;
  approvedOrigin?: string;
  closed: boolean;
  attached: boolean;
  heartbeat?: ReturnType<typeof setInterval>;
  setup?: Promise<void>;
  running?: Promise<void>;
  cleanup?: Promise<void>;
  decide?: (decision: Decision) => void;
  seen: Set<string>;
}
const registry = createBrowserToolRegistry();
const connections = new Map<number, Connection>();
const MAX_MESSAGE = 100_000;

function publish(s: Connection): void {
  s.state.revision++;
  void chrome.runtime.sendMessage({ kind: "external_state", tabId: s.state.tabId, external: s.state }).catch(() => {});
}

function actionDetails(name: string, input: Record<string, unknown>): Pick<ExternalAction, "summary" | "detail"> {
  const ref = typeof input.ref === "string" ? `Element ${input.ref}` : "This tab";
  switch (name) {
    case "snapshot": return { summary: "Read page", detail: "Inspect the page and its controls" };
    case "screenshot": return { summary: "Take screenshot", detail: input.clip ? "Capture a region of this tab" : "Capture this tab" };
    case "extractText": return { summary: "Read page text", detail: ref };
    case "click": return { summary: "Click element", detail: ref };
    case "hover": return { summary: "Hover over element", detail: ref };
    case "scroll_to": return { summary: "Scroll to element", detail: ref };
    case "scroll": return { summary: "Scroll page", detail: `${input.direction ?? "down"}${input.amount == null ? "" : ` · ${input.amount} pixels`}` };
    case "type": return { summary: input.submit ? "Type and submit" : "Type text", detail: `${ref} · ${(input.text as string).length} characters${input.clearFirst ? " · replace existing text" : ""}` };
    case "set_text": return { summary: "Replace page text", detail: `${ref} · ${(input.text as string).length} characters` };
    case "press_key": return { summary: "Press key", detail: "Send a keyboard action to this tab" };
    case "navigate": {
      const url = new URL(input.url as string);
      return { summary: "Navigate to page", detail: `${url.origin}${url.pathname}`.slice(0, 200) };
    }
    default: return { summary: "Browser action" };
  }
}

function alive(s: Connection): void {
  s.controller.signal.throwIfAborted();
  if (connections.get(s.state.tabId) !== s || s.closed) throw new Error("Tab access has been revoked");
}

function revoke(s: Connection, reason: string): Promise<void> {
  // A delayed close/error from an old socket cannot revoke a new tab owner.
  return connections.get(s.state.tabId) === s ? externalAgent.disconnect(s.state.tabId, reason) : Promise.resolve();
}

async function raw<T = unknown>(s: Connection, method: string, params?: unknown): Promise<T> {
  alive(s);
  // Strict CDP: a user stopping Chrome's debugger must NEVER auto-reattach.
  let result: T;
  try {
    result = await sendCommandOnce<T>(s.state.tabId, method, params);
  } catch (e) {
    if (/not attached|detached while|target.*closed|no tab/i.test((e as Error).message)) {
      void revoke(s, "Debugger disconnected — tab access revoked");
    }
    throw e;
  }
  alive(s);
  return result;
}

async function page(s: Connection): Promise<{ url: string; origin: string; frameId: string }> {
  const tree = await raw<{ frameTree: { frame: { id: string; url: string } } }>(s, "Page.getFrameTree");
  const url = webURL(tree.frameTree.frame.url);
  return { url: url.href, origin: url.origin, frameId: tree.frameTree.frame.id };
}

async function checkOrigin(s: Connection, origin: string): Promise<void> {
  if ((await page(s)).origin !== origin) throw new Error("The page changed sites during this action. Inspect it with a fresh tool call before continuing.");
}

async function approve(s: Connection, name: string, input: Record<string, unknown>, origin: string, reason: string): Promise<void> {
  alive(s);
  const decision = await new Promise<Decision>((resolve) => {
    s.decide = resolve;
    s.state.pending = { id: crypto.randomUUID(), name, input, origin, reason };
    s.state.status = "Waiting for your approval";
    s.state.phase = "waiting";
    const action = s.state.actions.at(-1);
    if (action) action.status = "waiting";
    publish(s);
  });
  s.decide = undefined;
  s.state.pending = undefined;
  alive(s);
  if (!decision.allow) throw new Error("Denied by user");
  await checkOrigin(s, origin);
  // A grant belongs to this live connection, never a stored site preference.
  // Apply it only after the pending action's origin and ownership still match.
  if (decision.scope === "connection") s.state.approvalMode = "connection";
}

async function invoke(s: Connection, message: { id: string; name: string; input: unknown }): Promise<void> {
  let content = "";
  let isError = false;
  const action: ExternalAction = {
    id: message.id, name: message.name, summary: "Browser action",
    status: "running", startedAt: Date.now(),
  };
  s.state.actionCount++;
  s.state.actions.push(action);
  s.state.actions = s.state.actions.slice(-50);
  try {
    const input = validateExternalTool(message.name, message.input);
    Object.assign(action, actionDetails(message.name, input));
    s.state.phase = "running";
    s.state.status = `Running ${message.name}`;
    publish(s);
    const tool = registry.get(message.name)!;
    const origin = (await page(s)).origin;
    if (origin !== s.approvedOrigin) {
      if (s.state.approvalMode !== "connection") {
        await approve(s, "access_page", { origin }, origin,
          "Share this site's page content with the connected agent and its configured model?");
      }
      s.approvedOrigin = origin;
    }
    // External access starts with explicit user sharing. Standalone Auto mode
    // and saved provider grants never silently authorize an external agent.
    if (s.state.approvalMode !== "connection" && !EXTERNAL_TOOLS.find((t) => t.name === message.name)!.readonly) {
      await approve(s, message.name, input, origin, "Allow this action on the shared tab?");
    }
    s.state.status = `Running ${message.name}`;
    s.state.phase = "running";
    action.status = "running";
    publish(s);
    const result = await tool.run({ id: message.id, name: message.name, input }, {
      tabId: s.state.tabId,
      cdp: async <T = unknown>(method: string, params?: unknown): Promise<T> => {
        await checkOrigin(s, origin);
        if (method === "Runtime.evaluate") {
          const current = await page(s);
          const world = await raw<{ executionContextId: number }>(s, "Page.createIsolatedWorld", {
            frameId: current.frameId, worldName: "tabagent-tools", grantUniveralAccess: false,
          });
          await checkOrigin(s, origin);
          return raw<T>(s, method, { ...(params as object), contextId: world.executionContextId });
        }
        return raw<T>(s, method, params);
      },
    });
    alive(s);
    // Never return data collected while the tab was redirected to another site.
    // navigate returns only the requested URL; Ask mode gates the next site's read.
    if (message.name !== "navigate") await checkOrigin(s, origin);
    content = result.content;
    isError = !!result.isError;
    if (content.length > 1_900_000) {
      content = "Result too large. Use a screenshot clip or reduce the extracted text.";
      isError = true;
    }
  } catch (e) {
    content = (e as Error).message;
    isError = true;
  }
  if (s.closed) return;
  s.state.pending = undefined;
  s.decide = undefined;
  s.state.status = "Connected — give instructions in your agent";
  s.state.phase = "ready";
  action.status = isError ? "error" : "done";
  action.finishedAt = Date.now();
  if (isError) action.error = content.slice(0, 300);
  publish(s);
  if (s.ws.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ type: "result", id: message.id, content, isError }));
}

export const externalAgent = {
  owns(tabId: number): boolean { return connections.has(tabId); },
  state(tabId: number): ExternalState | null { return connections.get(tabId)?.state ?? null; },

  async connect(tabId: number, code: string, approvalMode: ExternalApprovalMode = "ask"): Promise<void> {
    if (approvalMode !== "ask" && approvalMode !== "connection") throw new Error("Invalid approval setting");
    const { port, token } = parsePairingCode(code);
    if (connections.has(tabId)) throw new Error("Stop sharing this tab before pairing another agent.");
    if (!await chrome.permissions.contains({ origins: ["http://127.0.0.1/*"] })) throw new Error("Allow the local connection in TabAgent first.");
    // The background router serializes this with standalone run creation.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/tabagent`);
    const s: Connection = {
      state: {
        connectionId: crypto.randomUUID(), revision: 0, connectedAt: Date.now(),
        tabId, connected: true, phase: "connecting", approvalMode,
        agent: "Local agent", status: "Connecting…", actionCount: 0, actions: [],
      },
      ws, controller: new AbortController(), closed: false, attached: false, seen: new Set(),
    };
    connections.set(tabId, s);
    publish(s);
    let lastPong = Date.now();
    const connectionTimer = setTimeout(() => void revoke(s, "Connection timed out. Ask your agent for a fresh pairing code."), 15_000);
    ws.onopen = () => { if (!s.closed) ws.send(JSON.stringify({ type: "auth", token })); };
    ws.onerror = () => void revoke(s, "Could not connect. Keep your agent session open and use its latest pairing code.");
    ws.onclose = () => { clearTimeout(connectionTimer); void revoke(s, "Agent disconnected — tab access revoked"); };
    ws.onmessage = (event) => {
      if (s.closed) return;
      try {
        if (typeof event.data !== "string" || event.data.length > MAX_MESSAGE) throw new Error("Invalid message size");
        const msg = JSON.parse(event.data);
        if (msg.type === "ready" && !s.setup) {
          if (typeof msg.agent !== "string" || msg.agent.length > 80) throw new Error("Invalid agent name");
          s.state.agent = msg.agent;
          s.setup = (async () => {
            await chrome.debugger.attach({ tabId }, "1.3");
            s.attached = true;
            alive(s);
            await raw(s, "Page.enable");
            await raw(s, "Runtime.enable");
            await raw(s, "DOM.enable");
            const current = await page(s);
            const tab = await chrome.tabs.get(tabId);
            await checkOrigin(s, current.origin);
            s.approvedOrigin = current.origin;
            ws.send(JSON.stringify({ type: "share", tabId, url: current.url, title: (tab.title ?? "Shared tab").slice(0, 300) }));
          })();
          void s.setup.catch((e) => revoke(s, `Could not share tab: ${(e as Error).message}`));
        } else if (msg.type === "shared" && s.setup && !s.heartbeat) {
          clearTimeout(connectionTimer);
          s.state.status = "Connected — give instructions in your agent";
          s.state.phase = "ready";
          publish(s);
          s.heartbeat = setInterval(() => {
            if (Date.now() - lastPong > 45_000) { void revoke(s, "Connection lost — tab access revoked"); return; }
            if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}');
            // getTargets().attached also reports other CDP clients, so probe
            // OUR attachment with a strict read that cannot reattach.
            void raw(s, "Page.getFrameTree").catch(() => void revoke(s, "Debugger unavailable — tab access revoked"));
          }, 15_000);
        } else if (msg.type === "pong") {
          lastPong = Date.now();
        } else if (msg.type === "invoke" && s.heartbeat) {
          if (s.running || typeof msg.id !== "string" || !/^[a-f0-9-]{36}$/.test(msg.id) || s.seen.has(msg.id) ||
              typeof msg.name !== "string" || msg.name.length > 64 || s.seen.size >= 5000) throw new Error("Invalid, repeated or concurrent action");
          s.seen.add(msg.id);
          s.running = invoke(s, msg).finally(() => { s.running = undefined; });
        } else throw new Error("Unexpected message");
      } catch {
        void revoke(s, "Invalid bridge message — tab access revoked");
      }
    };
  },

  decide(tabId: number, id: string, allow: boolean, scope: ExternalApprovalScope = "action"): void {
    if ((scope !== "action" && scope !== "connection") || (scope === "connection" && allow !== true)) throw new Error("Invalid approval scope");
    const s = connections.get(tabId);
    if (!s || s.closed || s.state.pending?.id !== id || typeof allow !== "boolean") throw new Error("Approval has expired or belongs to another tab.");
    const decide = s.decide;
    s.decide = undefined;
    s.state.pending = undefined;
    decide?.({ allow, scope });
  },

  async disconnect(tabId: number, reason = "Stopped sharing — tab access revoked"): Promise<void> {
    const s = connections.get(tabId);
    if (!s) return;
    if (s.cleanup) return s.cleanup;
    // Abort synchronously; already-dispatched browser input cannot be undone.
    s.closed = true;
    s.controller.abort(new Error("Tab access revoked"));
    s.decide?.({ allow: false, scope: "action" });
    s.decide = undefined;
    s.state.pending = undefined;
    s.state.status = "Stopping…";
    s.state.phase = "stopping";
    const action = s.state.actions.at(-1);
    if (action && !action.finishedAt) {
      action.status = "cancelled";
      action.finishedAt = Date.now();
      action.error = "Connection ended. An action already sent to the page may have taken effect.";
    }
    clearInterval(s.heartbeat);
    s.ws.close();
    publish(s);
    s.cleanup = (async () => {
      await s.setup?.catch(() => {});
      if (s.attached) await chrome.debugger.detach({ tabId }).catch(() => {});
      await s.running?.catch(() => {});
      connections.delete(tabId);
      s.state.connected = false;
      s.state.status = reason;
      s.state.phase = "disconnected";
      publish(s);
    })();
    return s.cleanup;
  },
};

chrome.debugger?.onDetach?.addListener((source) => {
  if (source.tabId != null) void externalAgent.disconnect(source.tabId, "Chrome debugger stopped — tab access revoked");
});
