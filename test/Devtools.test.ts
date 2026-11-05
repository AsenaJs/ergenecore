import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ServerLogger } from '@asenajs/asena/logger';
import type { BaseMiddleware, BaseValidator } from '@asenajs/asena/adapter';
import { HttpMethod } from '@asenajs/asena/web-types';
import { z } from 'zod';
import { type Context, Ergenecore, ErgenecoreWebsocketAdapter, type ValidationSchemaWithHook } from '../lib';
import type { DevtoolsBus, DevtoolsStep, DevtoolsStepKind } from '../lib/types/Devtools';

const logger: ServerLogger = {
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  profile: mock(() => {}),
};

interface FakeRecord {
  method: string;
  path: string;
  steps: DevtoolsStep[];
}

interface ClosedRecord extends FakeRecord {
  status: number;
  answeredBy: DevtoolsStep | undefined;
}

/** Mirrors core's DevtoolsBus: steps land in the record of the current async context. */
class FakeBus implements DevtoolsBus {
  public readonly closed: ClosedRecord[] = [];

  private readonly storage = new AsyncLocalStorage<FakeRecord>();

  public open(method: string, path: string): FakeRecord {
    return { method, path, steps: [] };
  }

  public run<T>(record: FakeRecord, fn: () => T): T {
    return this.storage.run(record, fn);
  }

  public step(kind: DevtoolsStepKind, name: string): void {
    this.storage.getStore()?.steps.push({ kind, name });
  }

  public close(record: FakeRecord, status: number, answeredBy?: DevtoolsStep): void {
    this.closed.push({ ...record, steps: [...record.steps], status, answeredBy });
  }
}

const ADAPTER_DEFAULT: DevtoolsStep = { kind: 'adapter-default', name: 'Ergenecore' };

