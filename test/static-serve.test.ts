import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { Ergenecore } from '../lib';
import type { ServerLogger } from '@asenajs/asena/logger';
import * as fs from 'fs';
import * as path from 'path';
import { HttpMethod } from '@asenajs/asena/web-types';

// Mock logger for testing
const mockLogger: ServerLogger = {
  profile: mock(() => {}),
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
};

/**
 *
 * Tests for basic static file serving functionality using Bun.file()
 *
 * Test Coverage:
 * - File exists → 200 OK with correct content
 * - File does not exist → 404 Not Found
 * - Bun.file() usage verification
 */

describe('Basic Static File Serving', () => {
  let adapter: Ergenecore;
  const TEST_PORT = 3007;
  const TEST_HOST = 'localhost';
  const STATIC_DIR = path.join(import.meta.dir, 'fixtures', 'static');

  beforeAll(async () => {
    // Create test fixtures directory
    if (!fs.existsSync(STATIC_DIR)) {
      fs.mkdirSync(STATIC_DIR, { recursive: true });
    }

    // Create test files
    fs.writeFileSync(path.join(STATIC_DIR, 'test.txt'), 'Hello from static file!');
    fs.writeFileSync(path.join(STATIC_DIR, 'test.html'), '<h1>Test HTML</h1>');
    fs.writeFileSync(path.join(STATIC_DIR, 'test.json'), JSON.stringify({ message: 'test' }));

    // Create subdirectory with file
    const subDir = path.join(STATIC_DIR, 'subdirectory');

    if (!fs.existsSync(subDir)) {
      fs.mkdirSync(subDir, { recursive: true });
    }

    fs.writeFileSync(path.join(subDir, 'nested.txt'), 'Nested file content');

    // Initialize adapter
    adapter = new Ergenecore(mockLogger);

    // Register a static file route
    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/static/*',
      middlewares: [],
      handler: async (ctx) => ctx.send({ error: 'Should not reach here' }),
      staticServe: {
        root: STATIC_DIR,
        extra: {},
        rewriteRequestPath: (path: string) => path.replace('/static', ''),
        onFound: {
          handler: async () => {},
          override: false,
        },
        onNotFound: {
          handler: async () => {},
          override: false,
        },
      },
      validator: {} as any,
    });

    // Start server
    adapter.start(TEST_PORT);
  });

  afterAll(async () => {
    // Stop server
    await adapter.stop();

    // Clean up test fixtures
    if (fs.existsSync(STATIC_DIR)) {
      fs.rmSync(STATIC_DIR, { recursive: true, force: true });
    }
  });

  describe('File Exists', () => {
    it('should serve existing text file with 200 OK', async () => {
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/static/test.txt`);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Hello from static file!');
    });

    it('should serve existing HTML file with 200 OK', async () => {
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/static/test.html`);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<h1>Test HTML</h1>');
    });

    it('should serve existing JSON file with 200 OK', async () => {
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/static/test.json`);

      expect(response.status).toBe(200);
      const json = await response.json();

      expect(json).toEqual({ message: 'test' });
    });

    it('should serve nested file with 200 OK', async () => {
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/static/subdirectory/nested.txt`);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Nested file content');
    });
  });

  describe('File Does Not Exist', () => {
    it('should return 404 for non-existent file', async () => {
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/static/nonexistent.txt`);

      expect(response.status).toBe(404);
    });

    it('should return 404 for non-existent directory', async () => {
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/static/nonexistent/file.txt`);

      expect(response.status).toBe(404);
    });
  });

  describe('MIME Type Detection', () => {
    it('should set correct Content-Type for .txt files', async () => {
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/static/test.txt`);

      expect(response.headers.get('Content-Type')).toContain('text/plain');
    });

    it('should set correct Content-Type for .html files', async () => {
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/static/test.html`);

      expect(response.headers.get('Content-Type')).toContain('text/html');
    });

    it('should set correct Content-Type for .json files', async () => {
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/static/test.json`);

      expect(response.headers.get('Content-Type')).toContain('application/json');
    });
  });
});

/**
 *
 * Tests for path security and rewriting functionality:
 * - Path traversal attack prevention (../)
 * - Root directory confinement
 * - Path normalization
 * - rewriteRequestPath edge cases
 */
describe('Path Rewriting & Security', () => {
  let adapter: Ergenecore;
  const TEST_PORT = 3008;
  const TEST_HOST = 'localhost';
  const STATIC_DIR = path.join(import.meta.dir, 'fixtures', 'static-secure');
  const OUTSIDE_DIR = path.join(import.meta.dir, 'fixtures', 'outside');

  beforeAll(async () => {
    // Create test directories
    if (!fs.existsSync(STATIC_DIR)) {
      fs.mkdirSync(STATIC_DIR, { recursive: true });
    }

    if (!fs.existsSync(OUTSIDE_DIR)) {
      fs.mkdirSync(OUTSIDE_DIR, { recursive: true });
    }

    // Create files inside allowed directory
    fs.writeFileSync(path.join(STATIC_DIR, 'safe.txt'), 'Safe file');
    fs.writeFileSync(path.join(STATIC_DIR, 'public.html'), '<h1>Public</h1>');

    // Create file OUTSIDE allowed directory (should not be accessible)
    fs.writeFileSync(path.join(OUTSIDE_DIR, 'secret.txt'), 'Secret data - should not be accessible!');

    // Initialize adapter
    adapter = new Ergenecore(mockLogger);

    // Register static route with path rewriting
    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/public/*',
      middlewares: [],
      handler: async (ctx) => ctx.send({ error: 'Handler should not be reached' }),
      staticServe: {
        root: STATIC_DIR,
        extra: {},
        rewriteRequestPath: (path: string) => path.replace('/public', ''),
        onFound: {
          handler: async () => {},
          override: false,
        },
        onNotFound: {
          handler: async () => {},
          override: false,
        },
      },
      validator: {} as any,
    });

    // Start server
    adapter.start(TEST_PORT);
  });

  afterAll(async () => {
    // Stop server
    await adapter.stop();

    // Clean up fixtures
    if (fs.existsSync(STATIC_DIR)) {
      fs.rmSync(STATIC_DIR, { recursive: true, force: true });
    }

    if (fs.existsSync(OUTSIDE_DIR)) {
      fs.rmSync(OUTSIDE_DIR, { recursive: true, force: true });
    }
  });

  describe('Path Traversal Prevention', () => {
    it('should block path traversal with ../', async () => {
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/public/../outside/secret.txt`);

      // Should return 404 or 403, NOT 200 with secret data
      expect(response.status).not.toBe(200);
      const text = await response.text();

      expect(text).not.toContain('Secret data');
    });

    it('should block encoded path traversal (%2e%2e%2f)', async () => {
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/public/%2e%2e%2foutside/secret.txt`);

      expect(response.status).not.toBe(200);
      const text = await response.text();

      expect(text).not.toContain('Secret data');
    });

    it('should block multiple path traversal attempts', async () => {
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/public/../../outside/secret.txt`);

      expect(response.status).not.toBe(200);
      const text = await response.text();

      expect(text).not.toContain('Secret data');
    });

    it('should block absolute path attempt', async () => {
      const absolutePath = path.join(OUTSIDE_DIR, 'secret.txt');
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/public/${absolutePath}`);

      expect(response.status).not.toBe(200);
      const text = await response.text();

      expect(text).not.toContain('Secret data');
    });
  });

  describe('Safe Path Access', () => {
    it('should allow access to files within root directory', async () => {
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/public/safe.txt`);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Safe file');
    });

    it('should allow access to HTML files', async () => {
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/public/public.html`);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<h1>Public</h1>');
    });
  });

  describe('Path Rewriting', () => {
    it('should correctly rewrite /public to /', async () => {
      // /public/safe.txt should map to STATIC_DIR/safe.txt
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/public/safe.txt`);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Safe file');
    });

    it('should handle trailing slashes correctly', async () => {
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/public//safe.txt`);

      // Should still work (path normalization)
      expect(response.status).toBe(200);
    });
  });
});

/**
 *
 * Tests for hook execution and override behavior:
 * - onFound hook called when file exists
 * - onNotFound hook called when file doesn't exist
 * - override: true stops file serving, passes to handler
 * - override: false continues file serving
 * - Context passing to hooks
 */
describe('onFound/onNotFound Hooks', () => {
  let adapter: Ergenecore;
  const TEST_PORT = 3009;
  const TEST_HOST = 'localhost';
  const STATIC_DIR = path.join(import.meta.dir, 'fixtures', 'static-hooks');

  describe('onFound Hook', () => {
    it('should call onFound hook when file exists', async () => {
      const HOOK_DIR = path.join(STATIC_DIR, 'found-hook');

      if (!fs.existsSync(HOOK_DIR)) {
        fs.mkdirSync(HOOK_DIR, { recursive: true });
      }

      fs.writeFileSync(path.join(HOOK_DIR, 'test.txt'), 'Hook test file');

      let hookCalled = false;
      let hookPath = '';

      adapter = new Ergenecore(mockLogger);
      adapter.registerRoute({
        method: HttpMethod.GET,
        path: '/hook-test/*',
        middlewares: [],
        handler: async (ctx) => ctx.send({ error: 'Should not reach here' }),
        staticServe: {
          root: HOOK_DIR,
          extra: {},
          rewriteRequestPath: (path: string) => path.replace('/hook-test', ''),
          onFound: {
            handler: async (path, _ctx) => {
              hookCalled = true;
              hookPath = path;
            },
            override: false,
          },
          onNotFound: {
            handler: async () => {},
            override: false,
          },
        },
        validator: {} as any,
      });
      adapter.start(TEST_PORT);

      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/hook-test/test.txt`);

      expect(response.status).toBe(200);
      expect(hookCalled).toBe(true);
      expect(hookPath).toBe('/test.txt');

      await adapter.stop();
      fs.rmSync(HOOK_DIR, { recursive: true, force: true });
    });

    it('should override file serving when onFound.override = true', async () => {
      const HOOK_DIR = path.join(STATIC_DIR, 'found-override');

      if (!fs.existsSync(HOOK_DIR)) {
        fs.mkdirSync(HOOK_DIR, { recursive: true });
      }

      fs.writeFileSync(path.join(HOOK_DIR, 'test.txt'), 'Original file');

      adapter = new Ergenecore(mockLogger);
      adapter.registerRoute({
        method: HttpMethod.GET,
        path: '/override-test/*',
        middlewares: [],
        handler: async (ctx) => ctx.send({ custom: 'Handler response instead of file' }),
        staticServe: {
          root: HOOK_DIR,
          extra: {},
          rewriteRequestPath: (path: string) => path.replace('/override-test', ''),
          onFound: {
            handler: async () => {
              // Hook called, but override=true passes to handler
            },
            override: true, // Pass to handler instead of serving file
          },
          onNotFound: {
            handler: async () => {},
            override: false,
          },
        },
        validator: {} as any,
      });
      adapter.start(TEST_PORT);

      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/override-test/test.txt`);

      expect(response.status).toBe(200);
      const json = await response.json();

      expect(json).toEqual({ custom: 'Handler response instead of file' });

      await adapter.stop();
      fs.rmSync(HOOK_DIR, { recursive: true, force: true });
    });
  });

  describe('onNotFound Hook', () => {
    it('should call onNotFound hook when file does not exist', async () => {
      const HOOK_DIR = path.join(STATIC_DIR, 'notfound-hook');

      if (!fs.existsSync(HOOK_DIR)) {
        fs.mkdirSync(HOOK_DIR, { recursive: true });
      }

      let hookCalled = false;
      let hookPath = '';

      adapter = new Ergenecore(mockLogger);
      adapter.registerRoute({
        method: HttpMethod.GET,
        path: '/notfound-test/*',
        middlewares: [],
        handler: async (ctx) => ctx.send({ error: 'Should not reach here' }),
        staticServe: {
          root: HOOK_DIR,
          extra: {},
          rewriteRequestPath: (path: string) => path.replace('/notfound-test', ''),
          onFound: {
            handler: async () => {},
            override: false,
          },
          onNotFound: {
            handler: async (path, _ctx) => {
              hookCalled = true;
              hookPath = path;
            },
            override: false,
          },
        },
        validator: {} as any,
      });
      adapter.start(TEST_PORT);

      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/notfound-test/missing.txt`);

      expect(response.status).toBe(404);
      expect(hookCalled).toBe(true);
      expect(hookPath).toBe('/missing.txt');

      await adapter.stop();
      fs.rmSync(HOOK_DIR, { recursive: true, force: true });
    });

    it('should override 404 response when onNotFound.override = true', async () => {
      const HOOK_DIR = path.join(STATIC_DIR, 'notfound-override');

      if (!fs.existsSync(HOOK_DIR)) {
        fs.mkdirSync(HOOK_DIR, { recursive: true });
      }

      adapter = new Ergenecore(mockLogger);
      adapter.registerRoute({
        method: HttpMethod.GET,
        path: '/custom-404/*',
        middlewares: [],
        handler: async (ctx) => ctx.send({ message: 'Custom 404 from handler' }, 404),
        staticServe: {
          root: HOOK_DIR,
          extra: {},
          rewriteRequestPath: (path: string) => path.replace('/custom-404', ''),
          onFound: {
            handler: async () => {},
            override: false,
          },
          onNotFound: {
            handler: async () => {
              // Hook called, override=true passes to handler
            },
            override: true, // Pass to handler for custom 404
          },
        },
        validator: {} as any,
      });
      adapter.start(TEST_PORT);

      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/custom-404/missing.txt`);

      expect(response.status).toBe(404);
      const json = await response.json();

      expect(json).toEqual({ message: 'Custom 404 from handler' });

      await adapter.stop();
      fs.rmSync(HOOK_DIR, { recursive: true, force: true });
    });
  });

  describe('Context Passing to Hooks', () => {
    it('should pass context to onFound hook', async () => {
      const HOOK_DIR = path.join(STATIC_DIR, 'context-hook');

      if (!fs.existsSync(HOOK_DIR)) {
        fs.mkdirSync(HOOK_DIR, { recursive: true });
      }

      fs.writeFileSync(path.join(HOOK_DIR, 'test.txt'), 'Context test');

      let contextReceived = false;

      adapter = new Ergenecore(mockLogger);
      adapter.registerRoute({
        method: HttpMethod.GET,
        path: '/context-test/*',
        middlewares: [],
        handler: async (ctx) => ctx.send({ error: 'Should not reach here' }),
        staticServe: {
          root: HOOK_DIR,
          extra: {},
          rewriteRequestPath: (path: string) => path.replace('/context-test', ''),
          onFound: {
            handler: async (_path, ctx) => {
              // Verify context is valid
              if (ctx && ctx.req) {
                contextReceived = true;
                ctx.setValue('hook-data', 'from-onFound');
              }
            },
            override: false,
          },
          onNotFound: {
            handler: async () => {},
            override: false,
          },
        },
        validator: {} as any,
      });
      adapter.start(TEST_PORT);

      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/context-test/test.txt`);

      expect(response.status).toBe(200);
      expect(contextReceived).toBe(true);

      await adapter.stop();
      fs.rmSync(HOOK_DIR, { recursive: true, force: true });
    });
  });
});

/**
 *
 * Tests for performance optimization features:
 * - Cache-Control header setting
 * - Custom headers support
 * - Custom MIME type mappings
 * - ETag generation
 * - Last-Modified header
 */
describe('Cache Headers & MIME Types', () => {
  let adapter: Ergenecore;
  const TEST_PORT = 3010;
  const TEST_HOST = 'localhost';
  const STATIC_DIR = path.join(import.meta.dir, 'fixtures', 'static-cache');

  describe('Cache-Control Header', () => {
    it('should set Cache-Control header when specified in extras', async () => {
      const CACHE_DIR = path.join(STATIC_DIR, 'cache-control');

      if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
      }

      fs.writeFileSync(path.join(CACHE_DIR, 'cached.js'), 'console.log("cached");');

      adapter = new Ergenecore(mockLogger);
      adapter.registerRoute({
        method: HttpMethod.GET,
        path: '/cached/*',
        middlewares: [],
        handler: async (ctx) => ctx.send({ error: 'Should not reach here' }),
        staticServe: {
          root: CACHE_DIR,
          extra: {
            cacheControl: 'public, max-age=31536000, immutable',
          },
          rewriteRequestPath: (path: string) => path.replace('/cached', ''),
          onFound: { handler: async () => {}, override: false },
          onNotFound: { handler: async () => {}, override: false },
        },
        validator: {} as any,
      });
      adapter.start(TEST_PORT);

      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/cached/cached.js`);

      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');

      await adapter.stop();
      fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    });

    it('should set default Cache-Control when not specified', async () => {
      const CACHE_DIR = path.join(STATIC_DIR, 'no-cache');

      if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
      }

      fs.writeFileSync(path.join(CACHE_DIR, 'file.txt'), 'No cache');

      adapter = new Ergenecore(mockLogger);
      adapter.registerRoute({
        method: HttpMethod.GET,
        path: '/no-cache/*',
        middlewares: [],
        handler: async (ctx) => ctx.send({ error: 'Should not reach here' }),
        staticServe: {
          root: CACHE_DIR,
          extra: {}, // No cacheControl → should use default
          rewriteRequestPath: (path: string) => path.replace('/no-cache', ''),
          onFound: { handler: async () => {}, override: false },
          onNotFound: { handler: async () => {}, override: false },
        },
        validator: {} as any,
      });
      adapter.start(TEST_PORT);

      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/no-cache/file.txt`);

      expect(response.status).toBe(200);
      // Smart defaults: framework sets Cache-Control automatically
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=0');

      await adapter.stop();
      fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    });
  });

  describe('Custom Headers', () => {
    it('should add custom headers from extras', async () => {
      const HEADER_DIR = path.join(STATIC_DIR, 'custom-headers');

      if (!fs.existsSync(HEADER_DIR)) {
        fs.mkdirSync(HEADER_DIR, { recursive: true });
      }

      fs.writeFileSync(path.join(HEADER_DIR, 'file.txt'), 'Custom headers');

      adapter = new Ergenecore(mockLogger);
      adapter.registerRoute({
        method: HttpMethod.GET,
        path: '/custom-headers/*',
        middlewares: [],
        handler: async (ctx) => ctx.send({ error: 'Should not reach here' }),
        staticServe: {
          root: HEADER_DIR,
          extra: {
            headers: {
              'X-Custom-Header': 'CustomValue',
              'X-Frame-Options': 'DENY',
            },
          },
          rewriteRequestPath: (path: string) => path.replace('/custom-headers', ''),
          onFound: { handler: async () => {}, override: false },
          onNotFound: { handler: async () => {}, override: false },
        },
        validator: {} as any,
      });
      adapter.start(TEST_PORT);

      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/custom-headers/file.txt`);

      expect(response.status).toBe(200);
      expect(response.headers.get('X-Custom-Header')).toBe('CustomValue');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');

      await adapter.stop();
      fs.rmSync(HEADER_DIR, { recursive: true, force: true });
    });
  });

  describe('Custom MIME Types', () => {
    it('should use custom MIME type when specified in extras', async () => {
      const MIME_DIR = path.join(STATIC_DIR, 'custom-mime');

      if (!fs.existsSync(MIME_DIR)) {
        fs.mkdirSync(MIME_DIR, { recursive: true });
      }

      fs.writeFileSync(path.join(MIME_DIR, 'file.customext'), 'Custom extension file');

      adapter = new Ergenecore(mockLogger);
      adapter.registerRoute({
        method: HttpMethod.GET,
        path: '/custom-mime/*',
        middlewares: [],
        handler: async (ctx) => ctx.send({ error: 'Should not reach here' }),
        staticServe: {
          root: MIME_DIR,
          extra: {
            mimes: {
              '.customext': 'application/x-custom',
              '.ts': 'text/typescript',
            },
          },
          rewriteRequestPath: (path: string) => path.replace('/custom-mime', ''),
          onFound: { handler: async () => {}, override: false },
          onNotFound: { handler: async () => {}, override: false },
        },
        validator: {} as any,
      });
      adapter.start(TEST_PORT);

      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/custom-mime/file.customext`);

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('application/x-custom');

      await adapter.stop();
      fs.rmSync(MIME_DIR, { recursive: true, force: true });
    });

    it('should fall back to default MIME type for unknown extensions', async () => {
      const MIME_DIR = path.join(STATIC_DIR, 'default-mime');

      if (!fs.existsSync(MIME_DIR)) {
        fs.mkdirSync(MIME_DIR, { recursive: true });
      }

      fs.writeFileSync(path.join(MIME_DIR, 'file.unknownext'), 'Unknown extension');

      adapter = new Ergenecore(mockLogger);
      adapter.registerRoute({
        method: HttpMethod.GET,
        path: '/default-mime/*',
        middlewares: [],
        handler: async (ctx) => ctx.send({ error: 'Should not reach here' }),
        staticServe: {
          root: MIME_DIR,
          extra: {},
          rewriteRequestPath: (path: string) => path.replace('/default-mime', ''),
          onFound: { handler: async () => {}, override: false },
          onNotFound: { handler: async () => {}, override: false },
        },
        validator: {} as any,
      });
      adapter.start(TEST_PORT);

      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/default-mime/file.unknownext`);

      expect(response.status).toBe(200);
      // Bun defaults to application/octet-stream for unknown types
      const contentType = response.headers.get('Content-Type');

      expect(contentType).toBeTruthy();

      await adapter.stop();
      fs.rmSync(MIME_DIR, { recursive: true, force: true });
    });
  });

  describe('Combined Headers & Cache', () => {
    it('should apply both cache control and custom headers', async () => {
      const COMBINED_DIR = path.join(STATIC_DIR, 'combined');

      if (!fs.existsSync(COMBINED_DIR)) {
        fs.mkdirSync(COMBINED_DIR, { recursive: true });
      }

      fs.writeFileSync(path.join(COMBINED_DIR, 'asset.css'), 'body { color: red; }');

      adapter = new Ergenecore(mockLogger);
      adapter.registerRoute({
        method: HttpMethod.GET,
        path: '/combined/*',
        middlewares: [],
        handler: async (ctx) => ctx.send({ error: 'Should not reach here' }),
        staticServe: {
          root: COMBINED_DIR,
          extra: {
            cacheControl: 'public, max-age=86400',
            headers: {
              'X-Content-Type-Options': 'nosniff',
            },
            mimes: {
              '.css': 'text/css; charset=utf-8',
            },
          },
          rewriteRequestPath: (path: string) => path.replace('/combined', ''),
          onFound: { handler: async () => {}, override: false },
          onNotFound: { handler: async () => {}, override: false },
        },
        validator: {} as any,
      });
      adapter.start(TEST_PORT);

      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/combined/asset.css`);

      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Content-Type')).toContain('text/css');

      await adapter.stop();
      fs.rmSync(COMBINED_DIR, { recursive: true, force: true });
    });
  });
});
