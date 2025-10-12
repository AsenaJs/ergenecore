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
 * import { Middleware } from '@asenajs/asena/server';
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
   * @param context - Ergenecore context wrapper
   * @param next - Function to call next middleware or handler
   * @returns Promise that resolves when middleware completes
   */
  public abstract handle(context: Context, next: () => Promise<void>): Promise<any>;

}
