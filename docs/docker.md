# Running Mobius4 with Docker Compose

Mobius4, PostgreSQL with PostGIS, and an MQTT broker, in one command. Nothing to
install beyond Docker — no Node, no database, no manual `createdb`.

```bash
cp .env.example .env
# edit .env: DB_PW and CSE_POA at least
docker compose up -d
curl localhost:7599/health
```

This is a **single-instance** deployment. See [Scaling](#scaling) for why, and what
would have to change first.

---

## What comes up

| Service | Image | Published to the host |
| :--- | :--- | :---: |
| `mobius4` | built from this repository | 7599 (HTTP), 7580 (HTTPS, when enabled) |
| `postgres` | `postgis/postgis:17-3.5` | **no** |
| `mosquitto` | `eclipse-mosquitto:2` | **no** |

The database and the broker are reachable from the compose network and from nowhere
else. Publishing PostgreSQL to the host is how a development database ends up on the
internet; if you need to reach it for a `psql` session, use
`docker compose exec postgres psql -U "$DB_USER" "$DB_NAME"`.

Mobius4 waits for both to report healthy before it starts. PostgreSQL's schema is
created on first boot by `db/init.js` — there is no migration step for a fresh
deployment.

### On Apple Silicon and other arm64 hosts

The official PostGIS image publishes `linux/amd64` only, so the pull fails with
`no matching manifest for linux/arm64`. Set `POSTGRES_IMAGE` in `.env` to a
multi-architecture build; `.env.example` names two. Neither is published by the
PostGIS project, so pin a digest if that matters to you.

---

## Configuration

Everything is set in `.env`, which `docker compose` reads automatically.
`docker/entrypoint.js` assembles those values into `NODE_CONFIG`, which
node-config merges over `config/default.json`. **Anything you leave out keeps the
default** rather than being overridden with an empty value, so `.env` only needs the
settings you actually want to change.

The full list of keys and what they do is in [.env.example](../.env.example); the
underlying settings are in [configuration.md](configuration.md). Two are worth
calling out here, and one thing is configured outside `.env` entirely.

**`CSE_POA`** — the address this CSE advertises about itself, used by other CSEs and
by notification delivery. The default (`http://localhost:7599`) means "localhost" as
seen by whoever reads it, which from another host is not this CSE at all. Set it to
an address that resolves from outside the container.

**`HELMET_ENABLED` and `RATELIMIT_ENABLED`** default to `true` here and to `false` in
`config/default.json`. The defaults there suit a developer running from source. Turn
them off only if something in front of Mobius4 is doing the same job.

**`<flexContainer>` specializations** are not an `.env` setting. The registry the CSE reads
at startup, `config/specializations.json`, is generated from `config/specializations.manifest.json`
by a script the image carries — so adding a specialization needs no Node on the host. You run it in
a throwaway container with your checkout's `config/` mounted over the image's, so the registry lands
in the checkout, then rebuild and restart to carry it back in. The command, what the manifest holds
and the ownership check to make first on Linux are in
[docs/examples/specializations/](examples/specializations/#under-docker).

---

## Registering with another CSE

By default a container is a standalone IN-CSE: it registers with nobody, and
`CSE_TYPE` and the `REGISTRAR_*` variables are unset. To make it an MN-CSE or
ASN-CSE that registers with another CSE, set them.

| variable | what it is |
|---|---|
| `CSE_TYPE` | `1` IN-CSE, `2` MN-CSE, `3` ASN-CSE. **This is what decides whether registration happens at all** — Mobius4 only registers when it is 2 or 3. |
| `REGISTRAR_CSE_ID` | the registrar's CSE-ID, e.g. `/in-cse` |
| `REGISTRAR_CSE_BASE_RN` | the registrar's `<CSEBase>` resource name, usually `Mobius` |
| `REGISTRAR_HOST` | host or container name the registrar answers on |
| `REGISTRAR_PORT` | its HTTP port |
| `REGISTRAR_CSE_TYPE` | the registrar's own type, usually `1` |

Two things are easy to get wrong:

- **`CSE_SP_ID` must be the same on both CSEs.** SP-relative addressing
  (`/other-cse/Mobius/...`) is what lets one CSE reach a resource on the other, and
  it does not resolve across differing M2M-SP-IDs.
- **`CSE_POA` must be reachable from the other container**, not from your laptop.
  `http://localhost:7599` means "localhost" as read by whoever receives it. On a
  compose network the service name works: `http://in-cse:7579`.

Registration is attempted **once, at startup, and is not retried**, so the registree
has to start after the registrar is answering. In compose that means
`condition: service_healthy`, not merely `depends_on`.

### A working two-CSE example

[`docker/compose.two-cse.yml`](../docker/compose.two-cse.yml) brings up an IN-CSE and
an MN-CSE that register with each other, each with its own database:

```bash
docker compose -f docker/compose.two-cse.yml up -d --build
# on arm64, see "On Apple Silicon" above:
#   POSTGRES_IMAGE=imresamu/postgis:17-3.5 docker compose -f docker/compose.two-cse.yml up -d --build
```

The registrar is on host port 7801, the registree on 7802. To see the registration:

```bash
curl -s -H 'X-M2M-Origin: /mn-cse' -H 'X-M2M-RI: 1' -H 'X-M2M-RVI: 3' \
     'http://127.0.0.1:7801/Mobius?fu=1&ty=16'
# {"m2m:uril":["Mobius/csr-xHocATHzAq"]}
```

Note the originator: **`/mn-cse`, not the administrator.** A `<remoteCSE>` created by
a registering CSE carries no `accessControlPolicyIDs`, so the default access policy
shows it to its creator only — asking as the registrar's own administrator returns an
empty list, which looks exactly like a registration that never happened.

Once registered, either CSE can reach the other's resources by SP-relative address.
Over HTTP that is written with the `/~/` prefix (TS-0009 clause 6.2.2.1):

```bash
# create on the MN-CSE, read it from the IN-CSE
curl -s -X POST 'http://127.0.0.1:7802/Mobius' -H "X-M2M-Origin: $ADMIN" \
     -H 'X-M2M-RI: 1' -H 'X-M2M-RVI: 3' -H 'Content-Type: application/json;ty=3' \
     -d '{"m2m:cnt":{"rn":"fwd-probe"}}'
curl -si 'http://127.0.0.1:7801/~/mn-cse/Mobius/fwd-probe' -H "X-M2M-Origin: $ADMIN" \
     -H 'X-M2M-RI: 2' -H 'X-M2M-RVI: 3' | grep -i x-m2m-rsc
# X-M2M-RSC: 2000
```

Tear it down with `docker compose -f docker/compose.two-cse.yml down -v`.

---

## The administrator identity

`cse.admin` names the identity that bypasses access control. It is a credential:
anything sending it as `X-M2M-Origin` has full control of the CSE — every operation on
every resource, regardless of policy or creator, over plain HTTP as much as over TLS.
Mobius4 refuses to start without one, and refuses `SM` — the value it shipped up to
v4.5.1, which is in this repository's history.

The admin `<accessControlPolicy>` is still created at startup and still governs anyone
else it names; it simply no longer bounds what this identity can do. See
[configuration.md](configuration.md#cse) for why.

There are two ways to have one.

### Set it yourself — preferred

```bash
# .env
CSE_ADMIN=Syour-chosen-value
```

Keep it wherever you keep other credentials. This is the better path because the
alternative below lives on a Docker volume, and a volume is one
`docker compose down -v` away from being gone.

### Or let the container generate one

Leave `CSE_ADMIN` blank and the first start generates an identity, prints it once, and
stores it on the `identity` volume:

```
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  A new administrator identity was generated for this deployment.         │
  └──────────────────────────────────────────────────────────────────────────┘

      cse.admin = SR1tiZ5Igx.V
```

Every later start reads it back from the volume, so it stays the same across
`restart`, `docker compose down && up`, and an image rebuild. **That stability is not
a convenience.** `db/init.js` writes the identity into the admin
`<accessControlPolicy>` on first boot and skips the step forever after, so an identity
that changed on the second start would leave the deployment locked out of its own CSE:
the policy would still name the first one, and every administrator request would come
back 4103.

Generated identities start with `S` and are 12 characters. The prefix is not
decoration — `TS-0001:7.2` gives the first character of an AE-ID-Stem a meaning, and
`'S'` is "assigned by the M2M-SP", which is what a deployment-chosen identity is. The
length is a security choice rather than a conformance one; set `CSE_ADMIN_LENGTH` if
you want a different one.

### Reading it back, and backing it up

```bash
docker compose exec mobius4 cat /var/lib/mobius4/cse-admin

# keep a copy outside Docker
docker compose exec -T mobius4 cat /var/lib/mobius4/cse-admin > cse-admin.txt
```

Back it up together with the database, and restore them together. They are two halves
of one fact: the volume holds the identity, the database holds the policy that grants
it anything.

### If they get out of step

Losing the identity volume while keeping the database is the case to know about, and
it is what a `docker compose down -v` followed by restoring only the database backup
produces. The container checks for it before starting and refuses rather than coming
up into a state where every administrator request fails with nothing in the log to
explain it:

```
mobius4 entrypoint: the administrator identity does not match the one this database
was initialised with.

  starting with : Sdifferent1  (from the environment)
  database has  : SR1tiZ5Igx.V
```

Two ways out, both in the message: put the identity the database already has into
`CSE_ADMIN`, or keep the new one and run `db/migrations/v4.6.0.sql` against the
database to rewrite what it records.

```bash
docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" < db/migrations/v4.6.0.sql
```

That migration takes the new identity from the configuration, so set `CSE_ADMIN`
first, then run it, then start.

---

## HTTPS

Off by default. To serve TLS, put the key and certificate in `./certs` — mounted
read-only at `/app/certs`, never built into the image — and set:

```bash
# .env
HTTPS_ENABLED=true
HTTPS_KEY=certs/server.key
HTTPS_CERT=certs/server.crt
```

Obtaining a certificate, replacing it before it expires, and what TLS here does and
does not prove about the client: **[docs/tls.md](tls.md)**. Mobius4 reads the files
once at startup, so a renewed certificate needs `docker compose restart mobius4`.

If `HTTPS_ENABLED` is true and a file cannot be read, the container stops rather than
serving plain HTTP.

---

## MQTT

The broker in this stack accepts anonymous connections and is not published to the
host, so it is reachable only from the compose network. That is the reason it is safe
as configured, not the configuration itself: `docker/mosquitto/mosquitto.conf` sets
`allow_anonymous true`, because the oneM2M MQTT binding has no broker-level
credentials in Mobius4 — authorisation is `<accessControlPolicy>` resources, not
broker accounts.

**Publishing 1883 to the host, or pointing Mobius4 at a broker shared with anything
else, means putting real authentication in that file** — a `password_file`, or TLS
with client certificates. To use an external broker instead, remove the `mosquitto`
service and set `MQTT_HOST` and `MQTT_PORT`.

---

## Logs

Everything goes to stdout, and the JSON file driver rotates it at 10 MB × 5 files per
service. File logging inside the container is off: a file in a container layer is
invisible to `docker compose logs` and nobody backs it up.

```bash
docker compose logs -f mobius4
docker compose logs --since 10m postgres
```

`LOG_LEVEL=debug` adds a line per request and costs about 7% of throughput; see
[logging-guide.md](logging-guide.md#throughput-cost).

---

## Backup and restore

Two things to keep: the database and the administrator identity.

```bash
# backup
docker compose exec -T postgres pg_dump -U "$DB_USER" -Fc "$DB_NAME" > mobius4.dump
docker compose exec -T mobius4 cat /var/lib/mobius4/cse-admin > cse-admin.txt

# restore, into an empty deployment
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U "$DB_USER" -d "$DB_NAME" --clean --if-exists < mobius4.dump
# then put the saved identity into .env as CSE_ADMIN before starting mobius4
docker compose up -d
```

Restoring the database without the identity is the mismatch described above. The
entrypoint will catch it, but the recovery is easier if you kept both.

---

## Upgrading

```bash
git pull
docker compose build
docker compose up -d
```

**Check [upgrading.md](upgrading.md) first** for the versions you are crossing. A
clean deployment needs none of it — `db/init.js` builds the current schema — but an
existing database may need a migration, and those are not applied automatically:

```bash
docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" < db/migrations/v4.6.0.sql
```

Migrations live in `db/migrations/` and are named for the release that introduced
them. Apply the ones between your old version and the new one, in order.

---

## Using an external database

The `postgres` service is here so that `docker compose up` is one command, not because
the database belongs in the same place as the application. To use a managed or
existing PostgreSQL instead: delete the `postgres` service and the `pgdata` volume from
`docker-compose.yml`, remove the `depends_on` entry, and set `DB_HOST`, `DB_PORT`,
`DB_NAME`, `DB_USER` and `DB_PW` in `.env`.

It must have PostGIS available — `db/init.js` runs
`CREATE EXTENSION IF NOT EXISTS postgis`, and location filtering in discovery is a
geometry query.

---

## Scaling

**One instance.** `docker compose up --scale mobius4=N` is not supported, and the
reasons are not configuration:

- **Resource-ID resolution is cached per process and not invalidated across
  instances.** A resource deleted through one instance and recreated under the same
  name through another reads as missing from the first for up to five minutes. This is
  a correctness problem, not a performance one, and it has to be fixed before more
  than one instance is sound.
- **Compose gives every replica the same environment**, including the variable that
  decides which instance owns the singleton work. All of them would subscribe to the
  MQTT request topic and all of them would run the expired-resource sweep, so each
  request would be handled several times.
- **One host port cannot serve several replicas.** A reverse proxy would have to go in
  front.

None of that is thrown away by starting here: the image, the entrypoint and the `.env`
→ `NODE_CONFIG` path are unaffected by how many instances there are. It is
`docker-compose.yml` that would be rewritten.

Vertically, Mobius4 is single-threaded, so more than the two CPUs the compose file
allows buys nothing. `db.pool.max` is the connection total for the process (default
20) — see the sizing note in [configuration.md](configuration.md).

---

## Health checks and what they do not cover

```bash
curl localhost:7599/health     # {"status":"ok","uptime":132.5,"db":"ok"}
```

`/health` is a **readiness** check as of v4.11.0: it reads one row from the database before
answering. A CSE that cannot reach PostgreSQL — or reaches it but finds no usable schema —
answers `503` with `{"status":"unavailable","db":"unreachable"}` instead of `200`.

That matters because Compose uses this endpoint to decide whether the container is healthy.
Before v4.11.0 it only reported that the HTTP listener was answering, so a container whose
database had gone away stayed `healthy` while failing every request — observed in a deployment
lasting two and a half hours. Now the same situation marks the container unhealthy and the
restart policy takes over.

Metrics are richer, when `metrics.enabled` is on: `curl localhost:7599/metrics`. See
[operations.md](operations.md).

---

## Troubleshooting

**`no matching manifest for linux/arm64`** — the PostGIS image. See
[On Apple Silicon](#on-apple-silicon-and-other-arm64-hosts).

**`set DB_USER in .env`** — compose refuses to start without database credentials.
Copy `.env.example` and fill them in.

**The container restarts in a loop** — `docker compose logs mobius4` has the reason on
every attempt. A configuration error will not fix itself, so the loop continues until
you change something; `restart: unless-stopped` is deliberate, because the same policy
is what recovers the container from a genuine crash.

**Administrator requests return 4103** — the identity in use is not the one the
database records. The entrypoint refuses to start in the case it can detect; if you
reach this from another direction, compare
`docker compose exec mobius4 cat /var/lib/mobius4/cse-admin` with what the admin policy
holds:

```bash
docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" \
  -c "SELECT pv FROM acp WHERE rn = 'cb_admin_acp';"
```

**Resources vanished after `docker compose down -v`** — `-v` deletes the volumes,
which is the database and the administrator identity. Without `-v`, both survive.
