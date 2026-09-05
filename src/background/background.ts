import { isExtensionPage, isSelectionSender, providerURL } from "../core/security";
import { openTabPanel, panelTabId } from "../shared/panel-target";
/**
 * Service worker entry.
 *
 * Wires:
 *   - chrome.runtime.onMessage: the panel <-> SW request/response router.
 *   - chrome.alarms heartbeat: re-arms the loop if the SW was killed during a run.
 *   - chrome.runtime.onStartup / onInstalled: recover checkpoints within the current browser session.
 *   - chrome.tabs.onRemoved / chrome.debugger.onDetach: clean teardown.
 *   - chrome.action click / commands: open the side panel.
 *
 * v1 streaming note: the OpenAI-compat adapter runs its fetch + SSE parsing in
 * the SW directly. This is safe during a run because the attached debugger
 * keeps the SW alive (Chrome 118+). The offscreen document is wired but
 * dormant -- it's the v2 home for streaming when we want to survive SW death
 * mid-stream without relying on debugger keepalive.
 */

import {
  initStorageAccess,
  listActiveSessions,
  loadSession,
  loadSettings,
  readProviderCredentials,
  saveSettings,
  saveSession,
  saveProviderModels,
  unlockCredentials,
  writeEncryptedCredentials,
  loadMemory,
  upsertFact,
  deleteFact,
  clearMemory,
  loadTabState,
  saveTabState,
  deleteTabState,
  sessionsForTab,
} from "../core/storage";
import { BUILTIN_PROVIDERS, getProviderDefinition } from "../providers/catalog";
import { buildContext, getAdapter } from "../providers/registry";
import type { Session } from "../core/types";
import {
  cancel,
  enqueueMessage,
  isBusy,
  newSession,
  onLoopEvent,
  pause,
  removeSession,
  resumeIfInterrupted,
  run,
  resolveInterrupted,
  type LoopEvent,
} from "./loop";
import { permissions } from "./permissions";
import { planService } from "./plan-service";
import { cdpManager } from "./cdp-manager";
import { dialogHandler } from "./dialog-handler";
import { onLoopEventForNotify } from "./notify";
import type { PanelEvent, PanelRequest, SelectionAction } from "../shared/protocol";

const HEARTBEAT_ALARM = "agent-heartbeat";
const STALE_MS = 120_000;

// ---------------------------------------------------------------------------
// Selection-triggered suggestion: pending prompts awaiting panel boot.
//
// Content selections only fill a draft in the panel. Only pressing Send in
// the trusted panel starts a run.
// ---------------------------------------------------------------------------

const pendingPrompts = new Map<number, { prompt: string; at: number }>();

/** Build the prefixed prompt from a selection action + the selected text. */
function buildSelectionPrompt(action: SelectionAction, text: string): string {
  const sel = text.slice(0, 4000);
  switch (action) {
    case "explain":
      return `Explain this clearly:\n\n"""${sel}"""`;
    case "summarize":
      return `Summarize this concisely:\n\n"""${sel}"""`;
    case "translate":
      return `Translate this to English (if it's already English, translate to Spanish):\n\n"""${sel}"""`;
    case "rewrite":
      return `Rewrite this to be clearer and more concise:\n\n"""${sel}"""`;
    case "ask":
      // The content script already folded the user's question into `text`.
      return sel;
    default:
      return sel;
  }
}

/**
 * Detect a "forget everything I told you" / "wipe your memory about me" intent.
 * Matched in English and Arabic, case-insensitively. Intentionally narrow so it
 * does not fire on a normal question that merely contains the word "forget".
 * The wipe is handled in the SW (not by the model) so it is deterministic and
 * never followed by page actions.
 */
