import { describe, expect, it } from 'vitest';

import { classifyDirectAgentCommand, directCommandExecutable } from './agent-command';

describe('direct agent command classification', () => {
  it.each([
    ['codex', 'codex'],
    ['!codex --full-auto', 'codex'],
    ['codex.exe resume --last', 'codex'],
    ['"C:\\Tools\\codex.cmd" -i shot.png', 'codex'],
    ['claude --resume', 'claude'],
  ] as const)('classifies %s as %s', (command, provider) => {
    expect(classifyDirectAgentCommand(command)).toBe(provider);
  });

  it.each([
    'cmd /c codex',
    'codex | tee transcript.txt',
    'codex && echo done',
    'ssh host codex',
    'my-codex-wrapper --resume',
    '',
  ])('does not guess through wrappers or compound commands: %s', (command) => {
    expect(classifyDirectAgentCommand(command)).toBeNull();
  });

  it('returns a normalized executable for configured generic-agent matching', () => {
    expect(directCommandExecutable('!"C:\\Tools\\My-Agent.CMD" --resume')).toBe('my-agent');
  });
});
