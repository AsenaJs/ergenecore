import type z from 'zod';
import type { Context } from '../ErgenecoreContextWrapper';

// Validation schema type
export type ValidationSchema = z.ZodType<any, any, any>;

// Validation schema with hook
export interface ValidationSchemaWithHook<T extends z.ZodType = z.ZodType> {
  schema: T;
  hook?: (result: z.ZodSafeParseResult<z.output<T>>, context: Context) => Response | void | Promise<Response | void>;
}
