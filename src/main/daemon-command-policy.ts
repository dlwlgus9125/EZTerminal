import type {
  DaemonCommand,
  DaemonCommandError,
  DaemonCommandType,
} from '../shared/daemon-protocol';

export interface DaemonAuthorizationContext {
  /** True only for a non-detached managed descendant of rootSessionId. */
  readonly isManagedDescendant: (rootSessionId: string, candidateSessionId: string) => boolean;
}

export type DaemonAuthorizationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly error: DaemonCommandError };

const ANDROID_COMMANDS = new Set<DaemonCommandType>([
  'project.create',
  'project.update',
  'project.archive',
  'workspace.create',
  'workspace.update',
  'workspace.archive',
  'session.create',
  'session.update',
  'session.archive',
  'agent.create',
  'agent.resume',
  'agent.submit',
  'agent.interrupt-and-submit',
  'agent.interrupt',
  'agent.set-settings',
  'agent.cancel',
  'agent.archive',
  'agent.detach',
  'permission.resolve',
]);

const MCP_COMMANDS = new Set<DaemonCommandType>([
  'agent.create',
  'agent.resume',
  'agent.submit',
  'agent.interrupt-and-submit',
  'agent.interrupt',
  'agent.set-settings',
  'agent.cancel',
  'agent.archive',
  'agent.detach',
]);

function denied(command: DaemonCommand, reason: string): DaemonAuthorizationDecision {
  return {
    allowed: false,
    error: {
      code: 'unauthorized',
      message: reason,
      retryable: false,
      details: {
        principalKind: command.principal.kind,
        commandType: command.type,
      },
    },
  };
}

function getTargetSessionId(command: DaemonCommand): string | undefined {
  switch (command.type) {
    case 'agent.create':
    case 'agent.resume':
      return command.payload.parentSessionId;
    case 'agent.submit':
    case 'agent.interrupt-and-submit':
    case 'agent.interrupt':
    case 'agent.set-settings':
    case 'agent.cancel':
    case 'agent.archive':
    case 'agent.detach':
    case 'heartbeat.configure':
    case 'heartbeat.trigger':
    case 'browser.open':
    case 'browser.action':
    case 'browser.close':
    case 'script.run':
    case 'script.stop':
    case 'service.start':
    case 'service.stop':
      return command.payload.sessionId;
    default:
      return undefined;
  }
}

/**
 * Enforces transport-independent mutation authority. Authentication proves the
 * principal identity; this policy still decides which product operations that
 * identity may perform. Entity/state invariants remain the command handler's
 * responsibility.
 */
export function authorizeDaemonCommand(
  command: DaemonCommand,
  context: DaemonAuthorizationContext,
): DaemonAuthorizationDecision {
  switch (command.principal.kind) {
    case 'desktop':
    case 'cli':
      return { allowed: true };

    case 'android':
      return ANDROID_COMMANDS.has(command.type)
        ? { allowed: true }
        : denied(command, 'This command is available only on the Desktop host.');

    case 'provider':
      return denied(command, 'Provider runtimes publish adapter events and cannot issue daemon commands.');

    case 'mcp': {
      const rootSessionId = command.principal.sessionId;
      if (!rootSessionId || !MCP_COMMANDS.has(command.type)) {
        return denied(command, 'The session-scoped orchestration capability cannot perform this command.');
      }

      if (command.type === 'agent.create') {
        return command.payload.parentSessionId === rootSessionId
          ? { allowed: true }
          : denied(command, 'A session capability may create only its direct child.');
      }

      if (command.type === 'agent.resume') {
        if (command.payload.parentSessionId !== rootSessionId) {
          return denied(command, 'A session capability may resume only as its direct child.');
        }
        return context.isManagedDescendant(rootSessionId, command.payload.sourceSessionId)
          ? { allowed: true }
          : denied(command, 'A session capability may resume only a managed descendant Provider Session.');
      }

      const targetSessionId = getTargetSessionId(command);
      if (!targetSessionId || targetSessionId === rootSessionId) {
        return denied(command, 'A session capability cannot target its owning session.');
      }
      return context.isManagedDescendant(rootSessionId, targetSessionId)
        ? { allowed: true }
        : denied(command, 'A session capability may target only a managed descendant.');
    }
  }
}
