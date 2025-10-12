/**
 * Asena Ergenecore - Native Bun Adapter for Asenajs
 *
 * This is the main entry point for the package.
 * All public APIs are exported from lib/index.ts
 *
 * @module @asenajs/ergenecore
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

export * from './lib/index';