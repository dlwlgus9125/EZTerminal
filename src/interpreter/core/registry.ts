/**
 * Command registry + dispatch (architecture §5).
 *
 * The registry resolves a command name to its declarative definition + handler.
 * Definitions are plain typed data; argument validation against them happens at
 * dispatch time (see `evaluate.ts`) using Zod — never per row.
 */

import type { CommandDef } from './types';

export class CommandRegistry {
  private readonly commands = new Map<string, CommandDef>();

  register(def: CommandDef): void {
    if (this.commands.has(def.name)) {
      throw new Error(`command already registered: ${def.name}`);
    }
    this.commands.set(def.name, def);
  }

  get(name: string): CommandDef | undefined {
    return this.commands.get(name);
  }

  has(name: string): boolean {
    return this.commands.has(name);
  }

  names(): string[] {
    return [...this.commands.keys()];
  }
}
