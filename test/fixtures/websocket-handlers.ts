import type { ErgenecoreWebsocketAdapter } from '../../lib';

export function websocketHandlers(adapter: ErgenecoreWebsocketAdapter) {
  const { open, message, close } = adapter.websocket;

  if (!open || !message || !close) {
    throw new Error('prepareWebSocket() did not install the websocket handlers');
  }

  return { open, message, close };
}
