/**
 * Factory functions for creating Ergenecore instances
 *
 * Provides convenient factory functions for creating pre-configured
 * Ergenecore adapter instances with sensible defaults.
 *
 * @module factory
 *
 * @example
 * ```typescript
 * import { createErgenecoreAdapter } from '@asenajs/ergenecore/factory';
 *
 * const adapter = createErgenecoreAdapter({
 *   port: 3000,
 *   hostname: 'localhost'
 * });
 * ```
 */

import type { ServerLogger } from '@asenajs/asena/logger';
import { ErgenecoreWebsocketAdapter } from '../ErgenecoreWebsocketAdapter';
import { Ergenecore } from '../Ergenecore';

/**
 * Configuration options for creating an Ergenecore adapter
 */
export interface ErgenecoreOptions {
  /**
   * Server port
   * @default 3000
   */
  port?: number;

  /**
   * Server hostname
   * @default undefined (binds to all interfaces)
   */
  hostname?: string;

  /**
   * Custom logger instance
   * If not provided, a default logger will be used
   */
  logger?: ServerLogger;

  /**
   * Enable WebSocket support
   * @default true
   */
  enableWebSocket?: boolean;

  /**
   * Custom WebSocket adapter instance
   * Only used if enableWebSocket is true
   */
  websocketAdapter?: ErgenecoreWebsocketAdapter;
}

/**
 * Creates a new Ergenecore adapter instance with optional configuration
 *
 * @param options - Configuration options
 * @returns Configured Ergenecore adapter instance
 *
 * @example
 * ```typescript
 * // Basic usage with defaults
 * const adapter = createErgenecoreAdapter();
 *
 * // Custom port and hostname
 * const adapter = createErgenecoreAdapter({
 *   port: 8080,
 *   hostname: '0.0.0.0'
 * });
 *
 * // With custom logger
 * const adapter = createErgenecoreAdapter({
 *   logger: customLogger,
 *   port: 3000
 * });
 *
 * // Disable WebSocket support
 * const adapter = createErgenecoreAdapter({
 *   enableWebSocket: false
 * });
 * ```
 */
export function createErgenecoreAdapter(options: ErgenecoreOptions = {}): Ergenecore {
  const { port = 3000, hostname, logger, enableWebSocket = true, websocketAdapter } = options;

  // Create default logger if not provided
  const adapterLogger = logger || createDefaultLogger();

  // Create WebSocket adapter if enabled
  const wsAdapter = enableWebSocket ? websocketAdapter || new ErgenecoreWebsocketAdapter(adapterLogger) : undefined;

  // Create Ergenecore instance
  const adapter = new Ergenecore(adapterLogger, wsAdapter);

  // Configure port and hostname
  adapter.setPort(port);
  if (hostname) {
    adapter.hostname = hostname;
  }

  return adapter;
}

/**
 * Creates a default logger implementation
 *
 * Provides basic console logging for development purposes.
 * In production, you should provide your own logger instance.
 *
 * @returns Default ServerLogger implementation
 *
 * @internal
 */
function createDefaultLogger(): ServerLogger {
  return {
    info: (message: string, ...args: any[]) => {
      console.log(`[INFO]: ${message}`, ...args);
    },
    error: (message: string, ...args: any[]) => {
      console.error(`[ERROR]: ${message}`, ...args);
    },
    warn: (message: string, ...args: any[]) => {
      console.warn(`[WARN]: ${message}`, ...args);
    },
    profile: (message: string) => {
      console.time(message);
      return () => console.timeEnd(message);
    },
  };
}

/**
 * Creates a production-ready Ergenecore adapter with optimized settings
 *
 * This factory includes:
 * - Performance-optimized defaults
 * - WebSocket support enabled
 * - Production logging
 *
 * @param options - Configuration options
 * @returns Production-configured Ergenecore adapter
 *
 * @example
 * ```typescript
 * const adapter = createProductionAdapter({
 *   port: 8080,
 *   hostname: '0.0.0.0',
 *   logger: productionLogger
 * });
 * ```
 */
export function createProductionAdapter(options: ErgenecoreOptions = {}): Ergenecore {
  return createErgenecoreAdapter({
    ...options,
    enableWebSocket: options.enableWebSocket ?? true,
  });
}

/**
 * Creates a development-friendly Ergenecore adapter
 *
 * This factory includes:
 * - Verbose console logging
 * - WebSocket support enabled
 * - Default port 3000
 *
 * @param options - Configuration options
 * @returns Development-configured Ergenecore adapter
 *
 * @example
 * ```typescript
 * const adapter = createDevelopmentAdapter({
 *   port: 3000
 * });
 * ```
 */
export function createDevelopmentAdapter(options: ErgenecoreOptions = {}): Ergenecore {
  return createErgenecoreAdapter({
    port: 3000,
    ...options,
    logger: options.logger || createDefaultLogger(),
    enableWebSocket: true,
  });
}
