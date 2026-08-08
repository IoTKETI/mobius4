# Upgrading Mobius4

Everything here applies **only when upgrading an existing deployment**. A clean
install on the current version needs none of it — follow
[docs/installation.md](installation.md) instead.

Two kinds of thing live here:

- **Required steps** — a DB migration, a new prerequisite. The upgrade is not
  finished until these are done.
- **Known upgrade problems** — failures that happen *because* something from the
  old version is still around. The source tree is correct; the environment is
  stale.

Sections are newest first, matching [CHANGELOG.md](../CHANGELOG.md). Upgrading
across several versions means working **upward from your current version** and
applying each section in turn.

For what changed in a release and why, read the CHANGELOG. This document only
answers "what do I have to *do* about it."

---

## v4.13.0

### Required: DB migration

`<AE>` gains the `ontologyRef` attribute, which needs a new column. A clean
install does not need this — `db/init.js` creates the column — but an existing
database does:

```bash
psql -d mobius4 -f db/migrations/v4.13.0.sql
```

The migration is `ALTER TABLE ae ADD COLUMN IF NOT EXISTS "or" VARCHAR(255)`. It
does not rewrite existing rows and changes no behaviour by itself: every `<AE>`
that already exists gets `or = NULL`, which is what "the attribute is not
present" already meant. It is safe to run twice.

### Worth knowing: a fanout over an empty group now fails instead of succeeding

A RETRIEVE (or any operation) sent to `<group>/fopt` when the group has no
members used to answer **2000** with an empty `m2m:agr`. It now answers **4109
NO_MEMBERS**, which is what `TS-0004:7.4.14.2.4` requires.

If a client treats "2000 with nothing in it" as normal — polling a group that is
filled in later, for instance — it will start seeing an error status. The fix on
the client side is to treat 4109 as "not yet", not as a failure.

### Worth knowing: `memberTypeValidated` can now be false, and members are no longer silently dropped

Before this release, a `<group>` member hosted on another CSE was dropped at
creation time and the group still reported `memberTypeValidated` = true. Groups
created that way are **already missing those members in the database** — this
release does not go back and repair them. If you have groups whose `memberIDs`
were meant to include resources on another CSE, re-send the CREATE or an UPDATE
with the full member list.

Two consequences for clients:

- `memberTypeValidated` may now be **false**, which previously never appeared. It
  means the CSE could not reach some member's Hosting CSE and has not judged
  those members yet. The members are in the group regardless.
- A `<group>` CREATE or UPDATE naming a member whose type the CSE is not allowed
  to read is now rejected with **5105 RECEIVER_HAS_NO_PRIVILEGE** rather than
  quietly dropping that member.

### Worth knowing: forwarded Response Status Codes are numbers

In an aggregated fanout response (`m2m:agr`/`m2m:rsp`), a member response coming
from another CSE used to carry `rsc` as a JSON string (`"2000"`) while a local
one carried a number (`2000`). Both are numbers now, matching the `xs:integer`
type in TS-0004. A client that compared `rsc` against a string literal for
forwarded members must compare against a number.

---

## v4.11.0

### Worth knowing: `contentSize` values change, and with them what `mbis`/`mbs` refuse

`contentSize` counted JavaScript string units (`length * 2`), not bytes. It now counts UTF-8
bytes, as `TS-0001:9.6.7` requires.

```
"abc"          3 bytes    was 6    now 3
"0123456789"  10 bytes    was 20   now 10
"한글"          6 bytes    was 4    now 6
```

**Nothing needs migrating.** Existing `<contentInstance>` rows keep the `cs` they were stored
with, and a container's `cbs` is the sum of those, so a container's figure is a mix of old and new
until its instances turn over.

**Two things to check before upgrading:**

- A container sitting close to its `maxByteSize` ceiling may evict differently for a while, since
  `cbs` is compared against `mbs` and half the values were inflated.
- Requests that used to be refused will now succeed. If any client depends on a
  `maxByteSizePerInstance` refusal as a size guard, its effective limit has roughly doubled for
  ASCII content — halve the configured value to keep the previous behaviour.

Structured content is measured as its JSON form. Which serialization the standard means is
undefined and remains an open question.

### Worth knowing: a database failure now answers 5000

