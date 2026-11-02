import {
  REVIEWER_SESSION_PREFIX,
  type DaemonCommand,
  type DaemonCommandError,
  type DaemonCommandType,
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
  'agent.steer',
  'agent.steer-settle',
  'agent.queue',
  'agent.set-settings',
  'agent.cancel',
  'agent.archive',
  'agent.detach',
  'long-run.limit-action',
  'review.start',
  'review.fix',
  'review.resolve',
  'review.cancel',
  'wrap-up.recap-retry',
  'wrap-up.task-outcome',
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

/**
 * What a person does in the in-app browser. `cli` is also an AI's own shell and the host's own turns: a navigation from
 * there would pass as the person's and a site would pass as allowed by a person, so these are the desktop's alone.
 */
const DESKTOP_ONLY_COMMANDS = new Set<DaemonCommandType>(['browser.open', 'browser.action', 'browser.close', 'browser.site']);

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
    case 'agent.steer':
    case 'agent.steer-settle':
    case 'agent.queue':
    case 'agent.set-settings':
    case 'agent.cancel':
    case 'agent.archive':
    case 'agent.detach':
    case 'long-run.limit-action':
    case 'review.start':
    case 'review.fix':
    case 'review.resolve':
    case 'review.cancel':
    case 'wrap-up.recap-retry':
    case 'wrap-up.task-outcome':
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
      return { allowed: true };

    case 'cli':
      return DESKTOP_ONLY_COMMANDS.has(command.type)
        ? denied(command, 'Only a person at the desktop drives the in-app browser.')
        : { allowed: true };

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
      // A review's reviewer conversation belongs to the person who asked for the review, not to the reviewed AI.
      const named = [getTargetSessionId(command), 'sessionId' in command.payload ? command.payload.sessionId : undefined,
        command.type === 'agent.resume' ? command.payload.sourceSessionId : undefined];
      if (named.some((sessionId) => typeof sessionId === 'string' && sessionId.startsWith(REVIEWER_SESSION_PREFIX))) {
        return denied(command, 'A review conversation is not an agent’s to direct.');
      }
      // Both commands are an agent's for its own children: the card is not. The AI proposes; a person starts.
      if ((command.type === 'agent.create' || command.type === 'agent.submit') && command.payload.wrapUpTask) {
        return denied(command, 'Only a person starts a suggested task.');
      }
      // A "Continue." is the host's to send; an AI's message to its child is only a message.
      if (command.type === 'agent.submit' && command.payload.longRunResume) {
        return denied(command, 'Only the host resumes a conversation a limit stopped.');
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
