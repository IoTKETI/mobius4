# Mobius4 Logging Guide

This document describes the logging system used in Mobius4, and provides guidelines for contributors and operators.

---

## Overview

Mobius4 uses [Pino](https://getpino.io) — a high-performance, JSON-first Node.js logger. Pino is chosen for its minimal overhead, which is critical for an IoT middleware platform that may handle high message volumes.

| Package | Role |
|---------|------|
| `pino` | Core logger |
| `pino-http` | Express request/response middleware |
| `pino-roll` | File rotation (daily/hourly, by size) |
| `pino-pretty` | Human-readable dev output (devDependency) |

All logging behavior is configured in `config/default.json` under the `logging` key, and can be overridden in `config/local.json`.

---

## Log Levels

| Level | Value | When to use |
|-------|-------|-------------|
| `trace` | 10 | Full primitive/payload dumps (replaces `JSON.stringify` dumps) |
| `debug` | 20 | Flow tracing: request dispatch, MQTT messages, routing decisions |
| `info` | 30 | Important state changes: server start, resource CRUD, CSE registration |
| `warn` | 40 | Recoverable anomalies: unsupported geo type, notification delivery failure |
| `error` | 50 | Operation failures: DB errors, resource creation failures, forwarding failures |
| `fatal` | 60 | Process-level failures requiring restart: DB unreachable, port bind failure |

**Production recommended level:** `info`  
**Development recommended level:** `debug`

---

## Configuration Reference

In `config/default.json` (override in `config/local.json`):

```json
"logging": {
  "level": "info",
  "console": {
    "enabled": true,
    "pretty": false
  },
  "file": {
    "enabled": false,
    "path": "logs/mobius4.log",
    "rotate": "daily",
    "maxFiles": 14,
    "maxSize": "100m"
  },
  "http": {
    "logBody": false,
    "redactPaths": ["req.headers.authorization", "req.body.pw"]
  }
}
```

### Options

| Key | Description |
|-----|-------------|
| `level` | Minimum log level to emit. Messages below this level are dropped. |
| `console.enabled` | Log to stdout. |
| `console.pretty` | Use `pino-pretty` for human-readable output. Only active when `NODE_ENV !== 'production'`. |
| `file.enabled` | Log to a rotating file. |
| `file.path` | Log file path. The directory is created automatically if it does not exist. |
| `file.rotate` | Rotation frequency: `"daily"` or `"hourly"`. |
| `file.maxFiles` | Number of rotated files to retain. |
| `file.maxSize` | Max size per file before triggering a rotation (e.g. `"100m"`). |
| `http.redactPaths` | Pino redact paths — values at these paths are replaced with `[REDACTED]` in all log output. Extend this list to protect additional sensitive fields. |

---

## Typical Configurations

### Development (config/local.json)

```json
{
  "logging": {
    "level": "debug",
    "console": { "pretty": true }
  }
}
```

Start with `npm run dev` to get colorized, human-readable output.

### Production (config/local.json)

```json
{
  "logging": {
    "level": "info",
    "console": { "enabled": true, "pretty": false },
    "file": {
      "enabled": true,
      "path": "logs/mobius4.log",
      "rotate": "daily",
      "maxFiles": 30
    }
  }
}
```

JSON output to both stdout and a rotating file. Compatible with log shippers (Filebeat, Fluentd, etc.).

---

## Usage Patterns for Contributors

### Getting a logger in a module

Each module creates a **child logger** with its own `module` context:

```js
// At the top of the file, after other requires
const logger = require('../../logger').child({ module: 'cnt' });
```

The `module` field appears in every log line from that file, making it easy to filter.

### Logging an error in a catch block

```js
try {
    // ... operation
} catch (err) {
    logger.error({ err }, 'create_a_cnt failed');
}
```

> Always pass the error object as `{ err }` — Pino serializes it with stack trace automatically.

### Logging with structured context (preferred over string interpolation)

```js
// Good — fields are queryable in log aggregation systems
logger.info({ ri: res.ri, ty: res.ty }, 'resource created');

// Avoid — string interpolation loses structure
logger.info(`resource created: ${res.ri}`);
```

### Log level guidelines per operation

```js
// Server startup
logger.info({ port: config.http.port }, 'HTTP server listening');

// Incoming request (pino-http handles this automatically for HTTP)
// For MQTT, log manually:
logger.debug({ topic, originator, rqi, op }, 'mqtt request received');

// Full primitive dump (dev/trace only, never in production by default)
logger.trace({ prim: req_prim }, 'full request primitive');

// Resource operation success
logger.info({ ri, sid }, 'resource created');

// Recoverable warning
logger.warn({ geometry_type }, 'unsupported geometry type, skipping geo filter');

// Error in catch
logger.error({ err }, 'operation failed');

// Fatal — process should stop
logger.fatal({ err }, 'database unreachable, cannot start');
```

---

## HTTP Request Logging

HTTP requests and responses are logged automatically by `pino-http` middleware in `bindings/http.js`. You do **not** need to add logging inside route handlers.

**Log level mapping:**
- `5xx` responses → `error`
- `4xx` responses → `warn`
- `2xx/3xx` responses → `debug`

**Serialized fields per request:**

| Field | Source |
|-------|--------|
| `req.method` | HTTP method |
| `req.url` | Request URL |
| `req.op` | oneM2M operation (from `X-M2M-Op` header) |
| `req.fr` | Originator (from `X-M2M-Origin`) |
| `req.rqi` | Request ID (from `X-M2M-RI`) |
| `req.body` | Parsed request body (available at `debug` level) |
| `res.statusCode` | HTTP status code |
| `res.rsc` | oneM2M response status code (from `X-M2M-RSC`) |
| `res.body` | Response body (captured via `res.json()` interceptor) |

The `/health` and `/metrics` endpoints are excluded from HTTP logging.

---

## oneM2M Primitive Logging

All oneM2M requests and responses pass through `cse/reqPrim.js`, which logs them at `info` level regardless of transport (HTTP or MQTT).

| Event | Level | Fields |
|-------|-------|--------|
| Request received | `info` | `op`, `to`, `fr`, `rqi`, `pc` (payload, omitted if empty) |
| Response sent | `info` | `rsc`, `rqi`, `pc` (payload, omitted if empty) |
| Full raw primitive | `trace` | `prim` |

`pc` is the oneM2M payload content — equivalent to the HTTP body. It is automatically omitted from the log when empty (e.g. RETRIEVE or DELETE requests).

---

## MQTT Logging

MQTT bindings do not have middleware support, so logging is done manually in `bindings/mqtt.js` using a child logger:

```js
const logger = require('../logger').child({ module: 'mqtt', binding: 'mqtt' });
```

**Logged events:**

| Event | Level | Fields |
|-------|-------|--------|
| Client connecting | `info` | `endpoint` |
| Subscriptions ready | `info` | `cseId` |
| Request received | `debug` | `topic`, `originator`, `rqi`, `op`, `to` |
| Response sent | `debug` | `topic`, `rsc`, `rqi` |
| Full primitive | `debug` | `prim` |
| Publish failed | `error` | `err`, `topic` |
| Reconnecting | `warn` | `endpoint` |
| Offline | `error` | `endpoint` |

---

## Log Output Examples

### JSON (production)

```json
{"level":30,"time":"2026-04-04T19:23:11.452+09:00","pid":1234,"cseId":"/Mobius4","module":"db","msg":"PostgreSQL connected"}
{"level":30,"time":"2026-04-04T19:23:11.502+09:00","pid":1234,"cseId":"/Mobius4","module":"http","port":7599,"msg":"HTTP server listening"}
{"level":20,"time":"2026-04-04T19:23:15.100+09:00","pid":1234,"cseId":"/Mobius4","module":"mqtt","binding":"mqtt","topic":"/oneM2M/req/C1234/Mobius4/json","originator":"C1234","op":1,"to":"Mobius","msg":"mqtt request received"}
{"level":50,"time":"2026-04-04T19:23:16.200+09:00","pid":1234,"cseId":"/Mobius4","module":"cnt","err":{"message":"duplicate key value","stack":"..."},"msg":"create_a_cnt failed"}

> **Note:** The `level` field in file logs is a numeric value (pino standard). See the [Log Levels](#log-levels) table for the mapping. Timestamps use the system's local timezone automatically.
> To view file logs in human-readable form: `cat logs/mobius4.log | npx pino-pretty`
```

### Pretty-print (development, `console.pretty: true`)

```
[10:23:11] INFO  (db): PostgreSQL connected
[10:23:11] INFO  (http): HTTP server listening
    port: 7599
[10:23:15] DEBUG (mqtt): mqtt request received
    topic: "/oneM2M/req/C1234/Mobius4/json"
    originator: "C1234"
    op: 1
```

---

## Log Aggregation

For production deployments, JSON output can be ingested by:

- **ELK Stack** — Filebeat → Logstash → Elasticsearch → Kibana
- **Grafana Loki** — Promtail → Loki → Grafana
- **AWS CloudWatch / GCP Logging** — stdout JSON is natively captured in container environments

Filter by `module` to scope to a specific component, or by `level` to see only errors.

---

## Adding a New Module

When creating a new file under `cse/` or `bindings/`:

1. Add the child logger declaration at the top:
   ```js
   const logger = require('../logger').child({ module: 'my-module' });
   // or for files in cse/resources/:
   const logger = require('../../logger').child({ module: 'my-module' });
   ```

2. Never use `console.log`, `console.error`, or `console.warn` — use the appropriate Pino level.

3. Always pass error objects as `{ err }` in catch blocks, not as the message string.
