# Asena Ergenecore Adapter

[![Version](https://img.shields.io/npm/v/@asenajs/ergenecore.svg)](https://asena.sh)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Bun Version](https://img.shields.io/badge/Bun-1.4%2B-blueviolet)](https://bun.sh)

Native Bun HTTP/WebSocket adapter for [Asena](https://asena.sh), built only on Bun's own APIs, with zero runtime dependencies.

**Requirements:** Bun 1.4+, `@asenajs/asena` 0.12+, `zod` 4.3.6+ (peer dependencies).

## Installation

```bash
bun add @asenajs/asena @asenajs/ergenecore @asenajs/asena-logger zod
```

## Quick Start

```typescript
import { AsenaServerFactory } from '@asenajs/asena';
import { Controller } from '@asenajs/asena/decorators';
import { Get } from '@asenajs/asena/decorators/http';
import { createErgenecoreAdapter, type Context } from '@asenajs/ergenecore';
import { AsenaLogger } from '@asenajs/asena-logger';

@Controller('/')
class HelloController {
  @Get('/')
  async hello(context: Context) {
    return context.send({ message: 'Hello from Ergenecore' });
  }
}

const server = await AsenaServerFactory.create({
  adapter: createErgenecoreAdapter(),
  logger: new AsenaLogger(),
  port: 3000,
  components: [HelloController],
});

await server.start();
```

## Documentation

Full documentation: [asena.sh/docs/adapters/ergenecore](https://asena.sh/docs/adapters/ergenecore)

## Contributing

Contributions are welcome! Submit a Pull Request on [GitHub](https://github.com/AsenaJs/ergenecore).

## License

MIT License - see [LICENSE](LICENSE) for details.
