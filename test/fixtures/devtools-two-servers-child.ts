import { AsenaServerFactory } from '@asenajs/asena';
import { Controller } from '@asenajs/asena/decorators';
import { Get } from '@asenajs/asena/decorators/http';
import type { ServerLogger } from '@asenajs/asena/logger';
import type { Context } from '../../lib/ErgenecoreContextWrapper';
import { createErgenecoreAdapter } from '../../lib/utils/factory';

// Spawned with an IPC channel by DevtoolsCore.integration.test.ts: two servers in one process,
// attached through core's own agent, which reports to the parent as it would to `asena console`.

// A variable specifier: the entry point does not exist in core 0.12, which the typecheck also runs against.
const devtoolsEntry = '@asenajs/asena/devtools';
const { attachDevtoolsAgent, DEVTOOLS_HOOK } = await import(devtoolsEntry);

(globalThis as Record<symbol, unknown>)[DEVTOOLS_HOOK] = attachDevtoolsAgent;

const logger: ServerLogger = { info: () => {}, error: () => {}, profile: () => {}, warn: () => {} };

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

@Controller('/notes')
class ArchiveController {
  @Get('/:id')
  public find(context: Context) {
    return context.send({ archived: context.getParam('id') });
  }
}

for (const controller of [NoteController, ArchiveController]) {
  const server = await AsenaServerFactory.create({
    adapter: createErgenecoreAdapter({ logger }) as any,
    logger,
    port: 0,
    components: [controller],
  });

  await server.start();
}
