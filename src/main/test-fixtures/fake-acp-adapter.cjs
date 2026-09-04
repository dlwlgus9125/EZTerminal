const readline = require('node:readline');

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let promptRequestId = null;

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
    });
    return;
  }
  if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fake-session' } });
    return;
  }
  if (message.method === 'session/prompt') {
    promptRequestId = message.id;
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'fake-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Implemented the bounded task.' },
        },
      },
    });
    send({
      jsonrpc: '2.0',
      id: 'permission-1',
      method: 'session/request_permission',
      params: {
        sessionId: 'fake-session',
        toolCall: {
          toolCallId: 'tool-1',
          title: 'Read package metadata',
          kind: 'read',
          rawInput: { path: 'package.json' },
        },
        options: [
          { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject once', kind: 'reject_once' },
        ],
      },
    });
    return;
  }
  if (message.id === 'permission-1' && message.result) {
    const selected = message.result.outcome?.optionId;
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'fake-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Permission option: ${selected}` },
        },
      },
    });
    send({ jsonrpc: '2.0', id: promptRequestId, result: { stopReason: 'end_turn' } });
    promptRequestId = null;
    return;
  }
  if (message.method === 'session/cancel') process.exit(0);
});
