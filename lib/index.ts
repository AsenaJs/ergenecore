/**
 * Ergenecore - Blazing-fast native Bun adapter for Asena.js
 *
 * Main entry point for the Ergenecore adapter.
 * Exports the core adapter, factory functions, types, and base classes.
 *
 * @module ergenecore
 *
 * @example
 * ```typescript
 * import { AsenaServerFactory } from '@asenajs/asena';
 * import { createErgenecoreAdapter, type Context } from '@asenajs/ergenecore';
 *
 * const adapter = createErgenecoreAdapter();
 * const server = await AsenaServerFactory.create({
 *   adapter,
 *   logger,
 *   port: 3000
 * });
 *
 * await server.start();
 * ```
 */

// Core adapter
export { Ergenecore } from './Ergenecore';
export { ErgenecoreContextWrapper } from './ErgenecoreContextWrapper';
export { ErgenecoreWebsocketAdapter } from './ErgenecoreWebsocketAdapter';

// Stream writers
export { StreamWriter } from './stream/StreamWriter';
export { SSEStreamWriter } from './stream/SSEStreamWriter';

// Error classes
export { HttpException, type HttpExceptionInit } from './errors';

// Factory functions
export {
  createErgenecoreAdapter,
  createProductionAdapter,
  createDevelopmentAdapter,
  type ErgenecoreOptions,
} from './utils/factory';

// Default base classes
export { ValidationService } from './defaults/ValidationService';
export { ConfigService } from './defaults/ConfigService';
export { MiddlewareService } from './defaults/MiddlewareService';
export { StaticServeService } from './defaults/StaticServeService';

// Built-in middlewares
export { CorsMiddleware, type CorsOptions } from './middlewares/CorsMiddleware';
export { RateLimiterMiddleware, type RateLimiterOptions } from './middlewares/RateLimiterMiddleware';

// Types
export type { Context } from './ErgenecoreContextWrapper';
export type { ErgenecoreHandler, ErgenecoreNext } from './types/Handler';
export type { StaticServeExtras } from './types/StaticServeExtras';
export type { ValidationSchema, ValidationSchemaWithHook } from './types/Validation';
