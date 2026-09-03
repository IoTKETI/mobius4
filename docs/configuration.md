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
| `cse.expired_resource_cleanup_interval_days` | Interval for expired resource cleanup in days. A sweep also runs at startup, so the interval is the gap between sweeps of a process that stays up, not the worst case. What an expired resource does before its sweep is documented under [expirationTime](#expirationtime) |
| `cse.discovery_limit` | Max number of resource IDs in a discovery response |
| `cse.missing_data_sweep_interval_seconds` | **The longest the missing-data sweep will sleep, not how often it runs.** The sweep (`cse/missing-data-scheduler.js`, `TS-0001:10.2.4.29`) books each pass from the data: it reports the earliest instant any detecting `<timeSeries>` could next have something to judge, and the next pass runs then. It is also woken where a resource becomes detectable — the `<timeSeriesInstance>` that first anchors a detecting `<timeSeries>`, and an update that switches `missingDataDetect` on. So a gap is detected at `expected dataGenerationTime + missingDataDetectTimer` whatever this is set to, and lowering it does not make detection faster. What it bounds is the backstop: how long a change this CSE did not see for itself can go unnoticed, which in a single-instance deployment is nothing, and in a multi-instance one is a `<timeSeries>` created on an instance other than the one running the sweep. A floor of 250 ms is built in so a very small `periodicInterval` cannot spin |
| `cse.allow_discovery_for_any` | If `true`, access control is skipped for discovery (faster responses) |
| `cse.keep_alive_timeout` | HTTP keep-alive session timeout in seconds |
| `cse.subscription_verification` | Whether to send a Subscription Verification request before creating a `<subscription>` (`TS-0004:7.4.8.2.1` Recv-6.4). **Default `false`.** The clause says "may", not "shall", so this is a deployment choice rather than a conformance requirement, and turning it on can make a subscription creation fail that used to succeed — see "Subscription verification" in `docs/how-it-works.md` and `docs/how-to.md` before enabling it |



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
> `cse.admin` names the identity that bypasses access control. `cse/hostingCSE.js` grants it
> every operation **before any `<accessControlPolicy>` is consulted**, on every resource
> regardless of policy, creator or `acpi`. Whoever knows this value and can reach the port has
> full control of the CSE — including DELETE, over plain HTTP exactly as over TLS. Treat it as
> a credential, not as a name.
>
> v4.6.0 removed the bypass and left the identity reaching resources only through the admin
> `<accessControlPolicy>` (`cb.admin_acp.rn`, created at startup, granting `acop` 63). That
> policy is still created and still evaluated, but the bypass answers first and so decides for
> the administrator. See the changelog for why it came back: a resource created with no `acpi`
> is governed by its creator, and the administrator could neither reach it nor attach a policy
> to it, with no request that could undo the state.
>
> This is a deliberate departure from oneM2M, which expresses all privileges as
> `<accessControlPolicy>` resources and has no notion of a superuser identity. If your
> deployment needs conformant behaviour, do not distribute the `cse.admin` value.
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
| `db.pool.connectionTimeoutMs` | How long a request waits for a free connection, and for a new one to be established, before failing (default: `5000`). Raised from 2000 in v4.11.0 — a cold container on a throttled host was failing to acquire a connection inside two seconds |
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
| `default.container.mia` | Default maxInstanceAge of a container resource, in seconds (default: `31536000` = 365 days, chosen to track `default.common.et_month`'s 12 months — see the `v4.9.0` CHANGELOG entry) |
| `default.datasetPolicy.tcd` | Default time correlation duration for dataset creation |
| `default.datasetPolicy.nvp` | Default null value policy for dataset creation |
| `default.datasetPolicy.nrhd` | Default number of rows in historical dataset |
| `default.datasetPolicy.nrld` | Default number of rows in live dataset |
| `default.timeSeries.mbs` | Default maxByteSize of a `<timeSeries>` resource |
| `default.timeSeries.mni` | Default maxNumberOfInstances of a `<timeSeries>` resource |
| `default.timeSeries.mia` | Default maxInstanceAge of a `<timeSeries>` resource, in seconds |
| `default.timeSeries.peid_default` | Fallback `periodicIntervalDelta`, **in milliseconds**, used by the missing-data sweep's detection arithmetic (`detect_missing` in `cse/missing-data.js`) when a `<timeSeries>` resource has none set — `TS-0001:9.6.36` explicitly allows a local policy default here |
| `default.timeSeries.mdt_default` | Fallback `missingDataDetectTimer`, **in milliseconds**, used the same way when a `<timeSeries>` resource has none set. **This is the setting to lower if `missingDataList` seems to stay empty**: with the shipped value of 60000, a `<timeSeries>` whose `periodicInterval` is a few seconds shows nothing for a full minute after a gap, which is indistinguishable from detection being broken. See "missingDataList is empty when I expect entries" in `docs/how-to.md`. `TS-0001:9.6.36` grants no such local-policy allowance for this one, but without a value the detection time is undefined, so a deployment default is unavoidable regardless. `detect_missing` never uses this value as-is — it raises it to `periodicIntervalDelta + 1` when the effective `peid` would otherwise exceed it, so the fallback timer always satisfies `TS-0001:9.6.36`'s "shall be greater than periodicIntervalDelta" even though that constraint is only checked against an explicitly supplied `mdt` at CREATE/UPDATE |
| `default.timeSeries.mdn_default` | Fallback cap applied to `missingDataList`'s growth by the sweep (`sweep_missing_data` in `cse/missing-data.js`) when a `<timeSeries>` resource has no `missingDataMaxNr` set. `TS-0001:9.6.36` leaves the list genuinely uncapped in that case, and `apply_missing`, the pure function that implements the clause, still treats an explicit `null` as unbounded -- this default is applied one layer up, at the sweep, as a deployment safeguard rather than a reading of the spec: without it, a `<timeSeries>` with `missingDataDetect:true`, a small `periodicInterval` and one backfilled old instance accrues `missingDataList` entries every sweep tick forever, and `mdlt` is a `VARCHAR(20)[]` column that hits PostgreSQL's 1 GB field limit at roughly 31 million entries, after which every further sweep tick for that resource throws and is silently swallowed by the per-row catch. The resource's own `missingDataMaxNr` attribute is never written by this default -- a client that never set it still sees none in the representation, and a client-supplied value, however large, is always honored as-is. What a deployment gives up at the default of 10000: visibility into gaps older than the most recent 10000 detected for a `<timeSeries>` that never sets `missingDataMaxNr` itself -- older entries are dropped from `missingDataList` the same way they would be if the client had set `missingDataMaxNr: 10000` explicitly |
| `default.timeSeries.max_points_per_sweep` | Upper bound on how many expected data points `detect_missing` (`cse/missing-data.js`) evaluates for a single `<timeSeries>` in one sweep tick. Without this cap, a historical backfill (an anchor far in the past combined with a small `periodicInterval`) makes the range unbounded — a 7-day-old anchor at `periodicInterval: 1` implies over 600,000 points built into one array synchronously. The sweep resumes from `md_watermark_n` on the next tick, so a large backlog still catches up, just spread over more ticks rather than one. Cost scales with the number of surviving `<timeSeriesInstance>` children the call checks each expected point against (the window match is a binary search over the present set, `O(log n)` per point — finding 5), not just with `max_points_per_sweep` itself, so a figure measured against an empty present set understates it. Measured on this branch at a retention-sized shape — 10000 expected points checked against 10000 present instances, i.e. a `<timeSeries>` sitting at `default.timeSeries.mni`'s retention cap — averaged ~4.4ms/call over 20 iterations, comfortably sub-second relative to `cse.missing_data_sweep_interval_seconds`'s 30s default even with several detecting `<timeSeries>` resources sharing one tick. This is a deployment tuning knob, not a spec-mandated value; raise it to catch up backlogs faster at the cost of longer individual ticks, lower it if many resources are detecting at once |

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
| `attributes` | Allowed `[customAttribute]` names, their types, and whether they are mandatory. Supported types: `string`, `integer`, `number`, `boolean`, `array`, `object`. An entry carries `"required": true` when the XSD declares the attribute mandatory |

The envelope key of a request must be exactly `namespacePrefix:typeName` — for the entry
above, `{"sc:parkingBlock": {...}}`. Custom attribute names are matched **as they appear on
the wire**; no long-name/short-name translation is applied, because TS-0004:8.2.1 confines the
short-name tables to oneM2M-defined names and a third-party specialization has none.

A name that is not declared, or a declared name carrying the wrong type, is rejected with 4000.

**Whether a custom attribute is mandatory comes from the specialization's XSD**, not from oneM2M:
`TS-0004:7.4.37.1` lists `[customAttribute]` as O/O because the standard cannot know what a
third-party specialization requires. The XSD does — an element is mandatory unless it says
`minOccurs="0"`, since XSD's default for an omitted `minOccurs` is 1. A CREATE that omits a
mandatory attribute is rejected with 4000, and a mandatory attribute cannot be deleted by sending
`null` on UPDATE.

Enforcement follows the registry, not the release: an entry with no `required` flag — one written
by hand, or built before v4.19.0 — is read as declaring nothing mandatory. Rebuild the registry
from the manifest to turn it on.

`config/specializations.json` is **generated**, not hand-edited: `node
scripts/build-specializations.js` builds it from `config/specializations.manifest.json`, and the
build **overwrites** the file — a hand edit survives only until the next build. The registry is
read once at startup, so restart the CSE after a build for the change to take effect. If the file
is missing or unparseable the CSE still starts, logs a warning, and answers every `cnd` with 4125
— a deployment that uses no `<flexContainer>` does not need it at all.

For the manifest format and the build workflow, see
[docs/examples/specializations/](examples/specializations/README.md).

For a walkthrough of registering a specialization and then creating, updating, discovering and
deleting resources against it, see
[How to — flexContainer specializations](how-to.md#flexcontainer-specializations).

> **Not implemented: `<flexContainerInstance>` (ty=58).** TS-0004:7.4.37.2.1 step 3 makes
> instance creation conditional on a non-zero `mni`, `mbs` or `mia`, so those three attributes
> are rejected with 5001 rather than stored. Consequently `<latest>` and `<oldest>` are not
> available under a `<flexContainer>` either — TS-0001:9.6.35 scopes them to the case where
> instances are being created.

### expirationTime

Every resource has an `expirationTime` (`et`). If the requester does not supply one, the CSE
assigns `now + default.common.et_month`; a supplied value is taken as-is provided it is in the
future, and a value in the past is refused with 4000. Under a `<container>` with a
`maxInstanceAge`, a `<contentInstance>`'s `et` is capped to `ct + mia`.

`TS-0001:9.6.1.3.2` defines the attribute as the "time/date **after which** the resource will be
deleted by the Hosting CSE" and calls the resource **obsolete** from the moment that time passes.
Deletion is a separate event: `expired_resource_cleanup` performs it, at startup and then every
`cse.expired_resource_cleanup_interval_days`. So there is a window in which an obsolete resource
has not yet been deleted, and what happens in that window is deliberate:

| In the window, an obsolete resource… | |
|---|---|
| is **not** notified about by an obsolete `<subscription>` | no notification is published once the subscription's own `et` has passed |
| is **not** returned by `<latest>`/`<oldest>` | those answer with the newest/oldest instance that is not obsolete, or 4004 if there is none |
| is **not** among `rcn=4`/`rcn=8` child resources | `TS-0001:10.2.4.4` equates "all existing ones are obsolete" with having none |
| **is** still retrievable by its own address | RSC 2000, with the past `et` in the representation |
| **is** still listed by `fu=1` discovery | so that a client can find and clean up what it left behind |

The last two are why `et` is a weak basis for reclaiming resources promptly. If a client needs a
resource gone at a specific time, it should delete it rather than rely on the sweep; `et` is a
backstop for the case where the client never comes back.