During a database outage requests came back 4004 "target resource does not exist", for resources
that existed. They now answer 5000 INTERNAL_SERVER_ERROR (`TS-0004:6.6.2`, `6.6.3.6`).

**Check your client's error handling.** A client that treats 4004 as "it is not there, create it"
was being led into recreating live resources; a client that does not retry 4xxx was giving up on
a condition that would have cleared. Both are correct behaviours against the new code and wrong
against the old.

The create path (previously 4000) and the `<CSEBase>` retrieve (previously **4103 access denied**)
changed with it.

### Worth knowing: `/health` can now fail

It reads one row from the database before answering, and returns `503` with
`{"status":"unavailable","db":"unreachable"}` when it cannot.

If you have an external monitor treating any non-200 from `/health` as an incident, it will now
see incidents it previously missed — that is the point. If you were using `/health` as a liveness
probe specifically (restart only when the process is gone), it is no longer the right endpoint for
that: it now reports readiness.

Compose already used this endpoint as the container healthcheck, so no compose change is needed.

### Worth knowing: `<subscription>` now sets `creator` by itself

Where `notificationURI` is not the Originator, `creator` is filled in automatically
(`TS-0004:7.4.8.2.1`) and carried in notifications as `m2m:sgn.cr` (`TS-0004:7.5.1.2.2`).

If a notification consumer validates the set of members it receives strictly, it will now see one
more.

**A request can no longer set `creator` to another entity's identity** — that is refused with
4000. Sending an empty value to mean "fill it in for me" still works, as does sending your own ID.
This closes a privilege path: on a resource that defines `accessControlPolicyIDs` but has none
set, the creator holds full control.

### Optional: database pool settings on the container

`db.pool.connectionTimeoutMs` default is raised from 2000 to 5000. `DB_POOL_MAX`,
`DB_POOL_CONNECTION_TIMEOUT_MS` and `DB_POOL_STATEMENT_TIMEOUT_MS` can now be set in `.env`. Unset
values fall through to `config/default.json` as before.

## v4.10.0

### Required if any client sends `rcn=4` or `rcn=8`: update the response parser

Child resources are now nested inside their own parent. A parser written for the old flat shape
finds no children and reports an empty result — it does not raise.

```jsonc
// 4.9.0 and earlier — every descendant at the top level, grouped by type
{"m2m:cnt": {"rn": "sensors",
   "m2m:cnt": [{"rn": "humid01"}, {"rn": "temp01"}],
   "m2m:cin": [{"rn": "h1"}, {"rn": "t1"}, {"rn": "t2"}]}}

// 4.10.0 — each resource under the parent that owns it
{"m2m:cnt": {"rn": "sensors",
   "m2m:cnt": [{"rn": "humid01", "m2m:cin": [{"rn": "h1"}]},
               {"rn": "temp01",  "m2m:cin": [{"rn": "t1"}, {"rn": "t2"}]}]}}
```

Walk the tree recursively instead of reading one flat array per type. The parent-child
relationship no longer has to be reconstructed from `pi`.

**Nothing else is affected.** Plain retrieves (`rcn=1` or no `rcn`), discovery (`fu=1`, still a
flat `m2m:uril`), notifications and CREATE/UPDATE/DELETE responses are unchanged. To find out
whether this applies to you, grep your client for `rcn=4`, `rcn=8`, `rcn%3D4`, or a
`resultContent` of 4 or 8.

### Required if you paginate `rcn=4`/`rcn=8`: stop computing `ofst` yourself

`ofst` now counts **direct children** for these two values (it still counts resources for `fu=1`
discovery), because a nested result cannot be resumed in the middle of a subtree without
duplicating the parent or orphaning its children.

Send back the `X-M2M-CTO` value from the previous response rather than adding `lim` to your own
counter. Computing it yourself now skips or repeats whole subtrees, silently.

### Worth knowing: a large subtree can make a request return no children

`lim` now cuts on subtree boundaries, because `TS-0001:8.1.2` requires that a direct child whose
descendants cannot all be included is left out entirely.

