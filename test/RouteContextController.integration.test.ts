import { afterEach, expect, test } from 'bun:test';
import { AsenaServerFactory } from '@asenajs/asena';
import { Controller, Middleware } from '@asenajs/asena/decorators';
import { Post } from '@asenajs/asena/decorators/http';
import type { ServerLogger } from '@asenajs/asena/logger';
import { z } from 'zod';
import { Context, MiddlewareService, ValidationService, createErgenecoreAdapter } from '../lib';

const logger: ServerLogger = { info() {}, warn() {}, error() {}, profile() {} };
const order: string[] = [];

class CreateUserContext extends Context.define({
  body: z.object({ name: z.string().trim(), age: z.coerce.number().default(18) }),
  query: z.object({ active: z.stringbool().default(false) }),
}) {
  get displayName(): string {
    return this.input.body.name.toUpperCase();
  }
}

@Middleware()
class ReadBodyMiddleware extends MiddlewareService {
  public async handle(context: Context, next: () => Promise<void>): Promise<void> {
    order.push('middleware');
    await context.getBody();
    await next();
  }
}

@Controller('/contract-controller')
class ContractController {
  @Post({ path: '/', middlewares: [ReadBodyMiddleware] })
  public async create(context: CreateUserContext) {
    order.push('handler');
    return context.send({
      subclass: context instanceof CreateUserContext,
      name: context.displayName,
      age: (await context.getBody()).age,
      active: context.input.query.active,
      frozen: Object.isFrozen(context.input),
    });
  }
}

@Middleware({ validator: true })
class LegacyValidator extends ValidationService {
  public json() {
    return z.object({ name: z.string() });
  }
}

@Controller('/contract-conflict')
class ConflictController {
  @Post({ path: '/', validator: LegacyValidator })
  public create(context: CreateUserContext) {
    return context.send({ ok: true });
  }
}

let server: Awaited<ReturnType<typeof AsenaServerFactory.create>> | undefined;
afterEach(async () => {
  await server?.stop(true);
  server = undefined;
  order.length = 0;
});

test('decorated controller receives validated subclass and output through metadata registration', async () => {
  const adapter = createErgenecoreAdapter({ logger });
  server = await AsenaServerFactory.create({
    adapter,
    logger,
    port: 0,
    components: [ContractController, ReadBodyMiddleware],
  });
  await server.start();
  const port = (server as any).httpServer?.port ?? (adapter as any).server?.port;
  const response = await fetch(`http://localhost:${port}/contract-controller`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: ' Ada ' }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ subclass: true, name: 'ADA', age: 18, active: false, frozen: true });
  expect(order).toEqual(['middleware', 'handler']);
});

test('decorated route rejects contract and validator together during startup', async () => {
  const adapter = createErgenecoreAdapter({ logger });
  server = await AsenaServerFactory.create({
    adapter,
    logger,
    port: 0,
    components: [ConflictController, LegacyValidator],
  });
  await expect(server.start()).rejects.toThrow('both');
});
