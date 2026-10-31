import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestApp, silentLogger } from '@asenajs/asena/test';
import type { TestApp } from '@asenajs/asena/test';
import { Controller, Middleware } from '@asenajs/asena/decorators';
import { Get } from '@asenajs/asena/decorators/http';
import { createErgenecoreAdapter } from '../lib';
import { MiddlewareService } from '../lib/defaults';
import type { Context } from '../lib';

@Middleware()
class Guard extends MiddlewareService {
  public async handle(context: Context, next: () => Promise<void>): Promise<any> {
    if (context.req.headers.get('x-token') !== 'ok') {
      return new Response('Unauthorized', { status: 401 });
    }

    return await next();
  }
}

@Controller({ path: '/', middlewares: [Guard] })
class RootGuarded {
  @Get('/secret')
  public secret(context: Context) {
    return context.send({ from: 'root-secret' });
  }

  @Get('/')
  public root(context: Context) {
    return context.send({ from: 'root' });
  }
}

@Controller({ path: '', middlewares: [Guard] })
class EmptyGuarded {
  @Get('/empty-secret')
  public emptySecret(context: Context) {
    return context.send({ from: 'empty-secret' });
  }
}

@Controller({ path: '/admin/', middlewares: [Guard] })
class AdminSlashGuarded {
  @Get('/secret')
  public secret(context: Context) {
    return context.send({ from: 'admin-secret' });
  }

  @Get('/')
  public index(context: Context) {
    return context.send({ from: 'admin-root' });
  }
}

@Controller({ path: '/api', middlewares: [Guard] })
class ApiGuarded {
  @Get('/secret')
  public secret(context: Context) {
    return context.send({ from: 'api-secret' });
  }
}

@Controller('/api/open')
class ApiOpen {
  @Get('/x')
  public x(context: Context) {
    return context.send({ from: 'open' });
  }
}

@Controller('/')
class RootRouteLevel {
  @Get({ path: '/route-guarded', middlewares: [Guard] })
  public routeGuarded(context: Context) {
    return context.send({ from: 'route-guarded' });
  }
}

const guardedPaths = ['/secret', '/', '/empty-secret', '/admin/secret', '/admin', '/admin/', '/api/secret'];

// Needs core >= 0.12.0 (controller middlewares attached per route). The installed core is the
// published one, so this runs only when node_modules/@asenajs/asena is linked to a built core.
describe.skipIf(process.env.ASENA_LINKED_CORE !== '1')('controller middlewares scope to their own routes', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp({
      adapter: createErgenecoreAdapter({ logger: silentLogger }),
      components: [Guard, RootGuarded, EmptyGuarded, AdminSlashGuarded, ApiGuarded, ApiOpen, RootRouteLevel],
    });
  });

  afterAll(async () => {
    await app?.stop();
  });

  const status = async (path: string, token?: string): Promise<number> => {
    const response = await fetch(`${app.baseUrl}${path}`, {
      headers: token ? { 'x-token': token } : {},
    });

    return response.status;
  };

  it.each(guardedPaths)('should run the controller guard on %s', async (path) => {
    expect(await status(path)).toBe(401);
  });

  it.each(guardedPaths)('should let %s through once the guard is satisfied', async (path) => {
    expect(await status(path, 'ok')).toBe(200);
  });

  it('should not guard an unrelated controller mounted under the same prefix', async () => {
    // The old `/api/*` pattern was a path scope, not a controller scope, so this route inherited
    // an authorization decision its author never wrote.
    expect(await status('/api/open/x')).toBe(200);
  });

  it('should still run a route-level middleware on a root controller', async () => {
    expect(await status('/route-guarded')).toBe(401);
    expect(await status('/route-guarded', 'ok')).toBe(200);
  });
});