The consequence to plan for is **one direct child whose own subtree is larger than `lim`**.
Retrieving an `<AE>` that has a `<container>` holding 250 `<contentInstance>`s makes that
container's subtree 251 resources; it does not fit in the default `lim` of 200, so it is dropped
whole and the `<AE>` comes back with no children at all — where 4.9.0 returned 200 of them.
Raising `ofst` does not help; only a larger `lim` does.

Retrieving that `<container>` directly is fine: its 250 children are 250 subtrees of one resource
each, and 200 of them fit.

The response body gives no clue when this happens, so the server logs a warning:

```
rcn=4/8 returned no children: the first subtree is larger than lim
```

### Worth knowing: `rcn=5` and `rcn=6` do something now

Both used to be ignored — they returned the target's attributes with RSC 2000, exactly like
`rcn=1`, so a client asking which children existed was told "none", successfully. If you worked
around that by falling back to `fu=1` discovery, the fallback is no longer needed:

- `rcn=5` adds a `ch` array of `{"nm", "typ", "val"}` to the target's representation. The member
  is omitted, not empty, when there are no children.
- `rcn=6` returns `m2m:rrl` with an `rrf` array and no representation of the target.
- `drt=2` makes `val` an unstructured ID.

### Worth knowing: truncated child-resource results now say so

`X-M2M-CTS` (Content Status; `1` means partial) and `X-M2M-CTO` (Content Offset) are set whenever
`lim` truncates an `rcn=4/5/6/8` result. Previously a truncated result was indistinguishable from
a complete one. A client that inferred "fewer than `lim` means done" can keep working, but reading
these headers is both cheaper and correct.

## v4.9.0

### Required if you have an existing database: add the `mbis` column

```bash
psql -U "$DB_USER" -d "$DB_NAME" -f db/migrations/v4.9.0.sql
```

Adds `cnt.mbis` (`maxByteSizePerInstance`). Fast — no default value, no rewrite of existing
rows. Skip this if you are on Docker Compose and using its bundled database with a fresh
volume; `db/init.js` creates the column directly for a new deployment.

### Worth knowing: `maxInstanceAge` is now actually enforced

`TS-0004:7.4.7.2.1` step 2 e) requires a `<container>`'s `maxInstanceAge` to cap the
`expirationTime` of its `<contentInstance>` children. It never did before this release — `mia`
was stored and returned but nothing compared it against `et`.

If a container's `mia` was left at the deployment default, this now costs at most about a day
off what its content instances' lifetime would otherwise have been: the default moved from 30
days to 365 days in the same release that turns enforcement on, specifically so that a
container left at its defaults keeps behaving the way it did before (the 365-day default and
the previous 12-calendar-month `et` default can differ by up to a day, only in date ranges
that include 29 February).

If a container's `mia` was set explicitly to something narrower than that, its content
instances now actually get the shorter lifetime that attribute always claimed to promise. If
that is not what you want, widen or clear `mia` on that container (see the known issue below —
clearing it back to "no limit" does not currently work).

**Known issue, not fixed in this release**: sending `null` to clear `mni`, `mbs` or `mia` on a
`<container>` UPDATE does not work — the request is rejected with 4000 before the code that
would reset it ever runs. If you were relying on this to remove a limit, it has never actually
done so; set an explicit wide value instead.

---

## v4.7.0

### Required if you serve HTTPS: turn it on and say where the files are

The listener is now optional and **off by default**. Before this release it started
unconditionally, reading `certs/ca.crt`, `certs/wdc.key` and `certs/wdc.crt` at module
load with no condition and no error handling — a deployment without those files could
not start, and one with them had no way to turn TLS off.

After upgrading, a deployment that was serving HTTPS serves **only plain HTTP** until
`config/local.json` says otherwise:

```jsonc
{
  "https": {
    "enabled": true,
    "port": 7580,
    "key":  "certs/server.key",     // your own key
    "cert": "certs/server.crt",     // your own certificate
    "chain": ""                     // intermediate CA bundle, if your issuer gives one
  }
}
```

The old hardcoded paths are gone, so the values above are the defaults rather than
what you had. Point them wherever your files are; absolute paths work.

If `https.enabled` is true and a file cannot be read, Mobius4 **stops** instead of
serving plain HTTP, naming the setting that pointed at it. Check the startup log after
the first restart — `HTTPS server listening` or `HTTPS is disabled`.

