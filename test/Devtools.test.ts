import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ServerLogger } from '@asenajs/asena/logger';
import type { BaseMiddleware, BaseValidator, ValidatorHandler } from '@asenajs/asena/adapter';
import { HttpMethod } from '@asenajs/asena/web-types';
import { z } from 'zod';
import {
  Context,
  Ergenecore,
  ErgenecoreWebsocketAdapter,
  ValidationError,
  type ValidationSchemaWithHook,
} from '../lib';
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

  public enabled = true;

  public opened = 0;

  public stepped = 0;

  private readonly storage = new AsyncLocalStorage<FakeRecord>();

  public open(method: string, path: string): FakeRecord {
    this.opened += 1;

    return { method, path, steps: [] };
  }

  public run<T>(record: FakeRecord, fn: () => T): T {
    return this.storage.run(record, fn);
  }

  public step(kind: DevtoolsStepKind, name: string): void {
    this.stepped += 1;
    this.storage.getStore()?.steps.push({ kind, name });
  }

  public close(record: FakeRecord, status: number, answeredBy?: DevtoolsStep): void {
    this.closed.push({ ...record, steps: [...record.steps], status, answeredBy: answeredBy ?? record.steps.at(-1) });
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
    extra: {
      method?: HttpMethod;
      middlewares?: BaseMiddleware<Context>[];
      validator?: BaseValidator<any>;
      validatorName?: string;
    } = {},
  ) => {
    const params = {
      staticServe: undefined,
      validator: extra.validator,
      validatorName: extra.validatorName,
      method: extra.method ?? HttpMethod.GET,
      path,
      middlewares: extra.middlewares ?? [],
      handler: handler as any,
    };

    adapter.registerRoute(params);
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

    it('a validation failure keeps no attribution state', async () => {
      route('/notes', (ctx) => ctx.send('ok'), {
        method: HttpMethod.POST,
        validator: { json: { handle: () => z.object({ title: z.string() }), override: false } },
      });

      await boot();

      const response = await fetch(`${baseUrl}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 1 }),
      });

      expect(response.status).toBe(400);
      expect(adapter['producedBy']).toBeUndefined();
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
        answeredBy: { kind: 'controller', name: 'NoteController.find' },
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
      const failingLogger: ServerLogger = {
        ...logger,
        error: () => {
          throw new TypeError('log sink is gone');
        },
      };

      adapter = new Ergenecore(failingLogger, new ErgenecoreWebsocketAdapter(logger), true);
      adapter.attachDevtools(bus);

      route('/boom', () => {
        throw new Error('boom');
      });

      // Called directly: a rejection reaching Bun.serve fails the test run on its own.
      const routes = await adapter['buildBunRoutes']();

      await expect(routes['/boom'].GET(new Request('http://localhost/boom'))).rejects.toThrow(TypeError);

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
        answeredBy: ADAPTER_DEFAULT,
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
      class CreateNoteValidator {
        public json() {
          return { schema: z.object({ title: z.string().min(1) }) };
        }
      }

      /** Exactly what core's PrepareValidatorService hands over: a bound method, no name. */
      const prepared = <T extends object>(instance: T, key: keyof T & string): ValidatorHandler<any> => ({
        handle: (instance[key] as () => unknown).bind(instance) as ValidatorHandler<any>['handle'],
        override: false,
      });

      const validator: BaseValidator<ValidationSchemaWithHook> = {
        json: prepared(new CreateNoteValidator(), 'json'),
      };
      const VALIDATOR: DevtoolsStep = { kind: 'validator', name: 'CreateNoteValidator.json' };

      const post = (body: unknown) =>
        fetch(`${baseUrl}/notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

      const createRoute = () =>
        route(
          '/notes',
          controller('NoteController.create', (ctx) => ctx.send({ created: true })),
          { method: HttpMethod.POST, validator, validatorName: 'CreateNoteValidator' },
        );

      it('steps the validator, named component.target, before the handler', async () => {
        createRoute();

        await boot();

        expect((await post({ title: 'groceries' })).status).toBe(200);

        const [record] = await settled(1);

        expect(record.steps).toEqual([VALIDATOR, { kind: 'controller', name: 'NoteController.create' }]);
      });

      it('names the step after the target alone when the route carries no validator name', async () => {
        route(
          '/notes',
          controller('NoteController.create', (ctx) => ctx.send({ created: true })),
          { method: HttpMethod.POST, validator },
        );

        await boot();

        expect((await post({ title: 'groceries' })).status).toBe(200);

        const [record] = await settled(1);

        expect(record.steps[0]).toEqual({ kind: 'validator', name: 'json' });
      });

      it('a failing validator answers its own 400: no adapter-default step', async () => {
        createRoute();

        await boot();

        expect((await post({ title: '' })).status).toBe(400);

        const [record] = await settled(1);

        expect(record.status).toBe(400);
        expect(record.steps).toEqual([VALIDATOR]);
        expect(record.answeredBy).toEqual(VALIDATOR);
      });

      it('an error handler that declines the failure leaves the answer with the validator', async () => {
        createRoute();
        adapter.onError((() => {
          bus.step('config-onError', 'AppConfig.onError');
        }) as any);

        await boot();

        expect((await post({ title: '' })).status).toBe(400);

        const [record] = await settled(1);

        expect(record.steps).toEqual([VALIDATOR, { kind: 'config-onError', name: 'AppConfig.onError' }]);
        expect(record.answeredBy).toEqual(VALIDATOR);
      });

      it('an error handler that answers the failure keeps the answer, after the validator step', async () => {
        const CATCH: DevtoolsStep = { kind: 'catch', name: 'ValidationHandlers.onInvalid' };

        createRoute();
        adapter.onError((_error, ctx) => {
          bus.step(CATCH.kind, CATCH.name);

          return ctx.send({ invalid: true }, 422);
        });

        await boot();

        expect((await post({ title: '' })).status).toBe(422);

        const [record] = await settled(1);

        expect(record.steps).toEqual([VALIDATOR, CATCH]);
        expect(record.answeredBy).toEqual(CATCH);
      });

      it('a validator hook that answers is the answering step', async () => {
        class ListNotesValidator {
          public query(): ValidationSchemaWithHook {
            return {
              schema: z.object({ page: z.string() }),
              hook: (_result, ctx) => ctx.send({ invalid: true }, 422),
            };
          }
        }

        const hooked: BaseValidator<ValidationSchemaWithHook> = {
          query: prepared(new ListNotesValidator(), 'query'),
        };
        const QUERY: DevtoolsStep = { kind: 'validator', name: 'ListNotesValidator.query' };

        route(
          '/notes',
          controller('NoteController.list', (ctx) => ctx.send([])),
          { validator: hooked, validatorName: 'ListNotesValidator' },
        );

        await boot();

        expect((await fetch(`${baseUrl}/notes`)).status).toBe(422);

        const [record] = await settled(1);

        expect(record.status).toBe(422);
        expect(record.steps).toEqual([QUERY]);
        expect(record.answeredBy).toEqual(QUERY);
      });

      it('a failure behind a route middleware is still answered by the validator', async () => {
        const middleware: BaseMiddleware<Context> = {
          handle: async (_ctx, next) => {
            bus.step('middleware', 'AuditMiddleware.handle');
            await next();
          },
          override: false,
        };

        route(
          '/notes',
          controller('NoteController.create', (ctx) => ctx.send({ created: true })),
          { method: HttpMethod.POST, validator, validatorName: 'CreateNoteValidator', middlewares: [middleware] },
        );

        await boot();

        expect((await post({ title: '' })).status).toBe(400);

        const [record] = await settled(1);

        expect(record.steps).toEqual([{ kind: 'middleware', name: 'AuditMiddleware.handle' }, VALIDATOR]);
        expect(record.answeredBy).toEqual(VALIDATOR);
      });
    });

    describe('context contract', () => {
      class CreateNoteContext extends Context.define({ body: z.object({ title: z.string().min(1) }) }) {}

      const CONTRACT: DevtoolsStep = { kind: 'validator', name: 'CreateNoteContext' };

      const contractRoute = () =>
        adapter.registerRoute({
          staticServe: undefined,
          validator: undefined,
          method: HttpMethod.POST,
          path: '/notes',
          middlewares: [],
          contextClass: CreateNoteContext,
          handler: controller('NoteController.create', (ctx) => ctx.send({ created: true })) as any,
        });

      // Core records the contract's own step; the published core these tests run on does not.
      it('a contract failure reaching the default response is answered by the contract validator', async () => {
        contractRoute();

        await boot();

        const response = await fetch(`${baseUrl}/notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: '' }),
        });

        expect(response.status).toBe(400);

        const [record] = await settled(1);

        expect(record.steps).not.toContainEqual(ADAPTER_DEFAULT);
        expect(record.answeredBy).toEqual(CONTRACT);
      });
    });

    it('a ValidationError a fast-path handler throws itself stays with the adapter default', async () => {
      route(
        '/notes',
        controller('NoteController.find', () => {
          throw new ValidationError(z.string().safeParse(1).error!, 'query');
        }),
      );

      await boot();

      expect((await fetch(`${baseUrl}/notes`)).status).toBe(400);

      const [record] = await settled(1);

      expect(record.steps).toEqual([{ kind: 'controller', name: 'NoteController.find' }, ADAPTER_DEFAULT]);
      expect(record.answeredBy).toEqual(ADAPTER_DEFAULT);
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

    describe('a handler returning a thenable that is not a promise', () => {
      const thenable = (settle: () => Response): PromiseLike<Response> => ({
        then: (onFulfilled, onRejected) => Bun.sleep(1).then(settle).then(onFulfilled, onRejected),
      });

      it('closes the record once, with the status it settles to', async () => {
        route(
          '/lazy',
          controller('NoteController.lazy', (ctx) => thenable(() => ctx.send({ lazy: true }, 202) as Response)),
        );

        await boot();

        expect((await fetch(`${baseUrl}/lazy`)).status).toBe(202);

        await settled(1);
        await Bun.sleep(10);

        expect(bus.closed).toHaveLength(1);
        expect(bus.closed[0].status).toBe(202);
        expect(bus.closed[0].answeredBy).toEqual({ kind: 'controller', name: 'NoteController.lazy' });
      });

      it('closes a rejection as the adapter default, behind a middleware too', async () => {
        const middleware: BaseMiddleware<Context> = { handle: async (_ctx, next) => next(), override: false };
        const failing = controller('NoteController.lazy', () =>
          thenable(() => {
            throw new Error('lazy boom');
          }),
        );

        route('/lazy', failing);
        route('/guarded-lazy', failing, { middlewares: [middleware] });

        await boot();

        expect((await fetch(`${baseUrl}/lazy`)).status).toBe(500);
        expect((await fetch(`${baseUrl}/guarded-lazy`)).status).toBe(500);

        await settled(2);
        await Bun.sleep(10);

        expect(bus.closed.map(({ path, status, answeredBy }) => ({ path, status, answeredBy }))).toEqual([
          { path: '/lazy', status: 500, answeredBy: ADAPTER_DEFAULT },
          { path: '/guarded-lazy', status: 500, answeredBy: ADAPTER_DEFAULT },
        ]);
      });
    });

    describe('while the bus is disabled', () => {
      const validator: BaseValidator<any> = {
        json: { handle: () => z.object({ title: z.string() }), override: false },
      };

      beforeEach(() => {
        route('/ok', (ctx) => ctx.send('ok'));
        route('/boom', () => {
          throw new Error('boom');
        });
        route('/notes', (ctx) => ctx.send('ok'), { method: HttpMethod.POST, validator });
      });

      const everyOutcome = async (): Promise<number[]> => {
        const invalid = fetch(`${baseUrl}/notes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 1 }),
        });
        const responses = await Promise.all([
          fetch(`${baseUrl}/ok`),
          fetch(`${baseUrl}/boom`),
          fetch(`${baseUrl}/missing`),
          invalid,
        ]);

        return responses.map((response) => response.status);
      };

      it('serves every outcome and opens no record', async () => {
        bus.enabled = false;

        await boot();

        expect(await everyOutcome()).toEqual([200, 500, 404, 400]);

        await Bun.sleep(10);

        expect(bus.opened).toBe(0);
        expect(bus.closed).toEqual([]);
      });

      it('steps nothing: neither default answer nor the legacy validator reaches the bus', async () => {
        bus.enabled = false;

        await boot();

        expect(await everyOutcome()).toEqual([200, 500, 404, 400]);

        await Bun.sleep(10);

        expect(bus.stepped).toBe(0);
      });

      it('stops recording when the bus goes off under a running server, and resumes with it', async () => {
        await boot();

        expect((await fetch(`${baseUrl}/ok`)).status).toBe(200);
        await settled(1);

        bus.enabled = false;
        expect(await everyOutcome()).toEqual([200, 500, 404, 400]);
        await Bun.sleep(10);

        expect(bus.opened).toBe(1);
        expect(bus.closed).toHaveLength(1);

        bus.enabled = true;
        expect((await fetch(`${baseUrl}/missing`)).status).toBe(404);

        const records = await settled(2);

        expect(records).toHaveLength(2);
        expect(records[1].answeredBy).toEqual(ADAPTER_DEFAULT);
      });
    });
  });
});
