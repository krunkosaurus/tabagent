import { randomUUID } from 'node:crypto';
import { CHAT_TEXT_LIMIT, CHAT_HISTORY_LIMIT } from '../build/mcp-tools.mjs';

// Only visible user/assistant text leaves Pi. No tool output, reasoning, image,
// system prompt, session file path, or other conversation is serialized.
function visibleText(message) {
  if (!['user', 'assistant'].includes(message?.role)) return null;
  const content = message.content;
  return (typeof content === 'string' ? content : (Array.isArray(content) ? content : [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n'))
    .replace(/tabagent:[1-9][0-9]{0,4}:[a-f0-9]{64}/g, '[pairing code hidden]');
}

export class PiChat {
  sessionId = randomUUID(); // Opaque attachment generation; never a session file path.
  messages = [];
  truncated = false;
  notice = '';
  listeners = new Set();
  active = new Map();
  closed = false;
  constructor(pi, ctx) { this.pi = pi; this.ctx = ctx; this.restore(); }
  restore() {
    this.messages = [];
    this.active.clear();
    this.truncated = false;
    for (const entry of this.ctx.sessionManager.getBranch()) {
      if (entry.type !== 'message') continue;
      const text = visibleText(entry.message);
      if (text === null || !text.trim()) continue;
      this.messages.push({ id: randomUUID(), role: entry.message.role, text });
      this.trim();
    }
  }
  trim() {
    let remaining = CHAT_HISTORY_LIMIT;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      const limit = Math.min(CHAT_TEXT_LIMIT, remaining);
      if (m.text.length > limit) { m.text = limit ? m.text.slice(-limit) : ''; this.truncated = true; }
      remaining -= m.text.length;
      if (!remaining && i > 0) { this.messages.splice(0, i); this.truncated = true; break; }
    }
    if (this.messages.length > 40) { this.messages = this.messages.slice(-40); this.truncated = true; }
  }
  snapshot() {
    return { busy: !!this.submitting || !this.ctx.isIdle(), title: (this.pi.getSessionName() || 'Current Pi conversation').slice(0, 80),
      messages: this.messages, truncated: this.truncated, notice: this.notice };
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  publish(immediate = false) {
    if (immediate && !this.closed) {
      clearTimeout(this.timer);
      this.timer = undefined;
      for (const fn of this.listeners) fn();
      return;
    }
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.closed) for (const fn of this.listeners) fn();
    }, 100);
    this.timer.unref?.();
  }
  event(event, ctx) {
    if (this.closed) return;
    this.ctx = ctx;
    if (event.type === 'agent_start') {
      this.submitting = false;
      clearTimeout(this.deliveryTimer);
      this.notice = '';
    } else if (event.type === 'agent_settled' || event.type === 'session_compact') {
      this.submitting = false;
      clearTimeout(this.deliveryTimer);
      this.restore();
    } else if (event.message) {
      const text = visibleText(event.message);
      if (text !== null) {
        const role = event.message.role;
        if (event.type === 'message_start') this.active.delete(role);
        let row = this.active.get(role);
        // A stream can contain only thinking or tool calls. Wait for visible
        // text before adding a transcript row or consuming its history budget.
        if (text.trim()) {
          if (!row) {
            row = { id: randomUUID(), role, text };
            this.messages.push(row);
            this.active.set(role, row);
          }
          row.text = text;
          this.trim();
        } else if (row) {
          this.messages = this.messages.filter((message) => message !== row);
          this.active.delete(role);
        }
        if (event.type === 'message_end') {
          this.active.delete(role);
          if (event.message.stopReason === 'error') this.notice = 'Pi reported an error. Check Pi for details.';
          if (event.message.stopReason === 'aborted') this.notice = 'Pi stopped.';
        }
      }
    }
    this.publish();
  }
  send(text) {
    if (this.closed) throw new Error('This Pi session has ended.');
    if (this.snapshot().busy) throw new Error('Pi is working. Send your next message when it is ready.');
    if (!this.ctx.model) throw new Error('Choose a model in Pi before sending a message.');
    this.submitting = true;
    this.notice = 'Submitted to Pi…';
    this.publish(true);
    // Pi's public extension API returns void. Do not claim delivery until its
    // message events arrive; never retry a prompt whose delivery is uncertain.
    this.deliveryTimer = setTimeout(() => {
      if (this.closed || !this.submitting) return;
      this.submitting = false;
      this.notice = 'No reply from Pi yet. Check Pi before sending again; the message was submitted only once.';
      this.publish();
    }, 10_000);
    this.deliveryTimer.unref?.();
    try {
      this.pi.sendUserMessage(text, { expandPromptTemplates: false });
    } catch {
      clearTimeout(this.deliveryTimer);
      this.submitting = false;
      throw new Error('Pi could not accept this message. Check Pi before sending again.');
    }
  }
  abort() {
    if (this.closed) throw new Error('This Pi session has ended.');
    this.notice = this.ctx.hasPendingMessages() ? 'Stop requested. Check Pi for messages queued there.' : 'Stopping Pi…';
    this.ctx.abort();
    this.publish();
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.deliveryTimer);
    this.listeners.clear();
    this.messages = [];
    this.active.clear();
  }
}
