import { afterEach, describe, expect, test } from 'bun:test';
import { AsenaServerFactory } from '@asenajs/asena';
import { Controller, Middleware } from '@asenajs/asena/decorators';
import { Get, Post } from '@asenajs/asena/decorators/http';
import type { ServerLogger } from '@asenajs/asena/logger';
import { z } from 'zod';
import { createErgenecoreAdapter } from '../lib/utils/factory';
import { MiddlewareService } from '../lib/defaults/MiddlewareService';
import { ValidationService } from '../lib/defaults/ValidationService';
import type { Context } from '../lib/ErgenecoreContextWrapper';

/**
 * The undecorated-subclass substitution, over a real server.
 *
 * Asena's `test/server/web/RouteInheritance.test.ts` covers this against a mock adapter, which
 * can prove the route was registered with the wrong middleware object but cannot prove what a
 * request does. The bug's whole character is that the request succeeds - 200, correct-looking
 * body, nothing in the log - so the assertion that matters is about a response, and it can only
 * be made here.
 *
 * `@Middleware()` is forgotten on a subclass of a decorated guard. Component identity is not
 * inherited, so the subclass is not a component; the resolver used to read the name off the
 * prototype chain, find the *base's*, and hand the route the base's instance. A route that says
 * `middlewares: [AdminGuard]` was served by ReadGuard.
 *
 * All three places a component can be referenced from a route are covered, because they are
 * three different call sites in two different services and fixing one does not fix the others.
 */

const silentLogger = (): ServerLogger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  profile: () => {},
});

/** Which guard actually ran. Asserted by identity - a count cannot tell ReadGuard from AdminGuard. */
const ran: string[] = [];

@Middleware()
class ReadGuard extends MiddlewareService {
  public async handle(_context: Context, next: () => Promise<void>) {
    ran.push('ReadGuard');
    await next();
  }
}

// The @Middleware decorator was forgotten on the stricter guard. This is the shape people
// actually write: a base guard that checks a session, a subclass that also checks a role.
class AdminGuard extends ReadGuard {
  public override async handle(_context: Context, next: () => Promise<void>) {
    ran.push('AdminGuard');
    await next();
  }
}

@Controller('/route-level')
class RouteLevelController {
  @Get({ path: '/danger', middlewares: [AdminGuard] })
  public danger(context: Context) {
    return context.send({ ok: true });
  }
}

@Controller({ path: '/class-level', middlewares: [AdminGuard] })
class ClassLevelController {
  @Get('/danger')
  public danger(context: Context) {
    return context.send({ ok: true });
  }
}

@Middleware({ validator: true })
class PermissiveValidator extends ValidationService {
  public json() {
    return z.object({}).passthrough();
  }
}

// Same omission, on a validator. The base accepts anything; the subclass demands a field.
class StrictValidator extends PermissiveValidator {
  public override json() {
    return z.object({ approvedBy: z.string() });
  }
}

@Controller('/validator')
class ValidatorController {
  @Post({ path: '/submit', validator: StrictValidator })
  public submit(context: Context) {
    return context.send({ ok: true });
  }
}

describe('an undecorated subclass referenced from a route (ergenecore)', () => {
  let server: any;

  afterEach(async () => {
    await server?.stop(true);
    server = undefined;
  });

  /**
   * Boots, and if the boot wrongly succeeds drives the request the application would have
   * served - so the assertions can report which guard answered rather than only that no error
   * was thrown.
   */
  const bootAndProbe = async (components: any[], probe: { path: string; init?: RequestInit }) => {
    ran.length = 0;

    const adapter = createErgenecoreAdapter({ logger: silentLogger() });

    let failure: Error | undefined;

    try {
      server = await AsenaServerFactory.create({
        adapter: adapter as any,
        logger: silentLogger(),
        port: 0,
        components,
      });

      await server.start();
    } catch (error) {
      failure = error as Error;
    }

    if (failure) return { failure, response: undefined as Response | undefined };

    const port = (server as any).httpServer?.port ?? (adapter as any).server?.port;
    const response = await fetch(`http://localhost:${port}${probe.path}`, probe.init);

    return { failure, response };
  };

  test('route-level middlewares: the base guard cannot serve the route', async () => {
    const { failure, response } = await bootAndProbe([ReadGuard, RouteLevelController], {
      path: '/route-level/danger',
    });

    if (!failure) {
      throw new Error(
        `boot succeeded - /route-level/danger answered ${response!.status}, guarded by [${ran.join(', ')}]`,
      );
    }

    expect(failure.message).toMatch(/AdminGuard/);
    expect(failure.message).toMatch(/not a component/);
    // Nothing ran, because nothing started. The route is unreachable rather than weakly guarded.
    expect(ran).toEqual([]);
  });

  test('class-level @Controller middlewares: same rule', async () => {
    const { failure, response } = await bootAndProbe([ReadGuard, ClassLevelController], {
      path: '/class-level/danger',
    });

    if (!failure) {
      throw new Error(
        `boot succeeded - /class-level/danger answered ${response!.status}, guarded by [${ran.join(', ')}]`,
      );
    }

    expect(failure.message).toMatch(/AdminGuard/);
    expect(ran).toEqual([]);
  });

  test('validator: the permissive base cannot validate for the strict subclass', async () => {
    const { failure, response } = await bootAndProbe([PermissiveValidator, ValidatorController], {
      path: '/validator/submit',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // StrictValidator requires `approvedBy`; PermissiveValidator lets this through. A 200
        // here is the substitution, answered to the caller.
        body: JSON.stringify({ anything: true }),
      },
    });

    if (!failure) {
      throw new Error(
        `boot succeeded - /validator/submit answered ${response!.status} for a body the declared ` +
          'validator rejects',
      );
    }

    expect(failure.message).toMatch(/StrictValidator/);
    expect(failure.message).toMatch(/not a component/);
  });

  test('a decorated subclass is fine, and its own handler is the one that runs', async () => {
    @Middleware()
    class DecoratedAdminGuard extends ReadGuard {
      public override async handle(_context: Context, next: () => Promise<void>) {
        ran.push('DecoratedAdminGuard');
        await next();
      }
    }

    @Controller('/decorated')
    class DecoratedController {
      @Get({ path: '/danger', middlewares: [DecoratedAdminGuard] })
      public danger(context: Context) {
        return context.send({ ok: true });
      }
    }

    const { failure, response } = await bootAndProbe([ReadGuard, DecoratedAdminGuard, DecoratedController], {
      path: '/decorated/danger',
    });

    // The rule must reject only the missing decorator, not subclassing itself - a fix that
    // banned inheritance outright would also pass every assertion above.
    expect(failure).toBeUndefined();
    expect(response!.status).toBe(200);
    expect(ran).toEqual(['DecoratedAdminGuard']);
  });
});
