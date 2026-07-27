import { describe, expect, it } from 'bun:test';
import { ErgenecoreContextWrapper } from '../lib';

describe('ErgenecoreContextWrapper - Streaming', () => {
  const createContext = (url = 'http://localhost:3000/test') => {
    const request = new Request(url);

    return new ErgenecoreContextWrapper(request);
  };

  const readAll = async (response: Response): Promise<string> => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let result = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      result += decoder.decode(value, { stream: true });
    }

    return result;
  };

  describe('stream()', () => {
    it('should return a Response with ReadableStream body', () => {
      const context = createContext();
      const response = context.stream(async (stream) => {
        await stream.write('data');
      });

      expect(response).toBeInstanceOf(Response);
      expect(response.body).toBeDefined();
      expect(response.status).toBe(200);
    });

    it('should stream written data', async () => {
      const context = createContext();
      const response = context.stream(async (stream) => {
        await stream.write('hello ');
        await stream.write('world');
      });

      const result = await readAll(response);

      expect(result).toBe('hello world');
    });

    it('should not set content-type by default', () => {
      const context = createContext();
      const response = context.stream(async (stream) => {
        await stream.write('data');
      });

      expect(response.headers.get('content-type')).toBeNull();
    });

    it('should include middleware headers', () => {
      const context = createContext();

      context.setResponseHeader('X-Custom', 'value');

      const response = context.stream(async (stream) => {
        await stream.write('data');
      });

      expect(response.headers.get('X-Custom')).toBe('value');
    });

    it('should close stream after callback completes', async () => {
      const context = createContext();
      let streamRef: any;

      const response = context.stream(async (stream) => {
        streamRef = stream;
        await stream.write('data');
      });

      await readAll(response);

      // Give fire-and-forget callback time to finish
      await new Promise((r) => setTimeout(r, 10));

      expect(streamRef.closed).toBe(true);
    });

    it('should call onError when callback throws', async () => {
      const context = createContext();
      let errorReceived: Error | null = null;

      const response = context.stream(
        async () => {
          throw new Error('stream error');
        },
        async (error) => {
          errorReceived = error;
        },
      );

      await readAll(response);
      await new Promise((r) => setTimeout(r, 10));

      expect(errorReceived).not.toBeNull();
      expect(errorReceived!.message).toBe('stream error');
    });
  });

  describe('streamSSE()', () => {
    it('should set SSE headers', () => {
      const context = createContext();
      const response = context.streamSSE(async (stream) => {
        await stream.writeSSE({ data: 'test' });
      });

      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(response.headers.get('connection')).toBe('keep-alive');
    });

    it('should stream SSE formatted messages', async () => {
      const context = createContext();
      const response = context.streamSSE(async (stream) => {
        await stream.writeSSE({ data: 'hello', event: 'greeting' });
        await stream.writeSSE({ data: 'world', id: '2' });
      });

      const result = await readAll(response);

      expect(result).toContain('event: greeting');
      expect(result).toContain('data: hello');
      expect(result).toContain('data: world');
      expect(result).toContain('id: 2');
    });

    it('should include middleware headers alongside SSE headers', () => {
      const context = createContext();

      context.setResponseHeader('X-Request-Id', 'abc');

      const response = context.streamSSE(async (stream) => {
        await stream.writeSSE({ data: 'test' });
      });

      expect(response.headers.get('X-Request-Id')).toBe('abc');
      expect(response.headers.get('content-type')).toBe('text/event-stream');
    });

    it('should call onError when callback throws', async () => {
      const context = createContext();
      let errorReceived: Error | null = null;

      const response = context.streamSSE(
        async () => {
          throw new Error('sse error');
        },
        async (error) => {
          errorReceived = error;
        },
      );

      await readAll(response);
      await new Promise((r) => setTimeout(r, 10));

      expect(errorReceived).not.toBeNull();
      expect(errorReceived!.message).toBe('sse error');
    });
  });

  describe('streamText()', () => {
    it('should set text/plain content-type', () => {
      const context = createContext();
      const response = context.streamText(async (stream) => {
        await stream.writeln('line1');
      });

      expect(response.headers.get('content-type')).toBe('text/plain');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('should stream text data', async () => {
      const context = createContext();
      const response = context.streamText(async (stream) => {
        await stream.writeln('line1');
        await stream.writeln('line2');
      });

      const result = await readAll(response);

      expect(result).toBe('line1\nline2\n');
    });

    it('should include middleware headers alongside text headers', () => {
      const context = createContext();

      context.setResponseHeader('X-Trace', '123');

      const response = context.streamText(async (stream) => {
        await stream.write('data');
      });

      expect(response.headers.get('X-Trace')).toBe('123');
      expect(response.headers.get('content-type')).toBe('text/plain');
    });
  });
});
