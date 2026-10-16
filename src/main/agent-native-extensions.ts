import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentExtensionCommand } from '../shared/agent-capabilities';

/** Execute only a reviewed native executable with an argv array, never a shell. */
export async function runNativeExtensionCommand(executable: string, argv: readonly string[], workspaceRoot: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  let nativeExecutable = executable;
  if (process.platform === 'win32' && /\.cmd$/iu.test(executable)) {
    // npm's reviewed Codex launcher points at a package-owned native binary.
    // Resolve that fixed package location rather than interpreting user argv in cmd.exe.
    if (path.basename(executable).toLowerCase() !== 'codex.cmd') throw new Error('This command shim cannot manage native extensions.');
    const shim = await fs.readFile(executable, 'utf8');
    if (!shim.includes('node_modules\\@openai\\codex\\bin\\codex.js')) throw new Error('The Codex npm launcher changed. Review the provider again.');
    const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : undefined;
    if (!arch) throw new Error('The native Codex package architecture is unsupported.');
    nativeExecutable = await fs.realpath(path.join(path.dirname(executable), 'node_modules', '@openai', 'codex', 'node_modules', '@openai', `codex-win32-${process.arch}`, 'vendor', `${arch}-pc-windows-msvc`, 'bin', 'codex.exe'));
  }
  return new Promise((resolve, reject) => {
    execFile(nativeExecutable, [...argv], { cwd: workspaceRoot, env: environment, windowsHide: true, shell: false, timeout: 60_000, maxBuffer: 2 * 1024 * 1024, signal }, (error, stdout) => {
      // CLI diagnostics can include credentials; retain neither raw stdout nor stderr on failure.
      if (error) reject(new Error('The native extension command did not complete. Check the provider settings before retrying.'));
      else resolve(stdout);
    });
  });
}

export function claudeExtensionArguments(command: AgentExtensionCommand): readonly string[] {
  const target = command.target;
  if (target.startsWith('-') || command.source?.startsWith('-')) throw new Error('Invalid extension identifier.');
  const scope = ['--scope', command.scope];
  switch (command.action) {
    case 'plugin-install': return ['plugin', 'install', target, ...scope];
    case 'plugin-remove': return ['plugin', 'uninstall', target, ...scope];
    case 'plugin-enable': return ['plugin', 'enable', target, ...scope];
    case 'plugin-disable': return ['plugin', 'disable', target, ...scope];
    case 'plugin-update': return ['plugin', 'update', target, ...scope];
    case 'marketplace-add': return ['plugin', 'marketplace', 'add', command.source ?? target, ...scope];
    case 'marketplace-remove': return ['plugin', 'marketplace', 'remove', target, ...scope];
    case 'marketplace-update': return ['plugin', 'marketplace', 'update', target];
    case 'mcp-add': {
      if (!command.mcp) throw new Error('An MCP configuration is required.');
      if (!/^[A-Za-z0-9_-]+$/u.test(target)) throw new Error('Invalid MCP name.');
      return ['mcp', 'add-json', target, JSON.stringify(command.mcp), ...scope];
    }
    case 'mcp-remove': return ['mcp', 'remove', target, ...scope];
    default: throw new Error('This extension operation is not supported by the installed Claude CLI.');
  }
}

export function codexMcpArguments(command: AgentExtensionCommand): readonly string[] {
  if (command.target.startsWith('-') || !/^[A-Za-z0-9_-]+$/u.test(command.target) || command.scope !== 'user') throw new Error('Codex MCP management requires a user-scoped server name.');
  if (command.action === 'mcp-remove') return ['mcp', 'remove', command.target];
  if (command.action !== 'mcp-add' || !command.mcp) throw new Error('Invalid MCP operation.');
  return command.mcp.type === 'http'
    ? ['mcp', 'add', command.target, '--url', command.mcp.url]
    : ['mcp', 'add', command.target, '--', command.mcp.command, ...command.mcp.args];
}