function isForgetEverythingIntent(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length > 120) return false; // these commands are always short
  const patterns = [
    /\bforget\s+(everything|all|everything about me|what you know about me)\b/,
    /\bclear\s+(your|the|all)\s+(memory|memories)\b/,
    /\bwipe\s+(your|the|all)\s+(memory|memories)\b/,
    /\breset\s+(your|the)\s+(memory|memories)\b/,
    /\berase\s+(your|the|all)\s+(memory|memories)\b/,
    /\bforget\s+(me|who i am|everything i told you)\b/,
    // Arabic: "انسَ / انسى / امسح كل اللي/ما تعرفه عني / ذاكرتك / كل حاجة"
    /\u0627\u0646\u0633[\u0649\u064e\u0650]/, // انس / انسى / انسَ
  ];
  if (patterns.slice(0, -1).some((re) => re.test(t))) return true;
  // Arabic compound intent: verb + (everything | about me | your memory)
  const arVerb = /\u0627\u0646\u0633[\u0649\u064e\u0650]|\u0627\u0645\u0633\u062d|\u0646\u0633\u064a\u062a/;
  const arScope = /\u0643\u0644(\u0647|\u0627|\u064a\u0646)|\u0639\u0646\u064a|\u0630\u0627\u0643\u0631\u062a\u0643|\u0627\u0644\u0644\u064a \u062a\u0639\u0631\u0641\u0647\u0627/;
  return arVerb.test(t) && arScope.test(t);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

// A promise the message router awaits before serving credential-dependent
// requests. This closes the boot race: the SW can start handling messages the
// instant module evaluation finishes, which may be BEFORE bootstrap()'s
// unlockCredentials() has populated the working copy. Without this gate, a
// returning user's first list_models/connect could read empty creds.
async function bootstrap(): Promise<void> {
  // Disable the old global panel, including options left by earlier builds.
  await chrome.sidePanel.setOptions({ enabled: false });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  await initStorageAccess();
  await ensureAlarm();
  await ensureOffscreen();
  // Auto-unlock: decrypt any stored credentials into the session working copy
  // using the stored master key. No user interaction required.
  await unlockCredentials().catch((e) => console.error("[bootstrap] unlock failed:", e));
}

const ready = bootstrap();
void ready.catch((e) => console.error("Storage initialization failed", e));

async function ensureAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(HEARTBEAT_ALARM);
  if (!existing) {
    await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 }); // 30s
  }
}

async function ensureOffscreen(): Promise<void> {
  // The offscreen doc is created eagerly at boot. Its primary job today is
  // playing the notification chime (AUDIO_PLAYBACK); the WORKERS reason keeps
  // it valid for the v2 streaming path too.
  if (await hasOffscreen()) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK", "WORKERS"] as chrome.offscreen.Reason[],
      justification: "Plays notification sounds and hosts long-lived streaming fetches to AI providers.",
    });
  } catch {
    /* already exists */
  }
}

async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
  });
  return contexts.length > 0;
}

// ---------------------------------------------------------------------------
// Rehydrate on startup / install
// ---------------------------------------------------------------------------

chrome.runtime.onStartup.addListener(() => void rehydrate());
chrome.runtime.onInstalled.addListener(() => void rehydrate());

async function rehydrate(): Promise<void> {
  await ready;
  // Only resume within the current browser session. No disk transcript mirror.
  const mirror = await listActiveSessions();
  for (const s of mirror) {
    if (s.debuggerAttached) s.debuggerAttached = false;
    if (["idle", "done", "paused"].includes(s.state)) continue;
    // Treat as interrupted; the loop's resumeIfInterrupted will route safely.
    s.state = "resuming";
    // Re-save to session area so the loop can see it.
    const { saveSession } = await import("../core/storage");
    await saveSession(s);
    try {
      await resumeIfInterrupted(s);
    } catch (e) {
      console.error(`[rehydrate] resume failed for ${s.sessionId}:`, e);
    }
  }
}

// ---------------------------------------------------------------------------
// Heartbeat: catch SW death during a paused/resumable run.
// ---------------------------------------------------------------------------

// All top-level chrome.* event wiring is guarded. A missing API (e.g. a
// permission forgotten in the manifest) MUST NOT throw synchronously at module
// evaluation -- that fails SW registration entirely (status code 15) and masks
// the real cause. Each guard logs once so the cause is still discoverable.
chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) return;
  void heartbeat();
});

