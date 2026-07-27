import type { AsenaSSEStreamWriter, SSEMessage } from '@asenajs/asena/adapter';
import { StreamWriter } from './StreamWriter';

/**
 * SSE stream writer that extends StreamWriter with SSE message formatting.
 * Formats messages according to the Server-Sent Events specification.
 */
export class SSEStreamWriter extends StreamWriter implements AsenaSSEStreamWriter {
  public async writeSSE(message: SSEMessage): Promise<void> {
    const dataLines = message.data
      .split(/\r\n|\r|\n/)
      .map((line) => `data: ${line}`)
      .join('\n');

    const sseData =
      [
        message.event && `event: ${message.event}`,
        dataLines,
        message.id && `id: ${message.id}`,
        message.retry && `retry: ${message.retry}`,
      ]
        .filter(Boolean)
        .join('\n') + '\n\n';

    await this.write(sseData);
  }
}
