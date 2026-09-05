/** A panel's owner is fixed in its URL, never inferred from the active tab. */
export function panelPath(tabId: number): string {
  if (!Number.isSafeInteger(tabId) || tabId < 1) throw new Error("Invalid panel tab");
  return `panel.html?tabId=${tabId}`;
}

export function panelTabId(value: string | undefined): number | undefined {
  try {
    const url = new URL(value ?? "");
    const tabId = Number(url.searchParams.get("tabId"));
    return url.href === chrome.runtime.getURL(panelPath(tabId)) ? tabId : undefined;
  } catch { return undefined; }
}

export async function openTabPanel(tabId: number): Promise<void> {
  // Send these Chrome API calls in order in the original user-gesture stack.
  // Awaiting setOptions first loses Chrome's permission to open the panel.
  const configured = chrome.sidePanel.setOptions({ tabId, path: panelPath(tabId), enabled: true });
  const opened = chrome.sidePanel.open({ tabId });
  await Promise.all([configured, opened]);
}
