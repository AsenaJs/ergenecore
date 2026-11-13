import { afterEach, describe, expect, test } from 'bun:test';
import { AsenaServerFactory } from '@asenajs/asena';
import { isHttpException } from '@asenajs/asena/adapter';
import { Config, Controller, ExceptionHandler, Middleware } from '@asenajs/asena/decorators';
import { Get } from '@asenajs/asena/decorators/http';
import { Catch, NotFound } from '@asenajs/asena/exception';
import type { ServerLogger } from '@asenajs/asena/logger';
import { ConfigService } from '../lib/defaults/ConfigService';
import { MiddlewareService } from '../lib/defaults/MiddlewareService';
import { HttpException } from '../lib/errors';
import type { Context } from '../lib/ErgenecoreContextWrapper';
import { createErgenecoreAdapter } from '../lib/utils/factory';

const createLogger = () => {
  const errors: string[] = [];
  const logger: ServerLogger = {
    info: () => {},
    warn: () => {},
    error: (message: string) => {
      errors.push(message);
    },
    profile: () => {},
  };

  return { logger, errors };
};

describe('@ExceptionHandler over Ergenecore', () => {
  let server: any;

  afterEach(async () => {
    await server?.stop(true);
    server = undefined;
  });

  @Middleware()
  class FailingMiddleware extends MiddlewareService {
    public handle(): never {
      // eslint-disable-next-line no-throw-literal
      throw 'from middleware';
    }
  }

  @Controller('/throws')
  class ThrowingController {
    @Get('/string')
    public string() {
      // eslint-disable-next-line no-throw-literal
      throw 'text';
    }

    @Get('/number')
    public async number() {
      // eslint-disable-next-line no-throw-literal
      throw 42;
    }

    @Get('/http')
    public http() {
      throw new HttpException(409, 'Already there');
    }

    @Get({ path: '/middleware', middlewares: [FailingMiddleware] })
    public behindMiddleware(context: Context) {
      return context.send('unreachable');
    }
  }

  const boot = async (components: any[]) => {
    const { logger, errors } = createLogger();
    const adapter = createErgenecoreAdapter({ logger });

    server = await AsenaServerFactory.create({
      adapter: adapter as any,
      logger,
      port: 0,
      components: [FailingMiddleware, ThrowingController, ...components],
    });

    await server.start();

    const port = server.httpServer?.port ?? (adapter as any).server?.port;

    return { errors, get: (path: string) => fetch(`http://localhost:${port}${path}`) };
  };

  test('@Catch() receives a thrown string and number as thrown, from a handler and from a middleware', async () => {
    const seen: unknown[] = [];

    @ExceptionHandler()
    class CatchAllHandler {
      @Catch()
      public everything(error: unknown, ctx: any) {
        seen.push(error);

        return ctx.context.send({ caught: typeof error }, 418);
      }
    }

    const { get } = await boot([CatchAllHandler]);

    for (const [path, type] of [
      ['/throws/string', 'string'],
      ['/throws/number', 'number'],
      ['/throws/middleware', 'string'],
    ]) {
      const response = await get(path);

      expect([path, response.status]).toEqual([path, 418]);
      expect(await response.json()).toEqual({ caught: type });
    }

    expect(seen).toEqual(['text', 42, 'from middleware']);
  });

  test('@Catch(Error) receives an HttpException, and leaves a thrown string to the adapter default', async () => {
    const seen: unknown[] = [];

    @ExceptionHandler()
    class ErrorHandler {
      @Catch(Error)
      public anyError(error: Error, ctx: any) {
        seen.push(error);

        return ctx.context.send({ caught: error.message }, 422);
      }
    }

    const { get, errors } = await boot([ErrorHandler]);
    const conflict = await get('/throws/http');

    expect(conflict.status).toBe(422);
    expect(await conflict.json()).toEqual({ caught: 'Already there' });
    expect(seen).toHaveLength(1);
    expect(isHttpException(seen[0]) && seen[0].status).toBe(409);

    const text = await get('/throws/string');

    expect(text.status).toBe(500);
    expect(await text.json()).toEqual({ error: 'Internal Server Error' });
    expect(seen).toHaveLength(1);
    expect(errors).toContain('Application error occurred:');
  });

  test('a @Catch() that declines leaves the answer to the adapter default', async () => {
    let calls = 0;

    @ExceptionHandler()
    class DecliningHandler {
      @Catch()
      public everything(): undefined {
        calls += 1;

        return undefined;
      }
    }

    const { get } = await boot([DecliningHandler]);
    const text = await get('/throws/string');

    expect(text.status).toBe(500);
    expect(await text.json()).toEqual({ error: 'Internal Server Error' });

    const conflict = await get('/throws/http');

    expect(conflict.status).toBe(409);
    expect(await conflict.text()).toBe('Already there');
    expect(calls).toBe(2);
  });

  test('a @Catch() that throws is contained: the adapter default answers', async () => {
    @ExceptionHandler()
    class BrokenHandler {
      @Catch()
      public everything(): never {
        throw new Error('handler is broken');
      }
    }

    const { get } = await boot([BrokenHandler]);
    const response = await get('/throws/number');

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal Server Error' });
  });

  test('@Config.onError answers what every @Catch declined, with the thrown value as thrown', async () => {
    const seen: unknown[] = [];

    @ExceptionHandler()
    class DecliningHandler {
      @Catch()
      public everything(): undefined {
        return undefined;
      }
    }

    @Config()
    class ServerConfig extends ConfigService {
      public onError(error: Error, context: Context) {
        seen.push(error);

        return context.send({ by: 'config' }, 503);
      }
    }

    const { get } = await boot([DecliningHandler, ServerConfig]);
    const response = await get('/throws/string');

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ by: 'config' });
    expect(seen).toEqual(['text']);
  });

  test('@NotFound() answers an unmatched route; declining leaves the adapter 404', async () => {
    @ExceptionHandler()
    class NotFoundHandler {
      @NotFound()
      public missing(context: Context, request: { path: string; method: string }) {
        if (request.path.startsWith('/declined')) return undefined;

        return context.send({ missing: request.path, method: request.method }, 404);
      }
    }

    const { get } = await boot([NotFoundHandler]);
    const answered = await get('/nowhere?q=1');

    expect(answered.status).toBe(404);
    expect(await answered.json()).toEqual({ missing: '/nowhere', method: 'GET' });

    const declined = await get('/declined/path');

    expect(declined.status).toBe(404);
    expect(await declined.json()).toEqual({ error: 'Not Found' });
  });
});
