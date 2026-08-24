import { describe, expect, it } from 'bun:test';
import { ErgenecoreContextWrapper, HttpException } from '../lib';

describe('CoreContextWrapper', () => {
  /**
   * Create a mock Request object for testing
   */
  const createMockRequest = (
    options: {
      url?: string;
      method?: string;
      headers?: Record<string, string>;
      body?: any;
    } = {},
  ) => {
    const url = options.url || 'http://localhost:3000/test';
    const method = options.method || 'GET';
    const headers = new Headers(options.headers || {});

    const requestInit: RequestInit = {
      method,
      headers,
    };

    if (options.body) {
      requestInit.body = JSON.stringify(options.body);
      headers.set('Content-Type', 'application/json');
    }

    return new Request(url, requestInit);
  };

  describe('Constructor and Basic Getters', () => {
    it('should create a wrapper instance and provide access to request', () => {
      const request = createMockRequest();
      const wrapper = new ErgenecoreContextWrapper(request);

      expect(wrapper).toBeDefined();
      expect(wrapper.req).toBe(request);
    });

    it('should provide access to headers', () => {
      const request = createMockRequest({
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token123',
        },
      });
      const wrapper = new ErgenecoreContextWrapper(request);

      const headers = wrapper.headers;

      expect(headers['content-type']).toBe('application/json');
      expect(headers['authorization']).toBe('Bearer token123');
    });

    it('should parse URL correctly', () => {
      const request = createMockRequest({
        url: 'http://localhost:3000/users/123?page=1&limit=10',
      });
      const wrapper = new ErgenecoreContextWrapper(request);

      // URL should be accessible internally
      expect(wrapper.req.url).toBe('http://localhost:3000/users/123?page=1&limit=10');
    });
  });

  describe('Request Body Methods', () => {
    it('should get JSON body', async () => {
      const bodyData = { name: 'John Doe', email: 'john@example.com' };
      const request = createMockRequest({ body: bodyData });
      const wrapper = new ErgenecoreContextWrapper(request);

      const body = await wrapper.getBody<typeof bodyData>();

      expect(body).toEqual(bodyData);
    });

    it('should get array buffer', async () => {
      const request = new Request('http://localhost:3000/test', {
        method: 'POST',
        body: new ArrayBuffer(8),
      });
      const wrapper = new ErgenecoreContextWrapper(request);

      const buffer = await wrapper.getArrayBuffer();

      expect(buffer).toBeInstanceOf(ArrayBuffer);
      expect(buffer.byteLength).toBe(8);
    });

    it('should get blob', async () => {
      const blobContent = new Blob(['test content'], { type: 'text/plain' });
      const request = new Request('http://localhost:3000/test', {
        method: 'POST',
        body: blobContent,
      });
      const wrapper = new ErgenecoreContextWrapper(request);

      const blob = await wrapper.getBlob();

      expect(blob).toBeInstanceOf(Blob);
      // Bun may add charset to content type
      expect(blob.type).toMatch(/text\/plain/);
    });

    it('should get form data', async () => {
      const formData = new FormData();

      formData.append('username', 'johndoe');
      formData.append('email', 'john@example.com');

      const request = new Request('http://localhost:3000/test', {
        method: 'POST',
        body: formData,
      });
      const wrapper = new ErgenecoreContextWrapper(request);

      const retrievedFormData = await wrapper.getFormData();

      expect(retrievedFormData).toBeInstanceOf(FormData);
      expect(retrievedFormData.get('username')).toBe('johndoe');
      expect(retrievedFormData.get('email')).toBe('john@example.com');
    });

    it('should get parsed body (multipart form data)', async () => {
      const formData = new FormData();

      formData.append('field1', 'value1');
      formData.append('field2', 'value2');

      const request = new Request('http://localhost:3000/test', {
        method: 'POST',
        body: formData,
      });
      const wrapper = new ErgenecoreContextWrapper(request);

      const parsedBody = await wrapper.getParseBody();

      expect(parsedBody).toBeDefined();
      // Note: getParseBody should return an object representation
    });
  });

  /**
   * The Request body is a one-shot stream, but the wrapper hands out several representations
   * (text/JSON, FormData, ArrayBuffer, Blob). Without a shared raw-body cache each reader
   * consumed the stream independently, so whichever came second failed - as a misleading
   * 400 from the readers that wrap their errors, or as a bare stream error from the rest.
   */
  describe('Cross-Representation Body Reads', () => {
    const multipartRequest = () => {
      const formData = new FormData();

      formData.append('name', 'John');

      return new Request('http://localhost:3000/test', { method: 'POST', body: formData });
    };

    it('should serve getArrayBuffer after getFormData from the same request', async () => {
      const wrapper = new ErgenecoreContextWrapper(multipartRequest());

      const formData = await wrapper.getFormData();

      expect(formData.get('name')).toBe('John');

      const buffer = await wrapper.getArrayBuffer();

      expect(buffer.byteLength).toBeGreaterThan(0);
    });

    it('should serve getArrayBuffer after getBody from the same request', async () => {
      const request = createMockRequest({ method: 'POST', body: { name: 'John' } });
      const wrapper = new ErgenecoreContextWrapper(request);

      expect(await wrapper.getBody<{ name: string }>()).toEqual({ name: 'John' });

      const buffer = await wrapper.getArrayBuffer();

      expect(new TextDecoder().decode(buffer)).toBe(JSON.stringify({ name: 'John' }));
    });

    it('should return the same bytes on repeated getArrayBuffer calls', async () => {
      const request = new Request('http://localhost:3000/test', { method: 'POST', body: 'raw-bytes' });
      const wrapper = new ErgenecoreContextWrapper(request);

      const first = await wrapper.getArrayBuffer();
      const second = await wrapper.getArrayBuffer();

      expect(new TextDecoder().decode(second)).toBe('raw-bytes');
      expect(new TextDecoder().decode(first)).toBe('raw-bytes');
    });

    it('should keep the raw body readable after a malformed-form parse failure', async () => {
      const request = new Request('http://localhost:3000/test', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=x' },
        body: 'not a multipart payload',
      });
      const wrapper = new ErgenecoreContextWrapper(request);

      await expect(wrapper.getFormData()).rejects.toThrow(HttpException);

      // The failed parse must not eat the stream - the raw bytes are still there
      const buffer = await wrapper.getArrayBuffer();

      expect(new TextDecoder().decode(buffer)).toBe('not a multipart payload');
    });

    it('should keep rejecting non-JSON bodies from getBody', async () => {
      // getBody is the JSON reader; the unified cache must not silently make it form-aware
      const request = new Request('http://localhost:3000/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'name=John&age=25',
      });
      const wrapper = new ErgenecoreContextWrapper(request);

      await expect(wrapper.getBody()).rejects.toThrow(HttpException);
    });
  });

  describe('Query Parameters', () => {
    it('should get single query parameter', async () => {
      const request = createMockRequest({
        url: 'http://localhost:3000/search?q=test&page=1',
      });
      const wrapper = new ErgenecoreContextWrapper(request);

      const query = await wrapper.getQuery('q');

      expect(query).toBe('test');
    });

    it('should return undefined for missing query parameter', async () => {
      const request = createMockRequest({
        url: 'http://localhost:3000/search',
      });
      const wrapper = new ErgenecoreContextWrapper(request);

      const query = await wrapper.getQuery('missing');

      expect(query).toBeUndefined();
    });

    it('should return empty string for present-but-empty query parameter', async () => {
      const request = createMockRequest({
        url: 'http://localhost:3000/search?name=',
      });
      const wrapper = new ErgenecoreContextWrapper(request);

      const query = await wrapper.getQuery('name');

      expect(query).toBe('');
    });

    it('should get all query parameters (array)', async () => {
      const request = createMockRequest({
        url: 'http://localhost:3000/filter?tags=javascript&tags=typescript&tags=bun',
      });
      const wrapper = new ErgenecoreContextWrapper(request);

      const queries = await wrapper.getQueryAll('tags');

      expect(queries).toEqual(['javascript', 'typescript', 'bun']);
    });

    it('should return empty array for missing query parameter in getQueryAll', async () => {
      const request = createMockRequest({
        url: 'http://localhost:3000/test',
      });
      const wrapper = new ErgenecoreContextWrapper(request);

      const queries = await wrapper.getQueryAll('missing');

      expect(queries).toEqual([]);
    });
  });

  describe('URL Parameters', () => {
    it('should get URL parameter', () => {
      const request = createMockRequest({
        url: 'http://localhost:3000/users/123',
      });
      const wrapper = new ErgenecoreContextWrapper(request);

      // Set param manually for testing (router will do this in real usage)
      wrapper.setValue('param:id', '123');

      const param = wrapper.getParam('id');

      expect(param).toBe('123');
    });

    it('should return empty string for missing parameter', () => {
      const request = createMockRequest();
      const wrapper = new ErgenecoreContextWrapper(request);

      const param = wrapper.getParam('id');

      expect(param).toBe('');
    });
  });

  describe('Response Methods - send()', () => {
    it('should send string data as text response', () => {
      const request = createMockRequest();
      const wrapper = new ErgenecoreContextWrapper(request);

      const response = wrapper.send('Hello World');

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(200);
    });

    it('should send JSON data correctly', async () => {
      const request = createMockRequest();
      const wrapper = new ErgenecoreContextWrapper(request);

      const data = { message: 'Hello World', success: true };
      const response = wrapper.send(data);

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');

      const json = await response.json();

      expect(json).toEqual(data);
    });

    it('should send JSON with custom status code', async () => {
      const request = createMockRequest();
      const wrapper = new ErgenecoreContextWrapper(request);

      const data = { error: 'Not Found' };
      const response = wrapper.send(data, 404);

      expect(response.status).toBe(404);

      const json = await response.json();

      expect(json).toEqual(data);
    });

    it('should send JSON with SendOptions', async () => {
      const request = createMockRequest();
      const wrapper = new ErgenecoreContextWrapper(request);

      const data = { message: 'Created' };
      const options = { status: 201, headers: { 'X-Custom': 'value' } };

      const response = wrapper.send(data, options);

      expect(response.status).toBe(201);
      expect(response.headers.get('X-Custom')).toBe('value');

      const json = await response.json();

      expect(json).toEqual(data);
    });
  });

  describe('Response Methods - html()', () => {
    it('should send HTML content correctly', async () => {
      const request = createMockRequest();
      const wrapper = new ErgenecoreContextWrapper(request);

      const html = '<h1>Hello World</h1>';
      const response = wrapper.html(html);

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html');

      const text = await response.text();

      expect(text).toBe(html);
    });

    it('should send HTML with custom status code', async () => {
      const request = createMockRequest();
      const wrapper = new ErgenecoreContextWrapper(request);

      const html = '<h1>Not Found</h1>';
      const response = wrapper.html(html, 404);

      expect(response.status).toBe(404);

      const text = await response.text();

      expect(text).toBe(html);
    });

    it('should send HTML with SendOptions', () => {
      const request = createMockRequest();
      const wrapper = new ErgenecoreContextWrapper(request);

      const html = '<p>Hello</p>';
      const options = { status: 201, headers: { 'X-Custom-Header': 'custom' } };

      const response = wrapper.html(html, options);

      expect(response.status).toBe(201);
      expect(response.headers.get('X-Custom-Header')).toBe('custom');
    });
  });

  describe('Response Headers', () => {
    it('should keep the last value when setResponseHeader is called twice', () => {
      const wrapper = new ErgenecoreContextWrapper(createMockRequest());

      wrapper.setResponseHeader('X-Test', 'first');
      wrapper.setResponseHeader('X-Test', 'second');

      const response = wrapper.send('ok');

      expect(response.headers.get('X-Test')).toBe('second');
    });

    it('treats header names case-insensitively when staging set and append', () => {
      const wrapper = new ErgenecoreContextWrapper(createMockRequest());

      wrapper.setResponseHeader('vary', 'Accept-Encoding');

      wrapper.appendResponseHeader('Vary', 'Origin');

      const response = wrapper.send('ok');

      expect(response.headers.get('Vary')).toBe('Accept-Encoding, Origin');
    });

    it('should comma-join values when appendResponseHeader is called twice', () => {
      const wrapper = new ErgenecoreContextWrapper(createMockRequest());

      wrapper.appendResponseHeader('X-Test', 'a');
      wrapper.appendResponseHeader('X-Test', 'b');

      const response = wrapper.send('ok');

      expect(response.headers.get('X-Test')).toBe('a, b');
    });

    it('should append to a value staged with setResponseHeader', () => {
      const wrapper = new ErgenecoreContextWrapper(createMockRequest());

      wrapper.setResponseHeader('Vary', 'Accept-Encoding');
      wrapper.appendResponseHeader('Vary', 'Origin');

      const response = wrapper.send('ok');

      expect(response.headers.get('Vary')).toBe('Accept-Encoding, Origin');
    });

    it('should carry staged set and appended headers onto a raw Response', () => {
      const wrapper = new ErgenecoreContextWrapper(createMockRequest());

      wrapper.setResponseHeader('X-Set', 'value');
      wrapper.appendResponseHeader('X-Append', 'a');
      wrapper.appendResponseHeader('X-Append', 'b');

      const response = wrapper.applyMiddlewareHeaders(new Response('raw'));

      expect(response.headers.get('X-Set')).toBe('value');
      expect(response.headers.get('X-Append')).toBe('a, b');
    });
  });

  describe('Redirect', () => {
    it('should redirect correctly', () => {
      const request = createMockRequest();
      const wrapper = new ErgenecoreContextWrapper(request);

      const response = wrapper.redirect('/home');

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/home');
    });

    it('should redirect to external URL', () => {
      const request = createMockRequest();
      const wrapper = new ErgenecoreContextWrapper(request);

      const response = wrapper.redirect('https://example.com');

      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('https://example.com');
    });
  });

  describe('Context Value Management', () => {
    it('should get and set context values', () => {
      const request = createMockRequest();
      const wrapper = new ErgenecoreContextWrapper(request);

      wrapper.setValue('user', { id: '123', name: 'John' });
      const value = wrapper.getValue<{ id: string; name: string }>('user');

      expect(value).toEqual({ id: '123', name: 'John' });
    });

    it('should return undefined for non-existent key', () => {
      const request = createMockRequest();
      const wrapper = new ErgenecoreContextWrapper(request);

      const value = wrapper.getValue('nonexistent');

      expect(value).toBeUndefined();
    });

    it('should set and get WebSocket values', () => {
      const request = createMockRequest();
      const wrapper = new ErgenecoreContextWrapper(request);

      const wsData = { userId: '123', room: 'chat' };

      wrapper.setWebSocketValue(wsData);
      const retrievedData = wrapper.getWebSocketValue();

      expect(retrievedData).toEqual(wsData);
    });

    it('should handle WebSocket value as separate from regular values', () => {
      const request = createMockRequest();
      const wrapper = new ErgenecoreContextWrapper(request);

      wrapper.setValue('data', { type: 'regular' });
      wrapper.setWebSocketValue({ type: 'websocket' });

      expect(wrapper.getValue<any>('data')).toEqual({ type: 'regular' });
      expect(wrapper.getWebSocketValue<any>()).toEqual({ type: 'websocket' });
    });
  });
});
