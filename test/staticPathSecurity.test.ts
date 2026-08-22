import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { Ergenecore } from '../lib';
import type { ServerLogger } from '@asenajs/asena/logger';
import * as fs from 'fs';
import * as path from 'path';
import { HttpMethod } from '@asenajs/asena/web-types';

const mockLogger: ServerLogger = {
  profile: mock(() => {}),
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
};

/**
 * Static serve path handling, for the two cases the existing traversal tests cannot reach:
 * a sibling directory whose name starts with the root's, and a request path the URL spec
 * lets through but decodeURIComponent refuses.
 */
describe('Static Serve Path Security', () => {
  let adapter: Ergenecore;
  const TEST_PORT = 10000 + Math.floor(Math.random() * 22000);
  const TEST_HOST = 'localhost';
  const STATIC_DIR = path.join(import.meta.dir, 'fixtures', 'assets');
  const SIBLING_DIR = path.join(import.meta.dir, 'fixtures', 'assets-private');

  beforeAll(async () => {
    fs.mkdirSync(STATIC_DIR, { recursive: true });
    fs.mkdirSync(SIBLING_DIR, { recursive: true });

    fs.writeFileSync(path.join(STATIC_DIR, 'app.js'), 'console.log("app");');
    fs.writeFileSync(path.join(STATIC_DIR, '..dotdot.txt'), 'legitimate file whose name starts with ..');
    fs.writeFileSync(path.join(SIBLING_DIR, 'credentials.txt'), 'DATABASE_URL=postgres://user:pass@host/db');

    adapter = new Ergenecore(mockLogger);

    adapter.registerRoute({
      method: HttpMethod.GET,
      path: '/assets/*',
      middlewares: [],
      handler: async (ctx) => ctx.send({ error: 'Handler should not be reached' }),
      staticServe: {
        root: STATIC_DIR,
        extra: {},
        rewriteRequestPath: (requestPath: string) => requestPath.replace('/assets', ''),
        onFound: { handler: async () => {}, override: false },
        onNotFound: { handler: async () => {}, override: false },
      },
      validator: {} as any,
    });

    await adapter.start(TEST_PORT);
  });

  afterAll(async () => {
    await adapter.stop();

    fs.rmSync(STATIC_DIR, { recursive: true, force: true });
    fs.rmSync(SIBLING_DIR, { recursive: true, force: true });
  });

  describe('Sibling directory confinement', () => {
    it('should not serve a sibling directory whose name starts with the root', async () => {
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/assets/..%2Fassets-private%2Fcredentials.txt`);
      const text = await response.text();

      expect(response.status).toBe(403);
      expect(text).not.toContain('DATABASE_URL');
    });

    it('should still serve a file inside the root whose name starts with ..', async () => {
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/assets/..dotdot.txt`);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('legitimate file whose name starts with ..');
    });

    it('should let a request for the root itself reach the application 404, not 403', async () => {
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/assets/`);

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not Found' });
    });

    it('should still serve an ordinary file inside the root', async () => {
      const response = await fetch(`http://${TEST_HOST}:${TEST_PORT}/assets/app.js`);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('console.log("app");');
    });
  });

  describe('Malformed percent-encoding', () => {
    it('should answer 400 rather than 500 for an undecodable path', async () => {
      const response = await rawGet(TEST_PORT, '/assets/%zz.txt');

      expect(response.status).toBe(400);
      expect(response.body).not.toContain('Internal Server Error');
    });

    it('should answer 400 for a lone percent sign', async () => {
      const response = await rawGet(TEST_PORT, '/assets/100%.txt');

      expect(response.status).toBe(400);
    });

    it('should not log a malformed path at error level', async () => {
      (mockLogger.error as ReturnType<typeof mock>).mockClear();

      await rawGet(TEST_PORT, '/assets/%e0%a4%a.txt');

      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });
});

/**
 * fetch() normalises the request target, so an undecodable path has to go out over a raw
 * socket to reach the server the way a scanner would send it.
 */
async function rawGet(port: number, target: string): Promise<{ status: number; body: string }> {
  const chunks: Uint8Array[] = [];

  await new Promise<void>((resolve, reject) => {
    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(socket) {
          socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
        },
        data(_socket, data) {
          chunks.push(data);
        },
        close() {
          resolve();
        },
        error(_socket, error) {
          reject(error);
        },
      },
    }).catch(reject);
  });

  const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString();
  const [head, ...rest] = raw.split('\r\n\r\n');

  return { status: Number(head.split(' ')[1]), body: rest.join('\r\n\r\n') };
}
