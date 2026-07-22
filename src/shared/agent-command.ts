export type DirectAgentProvider = 'codex' | 'claude';

function hasUnquotedCompoundOperator(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '|' || char === ';' || char === '&') return true;
  }
  return false;
}

function firstCommandToken(commandText: string): string | null {
  let command = commandText.trim();
  if (command.startsWith('!')) command = command.slice(1).trimStart();
  if (!command || hasUnquotedCompoundOperator(command)) return null;
  const first = command[0];
  if (first === '"' || first === "'") {
    const end = command.indexOf(first, 1);
    return end > 1 ? command.slice(1, end) : null;
  }
  return /^\S+/u.exec(command)?.[0] ?? null;
}

export function executableBasename(token: string): string {
  const slashNormalized = token.replace(/\\/gu, '/');
  const basename = slashNormalized.slice(slashNormalized.lastIndexOf('/') + 1);
  return basename.toLocaleLowerCase('en-US').replace(/\.(?:exe|cmd|bat|ps1)$/u, '');
}

/** Returns only the directly-invoked executable. Wrappers and compound shell
 * commands deliberately fail closed so renderer key policy never guesses. */
export function directCommandExecutable(commandText: string): string | null {
  const token = firstCommandToken(commandText);
  return token ? executableBasename(token) : null;
}

export function classifyDirectAgentCommand(commandText: string): DirectAgentProvider | null {
  const executable = directCommandExecutable(commandText);
  if (executable === 'codex') return 'codex';
  if (executable === 'claude') return 'claude';
  return null;
}
