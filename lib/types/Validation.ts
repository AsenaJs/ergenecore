import type z from 'zod';
import type { Context } from '../ErgenecoreContextWrapper';

// Validation schema type
export type ValidationSchema = z.ZodType<any, any, any>;

// Validation schema with hook
export interface ValidationSchemaWithHook {
  schema: ValidationSchema;
  hook?: (result: any, context: Context) => any;
}
