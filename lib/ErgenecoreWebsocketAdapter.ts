import { AsenaWebsocketAdapter } from '@asenajs/asena/adapter';
import type { ServerLogger } from '@asenajs/asena/logger';
import type { Server, ServerWebSocket } from 'bun';
import type { AsenaWebSocketService } from '@asenajs/asena/web-socket';
import {
  AsenaSocket,
  AsenaWebSocketServer,
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

  private heartbeatIntervals: Map<string, NodeJS.Timeout> = new Map(); // connection ID -> interval

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
    for (const interval of this.heartbeatIntervals.values()) {
      clearInterval(interval);
    }

    this.heartbeatIntervals.clear();

    // Clear connection tracking
    this.activeConnections.clear();

    this.logger.info('WebSocket shutdown complete');
  }

  /**
   * Prepares WebSocket configuration with lifecycle handlers
   * @param options - WebSocket options
   */
  public prepareWebSocket(options?: WSOptions & { heartbeatInterval?: number }): void {
    if (!this.websockets || this.websockets.size < 1) {
      return;
    }

    const heartbeatInterval = options?.heartbeatInterval;

    this.websocket = {
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

        // Start heartbeat if enabled
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
      ...options,
    };
  }

  /**
   * Starts WebSocket server and initializes AsenaWebSocketServer for each namespace
   * @param server - Bun Server instance
   */
  public startWebsocket(server: Server<any>): void {
    if (!this.websockets || this.websockets.size < 1) {
      return;
    }

    for (const [namespace, websocket] of this.websockets) {
      websocket.server = new AsenaWebSocketServer(server, namespace);
    }
  }

  /**
   * Starts heartbeat for a connection
   * @param ws - WebSocket connection
   * @param intervalMs - Heartbeat interval in milliseconds (default: 30000)
   */
  private startHeartbeat(ws: ServerWebSocket<WebSocketData>, intervalMs = 30000): void {
    const interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch (error) {
          this.logger.error(`Heartbeat ping failed for connection ${ws.data.id}:`, error);
          this.stopHeartbeat(ws.data.id);

          if (ws.readyState === WebSocket.OPEN) {
            ws.close(1011, 'Heartbeat failed');
          }
        }
      } else {
        this.stopHeartbeat(ws.data.id);
      }
    }, intervalMs);

    this.heartbeatIntervals.set(ws.data.id, interval);
  }

  /**
   * Stops heartbeat for a connection
   * @param connectionId - Connection ID
   */
  private stopHeartbeat(connectionId: string): void {
    const interval = this.heartbeatIntervals.get(connectionId);

    if (interval) {
      clearInterval(interval);
      this.heartbeatIntervals.delete(connectionId);
    }
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

      let handler = websocket[type];

      if (!handler) {
        // Not all handlers are required, so this is not an error
        return;
      }

      handler = handler.bind(websocket);

      try {
        await (handler as (socket: AsenaSocket<WebSocketData>, ...args: any[]) => void | Promise<void>)(
          new AsenaSocket(ws, websocket),
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
