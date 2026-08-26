# Mobius4 Operations Guide

## PM2 Deployment

Install PM2 globally:
```bash
npm install -g pm2
```

Start / stop / restart:
```bash
pm2 start ecosystem.config.js --env production   # production start
pm2 stop mobius4
pm2 restart mobius4
pm2 delete mobius4
```

Check status and logs:
```bash
pm2 status
pm2 logs mobius4      # live stdout/stderr (Pino JSON)
```

> File logs are written by Pino to `logs/mobius4.log` when `logging.file.enabled: true`.

Enable auto-start on system boot:
```bash
pm2 startup           # run the printed command with sudo
pm2 save              # save current process list
```

---

## Health check endpoint

Mobius4 exposes a lightweight health check endpoint:

```
GET /health
```

Response:
```json
{ "status": "ok", "uptime": 123.45 }
```

This endpoint always returns HTTP 200 while the process is running. It is excluded from HTTP request logging to avoid noise. Use it for load balancer health checks, container liveness probes, or uptime monitors.

---

## Metrics endpoint

Mobius4 optionally exposes a Prometheus-compatible metrics endpoint:

```
GET /metrics
```

Disabled by default. Enable in `config/local.json`:
```json
{ "metrics": { "enabled": true } }
```

**When to enable:**
- Production deployments monitored by Prometheus/Grafana
- Capacity planning and trend analysis
- Debugging throughput or latency issues

**Keep disabled during:**
- Performance benchmarking and load testing — per-request counter increments add nanosecond-level overhead that skews baseline measurements

Excluded from HTTP access logging. Exposes default Node.js process metrics plus:

| Metric | Type | Description |
| :--- | :---: | :--- |
| `mobius4_http_requests_total{method, status_code}` | Counter | Total HTTP requests |
| `mobius4_http_request_duration_seconds{method}` | Histogram | HTTP response time |
| `mobius4_mqtt_messages_total` | Counter | MQTT messages received |
| `mobius4_resources_created_total{ty}` | Counter | oneM2M resources created by type |
| `mobius4_log_files_total` | Gauge | Current log file count |
| `mobius4_log_size_bytes` | Gauge | Total log file size in bytes |

> **Note:** Restrict `/metrics` to internal network or your Prometheus server only — it exposes operational details not intended for public access.

---

## Resource browser tool

A terminal tool for exploring a running Mobius4 — walk the resource tree, read attributes, and
watch resources change in real time. Download a build for your OS from the **Releases** menu on
this repository; **no Python or other runtime is needed.**

![oneM2M resource browser](images/res_browser.png)

| Platform | Asset |
|---|---|
| macOS (Apple Silicon) | `mobius4-browser-<version>-macos-arm64.zip` |
| macOS (Intel) | `mobius4-browser-<version>-macos-x86_64.zip` |
| Linux (x86_64) | `mobius4-browser-<version>-linux-x86_64.zip` |
| Linux (arm64) | `mobius4-browser-<version>-linux-arm64.zip` |
| Windows (x64) | `mobius4-browser-<version>-windows-x86_64.zip` |

Unzip it and run the `mobius4-browser` executable inside:

```bash
unzip mobius4-browser-<version>-linux-x86_64.zip
./mobius4-browser-<version>-linux-x86_64/mobius4-browser
```

### macOS: clear the quarantine flag first

Downloads from the internet are marked with the `com.apple.quarantine` attribute. Because these
builds are not signed with an Apple Developer ID, Gatekeeper **kills the process with no message
at all** — no dialog, no output, the command simply exits. Clear the attribute in the unzipped
folder:

```bash
xattr -r -d com.apple.quarantine ./mobius4-browser-<version>-macos-arm64
```

### First run

On first start the tool asks for the connection details, then stores them as a profile:

| Field | Value |
|---|---|
| Host / Port | Where Mobius4 serves HTTP (e.g. `localhost` / `7579`) |
| CSEBase name | `cseBaseName` from your configuration (default `Mobius`) |
| Originator | Your **Admin ID** (`cseAdmin`) to see everything; any AE-ID to see what that AE sees |
| MQTT broker | Optional — needed only to receive notifications; without it the tool polls |

> Set the originator to an AE-ID rather than the admin to check what that AE is actually allowed
> to see. The header line always states whose view you are looking at.

### What it does beyond browsing

- **Watch (`w`)** — creates a `<subscription>` and highlights attributes as they change. Every
  subscription it creates carries a lease (`expirationTime`) and a label, and is deleted on exit;
  a later run cleans up anything a crash left behind.
- **Write (`n` create, `e` edit, `D` delete)** — confirmation gets stricter the more that is at
  risk. Deleting shows what disappears with it first. Set `environment: production` in the profile
  when pointing at a production CSE to raise every confirmation a step.
- **Standard-only** — it never uses a Mobius4-specific API, so what you see is what any conformant
  oneM2M client would see.

Source, full user guide and issue tracker: <https://github.com/ooosm/mobius4-browser>
