/**
 * Ergenecore Defaults
 *
 * Export adapter-specific base classes for common services.
 * These classes provide type-safe implementations of Asena's service interfaces
 * with Ergenecore's Context type.
 *
 * @module defaults
 *
 * @example
 * ```typescript
 * import {
 *   ValidationService,
 *   ConfigService,
 *   MiddlewareService,
 *   type Context
 * } from '@asenajs/ergenecore';
 * ```
 */

export { ValidationService } from './ValidationService';
export { ConfigService } from './ConfigService';
export { MiddlewareService } from './MiddlewareService';
export { StaticServeService } from './StaticServeService';
export { CorsMiddleware, type CorsOptions } from '../middlewares/CorsMiddleware';
export { RateLimiterMiddleware, type RateLimiterOptions } from '../middlewares/RateLimiterMiddleware';
