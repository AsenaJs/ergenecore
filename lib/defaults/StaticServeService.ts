import { AsenaStaticServeService } from '@asenajs/asena/middleware';
import type { StaticServeExtras } from '../types';
import type { Context } from '../ErgenecoreContextWrapper';

/**
 * Base class for static file serving services in Ergenecore adapter
 *
 * Extends AsenaStaticServeService with Ergenecore-specific Context and StaticServeExtras types
 *
 * @example
 * ```typescript
 * import { StaticServe } from '@asenajs/asena/server';
 * import { StaticServeService } from '@asenajs/ergenecore';
 * import path from 'path';
 *
 * @StaticServe({ root: path.join(process.cwd(), 'public') })
 * export class MyStaticServe extends StaticServeService {
 *   public rewriteRequestPath(reqPath: string): string {
 *     return reqPath.replace(/^\/static/, '');
 *   }
 * }
 * ```
 */
export abstract class StaticServeService extends AsenaStaticServeService<Context, StaticServeExtras> {}