Full procedure for obtaining, installing and replacing a certificate: [docs/tls.md](tls.md).

### Your clients are no longer asked for a certificate

The listener used to set `requestCert: true` and `rejectUnauthorized: true`. Clients
that present a certificate still connect — it is simply ignored now.

If you were treating that requirement as authentication, it was not: nothing in
Mobius4 ever read the certificate, so the handshake proved possession of a CA-signed
certificate and never that the holder was the originator named in `X-M2M-Origin`. Any
client with a certificate from your CA could act as any AE, including the
administrator. Replace that assumption with network-level access control (firewall,
reverse proxy, or mTLS terminated in front of Mobius4) together with oneM2M
`<accessControlPolicy>` resources.

### Treat the keys this repository used to ship as disclosed

`certs/` is deleted from the source tree and gitignored. Two private keys were in it —
`certs/wdc.key` (the server key) and `certs/SAE1.key` (a sample client key) — and both
remain in the git history, where anyone with a clone can read them.

- If your deployment serves `wdc.crt`, issue a new certificate and key ([docs/tls.md](tls.md)).
- If any client still holds `SAE1.key` and it is used for anything, reissue it.

Nothing else changes. No DB migration, no configuration is newly required for a
deployment that does not use HTTPS.

---

## v4.6.5

Nothing is required. No DB migration, no new configuration. Two things are worth
checking, both of them workarounds you may now be able to undo.

### If you worked around `<contentInstance>` resources being unreadable

Before this release, a `<contentInstance>` under a `<container>` carrying an
`accessControlPolicyIDs` was refused to **every** originator, the administrator
included, and was dropped from discovery results without an error. Deployments
hit by this tended to work around it in one of two ways:

- **Leaving `acpi` off the containers** that hold content instances, so that the
  creator-comparison fallback governed them instead. Those containers can now
  carry a policy. Note the consequence of adding one: a resource with a policy is
  no longer governed by its creator, so whoever was reaching it through the
  creator fallback needs to be named in the policy.
- **Setting `cse.allow_discovery_for_any: true`**, which skips access control for
  discovery entirely. See below — there is now a better reason to turn it off.

If you were not affected — no `<accessControlPolicy>` on the containers holding
content instances — nothing about your deployment changes.

### If you set `cse.allow_discovery_for_any: true` for speed

That setting exists to skip discovery's access-control filter, and skipping it
used to be worth a great deal: the filter evaluated every matching resource
one at a time, which measured 18 requests per second over a container holding
150 content instances.

The filter now decides once per policy holder rather than once per resource, and
the same measurement is 614 requests per second. The speed argument for turning
access control off has largely gone.

The setting is a conformance decision, not a performance knob: `TS-0004:6.3.4.2.29`
defines 32 = DISCOVERY, so with it on, the DISCOVERY bit in every
`<accessControlPolicy>` stops meaning anything and any originator can enumerate
the resource tree (identifiers and structure — `fu=1` returns `m2m:uril` only, so
content is still protected). If it is on purely for throughput, this is the
release to turn it back off. The default is, and remains, `false`.

---

## v4.6.3

### Only if you raised `db.pool.max`: halve it

`db.pool.max` used to be applied by each of the two connection pools this process runs
separately, so the setting bought twice the connections it named — a process with `max: 30`
was measured holding 53. It is now the **process-wide total**, split between the pools.

If `config/local.json` overrides `db.pool.max`, the same value now opens **half** as many
connections as before. Halve your override to keep the behaviour you had, or leave it and use
the smaller number — the size buys very little either way: 10 connections per pool reached
3,069 requests per second against 3,139 for 30.

If you never overrode it there is nothing to do. The default moves from 30 to 20, which is
fewer connections than the old default actually opened.

### Worth knowing before you run more than one instance

The number of instances a PostgreSQL server can carry is bounded by
`max_connections / db.pool.max`. The default `max_connections` is 100, so at `db.pool.max: 20`
that is five instances. Before this release the arithmetic was invisible — the setting said 30
and opened 60, so a second instance already exceeded the default and failed with
`too many clients`.

Nothing else changes. No DB migration, no configuration is newly required.

---

## v4.6.1

Nothing to do on the server: no configuration change, no DB migration. One thing
to check on the **client** side.

