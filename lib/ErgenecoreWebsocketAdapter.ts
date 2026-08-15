import { AsenaWebsocketAdapter } from '@asenajs/asena/adapter';
import type { ServerLogger } from '@asenajs/asena/logger';
import type { Server, ServerWebSocket } from 'bun';
import type { AsenaWebSocketService } from '@asenajs/asena/web-socket';
import {
  AsenaSocket,
  AsenaWebSocketServer,
  BunLocalTransport,
  type WebSocketData,
  type WSEvents,
  type WSOptions,
} from '@asenajs/asena/web-socket';

/**
 * CoreWebsocketAdapter - WebSocket adapter for Bun
 *
 * Uses Bun's native WebSocket API with namespace-based routing
 */
export class ErgenecoreWebsocketAdapter extends AsenaWebsocketAdapter {
  public name = 'ErgenecoreWebsocketAdapter';

  private activeConnections: Map<string, Set<string>> = new Map(); // namespace -> Set of connection IDs

  private connectionLimits: Map<string, number> = new Map(); // namespace -> max connections

  public constructor(logger: ServerLogger) {
    super(logger);
  }

  /**
   * Registers a WebSocket service with namespace (base class implementation)
   * @param webSocketService - WebSocket service to register
   */
  public registerWebSocket(webSocketService: AsenaWebSocketService<any>): void {
    if (!webSocketService) {
      throw new Error('WebSocket service is required');
    }

    if (!webSocketService.namespace) {
      throw new Error('WebSocket namespace is required');
    }

    // Validate namespace format: alphanumeric, hyphens, underscores, and slashes allowed
    const namespaceRegex = /^[a-zA-Z0-9/_-]+$/;

    if (!namespaceRegex.test(webSocketService.namespace)) {
      throw new Error(
        `Invalid WebSocket namespace format: "${webSocketService.namespace}". Only alphanumeric characters, hyphens, underscores, and slashes are allowed.`,
      );
    }

    // Initialize websockets map if needed
    if (this._websockets === undefined) {
      this._websockets = new Map<string, AsenaWebSocketService<any>>();
    }

    // Check for duplicate registration
    if (this._websockets.has(webSocketService.namespace)) {
      this.logger.warn(
        `WebSocket namespace "${webSocketService.namespace}" is already registered. Overwriting previous registration...`,
      );
    }

    this._websockets.set(webSocketService.namespace, webSocketService);
  }

  /**
   * Sets maximum connections allowed per namespace
   * @param namespace - WebSocket namespace
   * @param limit - Maximum number of concurrent connections
   */
  public setConnectionLimit(namespace: string, limit: number): void {
    if (limit < 1) {
      throw new Error('Connection limit must be at least 1');
    }

    this.connectionLimits.set(namespace, limit);
    this.logger.info(`Connection limit set for namespace "${namespace}": ${limit}`);
  }

  /**
   * Gets active connection count for a namespace
   * @param namespace - WebSocket namespace
   * @returns Number of active connections
   */
  public getConnectionCount(namespace: string): number {
    return this.activeConnections.get(namespace)?.size || 0;
  }

  /**
   * Graceful shutdown - closes all connections
   * @param _timeoutMs - Timeout for graceful shutdown (default: 5000)
   */
  public async shutdown(_timeoutMs = 5000): Promise<void> {
    this.logger.info('Starting WebSocket graceful shutdown...');

    // Stop all heartbeats
    this.clearAllHeartbeats();

    // Clear connection tracking
    this.activeConnections.clear();

    // Release the transport. Both hooks are optional on the contract - BunLocalTransport declares
    // neither, because server.publish() owns nothing that has to be given back - but a remote
    // transport holds a subscriber connection with a live channel subscription plus a publisher
    // connection, and destroy() had no call site anywhere in the framework. A pod that restarts
    // in-process (a test suite, a watch-mode reload) therefore leaked two broker connections per
    // cycle until the broker refused new ones.
    //
    // Last, after the HTTP surface is already down: a close handler running during the drain may
    // still broadcast, and publish() on a destroyed transport is a null dereference.
    await this.transport?.destroy?.();

    this.logger.info('WebSocket shutdown complete');
  }

