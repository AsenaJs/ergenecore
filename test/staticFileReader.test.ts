import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { regularFileStats, StaticFileReader } from '../lib/utils/staticFileReader';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const decode = (bytes: Uint8Array | undefined) => (bytes === undefined ? undefined : new TextDecoder().decode(bytes));

describe('StaticFileReader', () => {
  let dir: string;
  const reader = new StaticFileReader(16, 2);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ergenecore-sfr-'));
  });

  afterAll(() => {
    reader.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const read = (name: string) => {
    const filePath = path.join(dir, name);
    const stats = regularFileStats(filePath);

    return stats === undefined ? undefined : reader.read(filePath, stats, true);
  };

  it('reads the bytes and Bun metadata of a regular file', () => {
    fs.writeFileSync(path.join(dir, 'a.html'), '<p>a</p>');

    const file = Bun.file(path.join(dir, 'a.html'));
    const result = read('a.html')!;

    expect(decode(result.bytes)).toBe('<p>a</p>');
    expect(result.type).toBe(file.type);
    expect(result.etag).toBe(`W/"${file.size}-${file.lastModified}"`);
    expect(result.lastModified).toBe(new Date(file.lastModified).toUTCString());
  });

  it('reads fresh bytes after an in-place write', () => {
    fs.writeFileSync(path.join(dir, 'b.txt'), 'one');
    expect(decode(read('b.txt')!.bytes)).toBe('one');

    fs.writeFileSync(path.join(dir, 'b.txt'), 'three');
    expect(decode(read('b.txt')!.bytes)).toBe('three');
  });

  it('follows a file replaced by rename', () => {
    fs.writeFileSync(path.join(dir, 'c.txt'), 'old');
    expect(decode(read('c.txt')!.bytes)).toBe('old');

    fs.writeFileSync(path.join(dir, 'c.tmp'), 'new');
    fs.renameSync(path.join(dir, 'c.tmp'), path.join(dir, 'c.txt'));
    expect(decode(read('c.txt')!.bytes)).toBe('new');
  });

  it('leaves large files, directories and missing paths to the caller', () => {
    fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(64));
    fs.mkdirSync(path.join(dir, 'sub'));

    expect(read('big.txt')!.bytes).toBeUndefined();
    expect(read('big.txt')!.etag).toBe(`W/"64-${Bun.file(path.join(dir, 'big.txt')).lastModified}"`);
    expect(read('sub')).toBeUndefined();
    expect(read('missing.txt')).toBeUndefined();
  });

  it('skips the body when asked and keeps serving after evictions and release', () => {
    for (const name of ['d1.txt', 'd2.txt', 'd3.txt']) {
      fs.writeFileSync(path.join(dir, name), name);
    }

    for (const name of ['d1.txt', 'd2.txt', 'd3.txt', 'd1.txt']) {
      expect(decode(read(name)!.bytes)).toBe(name);
    }

    const filePath = path.join(dir, 'd2.txt');

    expect(reader.read(filePath, regularFileStats(filePath)!, false).bytes).toBeUndefined();

    reader.release(filePath);
    expect(decode(read('d2.txt')!.bytes)).toBe('d2.txt');
  });
});
