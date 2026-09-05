/** Popup: opens the side panel for the active tab. */
import { openTabPanel } from "../shared/panel-target";
document.getElementById("open-panel")?.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) {
    await openTabPanel(tab.id);
  }
  window.close();
});
