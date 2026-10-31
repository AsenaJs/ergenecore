import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { regularFileStats, StaticFileReader } from '../lib/utils/staticFileReader';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('StaticFileReader.respond', () => {
  let dir: string;
  const reader = new StaticFileReader(16, 2);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ergenecore-sfr-respond-'));
  });

  afterAll(() => {
    reader.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const respond = (name: string, withBody = true) => {
    const filePath = path.join(dir, name);
    const stats = regularFileStats(filePath)!;

    return reader.respond(filePath, stats, withBody);
  };

  it('answers the bytes with the same headers read() reports', async () => {
    fs.writeFileSync(path.join(dir, 'a.html'), '<p>a</p>');

    const filePath = path.join(dir, 'a.html');
    const expected = reader.read(filePath, regularFileStats(filePath)!, false);
    const response = respond('a.html');

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<p>a</p>');
    expect(response.headers.get('content-type')).toBe(expected.type);
    expect(response.headers.get('etag')).toBe(expected.etag);
    expect(response.headers.get('last-modified')).toBe(expected.lastModified);
    expect(response.headers.get('cache-control')).toBe('public, max-age=0');
  });

  it('does not leak header changes made on one response into the next', () => {
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b');

    const first = respond('b.txt');

    first.headers.set('x-mutated', '1');
    first.headers.set('cache-control', 'no-store');

    const second = respond('b.txt');

    expect(second.headers.get('x-mutated')).toBeNull();
    expect(second.headers.get('cache-control')).toBe('public, max-age=0');
  });

  it('refreshes ETag and Last-Modified when the file changes in place', async () => {
    const filePath = path.join(dir, 'c.txt');

    fs.writeFileSync(filePath, 'one');
    fs.utimesSync(filePath, new Date(1_000_000_000_000), new Date(1_000_000_000_000));

    const before = respond('c.txt');

    fs.writeFileSync(filePath, 'three');
    fs.utimesSync(filePath, new Date(1_700_000_000_000), new Date(1_700_000_000_000));

    const after = respond('c.txt');
    const file = Bun.file(filePath);

    expect(await after.text()).toBe('three');
    expect(after.headers.get('etag')).toBe(`W/"${file.size}-${file.lastModified}"`);
    expect(after.headers.get('last-modified')).toBe(new Date(file.lastModified).toUTCString());
    expect(after.headers.get('etag')).not.toBe(before.headers.get('etag'));
  });

  it('refreshes the ETag when only the size changes', () => {
    const filePath = path.join(dir, 'd.txt');
    const when = new Date(1_600_000_000_000);

    fs.writeFileSync(filePath, 'aa');
    fs.utimesSync(filePath, when, when);

    const before = respond('d.txt');

    fs.writeFileSync(filePath, 'aaaa');
    fs.utimesSync(filePath, when, when);

    const after = respond('d.txt');

    expect(before.headers.get('etag')).toBe(`W/"2-${when.getTime()}"`);
    expect(after.headers.get('etag')).toBe(`W/"4-${when.getTime()}"`);
  });

  it('streams files above the size limit from disk with the same headers', async () => {
    const filePath = path.join(dir, 'big.txt');

    fs.writeFileSync(filePath, 'x'.repeat(64));

    const response = respond('big.txt');
    const file = Bun.file(filePath);

    expect(await response.text()).toBe('x'.repeat(64));
    expect(response.headers.get('etag')).toBe(`W/"64-${file.lastModified}"`);
    expect(response.headers.get('cache-control')).toBe('public, max-age=0');
  });

  it('serves from disk when the body is not read up front', async () => {
    fs.writeFileSync(path.join(dir, 'e.txt'), 'range');

    expect(await respond('e.txt', false).text()).toBe('range');
  });
});
