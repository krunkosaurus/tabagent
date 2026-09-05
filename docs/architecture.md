# Independent tab instances

Each browser tab owns its panel, conversation, composer draft, selected provider
and model, autonomy mode, queue and pending approvals. Switching tabs does not
retarget a running agent. Different tabs can run concurrently.

## Panel ownership

There is no global `side_panel.default_path` in the manifest. Startup disables
the global panel behavior left by older builds. The toolbar action and keyboard
shortcut configure and open a panel only for the requested tab, using
`panel.html?tabId=<owner>`.

`src/shared/panel-target.ts` validates this canonical URL and opens the native
panel. The configuration and open calls are issued in order within the original
click handler: awaiting configuration first loses Chrome's user-gesture permission.
Tabs where TabAgent has not been opened keep the panel disabled.

The panel reads its owner from its URL and never rebinds to the active tab.
The background router validates the extension sender and rejects a request for
another tab or a session belonging to another tab. Session events are filtered by
owner/session before rendering. Extension pages remain trusted contexts with
shared extension privileges; this is not an operating-system sandbox between tabs.

## Storage and restoration

`chrome.storage.session` holds `agent.tab.<tabId>` preferences/drafts and
`agent.session.<sessionId>` conversation checkpoints. Per-tab preference writes
are serialized so typing a draft and changing a model cannot overwrite each other.
These records survive service-worker restarts but are not written to local storage.
Reloading or updating the extension also clears this session storage.

Chrome may recreate a panel after it closes or becomes hidden. On boot, the panel
loads only its owner's sessions and current pending decisions. It restores the
conversation, draft, queued messages, active plan and permission prompts. Committed
messages are deduplicated against events received during initialization.

A completed conversation continues in the same session for follow-up requests.
Changing the provider/model or starting again after an error or cancellation starts
a new session in that tab. Unanswered tool calls from a previous ended run receive
an explicit failure result before the conversation continues; they are not replayed.

## Runs and cleanup

The background loop owns the run, abort controller and debugger attachment.
Closing a panel or selecting another tab leaves the run on its original tab.
Stopping a run or answering an approval affects only that panel's session.

Closing the browser tab aborts its runs and resolves its pending decisions, removes
its session records and draft/preferences, and cleans up its debugger attachment.
Late checkpoints from a cancelled run cannot recreate the removed session.

API connections, manual notes, explicit site grants, theme and notification settings
remain shared. Editing a connection is blocked while any tab is using that provider.
New tabs inherit the saved connection defaults; subsequent model and autonomy
changes are stored independently for each tab.

## Verification

`tests/browser.mjs` uses real Chrome extension APIs and an isolated profile with a
loopback mock provider. It checks native panel creation, separate panel paths,
restoration while another tab is active, concurrent runs, independent models and
drafts, cross-tab request rejection, pending approval restoration, follow-up history,
and closing one tab while another has a pending plan. `tests/security.mjs` checks
canonical panel URLs and concurrent per-tab preference writes.

Chrome's [Side Panel API documentation](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
describes native tab-specific visibility and instance behavior.
