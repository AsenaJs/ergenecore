/**
 * Configuration options for static file serving with Ergenecore adapter.
 * These options are passed via the `extra` field in BaseStaticServeParams.
 */
export interface StaticServeExtras {
  /**
   * Enable serving precompressed files (.br, .gz) if available.
   * When true, adapter will look for .br and .gz variants before serving the original file.
   * @default false
   */
  precompressed?: boolean;

  /**
   * Custom MIME type mappings for file extensions.
   * Overrides Bun's default MIME type detection.
   * @example { '.ts': 'text/typescript' }
   */
  mimes?: Record<string, string>;

  /**
   * Cache-Control header value for static files.
   * @example 'public, max-age=31536000, immutable'
   */
  cacheControl?: string;

  /**
   * Custom headers to include in static file responses.
   * These headers are added to all static file responses.
   * @example { 'X-Custom-Header': 'value' }
   */
  headers?: Record<string, string>;
}
