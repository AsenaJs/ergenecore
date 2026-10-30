import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Ergenecore, ErgenecoreWebsocketAdapter } from '../lib';
import { CorsMiddleware, MiddlewareService, WebSocketOriginMiddleware } from '../lib/defaults';
import { createErgenecoreAdapter } from '../lib/utils/factory';
import { AsenaServerFactory } from '@asenajs/asena';
import { Middleware, WebSocket as WebSocketNamespace } from '@asenajs/asena/decorators';
import type { ServerLogger } from '@asenajs/asena/logger';
import { AsenaWebSocketService, type Socket } from '@asenajs/asena/web-socket';
import type { Context } from '../lib';
import type { Server } from 'bun';

const mockLogger: ServerLogger = {
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  profile: mock(() => {}),
};

// A browser attaches cookies to a cross-site handshake, so by the time a cookie-based auth
// middleware looks at the request the session is already authenticated. CorsMiddleware does not
// help - it sets response headers, and the upgrade happens anyway.
describe('WebSocket Origin Middleware', () => {
  let adapter: Ergenecore;
  let server: Server<any>;
  let baseUrl: string;
  let wsUrl: string;
  let opened: number;

  beforeEach(() => {
    const wsAdapter = new ErgenecoreWebsocketAdapter(mockLogger);

    adapter = new Ergenecore(mockLogger, wsAdapter);
    adapter.setPort(0);
    opened = 0;
  });

  afterEach(async () => {
    if (server) {
      await adapter.stop();
    }
  });

  const start = async (middlewares: any[]) => {
    const chatService: Partial<AsenaWebSocketService<any>> = {
      namespace: 'chat',
      // @ts-ignore
      onOpenInternal: (socket: Socket) => {
        opened++;
        socket.send('welcome');
      },
    };

    await adapter.registerWebsocketRoute({
      path: 'chat',
      middlewares,
      websocketService: chatService as AsenaWebSocketService<any>,
    });

    server = await adapter.start();
    baseUrl = `http://localhost:${server.port}`;
    wsUrl = `ws://localhost:${server.port}/chat`;
  };

  const handshake = (headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/chat`, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': btoa('0123456789abcdef'),
        ...headers,
      },
    });

  const openSocket = (headers?: Record<string, string>): Promise<'open' | 'error' | 'timeout'> =>
    new Promise((resolve) => {
      // @ts-ignore - Bun accepts per-handshake headers
      const ws = new WebSocket(wsUrl, headers ? { headers } : undefined);

      ws.onopen = () => {
        ws.close();
        resolve('open');
      };
      ws.onerror = () => resolve('error');
      setTimeout(() => resolve('timeout'), 3000);
    });

  const allowedOrigins = ['https://app.example'];

  it('should reject a cookie-carrying handshake from a disallowed origin', async () => {
    await start([new WebSocketOriginMiddleware({ allowedOrigins })]);

    const response = await handshake({
      Origin: 'https://evil.example',
      Cookie: 'session=ok',
    });

    expect(response.status).toBe(403);
    // The upgrade must not have happened: a socket that opens is already authenticated
    expect(opened).toBe(0);
  });

  it('should fail a WebSocket client from a disallowed origin', async () => {
    await start([new WebSocketOriginMiddleware({ allowedOrigins })]);

    expect(await openSocket({ Origin: 'https://evil.example', Cookie: 'session=ok' })).toBe('error');
    expect(opened).toBe(0);
  });

  it('should upgrade a handshake from an allowed origin', async () => {
    await start([new WebSocketOriginMiddleware({ allowedOrigins })]);

    expect(await openSocket({ Origin: 'https://app.example' })).toBe('open');
    expect(opened).toBe(1);
  });

  it('should reject a handshake without an Origin by default', async () => {
    await start([new WebSocketOriginMiddleware({ allowedOrigins })]);

    expect((await handshake()).status).toBe(403);
    expect(await openSocket()).toBe('error');
    expect(opened).toBe(0);
  });

  it('should accept a handshake without an Origin when allowMissingOrigin is set', async () => {
    await start([new WebSocketOriginMiddleware({ allowedOrigins, allowMissingOrigin: true })]);

    // Also the proof that neither Bun client sends an Origin of its own - if one did, this
    // handshake would carry a disallowed origin and be rejected.
    expect(await openSocket()).toBe('open');
    expect(opened).toBe(1);
  });

  it('should support a predicate for wildcard subdomains', async () => {
    await start([new WebSocketOriginMiddleware({ allowedOrigins: (origin) => origin.endsWith('.example') })]);

    expect(await openSocket({ Origin: 'https://a.example' })).toBe('open');
    expect((await handshake({ Origin: 'https://a.evil' })).status).toBe(403);
    expect(opened).toBe(1);
  });

  it('should document that CorsMiddleware alone does not block a disallowed origin', async () => {
    await start([new CorsMiddleware({ origin: ['https://app.example'] })]);

    // The reason this middleware exists: CORS is a browser-side response policy, and the
    // handshake it was supposed to stop upgrades anyway.
    expect(await openSocket({ Origin: 'https://evil.example', Cookie: 'session=ok' })).toBe('open');
    expect(opened).toBe(1);
  });

  it('should short-circuit before the middlewares listed after it', async () => {
    let authCalls = 0;

    const countingAuth = {
      handle: async (_context: Context, next: () => Promise<void>) => {
        authCalls++;
        await next();
      },
    };

    await start([new WebSocketOriginMiddleware({ allowedOrigins }), countingAuth]);

    expect((await handshake({ Origin: 'https://evil.example' })).status).toBe(403);
    // Order is the point: an auth middleware that runs first would already have trusted the
    // cross-site session's cookie.
    expect(authCalls).toBe(0);
    expect(opened).toBe(0);
  });
});

let diSessionAuthCalls = 0;

@Middleware()
class ChatOrigin extends WebSocketOriginMiddleware {
  public constructor() {
    super({ allowedOrigins: ['https://app.example'] });
  }
}

@Middleware()
class SessionAuth extends MiddlewareService {
  public async handle(_context: Context, next: () => Promise<void>): Promise<any> {
    diSessionAuthCalls++;

    return await next();
  }
}

@WebSocketNamespace({ path: 'chat', middlewares: [ChatOrigin, SessionAuth] })
class ChatSocket extends AsenaWebSocketService<any> {}

describe('WebSocketOriginMiddleware registered through @WebSocket({ middlewares })', () => {
  let app: any;

  afterEach(async () => {
    await app?.stop();
    app = undefined;
  });

  const boot = async (): Promise<number> => {
    const port = 10000 + Math.floor(Math.random() * 22000);
    const silentLogger: ServerLogger = { info: () => {}, warn: () => {}, error: () => {}, profile: () => {} };

    diSessionAuthCalls = 0;
    app = await AsenaServerFactory.create({
      adapter: createErgenecoreAdapter({ logger: silentLogger }) as any,
      logger: silentLogger,
      port,
      components: [ChatOrigin, SessionAuth, ChatSocket],
    });
    await app.start();

    return port;
  };

  const handshake = (port: number, origin: string) =>
    fetch(`http://localhost:${port}/chat`, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': btoa('0123456789abcdef'),
        Origin: origin,
        Cookie: 'session=ok',
      },
    });

  it('should reject a disallowed origin before the session middleware runs', async () => {
    const port = await boot();

    expect((await handshake(port, 'https://evil.example')).status).toBe(403);
    expect(diSessionAuthCalls).toBe(0);
  });

  it('should upgrade an allowed origin through the session middleware', async () => {
    const port = await boot();

    expect((await handshake(port, 'https://app.example')).status).toBe(101);
    expect(diSessionAuthCalls).toBe(1);
  });
});
