/**
 * Ergenecore type definitions
 *
 * Centralized export point for all Ergenecore-specific types.
 * Provides type definitions for handlers, static serve configuration,
 * validation schemas, and more.
 *
 * Note: Router types are not needed as we use Bun's native router
 *
 * @module types
 *
 * @example
 * ```typescript
 * import type {
 *   ErgenecoreHandler,
 *   StaticServeExtras,
 *   ValidationSchemaWithHook
 * } from '@asenajs/ergenecore/types';
 * ```
 */

// Handler types
export type { ErgenecoreHandler, ErgenecoreNext } from './Handler';

// Static serve types
export * from './StaticServeExtras';

// Validation types
export * from './Validation';

// Re-export Context type for convenience
export type { Context } from '../ErgenecoreContextWrapper';
