/** Shared trust boundaries. Web content and model output are untrusted. */
import { panelTabId } from "../shared/panel-target";

export function webURL(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new Error('Enter a complete URL starting with https:// or http://.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP(S) URLs without embedded credentials are allowed.');
  }
  return url;
}

export function providerURL(value: string): URL {
  const url = webURL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error('Provider connections require HTTPS, except for localhost models.');
  }
  if (url.search || url.hash) throw new Error('Provider URLs cannot include a query or fragment.');
  return url;
}

export function isExtensionPage(sender: chrome.runtime.MessageSender, pages: string[]): boolean {
  if (sender.id !== chrome.runtime.id || sender.frameId && sender.frameId !== 0) return false;
  return pages.some((page) => page === "panel.html"
    ? panelTabId(sender.url) !== undefined
    : sender.url === chrome.runtime.getURL(page));
}

export function isBackground(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && !sender.tab &&
    (!sender.url || sender.url === chrome.runtime.getURL('background.js'));
}

export function isSelectionSender(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || sender.tab?.id == null || sender.frameId !== 0) return false;
  try { webURL(sender.url ?? ''); return true; } catch { return false; }
}

/** Block redirects so a provider cannot forward conversation bodies elsewhere. */
export function providerFetch(url: string, init: RequestInit = {}): Promise<Response> {
  providerURL(url);
  return fetch(url, { ...init, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store' });
}