async function heartbeat(): Promise<void> {
  await ready;
  const sessions = await listActiveSessions();
  const now = Date.now();
  for (const s of sessions) {
    if (["idle", "done", "paused", "awaiting_permission"].includes(s.state)) continue;
    if (now - s.updatedAt > STALE_MS) {
      // Likely a SW death the debugger-keepalive didn't cover (e.g. paused then idle).
      console.warn(`[heartbeat] stale session ${s.sessionId} (${s.state}); resuming`);
      try {
        await resumeIfInterrupted(s);
      } catch (e) {
        console.error(`[heartbeat] resume failed:`, e);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Message router: panel -> SW
// ---------------------------------------------------------------------------

const PANEL_REQUEST_KINDS = new Set([
  "list_providers", "list_models", "seed_models", "validate_token", "connect_provider", "get_provider_connection",
  "select_model", "set_draft", "set_autonomy", "set_notifications", "set_theme", "get_memory",
  "set_memory", "delete_memory", "export_session", "send_message", "stop", "pause",
  "resume", "permission_decision", "plan_decision", "resume_interrupted", "get_state",
  "open_side_panel_for_tab", "new_session", "selection_action", "pop_pending_prompt",
]);

// Starting a turn is serialized per tab, so rapid sends cannot create two runs.
const tabRequests = new Map<number, Promise<unknown>>();
function routePanelRequest(req: PanelRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = panelTabId(sender.url);
  if (tabId === undefined || !["send_message", "new_session"].includes(req.kind)) {
    return handlePanelRequest(req, sender);
  }
  const request = (tabRequests.get(tabId) ?? Promise.resolve()).catch(() => {})
    .then(() => handlePanelRequest(req, sender));
  tabRequests.set(tabId, request);
  void request.finally(() => { if (tabRequests.get(tabId) === request) tabRequests.delete(tabId); }).catch(() => {});
  return request;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const kind = msg?.kind;
  // Ignore events and offscreen messages so their owning listener can answer.
  if (typeof kind !== "string" || !PANEL_REQUEST_KINDS.has(kind)) return false;
  const trusted = isExtensionPage(sender, ["panel.html"]) ||
    (kind === "open_side_panel_for_tab" && isExtensionPage(sender, ["popup.html"]));
  if (!trusted && !(kind === "selection_action" && isSelectionSender(sender))) {
    sendResponse({ ok: false, error: "Untrusted message sender" });
    return false;
  }
  // Opening must begin before any await; even waiting on an already-resolved
  // initialization promise loses Chrome's user-gesture permission.
  if (kind === "open_side_panel_for_tab") {
    const owner = panelTabId(sender.url);
    if (owner !== undefined && owner !== msg.tabId) {
      sendResponse({ ok: false, error: "This panel belongs to another tab." });
      return false;
    }
    void openTabPanel(msg.tabId).then(() => sendResponse({ ok: true, data: { ok: true } }),
      (e) => sendResponse({ ok: false, error: (e as Error).message }));
    return true;
  }
  if (kind === "selection_action" && sender.tab?.id != null) {
    void openTabPanel(sender.tab.id).catch(() => {});
  }
  void (async () => {
    try {
      await ready;
      const data = await routePanelRequest(msg as PanelRequest, sender);
      sendResponse({ ok: true, data });
    } catch (e) {
      sendResponse({ ok: false, error: (e as Error).message });
    }
  })();
  return true; // keep the channel open for the async response
});

async function handlePanelRequest(req: PanelRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  const tabId = panelTabId(sender.url);
  if (req.kind !== "selection_action" && req.kind !== "open_side_panel_for_tab") {
    if (tabId === undefined) throw new Error("Open TabAgent from the toolbar on the intended tab.");
    await chrome.tabs.get(tabId); // A closed tab must never become a different active tab.
    if ("tabId" in req && req.tabId !== tabId) throw new Error("This panel belongs to another tab.");
    if ("sessionId" in req && req.sessionId) {
      const session = await loadSession(req.sessionId);
      if (!session || session.tabId !== tabId) throw new Error("This session belongs to another tab.");
    }
  }
  switch (req.kind) {
    case "list_providers":
      return { providers: BUILTIN_PROVIDERS };

    case "get_provider_connection": {
      const def = getProviderDefinition(req.providerId);
      if (!def) throw new Error("unknown provider");
      const saved = await readProviderCredentials(req.providerId);
      // Only return editable non-secret fields. Never send a saved API key to UI.
      return { baseURL: saved.baseURL || def.baseURL, hasSavedKey: !!saved.apiKey };
    }

    case "list_models": {
      const def = getProviderDefinition(req.providerId);
      if (!def) throw new Error("unknown provider");
      const creds = await readProviderCredentials(req.providerId);
      const ctx = buildContext(def, creds);
      const adapter = getAdapter(def.type);
      const result = await adapter.listModels(ctx);
      await saveProviderModels(req.providerId, result.models);
      return { models: result.models };
    }

    case "seed_models": {
      // Return the catalog's hardcoded seed models with NO network call and NO
      // auth required. Used on boot so the model dropdown is never empty, even
      // before the user connects. (After connect, list_models merges dynamic
      // discovery on top of these.)
      const def = getProviderDefinition(req.providerId);
      if (!def) throw new Error("unknown provider");
      return { models: def.models };
    }

    case "validate_token": {
      // Validate WITHOUT persisting. The panel calls this from the connect
      // modal so the user sees a real auth check before the key is saved.
      const def = getProviderDefinition(req.providerId);
      if (!def) throw new Error("unknown provider");
      const ctx = buildContext(def, req.credentials);
      await requireProviderPermission(ctx.baseURL);
      const adapter = getAdapter(def.type);
      const result = await adapter.validateCredentials(ctx);
      return result; // { ok, error? }
    }

    case "connect_provider": {
      const def = getProviderDefinition(req.providerId);
      if (!def) throw new Error("unknown provider");
      if ((await listActiveSessions()).some((s) => s.providerId === req.providerId && isBusy(s))) {
        throw new Error("Stop the current agent run before editing this connection.");
      }
      const previous = await readProviderCredentials(req.providerId);
      const credentials = { ...req.credentials };
      if (req.keepSavedKey && !credentials.apiKey && previous.apiKey) {
        const oldURL = buildContext(def, previous).baseURL;
        const newURL = buildContext(def, credentials).baseURL;
        if (oldURL !== newURL) {
          throw new Error("The server address changed. Enter an API key for the new server, or choose 'Use without an API key'.");
        }
        credentials.apiKey = previous.apiKey;
      }
      // NOTE: host-permission request is intentionally NOT here.
      // chrome.permissions.request() must run inside a user-gesture call stack,
      // and crossing a sendMessage boundary (panel -> SW) loses the gesture.
      // The panel requests the host permission BEFORE sending connect_provider.
      // Here we validate (real auth check) + persist.
      const ctx = buildContext(def, credentials);
      const adapter = getAdapter(def.type);
      // Validate FIRST. Don't persist a bad key.
      await requireProviderPermission(ctx.baseURL);
      const validation = await adapter.validateCredentials(ctx);
      if (!validation.ok) {
        throw new Error(validation.error ?? "validation failed");
      }
      const { models } = await adapter.listModels(ctx);
      // Persist credentials (encrypted at rest with the auto-generated master key).
      const { readWorkingCredentials } = await import("../core/storage");
      const all = await readWorkingCredentials();
      all[req.providerId] = credentials;
      await writeEncryptedCredentials(all);
      await saveProviderModels(req.providerId, models);
      const settings = await loadTabState(tabId!);
      const selectedModelId = (settings.providerId === req.providerId && models.find((m) => m.id === settings.modelId)?.id)
        || models.find((m) => m.id === def.defaultLargeModelId)?.id || models[0]?.id || "";
      await saveTabState(tabId!, { providerId: req.providerId, modelId: selectedModelId });
      await saveSettings({ providerId: req.providerId, modelId: selectedModelId, initialized: true });
      return { models, selectedModelId };
    }

    case "select_model":
      await saveTabState(tabId!, { providerId: req.providerId, modelId: req.modelId });
      return { ok: true };

    case "set_draft":
      if (typeof req.text !== "string") throw new Error("Invalid draft");
      await saveTabState(tabId!, { draft: req.text });
      return { ok: true };

    case "set_autonomy":
      if (!["ask", "auto"].includes(req.mode)) throw new Error("Invalid autonomy mode");
      await saveTabState(tabId!, { autonomyMode: req.mode });
      return { ok: true, mode: req.mode };

    case "set_notifications":
      await saveSettings({ notificationsEnabled: req.enabled });
      return { ok: true, enabled: req.enabled };

    case "set_theme":
      await saveSettings({ theme: req.theme });
      return { ok: true, theme: req.theme };

    case "get_memory": {
      const { facts } = await loadMemory();
      return { facts };
    }

    case "set_memory": {
      const fact = await upsertFact({ ...req.fact, source: "manual" });
      const { facts } = await loadMemory();
      return { ok: true, fact, facts };
    }

    case "delete_memory": {
      const removed = await deleteFact(req.id);
      const { facts } = await loadMemory();
      return { ok: true, removed, facts };
    }

    case "export_session": {
      // Explicit user export of the current in-memory conversation.
      let session: Session | null = null;
      // 1. Exact sessionId the panel already tracks (live session area).
      if (req.sessionId) session = (await loadSession(req.sessionId)) ?? null;
      // 3. Any active session for this tab (session area).
      if (!session) {
        session = (await sessionsForTab(req.tabId)).at(-1) ?? null;
      }
      return { session };
    }

    case "send_message": {
      const settings = await loadTabState(req.tabId);
      const providerId = req.providerId ?? settings.providerId;
      const modelId = req.modelId ?? settings.modelId;
      if (!providerId || !modelId) throw new Error("no provider/model selected");
      // Detect the destructive "forget everything" intent BEFORE entering the
      // agent loop. We never want the model to act on the page after such a
      // command, and we want the wipe + confirmation to be deterministic. The
      // command is matched in both English and Arabic.
      if (isForgetEverythingIntent(req.text)) {
        await clearMemory();
        const { facts } = await loadMemory();
        return { ok: true, cleared: true, userMemory: facts, sessionId: null };
      }
      // Find or create a session for this tab.
      const sessions = await sessionsForTab(req.tabId);
      let session = sessions.find(isBusy) ?? sessions.at(-1);
      if (!session || session.state === "error" || session.abortReason ||
          (!isBusy(session) && (session.providerId !== providerId || session.modelId !== modelId))) {
        session = await newSession(req.tabId, providerId, modelId);
      }
      // If a run is already active on this session, QUEUE the message: it will
      // be steered into the model's next turn (drained at the top of the loop)
      // or auto-started after the run finishes. Idle sessions start a new run.
      if (isBusy(session)) {
        await enqueueMessage(session.sessionId, req.text);
        return { sessionId: session.sessionId, queued: true };
      }
      // Run in the background; events flow via onLoopEvent.
      session.state = "attaching";
      await saveSession(session);
      void run(session.sessionId, req.text);
      return { sessionId: session.sessionId, queued: false };
    }

    case "stop":
      await cancel(req.sessionId);
      return { ok: true };

    case "pause":
      await pause(req.sessionId);
      return { ok: true };

    case "resume":
      // v1: resume means start a fresh run on the existing session.
      // (Real mid-run resume is for the recovery path only.)
      return { ok: true };

    case "permission_decision": {
      // Map the wire decision shape to the permission service's Decision type.
      if (req.decision === "allow" || req.decision === "deny") {
        permissions.resolve(req.toolCallId, req.decision, req.sessionId);
      } else {
        permissions.resolve(req.toolCallId, req.decision, req.sessionId);
      }
      return { ok: true };
    }

    case "plan_decision": {
      planService.resolve(req.planId, req.decision, req.sessionId);
      return { ok: true };
    }

    case "resume_interrupted":
      await resolveInterrupted(req.sessionId, req.action);
      return { ok: true };

    case "get_state": {
      if (req.sessionId) {
        const { loadSession } = await import("../core/storage");
        return { session: await loadSession(req.sessionId) };
      }
      const tabState = await loadTabState(tabId!);
      const defaults = await loadSettings();
      const settings = { ...defaults, providerId: tabState.providerId,
        modelId: tabState.modelId, autonomyMode: tabState.autonomyMode };
      // Report which providers have stored credentials so the panel can show
      // the "configured" indicator on each provider chip.
      const { readWorkingCredentials } = await import("../core/storage");
      const allCreds = await readWorkingCredentials();
      const configuredProviders: string[] = [];
      for (const def of BUILTIN_PROVIDERS) {
        const creds = allCreds[def.id];
        const hasKey = !!creds && Object.values(creds).some((v) => v && String(v).trim().length > 0);
        if (hasKey) configuredProviders.push(def.id);
      }
      // Include the global user memory so the panel can hydrate its memory
      // overlay on boot without a second round-trip.
      const { facts: userMemory } = await loadMemory();
      const sessions = await sessionsForTab(tabId!);
      const current = sessions.find(isBusy) ?? sessions.at(-1);
      const pendingPermissions = current ? permissions.pendingForSession(current.sessionId)
        .map(({ resolve: _resolve, ...request }) => request) : [];
      return { sessions, settings, tabState, configuredProviders, userMemory, pendingPermissions,
        planPending: !!current && planService.hasPending(current.sessionId) };
    }

    case "new_session": {
      if ((await sessionsForTab(req.tabId)).some(isBusy)) throw new Error("Stop this tab's run before starting a new conversation.");
      const settings = await loadTabState(req.tabId);
      if (!settings.providerId || !settings.modelId) throw new Error("no provider/model selected");
      const session = await newSession(req.tabId, settings.providerId, settings.modelId);
      return { sessionId: session.sessionId };
    }

    case "open_side_panel_for_tab":
      // Handled synchronously by the message listener to preserve the gesture.
      return { ok: true };

    case "selection_action": {
      // From the content script. The tab id is the SENDER's tab, not a field.
      const tabId = sender.tab?.id;
      if (tabId == null) throw new Error("selection_action: no sender tab");
      if (typeof req.text !== "string" || !["explain", "summarize", "translate", "rewrite", "ask"].includes(req.action)) throw new Error("Invalid selection");
      const prompt = buildSelectionPrompt(req.action, req.text);
      // Keep the draft until the panel has booted.
      pendingPrompts.set(tabId, { prompt, at: Date.now() });
      // Open the side panel for this tab.
      // The listener already began opening in the sender's gesture stack.
      // A content script can only suggest a draft, never start an agent run.
      await broadcast({ kind: "selection_draft", tabId }).catch(() => {});
      return { ok: true };
    }

    case "pop_pending_prompt": {
      // The panel, on boot, asks: "was there a prompt waiting for my tab?"
      const entry = pendingPrompts.get(req.tabId);
      pendingPrompts.delete(req.tabId);
      if (!entry || Date.now() - entry.at > 30_000) return { prompt: null };
      return { prompt: entry.prompt };
    }

    default:
      return { ignored: true };
  }
}

// ---------------------------------------------------------------------------
// Forward loop events to all extension pages (side panel, popup).
// ---------------------------------------------------------------------------

onLoopEvent((e) => {
  // Translate LoopEvent -> PanelEvent shape and broadcast.
  const panelEvt = loopEventToPanelEvent(e);
  if (panelEvt) {
    void broadcast(panelEvt).catch(() => {});
  }
  // Fire notification sound + toast for finish/attention transitions. Runs
  // alongside broadcast and swallows its own errors (never disturbs the loop).
  void onLoopEventForNotify(e).catch(() => {});
});

function loopEventToPanelEvent(e: LoopEvent): PanelEvent | null {
  switch (e.type) {
    case "state":
      return { kind: "session_state", session: e.session };
    case "stream_part":
      return { kind: "stream_part", sessionId: e.sessionId, part: e.part };
    case "assistant_committed":
      return { kind: "assistant_message", sessionId: e.sessionId, message: e.message };
    case "tool_started":
      return { kind: "tool_call_started", sessionId: e.sessionId, name: e.name, input: e.input };
    case "tool_result":
      return { kind: "tool_result", sessionId: e.sessionId, name: e.name, content: e.content, isError: e.isError };
    case "permission_request":
      return {
        kind: "permission_request",
        sessionId: e.sessionId,
        toolCallId: e.toolCallId,
        name: e.name,
        input: e.input,
        reason: e.reason,
        site: e.site,
      };
    case "plan_proposed":
      return {
        kind: "plan_proposed",
        sessionId: e.sessionId,
        planId: e.planId,
        steps: e.steps,
      };
    case "plan_step_update":
      return {
        kind: "plan_step_update",
        sessionId: e.sessionId,
        stepId: e.stepId,
        status: e.status,
      };
    case "actions_suggested":
      return {
        kind: "actions_suggested",
        sessionId: e.sessionId,
        messageId: e.messageId,
        actions: e.actions,
      };
    case "queue_update":
      return {
        kind: "queue_update",
        sessionId: e.sessionId,
        queue: e.queue,
      };
    case "interrupted":
      return { kind: "interrupted", sessionId: e.sessionId, pendingToolCalls: e.pending };
    case "memory_update":
      return { kind: "memory_update", facts: e.facts };
    case "error":
      return { kind: "error", sessionId: e.sessionId, message: e.message };
    default:
      return null;
  }
}

async function broadcast(evt: PanelEvent): Promise<void> {
  // runtime.sendMessage fans out to all extension contexts (panel + popup).
  try {
    await chrome.runtime.sendMessage(evt);
  } catch {
    /* no receiver */
  }
}

// ---------------------------------------------------------------------------
// Tab lifecycle
// ---------------------------------------------------------------------------

chrome.tabs?.onRemoved?.addListener((tabId) => {
  void (async () => {
    await ready;
    pendingPrompts.delete(tabId);
    const sessions = await listActiveSessions();
    for (const s of sessions) {
      if (s.tabId === tabId) {
        await removeSession(s.sessionId);
        cdpManager.notifyDetached(tabId, "tab_closed");
      }
    }
    await deleteTabState(tabId);
  })();
});

// ---------------------------------------------------------------------------
// Action + commands: open the side panel
// ---------------------------------------------------------------------------

chrome.action.onClicked.addListener((tab) => {
  if (tab.id != null) void openTabPanel(tab.id).catch(console.error);
});

chrome.commands?.onCommand.addListener((command, tab) => {
  if (command === "open-side-panel") {
    if (tab?.id != null) void openTabPanel(tab.id).catch(console.error);
  }
});

// Forward permission service pending requests to the panel as events.
permissions.onPendingChange((req) => {
  void chrome.runtime
    .sendMessage({
      kind: "permission_request",
      sessionId: req.sessionId,
      toolCallId: req.toolCallId,
      name: req.name,
      input: req.input,
      reason: req.reason,
      site: req.site,
      alwaysAsk: req.alwaysAsk,
    })
    .catch(() => {});
});

// Auto-dismiss JS modal dialogs (alert/confirm/prompt) the agent can't see;
// record beforeunload so navigate() can report a clear error instead of hanging.
dialogHandler.start();
dialogHandler.onDialog((info) => {
  if (!info.autoDismissed) return; // only surface auto-dismissed ones as a note
  void chrome.runtime
    .sendMessage({
      kind: "tool_result",
      sessionId: "",
      name: "system",
      content: `Auto-dismissed a ${info.kind} dialog: "${info.message.slice(0, 120)}"`,
    })
    .catch(() => {});
});

console.log("[background] service worker booted");

async function requireProviderPermission(baseURL: string): Promise<void> {
  const url = providerURL(baseURL);
  if (!await chrome.permissions.contains({ origins: [`${url.protocol}//${url.hostname}/*`] })) {
    throw new Error("Connect this provider from the panel to grant network access first.");
  }
}
