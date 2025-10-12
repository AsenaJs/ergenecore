import { describe, expect, it } from 'bun:test';
import { ErgenecoreContextWrapper } from '../lib';

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

  describe('Query Parameters', () => {
    it('should get single query parameter', async () => {
      const request = createMockRequest({
        url: 'http://localhost:3000/search?q=test&page=1',
      });
      const wrapper = new ErgenecoreContextWrapper(request);

      const query = await wrapper.getQuery('q');

      expect(query).toBe('test');
    });

    it('should return empty string for missing query parameter', async () => {
      const request = createMockRequest({
        url: 'http://localhost:3000/search',
      });
      const wrapper = new ErgenecoreContextWrapper(request);

      const query = await wrapper.getQuery('missing');

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
