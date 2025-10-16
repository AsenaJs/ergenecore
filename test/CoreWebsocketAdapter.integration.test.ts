import { describe, expect, it, beforeAll, afterAll, mock } from 'bun:test';
import { Ergenecore } from '../lib';
import { ErgenecoreWebsocketAdapter } from '../lib';
import type { ServerLogger } from '@asenajs/asena/logger';
import type { AsenaWebSocketService } from '@asenajs/asena/web-socket';
import type { Socket } from '@asenajs/asena/web-socket';

// Mock logger
const mockLogger: ServerLogger = {
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  profile: mock(() => {}),
};

describe('CoreWebsocketAdapter - Integration Tests', () => {
  let adapter: Ergenecore;
  let wsAdapter: ErgenecoreWebsocketAdapter;
  let port: number;

  beforeAll(async () => {
    // Find available port
    port = 45000 + Math.floor(Math.random() * 1000);

    wsAdapter = new ErgenecoreWebsocketAdapter(mockLogger);
    adapter = new Ergenecore(mockLogger, wsAdapter);

    // Register WebSocket services
    const chatService: Partial<AsenaWebSocketService<any>> = {
      namespace: 'chat',
      // @ts-ignore
      onOpenInternal: (socket: Socket) => {
        socket.send('Welcome!');
      },
    };

    const echoService: Partial<AsenaWebSocketService<any>> = {
      namespace: 'echo',
      // @ts-ignore
      onOpenInternal: (socket: Socket) => {
        socket.send('Connected');
      },
      onMessage: (socket: Socket, message: string) => {
        socket.send(`Echo: ${message}`);
      },
    };

    const closableService: Partial<AsenaWebSocketService<any>> = {
      namespace: 'closable',
      // @ts-ignore
      onCloseInternal: () => {},
    };

    const multiService: Partial<AsenaWebSocketService<any>> = {
      namespace: 'multi',
    };

    const limitedService: Partial<AsenaWebSocketService<any>> = {
      namespace: 'limited',
    };

    // Register WebSocket routes using new architecture
    adapter.registerWebsocketRoute({
      path: 'chat',
      middlewares: [],
      websocketService: chatService as AsenaWebSocketService<any>,
    });

    adapter.registerWebsocketRoute({
      path: 'echo',
      middlewares: [],
      websocketService: echoService as AsenaWebSocketService<any>,
    });

    adapter.registerWebsocketRoute({
      path: 'closable',
      middlewares: [],
      websocketService: closableService as AsenaWebSocketService<any>,
    });

    adapter.registerWebsocketRoute({
      path: 'multi',
      middlewares: [],
      websocketService: multiService as AsenaWebSocketService<any>,
    });

    adapter.registerWebsocketRoute({
      path: 'limited',
      middlewares: [],
      websocketService: limitedService as AsenaWebSocketService<any>,
    });

    wsAdapter.setConnectionLimit('limited', 2);

    // Start server
    adapter.setPort(port);
    adapter.hostname = '0.0.0.0';
    await adapter.start();
    await Bun.sleep(100); // Give server time to start
  });

  afterAll(() => {
    // Force cleanup without waiting
    // In test environment, we don't need graceful shutdown
    try {
      if (adapter['server']) {
        adapter['server'].stop(false);
      }
    } catch (error) {
      // Ignore errors during cleanup
    }
  });

  describe('WebSocket Upgrade Flow', () => {
    it('should upgrade HTTP connection to WebSocket and receive welcome message', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/chat`);

      const receivedMessage = await new Promise<string>((resolve, reject) => {
        ws.onmessage = (event) => resolve(event.data);
        ws.onerror = (error) => reject(error);
        setTimeout(() => reject(new Error('Connection timeout')), 5000);
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      expect(receivedMessage).toBe('Welcome!');

      ws.close();
    });

    it('should handle message exchange between client and server', async () => {
      const receivedMessages: string[] = [];

      const ws = new WebSocket(`ws://localhost:${port}/echo`);

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send('Hello Server!');
        };

        ws.onmessage = (event) => {
          receivedMessages.push(event.data);
          if (receivedMessages.length === 2) {
            resolve();
          }
        };

        ws.onerror = (error) => reject(error);
        setTimeout(() => reject(new Error('Message timeout')), 5000);
      });

      expect(receivedMessages).toContain('Connected');
      expect(receivedMessages).toContain('Echo: Hello Server!');

      ws.close();
    });

    it('should handle connection close events', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/closable`);

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.close(1000, 'Client disconnect');
        };
        ws.onclose = () => resolve();
        ws.onerror = (error) => reject(error);
        setTimeout(() => reject(new Error('Close timeout')), 5000);
      });

      // Give server time to process close event
      await Bun.sleep(100);

      // onCloseInternal should have been called (we can't directly test mock, but connection is closed)
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    });

    it('should reject connection when namespace does not exist', async () => {
      const ws = new WebSocket(`ws://localhost:${port}/non-existent`);

      const closeEvent = await new Promise<CloseEvent>((resolve) => {
        ws.onclose = (event) => resolve(event);
      });

      // Connection should close with error (various close codes possible)
      expect([1002, 1006, 1011]).toContain(closeEvent.code);
    });
  });

  describe('Multiple Connections', () => {
    it('should handle multiple concurrent connections to same namespace', async () => {
      const ws1 = new WebSocket(`ws://localhost:${port}/multi`);
      const ws2 = new WebSocket(`ws://localhost:${port}/multi`);
      const ws3 = new WebSocket(`ws://localhost:${port}/multi`);

      await Promise.all([
        new Promise<void>((resolve) => {
          ws1.onopen = () => resolve();
        }),
        new Promise<void>((resolve) => {
          ws2.onopen = () => resolve();
        }),
        new Promise<void>((resolve) => {
          ws3.onopen = () => resolve();
        }),
      ]);

      expect(ws1.readyState).toBe(WebSocket.OPEN);
      expect(ws2.readyState).toBe(WebSocket.OPEN);
      expect(ws3.readyState).toBe(WebSocket.OPEN);

      // Check connection count
      expect(wsAdapter.getConnectionCount('multi')).toBe(3);

      ws1.close();
      ws2.close();
      ws3.close();

      // Wait for closes to be processed
      await Bun.sleep(100);

      expect(wsAdapter.getConnectionCount('multi')).toBe(0);
    });

    it('should enforce connection limits per namespace', async () => {
      // First, ensure namespace is clear
      await Bun.sleep(200);

      const ws1 = new WebSocket(`ws://localhost:${port}/limited`);
      const ws2 = new WebSocket(`ws://localhost:${port}/limited`);

      // Wait for first two to connect
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          ws1.onopen = () => resolve();
          ws1.onerror = () => reject(new Error('ws1 failed to connect'));
          setTimeout(() => reject(new Error('ws1 connection timeout')), 3000);
        }),
        new Promise<void>((resolve, reject) => {
          ws2.onopen = () => resolve();
          ws2.onerror = () => reject(new Error('ws2 failed to connect'));
          setTimeout(() => reject(new Error('ws2 connection timeout')), 3000);
        }),
      ]);

      expect(ws1.readyState).toBe(WebSocket.OPEN);
      expect(ws2.readyState).toBe(WebSocket.OPEN);

      // Now try third connection - should be rejected
      const ws3 = new WebSocket(`ws://localhost:${port}/limited`);

      const ws3CloseEvent = await new Promise<CloseEvent>((resolve) => {
        ws3.onclose = (event) => resolve(event);

        // @ts-ignore
        const closeEvetn: CloseEvent = { code: 0 };

        setTimeout(() => resolve(closeEvetn), 2000); // Timeout fallback
      });

      expect(ws3CloseEvent.code).toBe(1008); // Policy violation

      ws1.close();
      ws2.close();

      // Wait for cleanup
      await Bun.sleep(200);
    });
  });

  describe('Graceful Shutdown', () => {
    it('should clean up connection tracking on shutdown', async () => {
      expect(wsAdapter.getConnectionCount('multi')).toBe(0); // From previous cleanup

      await wsAdapter.shutdown();

      // Should still be 0 after shutdown
      expect(wsAdapter.getConnectionCount('multi')).toBe(0);
    });
  });
});
