import { afterEach, describe, expect, it, mock } from 'bun:test';
import { Ergenecore, ErgenecoreWebsocketAdapter } from '../lib';
import type { ServerLogger } from '@asenajs/asena/logger';
import type { AsenaWebSocketService, WebSocketTransport } from '@asenajs/asena/web-socket';
import type { Server } from 'bun';

const mockLogger: ServerLogger = {
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  profile: mock(() => {}),
};

/**
 * A transport that records the two lifecycle calls the framework makes on it.
 *
 * Stands in for RedisTransport and friends: everything a remote transport holds - a subscriber
 * connection with a live channel subscription, a publisher connection - is acquired in init()
 * and given back in destroy(). Counting the calls is therefore the same thing as asking whether
 * those connections were released.
 */
const createTransportSpy = (destroy: () => Promise<void> = async () => {}) => ({
  init: mock(async () => {}),
  publish: mock(() => {}),
  destroy: mock(destroy),
});

const createService = (namespace: string): AsenaWebSocketService<any> =>
  ({
    namespace,
    onOpenInternal: mock(() => {}),
    onCloseInternal: mock(() => {}),
  }) as unknown as AsenaWebSocketService<any>;

/** A socket the adapter's own handlers accept, without opening a real connection. */
const createSocket = (id: string, path = 'chat') => ({
  data: { path, id },
  readyState: WebSocket.OPEN,
  ping: mock(() => {}),
  close: mock(() => {}),
});

describe('ErgenecoreWebsocketAdapter - shutdown()', () => {
  let adapter: ErgenecoreWebsocketAdapter;

  afterEach(async () => {
    // A test that asserts on a *failing* shutdown leaves the timers behind by design
    for (const interval of adapter?.['heartbeatIntervals']?.values() ?? []) {
      clearInterval(interval);
    }
  });

  it('should destroy the configured transport', async () => {
    adapter = new ErgenecoreWebsocketAdapter(mockLogger);

    const transport = createTransportSpy();

    adapter.transport = transport as unknown as WebSocketTransport;

    await adapter.shutdown();

    expect(transport.destroy).toHaveBeenCalledTimes(1);
  });

  it('should tolerate a transport that declares no destroy()', async () => {
    adapter = new ErgenecoreWebsocketAdapter(mockLogger);

    // Both lifecycle hooks are optional on WebSocketTransport - BunLocalTransport has no
    // destroy() at all, because server.publish() owns nothing that has to be given back.
    adapter.transport = { publish: mock(() => {}) } as unknown as WebSocketTransport;

    await expect(adapter.shutdown()).resolves.toBeUndefined();
  });

  it('should tolerate no transport at all', async () => {
    adapter = new ErgenecoreWebsocketAdapter(mockLogger);

    await expect(adapter.shutdown()).resolves.toBeUndefined();
  });

  it('should stop the heartbeat timers, not merely forget them', async () => {
    adapter = new ErgenecoreWebsocketAdapter(mockLogger);

    adapter.registerWebSocket(createService('chat'));
    adapter.prepareWebSocket({ perMessageDeflate: undefined, heartbeatInterval: 20 });

    const socket = createSocket('conn-1');

    await adapter.websocket.open(socket as any);

    await Bun.sleep(70);

    const pingsBeforeShutdown = socket.ping.mock.calls.length;

    expect(pingsBeforeShutdown).toBeGreaterThan(0);

    await adapter.shutdown();

    expect(adapter['heartbeatIntervals'].size).toBe(0);

    // Emptying the map would satisfy the size assertion above while the interval kept firing.
    // The ping count is what proves clearInterval actually ran.
    await Bun.sleep(70);

    expect(socket.ping.mock.calls.length).toBe(pingsBeforeShutdown);
  });
});

describe('Ergenecore - stop()', () => {
  let adapter: Ergenecore;
  let wsAdapter: ErgenecoreWebsocketAdapter;
  let server: Server<any> | undefined;

  const build = () => {
    wsAdapter = new ErgenecoreWebsocketAdapter(mockLogger);
    adapter = new Ergenecore(mockLogger, wsAdapter);
    adapter.setPort(0);
  };

  afterEach(async () => {
    server = undefined;

    for (const interval of wsAdapter?.['heartbeatIntervals']?.values() ?? []) {
      clearInterval(interval);
    }

    (mockLogger.error as any).mockClear();
  });

  it('should release the WebSocket transport the server started with', async () => {
    build();

    const transport = createTransportSpy();

    wsAdapter.transport = transport as unknown as WebSocketTransport;

    await adapter.registerWebsocketRoute({
      path: '/chat',
      middlewares: [],
      websocketService: createService('chat'),
    });

    server = await adapter.start();

    expect(transport.init).toHaveBeenCalledTimes(1);
    expect(transport.destroy).not.toHaveBeenCalled();

    await adapter.stop();

    // The whole point: WebSocketTransport.destroy() had no call site anywhere in the framework,
    // so every stop() left a subscriber connection and its channel subscription behind.
    expect(transport.destroy).toHaveBeenCalledTimes(1);
  });

  it('should clear heartbeats when the server stops', async () => {
    build();

    await adapter.serveOptions(() => ({ wsOptions: { heartbeatInterval: 20 } }) as any);

    await adapter.registerWebsocketRoute({
      path: '/chat',
      middlewares: [],
      websocketService: createService('chat'),
    });

    server = await adapter.start();

    const socket = createSocket('conn-1');

    await wsAdapter.websocket.open(socket as any);

    expect(wsAdapter['heartbeatIntervals'].size).toBe(1);

    await adapter.stop();

    expect(wsAdapter['heartbeatIntervals'].size).toBe(0);

    const pingsAtShutdown = socket.ping.mock.calls.length;

    await Bun.sleep(70);

    expect(socket.ping.mock.calls.length).toBe(pingsAtShutdown);
  });

  it('should close the HTTP socket even when the transport refuses to be destroyed', async () => {
    build();

    const transport = createTransportSpy(async () => {
      throw new Error('broker connection already gone');
    });

    wsAdapter.transport = transport as unknown as WebSocketTransport;

    await adapter.registerWebsocketRoute({
      path: '/chat',
      middlewares: [],
      websocketService: createService('chat'),
    });

    server = await adapter.start();

    const port = server.port;

    // Must resolve, not reject: AsenaServer.runStop() awaits adapter.stop() unguarded, so an
    // error escaping here would strand the components' @OnStop hooks, the microservice
    // transports and ulak behind it.
    await expect(adapter.stop()).resolves.toBeUndefined();

    expect(transport.destroy).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('WebSocket shutdown failed'),
      expect.any(Error),
    );

    await expect(fetch(`http://localhost:${port}/`)).rejects.toThrow();
  });

  it('should release the WebSocket layer even when the HTTP stop fails', async () => {
    build();

    const transport = createTransportSpy();

    wsAdapter.transport = transport as unknown as WebSocketTransport;

    // A Bun server whose stop() rejects. The teardown of the WebSocket layer sits in a
    // `finally` precisely so a socket that will not close cannot also hold the broker
    // connection open.
    adapter['server'] = {
      stop: async () => {
        throw new Error('socket refused to close');
      },
    } as unknown as Server<any>;

    await expect(adapter.stop()).rejects.toThrow('socket refused to close');

    expect(transport.destroy).toHaveBeenCalledTimes(1);
  });
});
