# @asenajs/ergenecore

## 1.2.0

### Minor Changes

- Refactored WebSocket adapter to use a single shared AsenaWebSocketServer instance instead of creating separate instances per namespace. Removed namespace parameter from AsenaWebSocketServer constructor for improved efficiency and alignment with @asenajs/asena v0.6.0 architecture.

## 1.1.0

### Minor Changes

- fix(lib): New AsenaWebSocketServer implemented
