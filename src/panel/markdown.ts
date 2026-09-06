import DOMPurify from "dompurify";
import { Marked, Renderer } from "marked";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Keep configuration private to this renderer. Raw HTML stays visible as text,
// and model-supplied images never create elements or initiate network requests.
const markdown = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }) { return escapeHtml(text); },
    image({ text }) { return escapeHtml(text); },
    checkbox({ checked }) { return checked ? "[x] " : "[ ] "; },
    link(token) {
      return Renderer.prototype.link.call(this, token)
        .replace(/^<a /, '<a target="_blank" rel="noopener noreferrer" ');
    },
    table(token) {
      return `<div class="md-table-wrap">${Renderer.prototype.table.call(this, token)}</div>`;
    },
  },
});

/** Render untrusted model Markdown for innerHTML in the panel's browser DOM. */
export function renderMarkdown(input: string): string {
  if (!input) return "";
  // Sanitize AFTER all Markdown transforms, including on every streaming update.
  // Only document formatting and explicit HTTP(S)/mailto links may survive.
  return DOMPurify.sanitize(markdown.parse(input, { async: false }), {
    ALLOWED_TAGS: [
      "p", "br", "strong", "em", "del", "h1", "h2", "h3", "h4", "h5", "h6",
      "ul", "ol", "li", "blockquote", "pre", "code", "hr", "a",
      "div", "table", "thead", "tbody", "tr", "th", "td",
    ],
    ALLOWED_ATTR: ["href", "title", "target", "rel", "class", "start", "align"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
    // These formatting/link-policy attributes do not contain URLs.
    ADD_URI_SAFE_ATTR: ["target", "rel", "start", "align"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}
