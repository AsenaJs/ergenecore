/**
 * Ergenecore MiddlewareService
 *
 * Base class for middleware services in Ergenecore adapter.
 * Extends Asena's middleware service interface with Ergenecore-specific Context type.
 *
 * @module defaults/MiddlewareService
 *
 * @example
 * ```typescript
 * import { Middleware } from '@asenajs/asena/decorators';
 * import { MiddlewareService, type Context } from '@asenajs/ergenecore';
 *
 * @Middleware()
 * export class AuthMiddleware extends MiddlewareService {
 *   async handle(context: Context, next: () => Promise<void>) {
 *     // Your middleware logic
 *     await next();
 *   }
 * }
 * ```
 */

import type { AsenaMiddlewareService } from '@asenajs/asena/middleware';
import type { Context } from '../ErgenecoreContextWrapper';

/**
 * Base class for Ergenecore middleware services
 *
 * Implements Asena's middleware service interface with Ergenecore's Context type.
 */
export abstract class MiddlewareService implements AsenaMiddlewareService<Context> {
  /**
   * Middleware handler
   *
   * The return type mirrors Asena's `AsenaMiddlewareService` on purpose: the adapter
   * awaits the result and stops the chain on a literal `false`, so a synchronous guard
   * (`if (!token) return false;`) is a supported shape and must type-check.
   *
   * @param context - Ergenecore context wrapper
   * @param next - Function to call next middleware or handler
   * @returns `false` to stop the chain, anything else (or nothing) to continue
   */
  public abstract handle(context: Context, next: () => Promise<void>): Promise<void> | any;
}
