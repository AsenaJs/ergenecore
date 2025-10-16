# Asena Ergenecore Adapter

**Blazing-fast** native Bun adapter for [Asena.js](https://github.com/asenajs/asena) - Built exclusively with Bun's native APIs for maximum performance.

## Features

- ⚡ **Zero Dependencies** - Pure Bun native APIs (except Zod for validation)
- 🚀 **SIMD-Accelerated** - Native Bun router with SIMD-optimized matching
- 🔌 **Full Adapter Support** - HTTP, WebSocket, Middleware, Validation
- 📦 **Zero-Copy File Serving** - Bun.file() for optimal static file performance
- 🎯 **TypeScript First** - Complete type safety out of the box
- ✅ **90%+ Test Coverage** - Thoroughly tested with 212+ passing tests
- 🧩 **Controller-Based** - Seamless integration with Asena decorators

## Why Ergenecore?

Ergenecore is the **fastest** Asena adapter because it:
- Uses Bun's **native HTTP server** (`Bun.serve()`)
- Leverages **SIMD-accelerated routing** (no framework overhead)
- Implements **zero-copy** file serving with `Bun.file()`
- Has **no external dependencies** (except Zod)
- Is optimized for **Bun runtime** exclusively

## Requirements

- [Bun](https://bun.sh) v1.3 or higher
- TypeScript v5.8.2 or higher

## Installation

```bash
bun add @asenajs/ergenecore
```

## Quick Start

### Basic Server Setup

```typescript
import { AsenaServerFactory } from '@asenajs/asena';
import { createErgenecoreAdapter } from '@asenajs/ergenecore/factory';
import { logger } from './logger';

// Create adapter with factory function
const adapter = createErgenecoreAdapter();

// Create and start server
const server = await AsenaServerFactory.create({
  adapter,
  logger,
  port: 3000
});

await server.start();
```

### Controller Example

```typescript
import { Controller } from '@asenajs/asena/server';
import { Get, Post, Put, Delete } from '@asenajs/asena/web';
import type { Context } from '@asenajs/ergenecore/types';

@Controller('/users')
export class UserController {
  @Get({ path: '/' })
  async list(context: Context) {
    const page = context.getQuery('page') || '1';
    return context.send({ users: [], page });
  }

  @Get({ path: '/:id' })
  async getById(context: Context) {
    const id = context.getParam('id');
    return context.send({ id, name: 'John Doe' });
  }

  @Post({ path: '/' })
  async create(context: Context) {
    const body = await context.getBody();
    return context.send({ created: true, data: body }, 201);
  }

  @Put({ path: '/:id' })
  async update(context: Context) {
    const id = context.getParam('id');
    const body = await context.getBody();
    return context.send({ id, updated: true, data: body });
  }

  @Delete({ path: '/:id' })
  async delete(context: Context) {
    const id = context.getParam('id');
    return context.send({ id, deleted: true }, 204);
  }
}
```

## API Documentation

### Factory Functions

#### `createErgenecoreAdapter(options?)`

Creates a new Ergenecore adapter instance with optional configuration.

```typescript
import { AsenaServerFactory } from '@asenajs/asena';
import { createErgenecoreAdapter } from '@asenajs/ergenecore/factory';
import { logger } from './logger';

const adapter = createErgenecoreAdapter({
  hostname: 'localhost',
  enableWebSocket: true
});

const server = await AsenaServerFactory.create({
  adapter,
  logger,
  port: 3000
});

await server.start();
```

**Options:**
- `hostname` (string): Server hostname (default: undefined)
- `logger` (ServerLogger): Custom logger instance (optional, can be passed to AsenaServerFactory)
- `enableWebSocket` (boolean): Enable WebSocket support (default: true)
- `websocketAdapter` (ErgenecoreWebsocketAdapter): Custom WebSocket adapter

#### `createProductionAdapter(options?)`

Creates a production-optimized adapter with sensible defaults.

```typescript
import { AsenaServerFactory } from '@asenajs/asena';
import { createProductionAdapter } from '@asenajs/ergenecore/factory';
import { logger } from './logger';

const adapter = createProductionAdapter({
  hostname: '0.0.0.0'
});

const server = await AsenaServerFactory.create({
  adapter,
  logger,
  port: 8080
});

await server.start();
```

#### `createDevelopmentAdapter(options?)`

Creates a development-friendly adapter with verbose logging.

```typescript
import { AsenaServerFactory } from '@asenajs/asena';
import { createDevelopmentAdapter } from '@asenajs/ergenecore/factory';
import { logger } from './logger';

const adapter = createDevelopmentAdapter();

const server = await AsenaServerFactory.create({
  adapter,
  logger,
  port: 3000
});

await server.start();
```

### Context API

The `Context` type provides access to request/response handling:

```typescript
import type { Context } from '@asenajs/ergenecore/types';

// Get route parameters
const id = context.getParam('id');

// Get query parameters
const page = context.getQuery('page');

// Get request body
const body = await context.getBody();

// Get headers
const auth = context.getHeader('authorization');

// Send JSON response
return context.send({ success: true });

// Send with custom status
return context.send({ error: 'Not found' }, 404);

// Set cookies
context.setCookie('session', 'abc123', {
  httpOnly: true,
  secure: true,
  maxAge: 86400
});

// Get cookies
const session = context.getCookie('session');
```

### Middleware

#### Custom Middleware

```typescript
import { Middleware } from '@asenajs/asena/server';
import { Controller } from '@asenajs/asena/server';
import { Get } from '@asenajs/asena/web';
import { MiddlewareService, type Context } from '@asenajs/ergenecore';

@Middleware()
export class AuthMiddleware extends MiddlewareService {
  async handle(context: Context, next: () => Promise<void>): Promise<any> {
    const token = context.getHeader('authorization');

    if (!token) {
      return context.send({ error: 'Unauthorized' }, 401);
    }

    // Verify token and set user in context
    context.setValue('userId', 123);

    await next();
  }
}

// Use in route
@Controller('/admin')
export class AdminController {
  @Get({ path: '/dashboard', middlewares: [AuthMiddleware] })
  async dashboard(context: Context) {
    const userId = context.getValue('userId');
    return context.send({ userId, message: 'Admin dashboard' });
  }
}
```

#### CORS Middleware

Ergenecore comes with a built-in CORS middleware for handling Cross-Origin Resource Sharing:

```typescript
import { Middleware } from '@asenajs/asena/server';
import { CorsMiddleware } from '@asenajs/ergenecore';

// Allow all origins (default)
@Middleware()
export class GlobalCors extends CorsMiddleware {
  constructor() {
    super(); // Defaults to { origin: '*' }
  }
}

// Whitelist specific origins
@Middleware()
export class RestrictedCors extends CorsMiddleware {
  constructor() {
    super({
      origin: ['https://example.com', 'https://app.example.com'],
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      exposedHeaders: ['X-Total-Count'],
      maxAge: 86400 // 24 hours
    });
  }
}

// Dynamic origin validation
@Middleware()
export class DynamicCors extends CorsMiddleware {
  constructor() {
    super({
      origin: (origin: string) => {
        // Allow all subdomains of example.com
        return origin.endsWith('.example.com') || origin === 'https://example.com';
      },
      credentials: true
    });
  }
}

// Use globally in server config
import { Config } from '@asenajs/asena/server';
import { ConfigService } from '@asenajs/ergenecore';

@Config()
export class ServerConfig extends ConfigService {
  middlewares = [GlobalCors];
}

// Or use per-route
@Controller('/api')
export class ApiController {
  @Get({ path: '/public', middlewares: [RestrictedCors] })
  async publicData(context: Context) {
    return context.send({ data: 'public' });
  }
}
```

#### Rate Limiter Middleware

Ergenecore includes a Token Bucket-based rate limiter for controlling request rates and preventing abuse:

```typescript
import { Middleware } from '@asenajs/asena/server';
import { RateLimiterMiddleware } from '@asenajs/ergenecore';

// General API rate limiter (100 requests per minute)
@Middleware()
export class ApiRateLimiter extends RateLimiterMiddleware {
  constructor() {
    super({
      capacity: 100,
      refillRate: 100 / 60, // 100 requests per minute
    });
  }
}

// Strict rate limiter for sensitive endpoints (5 requests per minute)
@Middleware()
export class StrictRateLimiter extends RateLimiterMiddleware {
  constructor() {
    super({
      capacity: 5,
      refillRate: 5 / 60, // 5 requests per minute
      message: 'Too many login attempts. Please try again later.',
    });
  }
}

// Custom rate limiter with advanced options
@Middleware()
export class CustomRateLimiter extends RateLimiterMiddleware {
  constructor() {
    super({
      capacity: 50,
      refillRate: 50 / 60, // 50 requests per minute

      // Rate limit by user ID instead of IP
      keyGenerator: (ctx) => ctx.state.user?.id || 'anonymous',

      // Skip rate limiting for admin users
      skip: (ctx) => ctx.state.user?.role === 'admin',

      // Expensive operations cost more tokens
      cost: (ctx) => ctx.req.url.includes('/search') ? 5 : 1,

      // Custom response message
      message: 'Rate limit exceeded. Please slow down.',
      statusCode: 429,

      // Cleanup inactive buckets every 60 seconds
      cleanupInterval: 60000,
      bucketTTL: 600000 // 10 minutes
    });
  }
}

// Use globally
import { Config } from '@asenajs/asena/server';
import { ConfigService } from '@asenajs/ergenecore';

@Config()
export class ServerConfig extends ConfigService {
  middlewares = [ApiRateLimiter];
}

// Use per-controller
@Controller('/api', { middlewares: [ApiRateLimiter] })
export class ApiController {
  @Get({ path: '/users' })
  async getUsers(context: Context) {
    return context.send({ users: [] });
  }
}

// Use per-route for stricter limits
@Controller('/auth')
export class AuthController {
  @Post({ path: '/login', middlewares: [StrictRateLimiter] })
  async login(context: Context) {
    const body = await context.getBody();
    // Login logic
    return context.send({ token: 'abc123' });
  }
}
```

**Rate Limiter Options:**
- `capacity` (number): Maximum token bucket size (burst capacity). Default: `100`
- `refillRate` (number): Tokens refilled per second. Default: `10`
- `keyGenerator` (function): Custom function to identify clients. Default: IP-based
- `message` (string): Custom error message. Default: `'Rate limit exceeded. Please try again later.'`
- `statusCode` (number): HTTP status code for rate limit response. Default: `429`
- `cost` (number | function): Token cost per request. Default: `1`
- `skip` (function): Skip rate limiting based on context. Default: `undefined`
- `cleanupInterval` (number): Cleanup interval in milliseconds. Default: `60000` (1 minute)
- `bucketTTL` (number): Inactive bucket TTL in milliseconds. Default: `600000` (10 minutes)

**Rate Limit Headers:**

The middleware automatically sets standard rate limit headers:
- `X-RateLimit-Limit`: Requests allowed per minute
- `X-RateLimit-Remaining`: Remaining tokens in bucket
- `X-RateLimit-Reset`: Unix timestamp when bucket resets
- `Retry-After`: Seconds to wait before retrying (on 429 response)

### Validation with Zod

```typescript
import { Controller, Middleware } from '@asenajs/asena/server';
import { Post } from '@asenajs/asena/web';
import { ValidationService, type Context, type ValidationSchema, type ValidationSchemaWithHook } from '@asenajs/ergenecore';
import { z } from 'zod';

@Middleware({ validator: true })
export class CreateUserValidator extends ValidationService {
  json(): ValidationSchema | ValidationSchemaWithHook {
    return z.object({
      name: z.string({ message: 'Name is required' }).min(3).max(50),
      email: z.string({ message: 'Email is required' }).email(),
      age: z.number({ message: 'Age must be a number' }).min(18)
    });
  }
}

// Use in controller
@Controller('/users')
export class UserController {
  @Post({ path: '/', validator: CreateUserValidator })
  async create(context: Context) {
    const body = await context.getBody();

    // Body is automatically validated by Asena
    return context.send({ created: true, data: body }, 201);
  }
}
```

**Note:** The `json()` method can also return a Promise for async validation schemas:
```typescript
async json(): Promise<ValidationSchema | ValidationSchemaWithHook> {
  return z.object({ /* schema */ });
}
```

### Combining Middleware and Validation

```typescript
import { Controller, Middleware } from '@asenajs/asena/server';
import { Post } from '@asenajs/asena/web';
import {
  MiddlewareService,
  ValidationService,
  type Context,
  type ValidationSchema,
  type ValidationSchemaWithHook
} from '@asenajs/ergenecore';
import { z } from 'zod';

// Authentication middleware
@Middleware()
export class AuthMiddleware extends MiddlewareService {
  async handle(context: Context, next: () => Promise<void>): Promise<any> {
    const token = context.getHeader('authorization');

    if (!token) {
      return context.send({ error: 'Unauthorized' }, 401);
    }

    // Verify token and set user
    context.setValue('userId', 123);
    await next();
  }
}

// Validation
@Middleware({ validator: true })
export class CreatePostValidator extends ValidationService {
  json(): ValidationSchema | ValidationSchemaWithHook {
    return z.object({
      title: z.string({ message: 'Title is required' }).min(5),
      content: z.string({ message: 'Content is required' }).min(10)
    });
  }
}

// Controller with both middleware and validation
@Controller('/posts')
export class PostController {
  @Post({ path: '/', validator: CreatePostValidator, middlewares: [AuthMiddleware] })
  async create(context: Context) {
    const body = await context.getBody();
    const userId = context.getValue('userId');

    return context.send({
      created: true,
      userId,
      post: body
    }, 201);
  }
}
```

### WebSocket Support

```typescript
import { WebSocket } from '@asenajs/asena/web-socket';
import { AsenaWebSocketService } from '@asenajs/asena/web-socket';
import type { Socket } from '@asenajs/asena/web-socket';

@WebSocket({ path: '/chat', name: 'ChatSocket' })
export class ChatSocket extends AsenaWebSocketService<void> {
  protected async onOpen(ws: Socket<void>): Promise<void> {
    console.log('Client connected:', ws.id);
    ws.send('Welcome to chat!');
  }

  protected async onMessage(ws: Socket<void>, message: string): Promise<void> {
    console.log('Received:', message);

    // Echo message back to client
    ws.send(`Echo: ${message}`);
  }

  protected async onClose(ws: Socket<void>): Promise<void> {
    console.log('Client disconnected:', ws.id);
  }
}
```

### Static File Serving

```typescript
import { Controller } from '@asenajs/asena/server';
import { Get } from '@asenajs/asena/web';
import { StaticServe, StaticServeService } from '@asenajs/asena/static';
import type { Context } from '@asenajs/ergenecore/types';

@StaticServe({ root: './public' })
export class StaticMiddleware extends StaticServeService {
  rewriteRequestPath(path: string): string {
    return path.replace(/^\/static\/|^static\//, '');
  }

  onFound(_path: string, _context: Context): void | Promise<void> {
    console.log('File found and served');
  }

  onNotFound(path: string, context: Context): void | Promise<void> {
    console.log(`${path} not found, requested: ${context.getRequest().url}`);
  }
}

// Use in controller
@Controller('/static')
export class StaticController {
  @Get({ path: '/*', staticServe: StaticMiddleware })
  static() {}
}
```

### Error Handling

```typescript
import { Config } from '@asenajs/asena/server';
import { Inject } from '@asenajs/asena/ioc';
import { ConfigService, type Context } from '@asenajs/ergenecore';

@Config()
export class ServerConfig extends ConfigService {
  onError(error: Error, context: Context): Response | Promise<Response> {
    console.error('Error:', error);

    return context.send({
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    }, 500);
  }
}

// With custom exception mapper
export class ExceptionMapper {
  map(error: Error, context: Context): Response {
    // Custom error mapping logic
    if (error.name === 'ValidationError') {
      return context.send({ error: 'Validation failed', details: error.message }, 400);
    }

    return context.send({ error: 'Internal server error' }, 500);
  }
}

@Config()
export class ServerConfigWithMapper extends ConfigService {
  @Inject('ExceptionMapper')
  private mapper: ExceptionMapper;

  onError(error: Error, context: Context): Response | Promise<Response> {
    return this.mapper.map(error, context);
  }
}
```

## Contributing

Contributions are welcome! Please follow these guidelines:

1. Follow the **TDD approach** (write tests first)
2. Maintain **90%+ test coverage**
3. Use **Bun native APIs** only (no external dependencies except Zod)
4. Follow the **CLAUDE.md** guidelines

## License

MIT License - see [LICENSE](LICENSE) for details.

## Related Projects

- [Asena.js](https://asena.sh) - The core framework
- [Bun](https://bun.sh) - The JavaScript runtime

---

**Built with ⚡ by the Asena.js team**
