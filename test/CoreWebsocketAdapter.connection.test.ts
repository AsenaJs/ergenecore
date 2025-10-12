import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { ErgenecoreWebsocketAdapter } from '../lib';
import type { ServerLogger } from '@asenajs/asena/logger';
import type { AsenaWebSocketService } from '@asenajs/asena/web-socket';

// Mock logger
const mockLogger: ServerLogger = {
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  profile: mock(() => {}),
};

describe('CoreWebsocketAdapter - Phase 6: Connection Tracking & Heartbeat', () => {
  let adapter: ErgenecoreWebsocketAdapter;

  beforeEach(() => {
    adapter = new ErgenecoreWebsocketAdapter(mockLogger);
    // Clear mock calls
    (mockLogger.info as any).mockClear();
    (mockLogger.warn as any).mockClear();
    (mockLogger.error as any).mockClear();
  });

  afterEach(() => {
    // Clean up any timers
    if (adapter['heartbeatIntervals']) {
      for (const interval of adapter['heartbeatIntervals'].values()) {
        clearInterval(interval);
      }
    }
  });

  describe('Connection Tracking', () => {
    it('should initialize with empty activeConnections map', () => {
      expect(adapter['activeConnections']).toBeDefined();
      expect(adapter['activeConnections']).toBeInstanceOf(Map);
      expect(adapter['activeConnections'].size).toBe(0);
    });

    it('should track connections when WebSocket opens', async () => {
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // @ts-ignore
        onOpenInternal: mock(() => {}),
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket();

      const mockWs: any = {
        data: { path: 'chat', id: 'conn-123' },
        readyState: WebSocket.OPEN,
      };

      await adapter.websocket.open(mockWs);

      expect(adapter['activeConnections'].has('chat')).toBe(true);
      expect(adapter['activeConnections'].get('chat')?.has('conn-123')).toBe(true);
      expect(adapter.getConnectionCount('chat')).toBe(1);
    });

    it('should track multiple connections in same namespace', async () => {
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // @ts-ignore
        onOpenInternal: mock(() => {}),
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket();

      const mockWs1: any = {
        data: { path: 'chat', id: 'conn-123' },
        readyState: WebSocket.OPEN,
      };
      const mockWs2: any = {
        data: { path: 'chat', id: 'conn-456' },
        readyState: WebSocket.OPEN,
      };

      await adapter.websocket.open(mockWs1);
      await adapter.websocket.open(mockWs2);

      expect(adapter.getConnectionCount('chat')).toBe(2);
      expect(adapter['activeConnections'].get('chat')?.has('conn-123')).toBe(true);
      expect(adapter['activeConnections'].get('chat')?.has('conn-456')).toBe(true);
    });

    it('should remove connection from tracking when WebSocket closes', async () => {
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // @ts-ignore
        onOpenInternal: mock(() => {}),
        onCloseInternal: mock(() => {}),
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket();

      const mockWs: any = {
        data: { path: 'chat', id: 'conn-123' },
        readyState: WebSocket.OPEN,
      };

      await adapter.websocket.open(mockWs);
      expect(adapter.getConnectionCount('chat')).toBe(1);

      mockWs.readyState = WebSocket.CLOSED;
      await adapter.websocket.close(mockWs, 1000, 'Normal closure');

      expect(adapter.getConnectionCount('chat')).toBe(0);
    });

    it('should track connections separately for different namespaces', async () => {
      const chatService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // @ts-ignore
        onOpenInternal: mock(() => {}),
      };
      const notifyService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'notifications',
        // @ts-ignore
        onOpenInternal: mock(() => {}),
      };

      adapter.registerWebSocket(chatService as AsenaWebSocketService<any>);
      adapter.registerWebSocket(notifyService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket();

      const mockWs1: any = {
        data: { path: 'chat', id: 'conn-123' },
        readyState: WebSocket.OPEN,
      };
      const mockWs2: any = {
        data: { path: 'notifications', id: 'conn-456' },
        readyState: WebSocket.OPEN,
      };

      await adapter.websocket.open(mockWs1);
      await adapter.websocket.open(mockWs2);

      expect(adapter.getConnectionCount('chat')).toBe(1);
      expect(adapter.getConnectionCount('notifications')).toBe(1);
    });

    it('should return 0 for non-existent namespace', () => {
      expect(adapter.getConnectionCount('non-existent')).toBe(0);
    });
  });

  describe('Connection Limits', () => {
    it('should set connection limit for a namespace', () => {
      adapter.setConnectionLimit('chat', 10);

      expect(adapter['connectionLimits'].get('chat')).toBe(10);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Connection limit set for namespace "chat": 10'),
      );
    });

    it('should throw error for invalid connection limit (less than 1)', () => {
      expect(() => {
        adapter.setConnectionLimit('chat', 0);
      }).toThrow('Connection limit must be at least 1');

      expect(() => {
        adapter.setConnectionLimit('chat', -5);
      }).toThrow('Connection limit must be at least 1');
    });

    it('should reject connection when limit is reached', async () => {
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // @ts-ignore
        onOpenInternal: mock(() => {}),
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket();
      adapter.setConnectionLimit('chat', 2); // Limit to 2 connections

      const mockWs1: any = {
        data: { path: 'chat', id: 'conn-1' },
        readyState: WebSocket.OPEN,
        close: mock(() => {}),
      };
      const mockWs2: any = {
        data: { path: 'chat', id: 'conn-2' },
        readyState: WebSocket.OPEN,
        close: mock(() => {}),
      };
      const mockWs3: any = {
        data: { path: 'chat', id: 'conn-3' },
        readyState: WebSocket.OPEN,
        close: mock(() => {}),
      };

      await adapter.websocket.open(mockWs1);
      await adapter.websocket.open(mockWs2);
      await adapter.websocket.open(mockWs3); // Should be rejected

      expect(adapter.getConnectionCount('chat')).toBe(2);
      expect(mockWs3.close).toHaveBeenCalledWith(1008, 'Connection limit reached');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Connection limit reached for namespace "chat"'),
      );
    });

    it('should allow new connection after one closes (within limit)', async () => {
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // @ts-ignore
        onOpenInternal: mock(() => {}),
        onCloseInternal: mock(() => {}),
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket();
      adapter.setConnectionLimit('chat', 2);

      const mockWs1: any = {
        data: { path: 'chat', id: 'conn-1' },
        readyState: WebSocket.OPEN,
      };
      const mockWs2: any = {
        data: { path: 'chat', id: 'conn-2' },
        readyState: WebSocket.OPEN,
      };

      await adapter.websocket.open(mockWs1);
      await adapter.websocket.open(mockWs2);
      expect(adapter.getConnectionCount('chat')).toBe(2);

      // Close first connection
      mockWs1.readyState = WebSocket.CLOSED;
      await adapter.websocket.close(mockWs1, 1000, 'Normal closure');
      expect(adapter.getConnectionCount('chat')).toBe(1);

      // Now third connection should be allowed
      const mockWs3: any = {
        data: { path: 'chat', id: 'conn-3' },
        readyState: WebSocket.OPEN,
      };

      await adapter.websocket.open(mockWs3);
      expect(adapter.getConnectionCount('chat')).toBe(2);
    });
  });

  describe('Heartbeat Mechanism', () => {
    it('should start heartbeat when connection opens with heartbeat option', async () => {
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // @ts-ignore
        onOpenInternal: mock(() => {}),
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket({ perMessageDeflate: undefined, heartbeatInterval: 1000 });

      const mockWs: any = {
        data: { path: 'chat', id: 'conn-123' },
        readyState: WebSocket.OPEN,
        ping: mock(() => {}),
      };

      await adapter.websocket.open(mockWs);

      expect(adapter['heartbeatIntervals'].has('conn-123')).toBe(true);
    });

    it('should send ping at heartbeat interval', async () => {
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // @ts-ignore
        onOpenInternal: mock(() => {}),
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket({ perMessageDeflate: undefined, heartbeatInterval: 100 }); // Short interval for testing

      const mockWs: any = {
        data: { path: 'chat', id: 'conn-123' },
        readyState: WebSocket.OPEN,
        ping: mock(() => {}),
      };

      await adapter.websocket.open(mockWs);

      // Wait for heartbeat
      await Bun.sleep(150);

      expect(mockWs.ping).toHaveBeenCalled();
    });

    it('should stop heartbeat when connection closes', async () => {
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // @ts-ignore
        onOpenInternal: mock(() => {}),
        onCloseInternal: mock(() => {}),
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket({ perMessageDeflate: undefined, heartbeatInterval: 1000 });

      const mockWs: any = {
        data: { path: 'chat', id: 'conn-123' },
        readyState: WebSocket.OPEN,
        ping: mock(() => {}),
      };

      await adapter.websocket.open(mockWs);
      expect(adapter['heartbeatIntervals'].has('conn-123')).toBe(true);

      mockWs.readyState = WebSocket.CLOSED;
      await adapter.websocket.close(mockWs, 1000, 'Normal closure');

      expect(adapter['heartbeatIntervals'].has('conn-123')).toBe(false);
    });

    it('should close connection if heartbeat ping fails', async () => {
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // @ts-ignore
        onOpenInternal: mock(() => {}),
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket({ perMessageDeflate: undefined, heartbeatInterval: 100 });

      const mockWs: any = {
        data: { path: 'chat', id: 'conn-123' },
        readyState: WebSocket.OPEN,
        ping: mock(() => {
          throw new Error('Ping failed');
        }),
        close: mock(() => {}),
      };

      await adapter.websocket.open(mockWs);

      // Wait for heartbeat to trigger
      await Bun.sleep(150);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Heartbeat ping failed'),
        expect.anything(),
      );
      expect(mockWs.close).toHaveBeenCalledWith(1011, 'Heartbeat failed');
    });

    it('should not start heartbeat if heartbeatInterval is not provided', async () => {
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // @ts-ignore
        onOpenInternal: mock(() => {}),
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket(); // No heartbeat option

      const mockWs: any = {
        data: { path: 'chat', id: 'conn-123' },
        readyState: WebSocket.OPEN,
      };

      await adapter.websocket.open(mockWs);

      expect(adapter['heartbeatIntervals'].has('conn-123')).toBe(false);
    });
  });

  describe('Graceful Shutdown', () => {
    it('should clear all heartbeat intervals on shutdown', async () => {
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // @ts-ignore
        onOpenInternal: mock(() => {}),
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket({ perMessageDeflate: undefined, heartbeatInterval: 1000 });

      const mockWs1: any = {
        data: { path: 'chat', id: 'conn-1' },
        readyState: WebSocket.OPEN,
        ping: mock(() => {}),
      };
      const mockWs2: any = {
        data: { path: 'chat', id: 'conn-2' },
        readyState: WebSocket.OPEN,
        ping: mock(() => {}),
      };

      await adapter.websocket.open(mockWs1);
      await adapter.websocket.open(mockWs2);

      expect(adapter['heartbeatIntervals'].size).toBe(2);

      await adapter.shutdown();

      expect(adapter['heartbeatIntervals'].size).toBe(0);
    });

    it('should clear all connection tracking on shutdown', async () => {
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // @ts-ignore
        onOpenInternal: mock(() => {}),
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket();

      const mockWs1: any = {
        data: { path: 'chat', id: 'conn-1' },
        readyState: WebSocket.OPEN,
      };
      const mockWs2: any = {
        data: { path: 'chat', id: 'conn-2' },
        readyState: WebSocket.OPEN,
      };

      await adapter.websocket.open(mockWs1);
      await adapter.websocket.open(mockWs2);

      expect(adapter.getConnectionCount('chat')).toBe(2);

      await adapter.shutdown();

      expect(adapter['activeConnections'].size).toBe(0);
    });

    it('should log shutdown progress', async () => {
      await adapter.shutdown();

      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Starting WebSocket graceful shutdown'));
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('WebSocket shutdown complete'));
    });

    it('should complete shutdown within timeout', async () => {
      const startTime = Date.now();

      await adapter.shutdown(1000);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(1100); // Should complete quickly
    });
  });

  describe('Edge Cases', () => {
    it('should handle connection tracking for unknown namespace gracefully', async () => {
      // Register a service, but try to connect to a different namespace
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket();

      const mockWs: any = {
        data: { path: 'unknown-namespace', id: 'conn-123' },
        readyState: WebSocket.OPEN,
        close: mock(() => {}),
      };

      // Should not throw, but should close connection
      await adapter.websocket.open(mockWs);

      expect(mockWs.close).toHaveBeenCalledWith(1011, 'Internal server error: handler not found');
    });

    it('should handle multiple shutdown calls gracefully', async () => {
      await adapter.shutdown();
      await adapter.shutdown();
      await adapter.shutdown();

      // Should not throw
      expect(mockLogger.info).toHaveBeenCalled();
    });

    it('should track connections correctly when same connection ID used in different namespaces', async () => {
      const chatService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // @ts-ignore
        onOpenInternal: mock(() => {}),
      };
      const notifyService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'notifications',
        // @ts-ignore
        onOpenInternal: mock(() => {}),
      };

      adapter.registerWebSocket(chatService as AsenaWebSocketService<any>);
      adapter.registerWebSocket(notifyService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket();

      const mockWs1: any = {
        data: { path: 'chat', id: 'conn-123' },
        readyState: WebSocket.OPEN,
      };
      const mockWs2: any = {
        data: { path: 'notifications', id: 'conn-123' }, // Same ID, different namespace
        readyState: WebSocket.OPEN,
      };

      await adapter.websocket.open(mockWs1);
      await adapter.websocket.open(mockWs2);

      expect(adapter.getConnectionCount('chat')).toBe(1);
      expect(adapter.getConnectionCount('notifications')).toBe(1);
    });
  });
});