### Check: the group fanout response member is `m2m:rsp`

A fanout retrieve (`.../<grp>/fopt`) returns the aggregated response as

```jsonc
{ "m2m:agr": { "m2m:rsp": [ /* one response primitive per member */ ] } }
```

The member used to be delivered as plain `rsp`, without the `m2m:` prefix, while
an issue on the conformance tester side was being worked around. `rsp` is
`m2m:responsePrimitive` in the TS-0004 symbol table, so it carries the prefix the
same way the surrounding `m2m:agr` envelope does, and it is now emitted that way.

A client that reads `agr.rsp` gets `undefined` and should read `agr["m2m:rsp"]`.
Nothing inside the CSE consumes this key, so no server-side state is affected.

---

## v4.6.0

Two required steps, and they have to be done together. **Mobius4 will not start
until the first one is done**, by design.

### Required: choose an administrator identity

`cse.admin` names an identity that the administrator `<accessControlPolicy>`
grants every operation to. Up to v4.5.1 it had a working default, `SM`, which is
published in this repository — anyone who could reach the port and send
`X-M2M-Origin: SM` had full control of the CSE, including DELETE, over plain HTTP
as much as over TLS.

There is now no default. Add the key to `config/local.json`:

```jsonc
{
  "cse": {
    "admin": "pick-something-unique-to-this-deployment"
  }
}
```

Treat the value as a credential, not a name. Startup refuses to continue when it
is missing, blank, or `SM`, and warns when it is `Superuser` — the placeholder
printed in `config/local.json.example`, which is no more secret than `SM` is.

A refusal looks like this, and the process exits with status 1:

```
FATAL: cse.admin is not set. Set it to an identity unique to this deployment in
config/local.json (see config/local.json.example).
```

### Required: DB migration

Configuration alone is not enough. `db/init.js` writes the administrator identity
into the database when it first creates the `<CSEBase>` and the default
`<accessControlPolicy>`, and never rewrites them — so the old value survives in
every resource's `creator` fields and in that policy's `privileges`. Without the
migration the new administrator cannot modify the default policy through the
standard path.

Edit `new_admin` in **both** `DO` blocks of the migration to the value you just
configured, then apply it:

```bash
psql -d mobius4 -v ON_ERROR_STOP=1 -f db/migrations/v4.6.0.sql
```

It runs as a single transaction and is idempotent — a second run reports zero
rows changed rather than doing anything twice. If you miss the second block, the
migration stops with a clear error and commits nothing.

**A clean install needs neither step's migration** — only the configuration.
`db/init.js` creates the administrator policy itself on an empty database.

### What changes for you

The administrator no longer bypasses access control. It reaches a resource
through a policy that names it, or through the creator fallback when the resource
carries no `accessControlPolicyIDs` at all. Two consequences are worth checking
against your own data before upgrading:

- A resource whose policy list names only the default policy is **no longer
  deletable or updatable by the administrator**. That policy grants `acop` 35 —
  create, retrieve, discovery — and nothing else.
- A resource created by someone else with no policy list at all is governed by
  the creator fallback, and the administrator is not the creator.

The migration attaches the new administrator policy to every resource that
already carries a policy list. Resources with an **empty** list are deliberately
left alone: giving them one would switch them from the creator fallback to policy
evaluation, and their creator would lose the update and delete rights it has
today.

### Known upgrade problem: resource names that are now invalid

`resourceName` is now checked against its ABNF (`TS-0004:6.2.4`). A name must
start with a letter or a digit; `-`, `.` and `_` are allowed from the second
character onwards, and `@` is not allowed at all. Names that violate this are
refused at CREATE with RSC 4000 where they previously returned 2001.

**Existing resources are not touched** and stay readable. This release also fixes
a defect that made a name beginning with `_` unreachable by its hierarchical path
— created successfully, then answering 4004 to both retrieve and delete — so if
you have such names, this is the version in which you can finally delete them.

To find them before upgrading:

```sql
SELECT sid FROM lookup WHERE rn !~ '^[a-zA-Z0-9][-._a-zA-Z0-9]*$';
```

Clients that mint names from a template are the ones to check: a prefix like
`_tmp` or an identifier containing `@` will start failing.

---

