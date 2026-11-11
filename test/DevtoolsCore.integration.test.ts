import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';

// The devtools bus exists from core 0.13 on; on 0.12 (the peer range allows both) this is skipped.
// Resolved rather than imported: loading the entry point in this process is the console's job.
const hasDevtools = (() => {
  try {
    Bun.resolveSync('@asenajs/asena/devtools', import.meta.dir);

    return true;
  } catch {
    return false;
  }
})();

interface ChildReport {
  hookCalls: number;
  attached: boolean;
  statuses: number[];
  records: { method: string; path: string; status: number; answeredBy: { kind: string; name: string } }[];
  warnings: string[];
}

describe.skipIf(!hasDevtools)('Ergenecore in a process asena console started', () => {
  let child: ReturnType<typeof Bun.spawn> | undefined;

  afterEach(() => {
    child?.kill();
    child = undefined;
  });

  const run = async (nodeEnv: string): Promise<ChildReport> => {
    const { promise, resolve, reject } = Promise.withResolvers<ChildReport>();

    child = Bun.spawn(['bun', join(import.meta.dir, 'fixtures', 'devtools-child.ts')], {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, NODE_ENV: nodeEnv },
      stdout: 'ignore',
      stderr: 'inherit',
      ipc: (message) => resolve(message as ChildReport),
    });

    void child.exited.then((code) => reject(new Error(`the child exited with ${code} before reporting`)));

    return promise;
  };

  test('each HTTP request reaches the console as one record', async () => {
    const report = await run('development');

    expect(report.hookCalls).toBe(1);
    expect(report.attached).toBe(true);
    expect(report.statuses).toEqual([200, 500, 404]);
    expect(report.records).toEqual([
      { method: 'GET', path: '/notes/7', status: 200, answeredBy: { kind: 'controller', name: 'NoteController.find' } },
      {
        method: 'GET',
        path: '/notes/failing',
        status: 500,
        answeredBy: { kind: 'adapter-default', name: 'Ergenecore' },
      },
      { method: 'GET', path: '/missing', status: 404, answeredBy: { kind: 'adapter-default', name: 'Ergenecore' } },
    ]);
  });

  test('under NODE_ENV=production nothing is attached and no request is recorded', async () => {
    const report = await run('production');

    expect(report.statuses).toEqual([200, 500, 404]);
    expect(report.hookCalls).toBe(0);
    expect(report.attached).toBe(false);
    expect(report.records).toEqual([]);
    expect(report.warnings.some((warning) => warning.includes('devtools agent not attached'))).toBe(true);
  });
});
