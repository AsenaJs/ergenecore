/**
 * Ergenecore handler type definitions
 *
 * Type aliases for route handlers and other function signatures
 * specific to the Ergenecore adapter.
 *
 * @module types/Handler
 */

import type { Context } from '../ErgenecoreContextWrapper';

/**
 * Ergenecore route handler function
 *
 * Asynchronous function that receives an ErgenecoreContextWrapper
 * and returns a Response or JSON-serializable data.
 *
 * @param ctx - Ergenecore context wrapper (ErgenecoreContextWrapper)
 * @returns Response object or JSON-serializable data
 *
 * @example
 * ```typescript
 * const handler: ErgenecoreHandler = async (ctx) => {
 *   const id = ctx.getParam('id');
 *   const user = await db.users.findById(id);
 *   return ctx.send(user);
 * };
 * ```
 *
 * @example
 * ```typescript
 * const handler: ErgenecoreHandler = async (ctx) => {
 *   // Return Response directly
 *   return new Response('Hello World', {
 *     status: 200,
 *     headers: { 'Content-Type': 'text/plain' }
 *   });
 * };
 * ```
 *
 * @example
 * ```typescript
 * const handler: ErgenecoreHandler = async (ctx) => {
 *   // Return JSON-serializable data
 *   return { message: 'Success', data: { id: 123 } };
 * };
 * ```
 */
export type ErgenecoreHandler = (ctx: Context) => Promise<Response | any>;

/**
 * Ergenecore middleware next function
 *
 * Asynchronous function called within middleware to proceed
 * to the next middleware in the chain or the route handler.
 *
 * @returns Promise that resolves when the next middleware/handler completes
 *
 * @example
 * ```typescript
 * const middleware = async (ctx: Context, next: ErgenecoreNext) => {
 *   console.log('Before handler');
 *   await next();
 *   console.log('After handler');
 * };
 * ```
 */
export type ErgenecoreNext = () => Promise<void>;
