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

> The `logging` block above is for development only. Pretty printing costs about
> 18% of throughput and `debug` a further 7% (measured — see
> [Logging guide → Throughput cost](logging-guide.md#throughput-cost)). Drop the
> block when deploying; mobius4 warns at startup if it is still present.

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
| `cse.admin` | **Required, no default.** Identity the admin `<accessControlPolicy>` grants all six operations to. See the warning below |
| `cse.aeid_length` | String length of AE ID |
| `cse.expired_resource_cleanup_interval_days` | Interval for expired resource cleanup in days |
| `cse.discovery_limit` | Max number of resource IDs in a discovery response |
| `cse.allow_discovery_for_any` | If `true`, access control is skipped for discovery (faster responses) |
| `cse.keep_alive_timeout` | HTTP keep-alive session timeout in seconds |



> #### Sizing `db.pool.max` for more than one instance
>
> `db.pool.max` is the **total for the process**, not a per-pool figure. mobius4 runs two
> connection pools — Sequelize's for the models and a raw `pg` pool for the hand-written SQL —
> and the setting is divided between them.
>
> This matters when planning capacity. PostgreSQL's default `max_connections` is `100`, so the
> number of instances you can run is bounded by `max_connections / db.pool.max`. At the default
> of `20`, that is five instances before the server starts refusing connections with
> `too many clients`.
>
> Raising it buys very little. Measured at a concurrency of 100 on the development machine:
> 10 connections per pool reached 3,069 requests per second against 3,139 for 30 — a 2%
> difference for three times the connections. Prefer spending the connection budget on
> instances rather than on pool size.

> #### ⚠️ `cse.admin` is a privileged identity
>
> `cse.admin` names the identity that the admin `<accessControlPolicy>`
> (`cb.admin_acp.rn`, created at startup) grants all six operations to. Whoever knows this
> value and can reach the port has whatever that policy allows, on every resource that carries
> it — over plain HTTP exactly as over TLS. Treat it as a credential.
>
> Up to v4.5.1 it was worse than that: `cse/hostingCSE.js` granted the identity every
> operation **before any `<accessControlPolicy>` was consulted**, on every resource
> regardless of policy. That short-circuit is gone as of v4.6.0 — the administrator now
> reaches a resource only through a policy that names it, or through the creator fallback
> when the resource carries no `acpi`.
>
> Because of that there is **no default**. Up to v4.5.1 the shipped value was `SM`, which meant
> every deployment that never overrode it could be taken over by anyone who had read this
> repository. Since v4.6.0 mobius4 refuses to start when `cse.admin` is missing, blank, or set
> to `SM`.
>
> Choose a value unique to this deployment and treat it as a credential. If you are upgrading
> from v4.5.1 or earlier, the old identity is also recorded in the database — in every
> resource's `cr`/`int_cr` and in the default ACP's `privileges` — so run
> `db/migrations/v4.6.0.sql` after changing the configuration. Changing the configuration alone
> leaves the new admin unable to modify the default `<accessControlPolicy>`.

### CSEBase

| key | description |
| :--- | :--- |
| `cb.default_acp.rn` | Resource name of the default accessControlPolicy resource |
| `cb.default_acp.create` | Allow Create privilege on the default ACP |
| `cb.default_acp.retrieve` | Allow Retrieve privilege |
| `cb.default_acp.update` | Allow Update privilege |
| `cb.default_acp.delete` | Allow Delete privilege |
| `cb.admin_acp.rn` | Resource name of the admin `<accessControlPolicy>`, which grants `cse.admin` all six operations (`acop` 63) |
| `cb.default_acp.discovery` | Allow Discovery privilege |

### HTTP / HTTPS

| key | description |
| :--- | :--- |
| `request.max_body_size` | Max HTTP request body size (default: `1mb`) |
| `http.port` | HTTP server port (default: `7599`) |
| `https.enabled` | Start the TLS listener (default: `false`). When `true` and a file below cannot be read, Mobius4 stops rather than serving plain HTTP |
| `https.port` | HTTPS server port (default: `7580`) |
| `https.key` | PEM private key for the server certificate (default: `certs/server.key`) |
| `https.cert` | PEM server certificate (default: `certs/server.crt`) |
| `https.chain` | PEM intermediate CA bundle, when the issuer provides one (default: empty) |

> Obtaining, installing and replacing a certificate — including what TLS here does and
> does not prove about the client — is **[docs/tls.md](tls.md)**. TLS material is read
> once at startup, so a renewed certificate needs a restart.

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
| `db.pool.max` | **PostgreSQL connections one mobius4 process may open, in total** (default: `20`). Split evenly between the two pools this process runs — see below |
| `db.pool.idleTimeoutMs` | How long an unused connection stays open before being closed (default: `30000`) |
| `db.pool.connectionTimeoutMs` | How long a request waits for a free connection, and for a new one to be established, before failing (default: `2000`) |
| `db.pool.statementTimeoutMs` | Server-side cap on a single statement (default: `30000`) |

### Logging

| key | description |
| :--- | :--- |
| `logging.level` | Log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` (default: `info`) |
| `logging.console.enabled` | Enable console output (default: `true`) |
| `logging.console.pretty` | Human-readable output for development (default: `false`). Costs about 18% of throughput and is ignored when `NODE_ENV=production` |
| `logging.file.enabled` | Enable file logging (default: `true`) |
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

### flexContainer specializations

A `<flexContainer>` (ty=28) carries `[customAttribute]` members whose names and types are
defined by the document its `cnd` (containerDefinition) attribute points at, not by oneM2M.
TS-0004:7.4.37.2.1 requires the CSE to validate a request against that schema and to answer
`SPECIALIZATION_SCHEMA_NOT_FOUND` (4125, HTTP 501) when the schema is unavailable.

Mobius4 declares that contract locally instead of fetching an XSD on the CREATE path. The
registry lives in its own file, **`config/specializations.json`**, read directly by
`cse/specialization.js` — it is not part of the `config` settings tree, so `NODE_ENV` and
`local.json` layering do not apply to it. The whole file is the registry, keyed by `cnd` URI:

```json
{
  "http://developers.iotocean.org/schema/parkingBlock.xsd": {
    "typeName": "parkingBlock",
    "namespacePrefix": "sc",
    "attributes": {
      "type":                { "type": "string"  },
      "category":            { "type": "array"   },
      "availableSpotNumber": { "type": "integer" },
      "totalSpotNumber":     { "type": "integer" }
    }
  }
}
```

It is a separate file because it describes the deployment's information model rather than CSE
settings, and it grows one entry per specialization. Adding one therefore never touches
`default.json`, and the two can be reviewed and deployed independently.

| key | description |
| :--- | :--- |
| `<cnd URI>` | The exact `cnd` value clients will send. An unregistered value is rejected with 4125 |
| `typeName` | Local name of the specialization, e.g. `parkingBlock` |
| `namespacePrefix` | Namespace prefix of the envelope key. TS-0004:7.4.37.1 allows a specialization to use a targetNamespace other than `m2m:` |
| `attributes` | Allowed `[customAttribute]` names and their types. Supported types: `string`, `integer`, `number`, `boolean`, `array`, `object` |

The envelope key of a request must be exactly `namespacePrefix:typeName` — for the entry
above, `{"sc:parkingBlock": {...}}`. Custom attribute names are matched **as they appear on
the wire**; no long-name/short-name translation is applied, because TS-0004:8.2.1 confines the
short-name tables to oneM2M-defined names and a third-party specialization has none.

All custom attributes are optional (TS-0004:7.4.37.1 lists `[customAttribute]` as O/O). A
name that is not declared, or a declared name carrying the wrong type, is rejected with 4000.

Adding a specialization means editing `config/specializations.json` and restarting the CSE; the
file is read once at startup. If it is missing or unparseable the CSE still starts, logs a
warning, and answers every `cnd` with 4125 — a deployment that uses no `<flexContainer>` does
not need the file at all.

For a walkthrough of registering a specialization and then creating, updating, discovering and
deleting resources against it, see
[How to — flexContainer specializations](how-to.md#flexcontainer-specializations).

> **Not implemented: `<flexContainerInstance>` (ty=58).** TS-0004:7.4.37.2.1 step 3 makes
> instance creation conditional on a non-zero `mni`, `mbs` or `mia`, so those three attributes
> are rejected with 5001 rather than stored. Consequently `<latest>` and `<oldest>` are not
> available under a `<flexContainer>` either — TS-0001:9.6.35 scopes them to the case where
> instances are being created.
