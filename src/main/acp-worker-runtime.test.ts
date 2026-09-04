import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import type { CollaborationTask, WorkerReportInput } from '../shared/agent-orchestration';
import type { AgentAdapterRuntimeDescriptor } from './agent-adapter-service';
import { AcpWorkerRuntime } from './acp-worker-runtime';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'test-fixtures',
  'fake-acp-adapter.cjs',
);

const task: CollaborationTask = {
  taskId: 'task-1',
  revision: 1,
  title: 'Bounded read',
  brief: 'Inspect package metadata.',
  mode: 'read-only',
  dependsOn: [],
  writeScopes: [],
  profileId: 'adapter:test:read',
  state: 'starting',
  createdAt: 1,
  updatedAt: 1,
};

const descriptor = {
  adapterId: 'test',
  executable: process.execPath,
  args: [fixturePath],
  manifest: { name: 'Fake ACP' },
} as unknown as AgentAdapterRuntimeDescriptor;

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let index = 0; index < 100; index += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw last;
}

describe('AcpWorkerRuntime', () => {
  it('negotiates ACP v1, routes permission through the activity gate, and reports completion', async () => {
    const states: string[] = [];
    const reports: WorkerReportInput[] = [];
    const approval = vi.fn(async () => 'allow' as const);
    const ended = vi.fn();
    const runtime = new AcpWorkerRuntime({
      setActivityState: (_activityId, state) => { states.push(state); },
      endActivity: ended,
      requestApproval: approval,
      report: async (_activityId, taskId, report) => {
        expect(taskId).toBe(task.taskId);
        reports.push(report);
        return { ok: true };
      },
    });

    try {
      const prepared = await runtime.prepare(descriptor, process.cwd(), task, 'ask');
      expect(runtime.bindActivity(prepared.sessionId, 'activity-1')).toBe(true);
      prepared.start('Inspect the project.');
      await eventually(() => expect(reports).toHaveLength(1));

      expect(approval).toHaveBeenCalledWith(
        'activity-1',
        'Read package metadata',
        JSON.stringify({ path: 'package.json' }),
      );
      expect(reports[0]).toMatchObject({
        outcome: 'succeeded',
        summary: expect.stringContaining('Permission option: once'),
      });
      expect(states).toEqual(expect.arrayContaining(['working', 'done']));
      expect(runtime.readActivity('activity-1')).toContain('Implemented the bounded task.');
      expect(runtime.stop(prepared.sessionId)).toBe(true);
      expect(ended).toHaveBeenCalledWith('activity-1', false);
    } finally {
      runtime.dispose();
    }
  });

  it('auto-allows declared read operations in safe-auto mode without opening an approval gate', async () => {
    const reports: WorkerReportInput[] = [];
    const approval = vi.fn(async () => 'deny' as const);
    const runtime = new AcpWorkerRuntime({
      setActivityState: vi.fn(),
      endActivity: vi.fn(),
      requestApproval: approval,
      report: async (_activityId, _taskId, report) => {
        reports.push(report);
        return { ok: true };
      },
    });

    try {
      const prepared = await runtime.prepare(descriptor, process.cwd(), task, 'safe-auto');
      expect(runtime.bindActivity(prepared.sessionId, 'activity-safe-auto')).toBe(true);
      prepared.start('Inspect the project.');
      await eventually(() => expect(reports).toHaveLength(1));

      expect(approval).not.toHaveBeenCalled();
      expect(reports[0]).toMatchObject({
        outcome: 'succeeded',
        summary: expect.stringContaining('Permission option: once'),
      });
    } finally {
      runtime.dispose();
    }
  });
});
