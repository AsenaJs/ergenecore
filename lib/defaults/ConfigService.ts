/**
 * Ergenecore ConfigService
 *
 * Base class for configuration services in Ergenecore adapter.
 * Extends Asena's config service interface with Ergenecore-specific Context type.
 *
 * @module defaults/ConfigService
 *
 * @example
 * ```typescript
 * import { Config } from '@asenajs/asena/server';
 * import { ConfigService, type Context } from '@asenajs/ergenecore';
 *
 * @Config()
 * export class ServerConfig extends ConfigService {
 *   onError(error: Error, context: Context): Response {
 *     return context.send({ error: error.message }, 500);
 *   }
 * }
 * ```
 */

import type { AsenaConfig } from '@asenajs/asena/server/config';
import type { Context } from '../ErgenecoreContextWrapper';

/**
 * Base class for Ergenecore configuration services
 *
 * Implements Asena's config service interface with Ergenecore's Context type.
 * Use this to define global error handlers and other server configuration.
 */
export abstract class ConfigService implements AsenaConfig<Context> {
  /**
   * Global error handler
   *
   * @param error - The error that occurred
   * @param context - Ergenecore context wrapper
   * @returns Response or Promise<Response>
   */
  public abstract onError(error: Error, context: Context): Response | Promise<Response>;
}
