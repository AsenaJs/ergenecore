import { AsenaServerFactory } from '@asenajs/asena';
import { Controller } from '@asenajs/asena/decorators';
import { Get } from '@asenajs/asena/decorators/http';
import type { ServerLogger } from '@asenajs/asena/logger';
import type { Context } from '../../lib/ErgenecoreContextWrapper';
import { createErgenecoreAdapter } from '../../lib/utils/factory';

// Spawned with an IPC channel by DevtoolsCore.integration.test.ts, standing in for a process
// `asena console` started: it sets the console's hook, serves three requests and reports back.

const warnings: string[] = [];
const records: unknown[] = [];
let hookCalls = 0;

const logger: ServerLogger = {
  info: () => {},
  error: () => {},
  profile: () => {},
  warn: (message: string) => {
    warnings.push(message);
  },
};

(globalThis as Record<symbol, unknown>)[Symbol.for('asena.devtools')] = (context: any) => {
  hookCalls += 1;
  context.bus.subscribe((record: any) => {
    records.push({ method: record.method, path: record.path, status: record.status, answeredBy: record.answeredBy });
  });

  return { detach() {} };
};

@Controller('/notes')
class NoteController {
  @Get('/failing')
  public failing() {
    throw new Error('boom');
  }

  @Get('/:id')
  public find(context: Context) {
    return context.send({ id: context.getParam('id') });
  }
}

const adapter = createErgenecoreAdapter({ logger });
const server = await AsenaServerFactory.create({
  adapter: adapter as any,
  logger,
  port: 0,
  components: [NoteController],
});

await server.start();

const port = (server as any).httpServer?.port ?? (adapter as any).server?.port;
const statuses: number[] = [];

for (const path of ['/notes/7', '/notes/failing', '/missing']) {
  statuses.push((await fetch(`http://localhost:${port}${path}`)).status);
}

// Records close after the response is handed to Bun.
await Bun.sleep(20);

process.send!({ hookCalls, attached: (adapter as any).devtools !== undefined, statuses, records, warnings });

await server.stop(true);
process.exit(0);