describe('Ergenecore devtools envelope', () => {
  let adapter: Ergenecore;
  let bus: FakeBus;
  let baseUrl: string;

  const route = (
    path: string,
    handler: (ctx: Context) => unknown,
    extra: { method?: HttpMethod; middlewares?: BaseMiddleware<Context>[]; validator?: BaseValidator<any> } = {},
  ) => {
    adapter.registerRoute({
      staticServe: undefined,
      validator: extra.validator,
      method: extra.method ?? HttpMethod.GET,
      path,
      middlewares: extra.middlewares ?? [],
      handler: handler as any,
    });
  };

  /** What core's prepared controller wrapper records before the handler runs. */
  const controller = (name: string, handler: (ctx: Context) => unknown) => (ctx: Context) => {
    bus.step('controller', name);

    return handler(ctx);
  };

  const boot = async () => {
    // Below the kernel's ephemeral range, see the root CLAUDE.md.
    adapter.setPort(10000 + Math.floor(Math.random() * 22000));
    const server = await adapter.start();

    baseUrl = `http://localhost:${server.port}`;
  };

  /** Records are closed after the response is handed to Bun, so wait for the count, not the fetch. */
  const settled = async (count: number): Promise<ClosedRecord[]> => {
    for (let i = 0; i < 50 && bus.closed.length < count; i++) {
      await Bun.sleep(5);
    }

    return bus.closed;
  };

  beforeEach(() => {
    adapter = new Ergenecore(logger, new ErgenecoreWebsocketAdapter(logger), false);
    bus = new FakeBus();
  });

  afterEach(async () => {
    if (adapter['server']) {
      await adapter.stop();
    }
  });

  describe('not attached', () => {
    it('registers the fast-path closure itself: no wrapper, no per-request branch', async () => {
      const built: unknown[] = [];
      const createFastPathHandler = adapter['createFastPathHandler'].bind(adapter);

      adapter['createFastPathHandler'] = (params: any) => {
        const handler = createFastPathHandler(params);

        built.push(handler);

        return handler;
      };

      route('/plain', (ctx) => ctx.send('ok'));

      const routes = await adapter['buildBunRoutes']();

      expect(built).toHaveLength(1);
      expect(routes['/plain'].GET).toBe(built[0]);
      expect(routes['/plain/'].GET).toBe(built[0]);
      // Guards against a `this.devtools?.` check creeping into the per-request closure.
      expect(String(built[0])).not.toContain('devtools');
    });

    it('hands every request entry back untouched', () => {
      const entry = (_req: Request) => new Response('ok');

      expect(adapter['traced'](entry)).toBe(entry);
    });

    it('a published core that never attaches still serves every outcome', async () => {
      route('/ok', (ctx) => ctx.send('ok'));
      route('/boom', () => {
        throw new Error('boom');
      });

      await boot();

      expect((await fetch(`${baseUrl}/ok`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/boom`)).status).toBe(500);
      expect((await fetch(`${baseUrl}/missing`)).status).toBe(404);
    });
  });

  describe('attached', () => {
    beforeEach(() => {
      adapter.attachDevtools(bus);
    });

    it('wraps the fast-path closure', async () => {
      const built: unknown[] = [];
      const createFastPathHandler = adapter['createFastPathHandler'].bind(adapter);

      adapter['createFastPathHandler'] = (params: any) => {
        const handler = createFastPathHandler(params);

        built.push(handler);

        return handler;
      };

      route('/plain', (ctx) => ctx.send('ok'));

      const routes = await adapter['buildBunRoutes']();

      expect(routes['/plain'].GET).not.toBe(built[0]);
    });

    it('frames a matched fast-path route with method, pathname and the final status', async () => {
      route(
        '/notes/:id',
        controller('NoteController.find', (ctx) => ctx.send({ id: ctx.getParam('id') })),
      );

      await boot();

      const response = await fetch(`${baseUrl}/notes/7?expand=1`);

      expect(response.status).toBe(200);

      const [record] = await settled(1);

      expect(record).toEqual({
        method: 'GET',
        path: '/notes/7',
        steps: [{ kind: 'controller', name: 'NoteController.find' }],
        status: 200,
        answeredBy: undefined,
      });
    });

    it('frames a matched full-path route, the middleware steps included', async () => {
      const middleware: BaseMiddleware<Context> = {
        handle: async (_ctx, next) => {
          bus.step('middleware', 'AuditMiddleware.handle');
          await next();
        },
        override: false,
      };

      route(
        '/notes',
        controller('NoteController.create', (ctx) => ctx.send({ created: true }, 201)),
        { method: HttpMethod.POST, middlewares: [middleware] },
      );

      await boot();

      expect((await fetch(`${baseUrl}/notes`, { method: 'POST' })).status).toBe(201);

      const [record] = await settled(1);

      expect(record.method).toBe('POST');
      expect(record.status).toBe(201);
      expect(record.steps).toEqual([
        { kind: 'middleware', name: 'AuditMiddleware.handle' },
        { kind: 'controller', name: 'NoteController.create' },
      ]);
    });

    it('a thrown error the chain answers adds no adapter-default step', async () => {
      route(
        '/boom',
        controller('NoteController.boom', () => {
          throw new Error('boom');
        }),
      );
      adapter.onError((_error, ctx) => {
        bus.step('catch', 'NoteHandlers.onBoom');

        return ctx.send({ handled: true }, 418);
      });

      await boot();

      expect((await fetch(`${baseUrl}/boom`)).status).toBe(418);

      const [record] = await settled(1);

      expect(record.status).toBe(418);
      expect(record.steps).toEqual([
        { kind: 'controller', name: 'NoteController.boom' },
        { kind: 'catch', name: 'NoteHandlers.onBoom' },
      ]);
    });

    it('records adapter-default when no error handler exists', async () => {
      route(
        '/boom',
        controller('NoteController.boom', async () => {
          throw new Error('boom');
        }),
      );

      await boot();

      expect((await fetch(`${baseUrl}/boom`)).status).toBe(500);

      const [record] = await settled(1);

      expect(record.status).toBe(500);
      expect(record.steps).toEqual([{ kind: 'controller', name: 'NoteController.boom' }, ADAPTER_DEFAULT]);
    });

    it('records adapter-default when the error handler declines', async () => {
      route(
        '/boom',
        controller('NoteController.boom', () => {
          throw new Error('boom');
        }),
      );
      adapter.onError((() => {
        bus.step('catch', 'NoteHandlers.onAnything');
      }) as any);

      await boot();

      expect((await fetch(`${baseUrl}/boom`)).status).toBe(500);

      const [record] = await settled(1);

      expect(record.steps).toEqual([
        { kind: 'controller', name: 'NoteController.boom' },
        { kind: 'catch', name: 'NoteHandlers.onAnything' },
        ADAPTER_DEFAULT,
      ]);
    });

    it('a failure escaping the adapter closes the record as a 500 from the adapter', async () => {
      adapter = new Ergenecore(logger, new ErgenecoreWebsocketAdapter(logger), true);
      adapter.attachDevtools(bus);

      // The error log serialises a thrown non-Error with JSON.stringify, which throws on a cycle.
      const circular: Record<string, unknown> = {};

      circular.self = circular;
      route('/cycle', () => {
        throw circular;
      });

      // Called directly: a rejection reaching Bun.serve fails the test run on its own.
      const routes = await adapter['buildBunRoutes']();

      await expect(routes['/cycle'].GET(new Request('http://localhost/cycle'))).rejects.toThrow(TypeError);

      const [record] = await settled(1);

      expect(record.status).toBe(500);
      expect(record.answeredBy).toEqual(ADAPTER_DEFAULT);
    });

    it('an unmatched route without a not-found handler is answered by the adapter default', async () => {
      route('/known', (ctx) => ctx.send('ok'));

      await boot();

      expect((await fetch(`${baseUrl}/missing/deep?q=1`, { method: 'DELETE' })).status).toBe(404);

      const [record] = await settled(1);

      expect(record).toEqual({
        method: 'DELETE',
        path: '/missing/deep',
        steps: [ADAPTER_DEFAULT],
        status: 404,
        answeredBy: undefined,
      });
    });

    it('an unmatched route answered by the not-found handler has no adapter-default step', async () => {
      route('/known', (ctx) => ctx.send('ok'));
      adapter.onNotFound((ctx) => {
        bus.step('not-found', 'NoteHandlers.notFound');

        return ctx.send({ missing: true }, 404);
      });

      await boot();

      expect((await fetch(`${baseUrl}/missing`)).status).toBe(404);

      const [record] = await settled(1);

      expect(record.status).toBe(404);
      expect(record.steps).toEqual([{ kind: 'not-found', name: 'NoteHandlers.notFound' }]);
    });

    it('an unmatched route whose not-found handler declines falls to the adapter default', async () => {
      route('/known', (ctx) => ctx.send('ok'));
      adapter.onNotFound((() => {
        bus.step('not-found', 'NoteHandlers.notFound');
      }) as any);

      await boot();

      expect((await fetch(`${baseUrl}/missing`)).status).toBe(404);

      const [record] = await settled(1);

      expect(record.steps).toEqual([{ kind: 'not-found', name: 'NoteHandlers.notFound' }, ADAPTER_DEFAULT]);
    });

    describe('legacy validator', () => {
      const validator: BaseValidator<ValidationSchemaWithHook> = {
        json: { handle: () => ({ schema: z.object({ title: z.string().min(1) }) }), override: false },
      };

      const post = (body: unknown) =>
        fetch(`${baseUrl}/notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

      it('steps the validator before the handler', async () => {
        route(
          '/notes',
          controller('NoteController.create', (ctx) => ctx.send({ created: true })),
          { method: HttpMethod.POST, validator },
        );

        await boot();

        expect((await post({ title: 'groceries' })).status).toBe(200);

        const [record] = await settled(1);

        expect(record.steps).toEqual([
          { kind: 'validator', name: 'json' },
          { kind: 'controller', name: 'NoteController.create' },
        ]);
      });

      it('a failing validator reaches the adapter default with its 400', async () => {
        route(
          '/notes',
          controller('NoteController.create', (ctx) => ctx.send({ created: true })),
          { method: HttpMethod.POST, validator },
        );

        await boot();

        expect((await post({ title: '' })).status).toBe(400);

        const [record] = await settled(1);

        expect(record.status).toBe(400);
        expect(record.steps).toEqual([{ kind: 'validator', name: 'json' }, ADAPTER_DEFAULT]);
      });

      it('a validator hook that answers is the last step', async () => {
        const hooked: BaseValidator<ValidationSchemaWithHook> = {
          query: {
            handle: () => ({
              schema: z.object({ page: z.string() }),
              hook: (_result, ctx) => ctx.send({ invalid: true }, 422),
            }),
            override: false,
          },
        };

        route(
          '/notes',
          controller('NoteController.list', (ctx) => ctx.send([])),
          { validator: hooked },
        );

        await boot();

        expect((await fetch(`${baseUrl}/notes`)).status).toBe(422);

        const [record] = await settled(1);

        expect(record.status).toBe(422);
        expect(record.steps).toEqual([{ kind: 'validator', name: 'query' }]);
      });
    });

    describe('middleware answering false', () => {
      const guard: BaseMiddleware<Context> = {
        handle: () => {
          bus.step('middleware', 'NoteGuard.handle');

          return false;
        },
        override: false,
      };

      it('on a route: the 403 is closed with the guard as the last step', async () => {
        route(
          '/notes',
          controller('NoteController.list', (ctx) => ctx.send([])),
          { middlewares: [guard] },
        );

        await boot();

        expect((await fetch(`${baseUrl}/notes`)).status).toBe(403);

        const [record] = await settled(1);

        expect(record.status).toBe(403);
        expect(record.steps).toEqual([{ kind: 'middleware', name: 'NoteGuard.handle' }]);
      });

      it('on an unmatched route: a global guard answers before the 404', async () => {
        adapter.use(guard);
        route('/known', (ctx) => ctx.send('ok'));

        await boot();

        expect((await fetch(`${baseUrl}/missing`)).status).toBe(403);

        const [record] = await settled(1);

        expect(record.status).toBe(403);
        expect(record.steps).toEqual([{ kind: 'middleware', name: 'NoteGuard.handle' }]);
      });
    });

    it('keeps concurrent requests in separate records', async () => {
      let releaseFirst!: () => void;
      const firstMayFinish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      route(
        '/slow/:id',
        controller('NoteController.slow', async (ctx) => {
          await firstMayFinish;
          bus.step('catch', `after-wait-${ctx.getParam('id')}`);

          return ctx.send({ id: ctx.getParam('id') });
        }),
      );
      route(
        '/fast/:id',
        controller('NoteController.fast', async (ctx) => {
          await Bun.sleep(1);
          bus.step('catch', `after-sleep-${ctx.getParam('id')}`);

          return ctx.send({ id: ctx.getParam('id') });
        }),
      );

      await boot();

      const slow = fetch(`${baseUrl}/slow/1`);

      await Bun.sleep(10);
      expect((await fetch(`${baseUrl}/fast/2`)).status).toBe(200);
      releaseFirst();
      expect((await slow).status).toBe(200);

      const records = await settled(2);
      const byPath = Object.fromEntries(records.map((record) => [record.path, record.steps]));

      expect(records.map((record) => record.path)).toEqual(['/fast/2', '/slow/1']);
      expect(byPath['/slow/1']).toEqual([
        { kind: 'controller', name: 'NoteController.slow' },
        { kind: 'catch', name: 'after-wait-1' },
      ]);
      expect(byPath['/fast/2']).toEqual([
        { kind: 'controller', name: 'NoteController.fast' },
        { kind: 'catch', name: 'after-sleep-2' },
      ]);
    });
  });
});
