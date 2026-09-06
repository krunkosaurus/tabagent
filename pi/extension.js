/** Native Pi extension: the existing agent owns both chat and browser tools. */
import { createBridge, browserTools, instructions } from '../mcp/bridge.mjs';
import { PiChat } from './chat.js';

export default function tabagent(pi) {
  let chat;
  let bridge;
  let generation = 0;
  const reset = () => {
    generation++;
    chat?.close();
    chat = undefined;
    const old = bridge;
    bridge = undefined;
    void old?.then((b) => b.close(), () => {});
  };
  const start = (_event, ctx) => { reset(); chat = new PiChat(pi, ctx); };
  pi.on('session_start', start);
  pi.on('session_tree', start); // A different branch requires fresh user pairing.
  pi.on('session_shutdown', reset);
  for (const event of ['agent_start', 'agent_settled', 'message_start', 'message_update', 'message_end', 'session_compact', 'model_select']) {
    pi.on(event, (data, ctx) => {
      if (chat && ctx.sessionManager.getSessionId() === chat.ctx.sessionManager.getSessionId()) chat.event(data, ctx);
    });
  }
  async function getBridge() {
    if (!chat) throw new Error('Pi session is not ready.');
    const current = generation;
    if (!bridge) {
      bridge = createBridge({ agentName: () => 'Pi', chat }).catch((error) => {
        if (current === generation) bridge = undefined;
        throw error;
      });
    }
    const result = await bridge;
    if (current !== generation) { result.close(); throw new Error('Pi session changed. Ask for a fresh pairing code.'); }
    return result;
  }
  for (const tool of browserTools) {
    pi.registerTool({
      name: tool.name, label: tool.name.replace('tabagent_', 'Browser: '), description: tool.description,
      parameters: tool.inputSchema,
      ...(tool.name === 'tabagent_connect' ? { promptGuidelines: [instructions] } : {}),
      async execute(_id, args, signal) {
        const result = await (await getBridge()).call(tool.name, args, { signal });
        if (result.isError) throw new Error(result.content[0].text);
        return { ...result, details: {} };
      },
    });
  }
  pi.registerCommand('tabagent', {
    description: 'Get a pairing code for TabAgent browser tools and optional in-tab chat',
    async handler(_args, ctx) {
      const result = await (await getBridge()).call('tabagent_connect');
      const { pairingCode } = JSON.parse(result.content[0].text);
      ctx.ui.notify(`TabAgent: paste this into Local agent → Share this tab:\n${pairingCode}`, 'info');
    },
  });
}