  /**
   * Prepares WebSocket configuration with lifecycle handlers
   * @param options - WebSocket options
   */
  public prepareWebSocket(options?: WSOptions): void {
    if (!this.websockets || this.websockets.size < 1) {
      return;
    }

    const strategy = options?.sendPingStrategy ?? 'adapter';
    // Heartbeat is only used in adapter strategy
    const heartbeatInterval = strategy === 'adapter' ? options?.heartbeatInterval : undefined;

    // Separate strategy/heartbeat fields from WSOptions to avoid conflicts
    const {
      sendPings: _sendPings,
      sendPingStrategy: _strategy,
      heartbeatInterval: _hbInterval,
      ...restOptions
    } = options ?? ({} as any);

    this.websocket = {
      // Strategy controls sendPings:
      //   'adapter' → false (Bun native disabled, adapter handles keepalive)
      //   'native'  → true  (Bun native handles ping/pong)
      // See: https://github.com/oven-sh/bun/issues/26554
      sendPings: strategy === 'native',

      open: async (ws: ServerWebSocket<WebSocketData>) => {
        // Normalize to namespace format (remove leading /)
        const namespace = ws.data.path.replace(/^\//, '');

        // Check connection limit
        const limit = this.connectionLimits.get(namespace);
        const currentCount = this.getConnectionCount(namespace);

        if (limit && currentCount >= limit) {
          this.logger.warn(
            `Connection limit reached for namespace "${namespace}": ${currentCount}/${limit}. Rejecting new connection.`,
          );

          ws.close(1008, 'Connection limit reached');

          return;
        }

        // Track connection
        if (!this.activeConnections.has(namespace)) {
          this.activeConnections.set(namespace, new Set());
        }

        this.activeConnections.get(namespace).add(ws.data.id);

        // Start heartbeat if enabled (adapter strategy only)
        if (heartbeatInterval) {
          this.startHeartbeat(ws, heartbeatInterval);
        }

        this.logger.info(
          `WebSocket opened: ${ws.data.id} on namespace "${namespace}" (${currentCount + 1} active connections)`,
        );

        // Call user handler
        await this.createHandler('onOpenInternal')(ws);
      },

      close: async (ws: ServerWebSocket<WebSocketData>, code: number, reason: string) => {
        // Normalize to namespace format (remove leading /)
        const namespace = ws.data.path.replace(/^\//, '');

        // Stop heartbeat
        this.stopHeartbeat(ws.data.id);

        // Remove from tracking
        this.activeConnections.get(namespace)?.delete(ws.data.id);

        const remainingCount = this.getConnectionCount(namespace);

        this.logger.info(
          `WebSocket closed: ${ws.data.id} on namespace "${namespace}" (${remainingCount} remaining connections)`,
        );

        // Call user handler
        await this.createHandler('onCloseInternal')(ws, code, reason);
      },

      message: this.createHandler('onMessage'),
      drain: this.createHandler('onDrain'),
      ping: this.createHandler('onPing'),
      pong: this.createHandler('onPong'),
      ...restOptions,
    };
  }

  /**
   * Starts WebSocket server and initializes a single shared AsenaWebSocketServer
   * All WebSocket services share the same wrapper instance for efficiency
   * @param server - Bun Server instance
   */
  public async startWebsocket(server: Server<any>): Promise<void> {
    if (!this.websockets || this.websockets.size < 1) {
      return;
    }

    // Initialize transport (default: BunLocalTransport)
    //
    // Assigned back to the field, not kept in a local. Sockets are built from `this._transport`
    // (see the AsenaSocket construction below), so a default that only reached the local variable
    // left them transport-less while AsenaWebSocketServer got one - the two broadcast paths then
    // disagreed. The shutdown path reads the field too, so the default was never torn down.
    this._transport ??= new BunLocalTransport();

    await this._transport.init?.(server);

    this.warnIfTransportLacksPublishRemote();

    // Create a single shared wrapper for all WebSocket services
    const sharedServer = new AsenaWebSocketServer(this._transport);

    // Assign the shared wrapper to all services
    for (const websocket of this.websockets.values()) {
      websocket.server = sharedServer;
    }
  }

  /**
   * Warns once, at startup, when the configured transport predates `publishRemote()`.
   *
   * Such a transport still works: `socket.publish()` falls back to its `publish()`, which does
   * local delivery as well - so the sender receives its own message, unlike every other
   * configuration. Warning here rather than per message keeps a hot path clean, and warning at
   * all is the point: the alternative reading, treating the missing method as "no cross-pod
   * delivery wanted", would drop messages between pods in silence.
   */
  private warnIfTransportLacksPublishRemote(): void {
    if (typeof this._transport?.publishRemote === 'function') {
      return;
    }

    this.logger.warn(
      'WebSocket transport does not implement publishRemote(). socket.publish() will fall back to ' +
        'transport.publish(), which delivers to the publishing socket as well. Implement ' +
        'publishRemote() (broker publish only, no local delivery) to keep the sender excluded. ' +
        'The fallback is removed in the next major version.',
    );
  }

  /**
   * Creates a handler wrapper for WebSocket lifecycle events
   * @param type - Event type (onOpenInternal, onMessage, etc.)
   * @returns Handler function
   */
  private createHandler(type: keyof WSEvents) {
    return async (ws: ServerWebSocket<WebSocketData>, ...args: any[]) => {
      const websocket = this.websockets.get(ws.data.path);

      if (!websocket) {
        this.logger.error(`WebSocket handler not found for path: ${ws.data.path}`);
        // Close connection with error code if handler not found
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1011, 'Internal server error: handler not found');
        }

        return;
      }

      // Bound at the point it is read. Pulling a method off an object and binding it two
      // statements later is the shape `unbound-method` exists to flag, and the gap is where a
      // future edit loses `this`.
      const handler = websocket[type]?.bind(websocket);

      if (!handler) {
        // Not all handlers are required, so this is not an error
        return;
      }

      try {
        await (handler as (socket: AsenaSocket<WebSocketData>, ...args: any[]) => void | Promise<void>)(
          new AsenaSocket(ws, websocket.namespace, this._transport),
          ...args,
        );
      } catch (error) {
        this.logger.error(`WebSocket ${type} handler error for path ${ws.data.path}:`, {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          socketId: ws.data.id,
          path: ws.data.path,
        });

        // Try to send error to client if connection is still open
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(
              JSON.stringify({
                type: 'error',
                message: 'Server error occurred',
                timestamp: new Date().toISOString(),
              }),
            );
          } catch (sendError) {
            this.logger.error('Failed to send error message to client:', sendError);
          }
        }

        // For critical errors, close connection gracefully
        if (type === 'onOpenInternal' || type === 'onMessage') {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(1011, 'Handler error');
          }
        }
      }
    };
  }
}
