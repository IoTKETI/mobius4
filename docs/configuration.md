# Mobius4 Configuration Reference

All settings live in `config/default.json`. Override locally with `config/local.json` — it is loaded automatically with higher priority and is gitignored, so credentials never get committed.

## Local configuration override

**Setup (first time):**
```bash
cp config/local.json.example config/local.json
# then edit config/local.json with your actual values
```

**Typical `config/local.json` for development:**
```json
{
  "cse": {
    "sp_id": "//your-domain.io",
    "poa": ["http://YOUR_SERVER_IP:7599"]
  },
  "db": {
    "user": "your_db_user",
    "pw": "your_db_password"
  },
  "logging": {
    "level": "debug",
    "console": { "pretty": true }
  }
}
```

**Typical `config/local.json` for production deployment:**
```json
{
  "cse": {
    "sp_id": "//your-domain.io",
    "poa": ["http://YOUR_SERVER_IP:7599"]
  },
  "db": {
    "user": "mobius4",
    "pw": "strong_password_here"
  },
  "logging": {
    "level": "info",
    "file": { "enabled": true }
  },
  "security": {
    "helmet": { "enabled": true },
    "rateLimit": { "enabled": true, "max": 500 }
  }
}
```

---

## Configuration keys

### CSE

| key | description |
| :--- | :--- |
| `cse.cse_type` | CSE Mode (1: IN, 2: MN, 3: ASN) |
| `cse.sp_id` | M2M Service Provider ID — must start with `//` |
| `cse.cse_id` | CSE ID — must start with `/` |
| `cse.csebase_rn` | Resource name of the CSEBase resource |
| `cse.poa` | Point of access of this CSE |
| `cse.registrar.cse_type` | CSE type of the Registrar (registration target) |
| `cse.registrar.cse_id` | CSE ID of the Registrar |
| `cse.registrar.csebase_rn` | CSEBase resource name of the Registrar |
| `cse.registrar.ip` | IP address of the Registrar |
| `cse.registrar.port` | Port number of the Registrar |
| `cse.registrar.versions` | Supported oneM2M versions of the Registrar |
| `cse.admin` | ID of the Administrator — has full privileges to all resources |
| `cse.aeid_length` | String length of AE ID |
| `cse.expired_resource_cleanup_interval_days` | Interval for expired resource cleanup in days |
| `cse.discovery_limit` | Max number of resource IDs in a discovery response |
| `cse.allow_discovery_for_any` | If `true`, access control is skipped for discovery (faster responses) |
| `cse.keep_alive_timeout` | HTTP keep-alive session timeout in seconds |

### CSEBase

| key | description |
| :--- | :--- |
| `cb.default_acp.rn` | Resource name of the default accessControlPolicy resource |
| `cb.default_acp.create` | Allow Create privilege on the default ACP |
| `cb.default_acp.retrieve` | Allow Retrieve privilege |
| `cb.default_acp.update` | Allow Update privilege |
| `cb.default_acp.delete` | Allow Delete privilege |
| `cb.default_acp.discovery` | Allow Discovery privilege |

### HTTP / HTTPS

| key | description |
| :--- | :--- |
| `request.max_body_size` | Max HTTP request body size (default: `1mb`) |
| `http.port` | HTTP server port (default: `7599`) |
| `https.port` | HTTPS server port (default: `7580`) |

### MQTT

| key | description |
| :--- | :--- |
| `mqtt.enabled` | Enable MQTT binding (default: `true`; set `false` to run HTTP-only) |
| `mqtt.ip` | MQTT broker IP address |
| `mqtt.port` | MQTT broker port number (default: `1883`) |
| `mqtt.initialConnectTimeoutMs` | Startup wait for MQTT broker in ms (default: `10000`). On timeout, continues HTTP-only with background reconnect. |
| `mqtt.reconnect.initialDelayMs` | First reconnect wait time in ms (default: `1000`) |
| `mqtt.reconnect.maxDelayMs` | Upper bound of reconnect delay in ms (default: `60000`) |
| `mqtt.reconnect.multiplier` | Backoff multiplier applied on each failure (default: `2`) |
| `mqtt.reconnect.jitter` | Random variance factor ±jitter applied to delay (default: `0.2` = ±20%) |
| `mqtt.reconnect.maxAttempts` | Max reconnect attempts. `0` = unlimited (default: `0`) |

### Database

| key | description |
| :--- | :--- |
| `db.host` | PostgreSQL host address |
| `db.port` | PostgreSQL port number (default: `5432`) |
| `db.name` | Database name (default: `mobius4`) |
| `db.user` | Database user name |
| `db.pw` | Database user password |

### Logging

| key | description |
| :--- | :--- |
| `logging.level` | Log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` (default: `info`) |
| `logging.console.enabled` | Enable console output (default: `true`) |
| `logging.console.pretty` | Human-readable output for development (default: `false`; set `true` in `local.json`) |
| `logging.file.enabled` | Enable file logging (default: `false`) |
| `logging.file.path` | Log file path (default: `logs/mobius4.log`) |
| `logging.file.rotate` | Rotation frequency: `daily` or `hourly` (default: `daily`) |
| `logging.file.maxFiles` | Number of rotated files to keep (default: `14`) |
| `logging.file.maxSize` | Max file size before rotation (default: `100m`) |

See [logging-guide.md](logging-guide.md) for structured logging details.

### Security

| key | description |
| :--- | :--- |
| `security.helmet.enabled` | Enable HTTP security headers via Helmet (default: `false`) |
| `security.rateLimit.enabled` | Enable per-IP rate limiting (default: `false`; disable for load/performance tests) |
| `security.rateLimit.windowMs` | Rate limit window in milliseconds (default: `60000`) |
| `security.rateLimit.max` | Max requests per window per IP (default: `500`) |

### Metrics

| key | description |
| :--- | :--- |
| `metrics.enabled` | Enable Prometheus `/metrics` endpoint (default: `false`). Keep disabled during load/performance testing. |

---

## Advanced

These settings control internal ID and data size limits. The defaults work for most deployments.

### Length constraints

| key | description |
| :--- | :--- |
| `length.entity_id` | Max length of AE and CSE ID |
| `length.ri` | Length of resourceID (ri) attribute |
| `length.pi` | Length of parentID (pi) attribute |
| `length.rn_random` | Length of random part of resourceName when not given by Originator |
| `length.rn` | Max length of resourceName (rn) |
| `length.structured_res_id` | Max length of structured resource ID (e.g. `Mobius/cnt1`) |
| `length.str_token` | Length of each string token (e.g. `cnt1`) |
| `length.url` | Max URL length (e.g. pointOfAccess attribute) |
| `length.data` | Max data length (e.g. datasetFragment attribute) |

### Default resource values

| key | description |
| :--- | :--- |
| `default.common.et_month` | Default resource expiration in months (current time + et_month) |
| `default.container.mbs` | Default maxByteSize of a container resource |
| `default.container.mni` | Default maxNumberOfInstances of a container resource |
| `default.container.mia` | Default maxInstanceAge of a container resource |
| `default.datasetPolicy.tcd` | Default time correlation duration for dataset creation |
| `default.datasetPolicy.nvp` | Default null value policy for dataset creation |
| `default.datasetPolicy.nrhd` | Default number of rows in historical dataset |
| `default.datasetPolicy.nrld` | Default number of rows in live dataset |
