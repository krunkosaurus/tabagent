// Manifest V3. The CDP-required decision means "debugger" is a required permission
// (surfaces a scary install warning + a "being debugged" banner on controlled tabs;
// documented in README as the tradeoff for the real AX tree, screenshots, trusted input).
// Broad host access is OPTIONAL and requested per-provider-domain at runtime so the
// default install does not ask for "read and change all your data on all websites".
import type { Manifest } from "./manifest-type";

const manifest: Manifest = {
  manifest_version: 3,
  name: "TabAgent",
  version: "0.2.1",
  description:
    "Universal AI browser agent. Connect any OpenAI-compatible provider (Z.AI coding plan, OpenAI, OpenRouter, Ollama, ...) and let the AI drive the active tab.",
  minimum_chrome_version: "120",
  // MV3 SW. type: "module" would also work; classic is used to keep the build simple.
  background: { service_worker: "background.js" },
  action: {
    default_title: "Open TabAgent",
    default_icon: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    },
  },
  icons: {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png",
  },
  permissions: [
    "sidePanel",
    "offscreen",
    "storage",
    "alarms", // heartbeat for the agent-loop survival layer
    "scripting",
    "activeTab",
    "debugger", // CDP-required: real AX tree, screenshots, trusted input
    "notifications", // chime + system toast when a turn finishes or attention is needed
  ],
  // Requested per-site / per-provider at runtime via chrome.permissions.request.
  optional_host_permissions: ["https://*/*", "http://*/*"],
  host_permissions: [], // none required at install
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; form-action 'none'",
  },
  commands: {
    "_execute_action": {
      suggested_key: { default: "Ctrl+Shift+Y", mac: "Command+Shift+Y" },
      description: "Open the agent for this tab",
    },
    "open-side-panel": {
      suggested_key: { default: "Ctrl+Shift+A", mac: "Command+Shift+A" },
      description: "Open the agent side panel",
    },
  },
};

export default manifest;
