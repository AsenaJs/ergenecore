import { describe, expect, it } from 'bun:test';
import { StreamWriter } from '../lib';
import { SSEStreamWriter } from '../lib';

describe('StreamWriter', () => {
  const createWriter = () => {
    const { readable, writable } = new TransformStream();

    return { writer: new StreamWriter(writable, readable), readable };
  };

  const readAll = async (readable: ReadableStream): Promise<string> => {
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    let result = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      result += decoder.decode(value, { stream: true });
    }

    return result;
  };

  describe('write', () => {
    it('should write string data to stream', async () => {
      const { writer } = createWriter();

      await writer.write('hello world');
      await writer.close();

      const result = await readAll(writer.responseReadable);

      expect(result).toBe('hello world');
    });

    it('should write Uint8Array data to stream', async () => {
      const { writer } = createWriter();
      const data = new TextEncoder().encode('binary data');

      await writer.write(data);
      await writer.close();

      const result = await readAll(writer.responseReadable);

      expect(result).toBe('binary data');
    });

    it('should write multiple chunks', async () => {
      const { writer } = createWriter();
      // Start reading before writing to avoid TransformStream backpressure
      const readPromise = readAll(writer.responseReadable);

      await writer.write('chunk1');
      await writer.write('chunk2');
      await writer.write('chunk3');
      await writer.close();

      const result = await readPromise;

      expect(result).toBe('chunk1chunk2chunk3');
    });
  });

  describe('writeln', () => {
    it('should write string with newline', async () => {
      const { writer } = createWriter();
      const readPromise = readAll(writer.responseReadable);

      await writer.writeln('line1');
      await writer.writeln('line2');
      await writer.close();

      const result = await readPromise;

      expect(result).toBe('line1\nline2\n');
    });
  });

  describe('close', () => {
    it('should set closed flag to true', async () => {
      const { writer } = createWriter();

      expect(writer.closed).toBe(false);
      await writer.close();
      expect(writer.closed).toBe(true);
    });

    it('should not throw when called multiple times', async () => {
      const { writer } = createWriter();

      await writer.close();
      await writer.close();

      expect(writer.closed).toBe(true);
    });
  });

  describe('abort', () => {
    it('should set aborted flag', () => {
      const { writer } = createWriter();

      expect(writer.aborted).toBe(false);
      writer.abort();
      expect(writer.aborted).toBe(true);
    });

    it('should call onAbort listeners', () => {
      const { writer } = createWriter();
      let called = false;

      writer.onAbort(() => {
        called = true;
      });

      writer.abort();

      expect(called).toBe(true);
    });

    it('should call multiple onAbort listeners', () => {
      const { writer } = createWriter();
      const calls: number[] = [];

      writer.onAbort(() => {
        calls.push(1);
      });
      writer.onAbort(() => {
        calls.push(2);
      });

      writer.abort();

      expect(calls).toEqual([1, 2]);
    });

    it('should not call listeners twice', () => {
      const { writer } = createWriter();
      let callCount = 0;

      writer.onAbort(() => {
        callCount++;
      });

      writer.abort();
      writer.abort();

      expect(callCount).toBe(1);
    });
  });

  describe('pipe', () => {
    it('should pipe external ReadableStream through writer', async () => {
      const { writer } = createWriter();
      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('piped data'));
          controller.close();
        },
      });

      await writer.pipe(source);
      await writer.close();

      const result = await readAll(writer.responseReadable);

      expect(result).toBe('piped data');
    });

    it('should allow writing after pipe', async () => {
      const { writer } = createWriter();
      const readPromise = readAll(writer.responseReadable);
      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('piped'));
          controller.close();
        },
      });

      await writer.pipe(source);
      await writer.write(' and written');
      await writer.close();

      const result = await readPromise;

      expect(result).toBe('piped and written');
    });
  });

  describe('responseReadable cancel triggers abort', () => {
    it('should abort when responseReadable is cancelled', async () => {
      const { writer } = createWriter();
      let abortCalled = false;

      writer.onAbort(() => {
        abortCalled = true;
      });

      const reader = writer.responseReadable.getReader();

      await reader.cancel();

      expect(abortCalled).toBe(true);
      expect(writer.aborted).toBe(true);
    });
  });
});

describe('SSEStreamWriter', () => {
  const createSSEWriter = () => {
    const { readable, writable } = new TransformStream();

    return { writer: new SSEStreamWriter(writable, readable) };
  };

  const readAll = async (readable: ReadableStream): Promise<string> => {
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    let result = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      result += decoder.decode(value, { stream: true });
    }

    return result;
  };

  describe('writeSSE', () => {
    it('should format basic SSE message with data only', async () => {
      const { writer } = createSSEWriter();

      await writer.writeSSE({ data: 'hello' });
      await writer.close();

      const result = await readAll(writer.responseReadable);

      expect(result).toBe('data: hello\n\n');
    });

    it('should format SSE message with event type', async () => {
      const { writer } = createSSEWriter();

      await writer.writeSSE({ data: 'payload', event: 'update' });
      await writer.close();

      const result = await readAll(writer.responseReadable);

      expect(result).toBe('event: update\ndata: payload\n\n');
    });

    it('should format SSE message with all fields', async () => {
      const { writer } = createSSEWriter();

      await writer.writeSSE({
        data: 'payload',
        event: 'message',
        id: '42',
        retry: 5000,
      });
      await writer.close();

      const result = await readAll(writer.responseReadable);

      expect(result).toBe('event: message\ndata: payload\nid: 42\nretry: 5000\n\n');
    });

    it('should split multi-line data into separate data: lines', async () => {
      const { writer } = createSSEWriter();

      await writer.writeSSE({ data: 'line1\nline2\nline3' });
      await writer.close();

      const result = await readAll(writer.responseReadable);

      expect(result).toBe('data: line1\ndata: line2\ndata: line3\n\n');
    });

    it('should handle \\r\\n line endings in data', async () => {
      const { writer } = createSSEWriter();

      await writer.writeSSE({ data: 'line1\r\nline2' });
      await writer.close();

      const result = await readAll(writer.responseReadable);

      expect(result).toBe('data: line1\ndata: line2\n\n');
    });

    it('should write multiple SSE messages', async () => {
      const { writer } = createSSEWriter();
      const readPromise = readAll(writer.responseReadable);

      await writer.writeSSE({ data: 'first', event: 'a' });
      await writer.writeSSE({ data: 'second', event: 'b' });
      await writer.close();

      const result = await readPromise;

      expect(result).toBe('event: a\ndata: first\n\nevent: b\ndata: second\n\n');
    });

    it('should handle JSON data', async () => {
      const { writer } = createSSEWriter();
      const jsonData = JSON.stringify({ count: 1, message: 'test' });

      await writer.writeSSE({ data: jsonData, event: 'update' });
      await writer.close();

      const result = await readAll(writer.responseReadable);

      expect(result).toBe(`event: update\ndata: ${jsonData}\n\n`);
    });
  });
});
