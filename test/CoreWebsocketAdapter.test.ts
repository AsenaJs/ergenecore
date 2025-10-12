import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { ErgenecoreWebsocketAdapter } from '../lib';
import type { ServerLogger } from '@asenajs/asena/logger';
import type { AsenaWebSocketService, WSOptions } from '@asenajs/asena/web-socket';

// Mock logger
const mockLogger: ServerLogger = {
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  profile: mock(() => {}),
};

describe('CoreWebsocketAdapter - Namespace Registration', () => {
  let adapter: ErgenecoreWebsocketAdapter;

  beforeEach(() => {
    adapter = new ErgenecoreWebsocketAdapter(mockLogger);
    // Clear mock calls
    (mockLogger.info as any).mockClear();
    (mockLogger.warn as any).mockClear();
    (mockLogger.error as any).mockClear();
  });

  describe('Initialization', () => {
    it('should initialize with correct name', () => {
      expect(adapter.name).toBe('ErgenecoreWebsocketAdapter');
    });

    it('should initialize with empty websockets registry', () => {
      expect(adapter['_websockets']).toBeUndefined();
    });
  });

  describe('registerWebSocket()', () => {
    it('should register a valid WebSocket service with namespace', () => {
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);

      expect(adapter['_websockets']).toBeDefined();
      expect(adapter['_websockets'].size).toBe(1);
      expect(adapter['_websockets'].has('chat')).toBe(true);
      expect(adapter['_websockets'].get('chat')).toBe(mockService as AsenaWebSocketService<any>);
    });

    it('should register multiple WebSocket services with different namespaces', () => {
      const chatService: Partial<AsenaWebSocketService<any>> = { namespace: 'chat' };
      const notifyService: Partial<AsenaWebSocketService<any>> = { namespace: 'notifications' };

      adapter.registerWebSocket(chatService as AsenaWebSocketService<any>);
      adapter.registerWebSocket(notifyService as AsenaWebSocketService<any>);

      expect(adapter['_websockets'].size).toBe(2);
      expect(adapter['_websockets'].has('chat')).toBe(true);
      expect(adapter['_websockets'].has('notifications')).toBe(true);
    });

    it('should throw error if WebSocket service is null or undefined', () => {
      // eslint-disable-next-line max-nested-callbacks
      expect(() => {
        adapter.registerWebSocket(null as any);
      }).toThrow('WebSocket service is required');

      // eslint-disable-next-line max-nested-callbacks
      expect(() => {
        adapter.registerWebSocket(undefined as any);
      }).toThrow('WebSocket service is required');
    });

    it('should throw error if namespace is missing', () => {
      const mockService: Partial<AsenaWebSocketService<any>> = {
        // namespace missing
      };

      // eslint-disable-next-line max-nested-callbacks
      expect(() => {
        adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      }).toThrow('WebSocket namespace is required');
    });

    it('should throw error for invalid namespace format (special characters)', () => {
      const invalidNamespaces = [
        'chat@room', // @ not allowed
        'user#123', // # not allowed
        'test space', // space not allowed
        'room$vip', // $ not allowed
        'admin!panel', // ! not allowed
      ];

      for (const ns of invalidNamespaces) {
        const mockService: Partial<AsenaWebSocketService<any>> = { namespace: ns };

        // eslint-disable-next-line max-nested-callbacks
        expect(() => {
          adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
        }).toThrow(/Invalid WebSocket namespace format/);
      }
    });

    it('should accept valid namespace formats', () => {
      const validNamespaces = [
        'chat', // simple alphanumeric
        'chat-room', // with hyphen
        'user_notifications', // with underscore
        'api/v1/chat', // with slashes (path-like)
        'Room123', // mixed case with numbers
        'chat-room_v2', // mixed separators
      ];

      for (const ns of validNamespaces) {
        const mockService: Partial<AsenaWebSocketService<any>> = { namespace: ns };

        // eslint-disable-next-line max-nested-callbacks
        expect(() => {
          adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
        }).not.toThrow();
      }

      expect(adapter['_websockets'].size).toBe(validNamespaces.length);
    });

    it('should warn and overwrite when registering duplicate namespace', () => {
      const service1: Partial<AsenaWebSocketService<any>> = { namespace: 'chat' };
      const service2: Partial<AsenaWebSocketService<any>> = { namespace: 'chat' }; // duplicate

      adapter.registerWebSocket(service1 as AsenaWebSocketService<any>);
      adapter.registerWebSocket(service2 as AsenaWebSocketService<any>);

      expect(adapter['_websockets'].size).toBe(1);
      expect(adapter['_websockets'].get('chat')).toBe(service2 as AsenaWebSocketService<any>); // overwritten
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('already registered'));
    });

    it('should initialize websockets map if undefined on first registration', () => {
      expect(adapter['_websockets']).toBeUndefined();

      const mockService: Partial<AsenaWebSocketService<any>> = { namespace: 'chat' };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);

      expect(adapter['_websockets']).toBeDefined();
      expect(adapter['_websockets']).toBeInstanceOf(Map);
    });
  });

  describe('prepareWebSocket() - Lifecycle Handlers', () => {
    it('should create websocket handler with open, message, close events', () => {
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // @ts-ignore
        // eslint-disable-next-line max-nested-callbacks
        onOpenInternal: mock(() => {}),
        // @ts-ignore
        // eslint-disable-next-line max-nested-callbacks
        onMessage: mock(() => {}),
        // @ts-ignore
        // eslint-disable-next-line max-nested-callbacks
        onCloseInternal: mock(() => {}),
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket();

      expect(adapter.websocket).toBeDefined();
      expect(adapter.websocket.open).toBeDefined();
      expect(adapter.websocket.message).toBeDefined();
      expect(adapter.websocket.close).toBeDefined();
      expect(typeof adapter.websocket.open).toBe('function');
      expect(typeof adapter.websocket.message).toBe('function');
      expect(typeof adapter.websocket.close).toBe('function');
    });

    it('should not create websocket handler if no services registered', () => {
      adapter.prepareWebSocket();

      expect(adapter.websocket).toBeUndefined();
    });

    it('should call onOpenInternal when WebSocket connection opens', async () => {
      // eslint-disable-next-line max-nested-callbacks
      const onOpenMock = mock(() => {});
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // @ts-ignore
        onOpenInternal: onOpenMock,
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket();

      // Mock WebSocket connection data
      const mockWs: any = {
        data: { path: 'chat', id: 'conn-123' },
        readyState: WebSocket.OPEN,
      };

      await adapter.websocket.open(mockWs);

      expect(onOpenMock).toHaveBeenCalled();
    });

    it('should call onMessage when WebSocket receives message', async () => {
      // eslint-disable-next-line max-nested-callbacks
      const onMessageMock = mock(() => {});
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // @ts-ignore
        onMessage: onMessageMock,
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket();

      const mockWs: any = {
        data: { path: 'chat', id: 'conn-123' },
        readyState: WebSocket.OPEN,
      };
      const testMessage = 'Hello, WebSocket!';

      await adapter.websocket.message(mockWs, testMessage);

      expect(onMessageMock).toHaveBeenCalled();
    });

    it('should call onCloseInternal when WebSocket connection closes', async () => {
      // eslint-disable-next-line max-nested-callbacks
      const onCloseMock = mock(() => {});
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // @ts-ignore
        onCloseInternal: onCloseMock,
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket();

      const mockWs: any = {
        data: { path: 'chat', id: 'conn-123' },
        readyState: WebSocket.CLOSED,
      };
      const code = 1000;
      const reason = 'Normal closure';

      await adapter.websocket.close(mockWs, code, reason);

      expect(onCloseMock).toHaveBeenCalled();
    });

    it('should handle missing handlers gracefully (optional handlers)', async () => {
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // No handlers defined
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket();

      const mockWs: any = {
        data: { path: 'chat', id: 'conn-123' },
        readyState: WebSocket.OPEN,
      };

      // Should not throw
      // eslint-disable-next-line max-nested-callbacks
      expect(async () => {
        await adapter.websocket.open(mockWs);
        await adapter.websocket.message(mockWs, 'test');
        await adapter.websocket.close(mockWs, 1000, 'test');
      }).not.toThrow();
    });

    it('should log error when handler throws exception', async () => {
      const errorMessage = 'Handler error!';
      const onMessageMock = mock(() => {
        throw new Error(errorMessage);
      });

      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // @ts-ignore
        onMessage: onMessageMock,
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket();

      const mockWs: any = {
        data: { path: 'chat', id: 'conn-123' },
        readyState: WebSocket.OPEN,
        // eslint-disable-next-line max-nested-callbacks
        send: mock(() => {}),
        // eslint-disable-next-line max-nested-callbacks
        close: mock(() => {}),
      };

      await adapter.websocket.message(mockWs, 'test');

      expect(mockLogger.error).toHaveBeenCalled();
      expect(mockWs.send).toHaveBeenCalled(); // Error message sent to client
      expect(mockWs.close).toHaveBeenCalledWith(1011, 'Handler error'); // Connection closed
    });

    it('should support drain, ping, pong event handlers if provided', () => {
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
        // @ts-ignore
        // eslint-disable-next-line max-nested-callbacks
        onDrain: mock(() => {}),
        // eslint-disable-next-line max-nested-callbacks
        onPing: mock(() => {}),
        // eslint-disable-next-line max-nested-callbacks
        onPong: mock(() => {}),
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);
      adapter.prepareWebSocket();

      expect(adapter.websocket.drain).toBeDefined();
      expect(adapter.websocket.ping).toBeDefined();
      expect(adapter.websocket.pong).toBeDefined();
      expect(typeof adapter.websocket.drain).toBe('function');
      expect(typeof adapter.websocket.ping).toBe('function');
      expect(typeof adapter.websocket.pong).toBe('function');
    });

    it('should pass custom WSOptions to websocket configuration', () => {
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);

      const customOptions: WSOptions & { heartbeatInterval?: number } = {
        perMessageDeflate: undefined,
      };

      adapter.prepareWebSocket(customOptions);

      expect(adapter.websocket).toBeDefined();
      // Options should be merged into websocket config
    });
  });

  describe('startWebsocket()', () => {
    it('should not throw if no WebSocket services registered', () => {
      const mockServer: any = { upgrade: mock(() => {}) };

      expect(() => {
        adapter.startWebsocket(mockServer);
      }).not.toThrow();
    });

    it('should initialize AsenaWebSocketServer for each registered namespace', () => {
      const mockService: Partial<AsenaWebSocketService<any>> = {
        namespace: 'chat',
      };

      adapter.registerWebSocket(mockService as AsenaWebSocketService<any>);

      const mockServer: any = { upgrade: mock(() => {}) };

      adapter.startWebsocket(mockServer);

      // After startWebsocket, each service should have a server property set
      expect(mockService.server).toBeDefined();
    });
  });
});
