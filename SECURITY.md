# Security review and hardening

Assessment: useful for supervised tasks on one tab, but early-stage software.
The reviewed source had trust-boundary weaknesses and several functional bugs.
This build addresses the findings below. It is not a security
certification, a comprehensive penetration test, or an evaluation of model quality.

| Finding in the original source | Change in this checkout |
| --- | --- |
| API ciphertext and its master key were both exposed to extension content scripts through default `storage.local` access. | Restrict both local/session storage to `TRUSTED_CONTEXTS`; initialization fails closed if access cannot be restricted. |
| Background commands accepted messages from content scripts without checking sender context. | Privileged commands require the extension's panel/popup. Content scripts can only submit selection drafts from their own top-level HTTP(S) tab. Offscreen commands and panel events require the background sender. |
| Page selections could start an agent run; the open shadow root accepted synthetic clicks. | Selection requires trusted clicks, uses a closed shadow root, and only fills a draft for the user to submit. |
| Model-generated plan text and tool-result previews were inserted as raw HTML. | Escape these fields; create screenshot elements using DOM APIs; limit images/fonts/frames/objects with CSP. |
| Plan approval and Auto mode bypassed navigation approval; grants used hostname only; prompts omitted actual arguments. | Standalone plan approval no longer skips action checks. Navigation always asks. Grants/decisions bind to origin and session; prompts display arguments. New origins require read-access approval, including in standalone Auto mode. |
| `navigate` accepted arbitrary schemes; custom provider URLs allowed cleartext remote credentials and redirecting POST bodies. | Navigation permits HTTP(S) without embedded credentials. Providers require HTTPS except loopback, reject query/fragment URLs, omit cookies/referrers and reject redirects. |
| Page JavaScript could tamper with the reference map and helpers in the main world. | DOM tools run in a named isolated world; native page DOM remains untrusted. Stop prevents subsequent tool CDP commands. |
| Full conversation/page-text checkpoints were mirrored to disk; the model could silently store persistent memories and trigger extra inference. | Memory-only conversation checkpoints. Automatic memory tools/extraction removed; only user-edited notes feed future prompts. Old disk mirrors are removed on startup. |
| Optional provider headers identified this app and an attribution URL. | Removed `X-Title` and `HTTP-Referer` headers. No analytics SDK or telemetry collector was found in reviewed source. |
| Broad static content-script injection and public offscreen resources enlarged the attack surface. | Inject selection UI only on an activated tab. Remove static content scripts, public resources, unused permissions and WebAssembly evaluation permission. |
| Provider setup validated before obtaining host permission, and guessed a model for validation. Dynamic model selections fell back to seeded models or failed. | Request permission first in the click handler. Most providers validate with `/models`; retain Z.AI's special chat probe. Cache the discovered model list and use the selected ID. |
| Origin checks parsed an empty `Tab.url` when Chrome withheld tab metadata, causing an `Invalid URL` crash. | Read the top-level frame URL through the run's existing debugger attachment. The regression test uses a target host without host permissions, and verifies cross-origin approval in that condition. |
| Saved custom connections had no editor. | Provide an editor with non-secret endpoint metadata. Blank keys can retain an existing key only for the unchanged address; address changes require an explicit replacement or removal. Block editing while the provider is in use by a run. |
| A global side panel followed tab switches and inferred its target from the active tab at boot; model/autonomy choices were global. | Use a tab-specific panel URL with an immutable owner, validate requested tabs/sessions against it, and store each tab's choices and draft in session storage. Reopening restores only that tab's history and approvals. Closing a tab aborts its pending decisions and prevents its run from recreating deleted checkpoints. |
| Tool results could lack matching assistant tool calls; screenshots were replaced with placeholders before the model saw them. | Preserve tool-call history and send screenshots as image attachments; omit screenshot bytes only from checkpoint copies. |
| esbuild 0.24.x had a known development-server vulnerability. | Update to esbuild 0.28.2; dependency audit reports zero known vulnerabilities. This project did not use the vulnerable development server. |

## Data flows and remaining risks

### Native Pi chat (v0.3.0)

The optional Pi extension lets one explicitly attached shared tab show recent
user/assistant text and submit prompts to the current Pi session. These prompts
have the same authority as terminal prompts: Pi's file/command tools remain
governed by Pi, while browser actions remain governed by TabAgent approvals.
Attaching chat is a separate user action from sharing browser access.

Both directions use the existing authenticated loopback socket and private
Chrome runtime ports, validated against the panel's immutable tab identity.
Other panels and content scripts cannot subscribe to that transcript or send
prompts into it. No host chat is exposed through generic MCP tools. Session
replacement, branch changes and reload revoke the old pairing. Requests are
bounded, deduplicated and never automatically replayed after uncertain delivery.

The transcript contains bounded recent visible text only, rendered literally;
raw reasoning, tool output, images and system prompts are excluded. User or
assistant text can itself contain private information. Pi may persist the
conversation; Chrome does not save this transcript or its drafts. Stop sharing
revokes browser/chat access but does not cancel unrelated Pi work already
submitted. [Setup, controls, limits and tests](docs/pi-chat.md).

