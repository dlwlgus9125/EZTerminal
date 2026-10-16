import { describe, expect, it } from 'vitest';
import type { AgentExtensionCommand } from '../shared/agent-capabilities';
import { claudeExtensionArguments, codexMcpArguments } from './agent-native-extensions';

const command: AgentExtensionCommand = { providerId: 'claude', workspaceId: 'ws', commandId: 'c', expectedRevision: 'a'.repeat(64), action: 'marketplace-remove', target: 'team', scope: 'project' };
describe('native extension argv boundaries', () => {
  it('keeps marketplace removal within the selected Claude scope', () => {
    expect(claudeExtensionArguments(command)).toEqual(['plugin', 'marketplace', 'remove', 'team', '--scope', 'project']);
    expect(claudeExtensionArguments({ ...command, action: 'plugin-remove' })).toEqual(['plugin', 'uninstall', 'team', '--scope', 'project']);
  });
  it('passes MCP argv as data after the option terminator, without shell interpolation', () => {
    expect(codexMcpArguments({ ...command, providerId: 'codex', action: 'mcp-add', scope: 'user', mcp: { type: 'stdio', command: 'node', args: ['-e', 'console.log("$HOME & literal")'] } })).toEqual(['mcp', 'add', 'team', '--', 'node', '-e', 'console.log("$HOME & literal")']);
    expect(() => codexMcpArguments({ ...command, action: 'mcp-remove', scope: 'project' })).toThrow();
  });
  it('rejects identifiers and marketplace sources that could be interpreted as CLI options', () => {
    expect(() => claudeExtensionArguments({ ...command, target: '--all' })).toThrow();
    expect(() => claudeExtensionArguments({ ...command, action: 'marketplace-add', source: '--help' })).toThrow();
    expect(() => codexMcpArguments({ ...command, action: 'mcp-remove', target: '--help', scope: 'user' })).toThrow();
  });
});
