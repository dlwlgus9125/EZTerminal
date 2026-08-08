import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { ProcessGuardian } from './process-guardian';

interface GuardianCommand {
  readonly id: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

class FakeGuardianChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly commands: GuardianCommand[] = [];

  constructor(private readonly respond: (command: GuardianCommand) => Record<string, unknown>) {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      for (const line of chunk.split('\n').filter(Boolean)) {
        const command = JSON.parse(line) as GuardianCommand;
        this.commands.push(command);
        this.stdout.write(`${JSON.stringify(this.respond(command))}\n`);
      }
    });
  }

  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }

  ready(ownerPid: number): void {
    this.stdout.write(`${JSON.stringify({ type: 'ready', owner_pid: ownerPid })}\n`);
  }

  finish(code = 0): void {
    this.stdout.end();
    this.stderr.end();
    this.stdin.end();
    this.emit('exit', code, null);
  }
}

describe('ProcessGuardian', () => {
  it('waits for ownership and correlates group and deadline commands', async () => {
    const child = new FakeGuardianChild((command) => ({ type: 'ok', id: command.id }));
    queueMicrotask(() => child.ready(4242));

    const guardian = await ProcessGuardian.start({
      executablePath: 'unused-in-test.exe',
      ownerPid: 4242,
      spawnProcess: () => child.asChildProcess(),
    });

    await guardian.createGroup('interpreter:1', 100);
    await guardian.createGroup('script:1', 101, 'interpreter:1');
    await guardian.terminateGroup('interpreter:1');
    await guardian.armRootDeadline(5_000);
    await guardian.shellHandoff('open', 'https://example.com');
    await guardian.shellHandoff('reveal', 'C:\\workspace\\report.txt');

    expect(child.commands.map((command) => Object.fromEntries(
      Object.entries(command).filter(([key]) => key !== 'id'),
    ))).toEqual([
      { type: 'create-group', group_id: 'interpreter:1', pid: 100 },
      {
        type: 'create-group',
        group_id: 'script:1',
        pid: 101,
        parent_group_id: 'interpreter:1',
      },
      { type: 'terminate-group', group_id: 'interpreter:1' },
      { type: 'arm-root-deadline', timeout_ms: 5_000 },
      { type: 'shell-handoff', action: 'open', target: 'https://example.com' },
      { type: 'shell-handoff', action: 'reveal', target: 'C:\\workspace\\report.txt' },
    ]);
    child.finish();
  });

  it('rejects a native command error with its diagnostic', async () => {
    const child = new FakeGuardianChild((command) => ({
      type: 'error',
      id: command.id,
      message: 'process is outside the root job',
    }));
    queueMicrotask(() => child.ready(77));
    const guardian = await ProcessGuardian.start({
      executablePath: 'unused-in-test.exe',
      ownerPid: 77,
      spawnProcess: () => child.asChildProcess(),
    });

    await expect(guardian.createGroup('worker', 88)).rejects.toThrow(/outside the root job/);
    child.finish();
  });

  it('fails closed when the native process acknowledges a different owner', async () => {
    const child = new FakeGuardianChild((command) => ({ type: 'ok', id: command.id }));
    queueMicrotask(() => child.ready(999));

    await expect(ProcessGuardian.start({
      executablePath: 'unused-in-test.exe',
      ownerPid: 123,
      spawnProcess: () => child.asChildProcess(),
    })).rejects.toThrow(/wrong owner process/);
    child.finish();
  });
});
