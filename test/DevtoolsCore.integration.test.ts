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

  // Both servers answer the same paths, so only the scope each adapter was handed can tell their records apart.
  test('two servers in one process: each request is reported under the server that served it', async () => {
    const messages: { type: string; payload: any }[] = [];

    child = Bun.spawn(['bun', join(import.meta.dir, 'fixtures', 'devtools-two-servers-child.ts')], {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, NODE_ENV: 'development' },
      stdout: 'ignore',
      stderr: 'inherit',
      ipc: (message) => messages.push(message as { type: string; payload: any }),
    });

    const received = async (type: string, count: number): Promise<any[]> => {
      const ofType = () => messages.filter((message) => message.type === type).map((message) => message.payload);

      for (let i = 0; i < 400 && ofType().length < count; i++) {
        await Bun.sleep(25);
      }

      return ofType();
    };

    const [first, second] = await received('hello', 2);

    expect(first.adapter).toBe('Ergenecore');
    expect(second.adapter).toBe('Ergenecore');
    expect(second.serverId).not.toBe(first.serverId);
    expect(second.port).not.toBe(first.port);

    const get = async (hello: { port: number }, path: string) =>
      (await fetch(`http://localhost:${hello.port}${path}`)).status;

    expect(
      await Promise.all([
        get(first, '/notes/1'),
        get(second, '/notes/1'),
        get(second, '/missing'),
        get(first, '/notes/failing'),
        get(first, '/missing'),
        get(second, '/notes/2'),
      ]),
    ).toEqual([200, 200, 404, 500, 404, 200]);

    const records = await received('request', 6);
    const reportedBy = (hello: { serverId: string }) =>
      records
        .filter((record) => record.serverId === hello.serverId)
        .map((record) => `${record.path} ${record.status} ${record.answeredBy.kind}:${record.answeredBy.name}`)
        .sort();

    expect(records).toHaveLength(6);
    expect(reportedBy(first)).toEqual([
      '/missing 404 adapter-default:Ergenecore',
      '/notes/1 200 controller:NoteController.find',
      '/notes/failing 500 adapter-default:Ergenecore',
    ]);
    expect(reportedBy(second)).toEqual([
      '/missing 404 adapter-default:Ergenecore',
      '/notes/1 200 controller:ArchiveController.find',
      '/notes/2 200 controller:ArchiveController.find',
    ]);
  });
});