## v4.5.1

### Test prerequisite: `mosquitto`

Only relevant if you run the test suite. The suite now covers the MQTT binding
and starts its own broker, so `mosquitto` must be installed:

```bash
brew install mosquitto        # macOS
sudo apt install -y mosquitto # Debian/Ubuntu
```

Only the **binary on `PATH`** is required. Unlike running Mobius4 itself, the
tests need no running instance and no `mosquitto.conf` — they spawn a broker on
a free port and shut it down afterwards. See [test/README.md](../test/README.md).

Nothing to do for a runtime upgrade.

---

## v4.5.0

### Required: DB migration

`<flexContainer>` (ty=28) adds a table. Apply:

```bash
psql -U <db_user> -d mobius4 -f db/migrations/v4.5.0.sql
```

The change is backward compatible — existing resources are untouched.

Back up first:

```bash
pg_dump -U <db_user> -d mobius4 -F c -f mobius4_backup_$(date +%Y%m%d).dump
```

---

## v4.4.1

This release added Node 24 support. Node 22 remains supported
(`engines: { node: ">=22" }`), so no runtime change is forced — but if you *do*
move to Node 24, the problem below is the one you are most likely to hit.

<a id="utils-isregexp"></a>
### `TypeError: Utils.isRegExp is not a function` on Node 24

```
TypeError: Utils.isRegExp is not a function
    at _clone (node_modules/config/lib/config.js:1217:22)
    at Config.cloneDeep (node_modules/config/lib/config.js:1255:10)
    ...
Node.js v24.x
```

`config` 1.x calls `util.isRegExp`, which Node 24 removed, so the server cannot
start. v4.4.1 fixed this by moving to `config` 3.3.12.

Seeing it after upgrading means **the fix is in your source tree but an old
`config` is still installed**. The code is fine; `node_modules` is stale.

#### Identify the installed version from the stack trace

The offending call sits on a different line in each release, so the crash names
its own cause:

| Line of `Utils.isRegExp(parent)` | Installed version |
|---|---|
| 1217 | 1.31.0 |
| 1087 | 2.0.2 |
| 1008 | 3.3.11 |
| *(absent)* | **3.3.12+ — this is what you want** |

#### Diagnose

Both causes need the same fix, but they tell you different things about your
checkout:

```bash
git branch --show-current
node -e "console.log('required :', require('./package.json').dependencies.config)"
node -e "console.log('installed:', require('./node_modules/config/package.json').version)"
git status --short
```

- `required` is `^1.30.0` → **you are on a branch that predates v4.4.1.**
  `git pull` updates the branch you are on, not `master`, so a stale branch stays
  stale — and `npm install` then correctly installs the old `config` that
  branch's `package.json` asks for. This is the common case, and it is why the
  upgrade can look like it silently failed.
- `required` is `^3.3.12` but `installed` is `1.31.0` → the branch is right and
  the install did not take.
- `package.json` shows as modified → a local edit is overriding the pinned
  version.

#### Fix

Commit or stash any work in progress first — this changes branches.

```bash
git checkout master
git pull
rm -rf node_modules
npm ci
```

Use `npm ci`, not `npm install`: it installs exactly what `package-lock.json`
pins and rebuilds `node_modules` from scratch, which is what clears a
mismatched tree.

#### Verify

```bash
node -v                                                                        # v24.x
node -e "console.log(require('./node_modules/config/package.json').version)"    # 3.3.12
```

---

## v4.4.0

### Required: DB migration

Schema changes including a **destructive** one (the `cnt.cin_list` column is
dropped). Read the dedicated guide before running anything:

**[DB Migration Guide — v4.4.0](migration-v4.4.0.md)** — covers the dropped
column, a widened column, eight new indexes, step-by-step instructions, and the
rollback procedure.

---

## Adding to this document

When a release introduces something an upgrader must do — or a failure mode that
only bites people coming from an older version — add a section here rather than
burying it in the CHANGELOG. The CHANGELOG explains *what changed and why*; this
document is the actionable counterpart, and it is what the version-history table
in [README.md](../README.md) points at.

A good section states the symptom in the form the user will actually see it (an
exact error message, a specific failure), then the diagnosis, then the fix, then
how to confirm it worked.
