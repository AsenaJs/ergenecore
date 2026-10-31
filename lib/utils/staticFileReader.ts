import { closeSync, fstatSync, openSync, readSync, type Stats, statSync } from 'fs';

const IS_WINDOWS = process.platform === 'win32';

export function staticFileHeaders(type: string, etag: string, lastModified: string): Headers {
  const headers = new Headers();

  headers.set('Content-Type', type);
  headers.set('ETag', etag);
  headers.set('Last-Modified', lastModified);

  return headers;
}

interface OpenStaticFile {
  readonly fd: number;
  readonly ino: number;
  readonly dev: number;
  readonly type: string;
  mtimeMs: number;
  size: number;
  etag: string;
  lastModified: string;
  headers: Headers | undefined;
}

export interface StaticFileRead {
  readonly bytes: Uint8Array<ArrayBuffer> | undefined;
  readonly type: string;
  readonly etag: string;
  readonly lastModified: string;
}

function defaultStaticHeaders(type: string, etag: string, lastModified: string): Headers {
  const headers = new Headers();

  headers.set('Content-Type', type);
  headers.set('ETag', etag);
  headers.set('Last-Modified', lastModified);
  headers.set('Cache-Control', 'public, max-age=0');

  return headers;
}

export function regularFileStats(filePath: string): Stats | undefined {
  try {
    const stats = statSync(filePath);

    return stats.isFile() ? stats : undefined;
  } catch {
    return undefined;
  }
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    return;
  }
}

/**
 * Reads small regular files from disk on every call through a bounded set of open descriptors.
 * Nothing but the descriptor and derived metadata outlives a call; the bytes are always fresh.
 */
export class StaticFileReader {
  private readonly files = new Map<string, OpenStaticFile>();

  public constructor(
    private readonly maxFileBytes = 64 * 1024,
    private readonly maxOpen = 64,
  ) {}

  public read(filePath: string, stats: Stats, withBody: boolean): StaticFileRead {
    const entry = IS_WINDOWS ? undefined : this.entry(filePath, stats);

    if (entry === undefined) {
      const lastModifiedMs = Math.trunc(stats.mtimeMs);

      return {
        bytes: undefined,
        type: Bun.file(filePath).type,
        etag: `W/"${stats.size}-${lastModifiedMs}"`,
        lastModified: new Date(lastModifiedMs).toUTCString(),
      };
    }

    this.refresh(entry, stats);

    return {
      bytes: withBody ? this.readBytes(filePath, entry, stats.size) : undefined,
      type: entry.type,
      etag: entry.etag,
      lastModified: entry.lastModified,
    };
  }

  public respond(filePath: string, stats: Stats, withBody: boolean): Response {
    const entry = IS_WINDOWS ? undefined : this.entry(filePath, stats);

    if (entry === undefined) {
      const lastModifiedMs = Math.trunc(stats.mtimeMs);
      const file = Bun.file(filePath);

      return new Response(file, {
        status: 200,
        headers: defaultStaticHeaders(
          file.type,
          `W/"${stats.size}-${lastModifiedMs}"`,
          new Date(lastModifiedMs).toUTCString(),
        ),
      });
    }

    this.refresh(entry, stats);

    const headers = (entry.headers ??= defaultStaticHeaders(entry.type, entry.etag, entry.lastModified));
    const bytes = withBody ? this.readBytes(filePath, entry, stats.size) : undefined;

    return new Response(bytes ?? Bun.file(filePath), { status: 200, headers });
  }

  private refresh(entry: OpenStaticFile, stats: Stats): void {
    const lastModifiedMs = Math.trunc(stats.mtimeMs);

    if (entry.mtimeMs === lastModifiedMs && entry.size === stats.size) {
      return;
    }

    if (entry.mtimeMs !== lastModifiedMs) {
      entry.mtimeMs = lastModifiedMs;
      entry.lastModified = new Date(lastModifiedMs).toUTCString();
    }

    entry.size = stats.size;
    entry.etag = `W/"${stats.size}-${lastModifiedMs}"`;
    entry.headers = undefined;
  }

  public release(filePath: string): void {
    const entry = this.files.get(filePath);

    if (entry !== undefined) {
      this.forget(filePath, entry);
    }
  }

  public close(): void {
    for (const entry of this.files.values()) {
      closeQuietly(entry.fd);
    }

    this.files.clear();
  }

  private readBytes(filePath: string, entry: OpenStaticFile, size: number): Uint8Array<ArrayBuffer> | undefined {
    if (size > this.maxFileBytes) {
      return undefined;
    }

    const bytes: Uint8Array<ArrayBuffer> = Buffer.allocUnsafeSlow(size);

    try {
      return readSync(entry.fd, bytes, 0, size, 0) === size ? bytes : undefined;
    } catch {
      this.forget(filePath, entry);

      return undefined;
    }
  }

  private entry(filePath: string, stats: Stats): OpenStaticFile | undefined {
    const existing = this.files.get(filePath);

    if (existing !== undefined) {
      if (existing.ino === stats.ino && existing.dev === stats.dev) {
        return existing;
      }

      this.forget(filePath, existing);
    }

    if (stats.size > this.maxFileBytes) {
      return undefined;
    }

    let fd: number;

    try {
      fd = openSync(filePath, 'r');
    } catch {
      return undefined;
    }

    let opened: Stats;

    try {
      opened = fstatSync(fd);
    } catch {
      closeQuietly(fd);

      return undefined;
    }

    if (opened.ino !== stats.ino || opened.dev !== stats.dev || !opened.isFile()) {
      closeQuietly(fd);

      return undefined;
    }

    while (this.files.size >= this.maxOpen) {
      const [oldestPath, oldest] = this.files.entries().next().value as [string, OpenStaticFile];

      this.forget(oldestPath, oldest);
    }

    const entry: OpenStaticFile = {
      fd,
      ino: stats.ino,
      dev: stats.dev,
      type: Bun.file(filePath).type,
      mtimeMs: -1,
      size: -1,
      etag: '',
      lastModified: '',
      headers: undefined,
    };

    this.files.set(filePath, entry);

    return entry;
  }

  private forget(filePath: string, entry: OpenStaticFile): void {
    this.files.delete(filePath);
    closeQuietly(entry.fd);
  }
}
