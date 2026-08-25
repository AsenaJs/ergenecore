import type { AsenaSSEStreamWriter, SSEMessage } from '@asenajs/asena/adapter';
import { StreamWriter } from './StreamWriter';

/**
 * SSE stream writer that extends StreamWriter with SSE message formatting.
 * Formats messages according to the Server-Sent Events specification.
 */
export class SSEStreamWriter extends StreamWriter implements AsenaSSEStreamWriter {
  public async writeSSE(message: SSEMessage): Promise<void> {
    if (message.data === undefined && message.comment === undefined) {
      throw new Error('writeSSE: message needs data or comment');
    }

    const lines: string[] = [];

    for (const line of message.comment?.split(/\r\n|\r|\n/) ?? []) {
      lines.push(`: ${line}`);
    }

    if (message.event) {
      lines.push(`event: ${message.event}`);
    }

    if (message.data !== undefined) {
      for (const line of message.data.split(/\r\n|\r|\n/)) {
        lines.push(`data: ${line}`);
      }
    }

    if (message.id) {
      lines.push(`id: ${message.id}`);
    }

    if (message.retry) {
      lines.push(`retry: ${message.retry}`);
    }

    await this.write(lines.join('\n') + '\n\n');
  }
}
