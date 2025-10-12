/**
 * Ergenecore ValidationService
 *
 * Base class for validation services in Ergenecore adapter.
 * Extends Asena's validation service interface with Ergenecore-specific types.
 *
 * @module defaults/ValidationService
 *
 * @example
 * ```typescript
 * import { Middleware } from '@asenajs/asena/server';
 * import { ValidationService } from '@asenajs/ergenecore';
 * import { z } from 'zod';
 *
 * @Middleware({ validator: true })
 * export class CreateUserValidator extends ValidationService {
 *   json() {
 *     return z.object({
 *       name: z.string().min(3),
 *       email: z.string().email()
 *     });
 *   }
 * }
 * ```
 */

import type { AsenaValidationService } from '@asenajs/asena/middleware';
import type { ValidationSchema, ValidationSchemaWithHook } from '../types';

/**
 * Base class for Ergenecore validation services
 *
 * Implements Asena's validation service interface with support for
 * Zod schemas and custom validation hooks.
 */
export abstract class ValidationService implements AsenaValidationService<ValidationSchema | ValidationSchemaWithHook> {

  public abstract form():
    | Promise<ValidationSchema | ValidationSchemaWithHook>
    | ValidationSchema
    | ValidationSchemaWithHook;

  public abstract header():
    | Promise<ValidationSchema | ValidationSchemaWithHook>
    | ValidationSchema
    | ValidationSchemaWithHook;

  public abstract param():
    | Promise<ValidationSchema | ValidationSchemaWithHook>
    | ValidationSchema
    | ValidationSchemaWithHook;

  public abstract query():
    | Promise<ValidationSchema | ValidationSchemaWithHook>
    | ValidationSchema
    | ValidationSchemaWithHook;

  /**
   * Define validation schema for request body
   *
   * @returns Zod schema or schema with custom hook
   */
  public abstract json():
    | Promise<ValidationSchema | ValidationSchemaWithHook>
    | ValidationSchema
    | ValidationSchemaWithHook;

}