### External MCP agents (v0.2.2)

Local Codex/Hermes/Pi sessions can use an authenticated companion to control
explicitly shared tabs. Each process has an ephemeral loopback socket and random
pairing secret. The extension enforces per-tab ownership and defaults to asking
for mutations/navigation and new-origin reads. The user can select **Allow for
this connection** in the panel to permit those operations, including form
submissions, without further prompts on that tab. This grant stays in memory,
ends with the connection and cannot be selected by the MCP client or inherited
by other tabs. Both modes use strict CDP without automatic reattachment.
Stop, cancellation, disconnect and timeout revoke access. Page
confirmations are dismissed with `accept: false`, including in standalone mode.
The shared API excludes arbitrary JavaScript, raw CDP and extension settings.
The transport rejects page origins, rebinding Hosts, invalid tokens and spoofed
results. [Full architecture, limits and test coverage](docs/mcp.md).

External-session page content goes to the calling agent and its configured
model. The extension/companion do not persist those results or pairing secrets;
the caller can retain them in its own history and media cache. Sharing is a
permission to read the initial site in Ask mode; each subsequently visited
origin asks again. Connection approval covers subsequent sites in the shared
tab as well. In both modes, tab listings expose only the metadata explicitly
shared initially, and origin changes during an action still discard its result.

The activity view keeps at most 50 action summaries and timings in connection
memory. Normal summaries omit entered text, keyboard values, URL query strings,
fragments and screenshot bytes; failures show a bounded error message. Agent
names and activity fields render as text. The panel reports actual browser
calls and distinguishes idle connections from running tools.

### Standalone mode

The connected provider receives your prompt, conversation context, manually saved
notes, and page text/screenshots accessed by the agent. There is no developer
relay in the reviewed implementation. Provider-side logging, retention, billing
and training policies are outside this extension's control. A local model avoids
sending task data to a remote inference provider if that model server itself
operates locally.

API keys remain recoverable by someone who can read your Chrome profile, because
the encryption key is stored with the ciphertext. Do not interpret AES-GCM as an
OS keychain or passphrase vault. Credentials, grants, settings and manual notes
persist locally; conversations and per-tab drafts end on tab closure, browser exit,
or extension reload/update. Exports are explicit plaintext
JSON files. On upgrade, export old conversations before loading this build if
you need to retain them.

The debugger permission is still powerful. Host permission minimization does
not remove CDP's ability to interact with logged-in sites. The agent can follow
malicious page instructions, misidentify elements, read sensitive visible text,
or take harmful actions after approval. DOM can change during an interaction;
origin checks and isolated worlds do not authenticate page content. Auto mode
and stored origin grants intentionally permit ordinary actions without a new
prompt. There is no semantic detector that reliably recognizes every payment,
message submission, deletion or secret.

Use Ask mode, supervise actions, and prefer a separate Chrome profile containing
only the accounts needed for the task. This is not ready for unattended sensitive
account administration. Each agent controls one tab, has no reliable spend budget, and does
not use an existing Claude browser subscription. Native Anthropic support is
still unimplemented; Claude models require a compatible provider such as
OpenRouter. Model quality, real API compatibility and cost need validation with
your chosen provider.

## Validation

- `npm run typecheck` and `npm run build`.
- `npm test`: storage access policy, credential encryption round trip, checkpoint
  privacy, unsafe URLs, sender checks, session/origin-bound permissions, mandatory
  navigation approval, provider fetch privacy options, tool/image wire formats,
  markdown and manifest restrictions.
- `npm run test:browser`: isolated Chrome for Testing profile and real extension
  APIs against a loopback mock provider. Covers boot, model discovery/selection,
  content-script rejection/storage isolation, selection draft behavior, DOM
  snapshot without tab URL access, custom connection editing/key retention,
  rejection of implicit key forwarding to a new address,
  snapshot and typing in an isolated world, escaped plan HTML, action approval
  after plan approval, Auto navigation, cross-origin read gating, image delivery,
  disk storage checks and panel JavaScript errors.
  Also covers native tab-specific panel creation from a real click, switching and
  reopening panels, separate model/autonomy choices and drafts, concurrent tab
  runs, rejected cross-tab control requests, restored approvals and follow-up
  context, and cancellation/cleanup when one tab closes.
- `npm audit --ignore-scripts`: zero known dependency vulnerabilities at review.

The browser test copy pre-grants access to loopback for CI; the actual distribution
has no required host permissions. Native first-time Chrome permission dialogs,
the user's browser profile and live paid providers were not exercised.

## Primary references

- [Chrome storage access levels](https://developer.chrome.com/docs/extensions/reference/api/storage/)
- [Chrome tab URL visibility](https://developer.chrome.com/docs/extensions/reference/api/tabs#property-Tab-url)
- [Chrome tab-specific side panels](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Debugger frame tree](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-getFrameTree)
- [Chrome message-passing security guidance](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#security-considerations)
- [Chromium extension security FAQ, including debugger privileges](https://chromium.googlesource.com/chromium/src/+/main/extensions/docs/security_faq.md)
- [esbuild development-server advisory](https://github.com/advisories/GHSA-67mh-4wv8-2f99)
