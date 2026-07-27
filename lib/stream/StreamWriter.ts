import type { AsenaStreamWriter } from '@asenajs/asena/adapter';

/**
 * Generic stream writer implementation using Web Streams API.
 * Built on TransformStream - zero external dependencies.
 */
export class StreamWriter implements AsenaStreamWriter {
  private writer: WritableStreamDefaultWriter;

  private encoder: TextEncoder;

  private writable: WritableStream;

  private abortSubscribers: (() => void | Promise<void>)[] = [];

  public readonly responseReadable: ReadableStream;

  public aborted = false;

  public closed = false;

  public constructor(writable: WritableStream, readable: ReadableStream) {
    this.writable = writable;
    this.writer = writable.getWriter();
    this.encoder = new TextEncoder();

    const reader = readable.getReader();

    this.abortSubscribers.push(async () => {
      await reader.cancel();
    });

    this.responseReadable = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();

        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      },
      cancel: () => {
        this.abort();
      },
    });
  }

  public async write(input: Uint8Array | string): Promise<void> {
    try {
      if (typeof input === 'string') {
        input = this.encoder.encode(input);
      }

      await this.writer.write(input);
    } catch {
      // Stream already closed or errored
    }
  }

  public async writeln(input: string): Promise<void> {
    await this.write(input + '\n');
  }

  public async close(): Promise<void> {
    try {
      await this.writer.close();
    } catch {
      // Stream already closed
    }

    this.closed = true;
  }

  public async pipe(body: ReadableStream): Promise<void> {
    this.writer.releaseLock();
    await body.pipeTo(this.writable, { preventClose: true });
    this.writer = this.writable.getWriter();
  }

  public onAbort(listener: () => void | Promise<void>): void {
    this.abortSubscribers.push(listener);
  }

  /**
   * Abort the stream. Called when the client disconnects.
   */
  public abort(): void {
    if (!this.aborted) {
      this.aborted = true;
      // A subscriber may be async - `reader.cancel()` above is. `abort()` is called from a
      // sync teardown path and cannot wait for them, so the promise is dropped deliberately.
      this.abortSubscribers.forEach((subscriber) => void subscriber());
    }
  }
}
