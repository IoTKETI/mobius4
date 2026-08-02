# Changelog

Notable changes to this repository are recorded here. The newest entry comes
first.

## Versioning

The **single source of truth for the version is `version` in `package.json`**.
It is not hardcoded anywhere else (for a long time the first line of
`mobius4.js` still said `0.1.0`, out of sync with the 4.x in `package.json` —
it now reads `package.json`).

SemVer, made concrete for this project:

| Digit | When it goes up |
|---|---|
| **MAJOR** | oneM2M release-axis change, compatibility break requiring manual intervention |
| **MINOR** | oneM2M capability added (resource type, operation, filter criteria, notification event type), new binding, backward-compatible DB migration |
| **PATCH** | Bug fix that adds no capability, performance, docs, tests |

At release time, close off `[Unreleased]` as `## vX.Y.Z (YYYY-MM-DD)` and bump
`package.json` along with it.

## [Unreleased]

_(Accumulate items here for the next release.)_

### Unresolved — pending spec clarification

- **Whether CIN eviction (`mni`/`mbs` exceeded) should fire `net=4`.** In oneM2M
  standardization discussion, **indirect deletion** (a deletion that happens as a
  side effect of deleting a different resource) is treated as not firing a
  notification. Whether eviction falls under this needs confirmation — what
  triggers eviction is CREATE, not DELETE. Excluded conservatively pending
  confirmation; the regression test is left as `todo` to keep the question visible.
  If the answer is "yes, notify," removing the `int_cr_req !== true` condition in
  `cse/noti.js` turns it on (at which point `int_cr`, carried by `retrieve_a_cin`,
  must be stripped from the notification).
- **Three questions about the MQTT binding, left open rather than guessed at
  when its test coverage was designed.** Confirmed from TS-0010's topic-format
  rule only, not from a full reading of the spec:
  - **Registration topics.** TS-0010 defines `/oneM2M/reg_req/...` for an AE
    that does not yet have an ID. `bindings/mqtt.js` subscribes only to
    `/oneM2M/req/+/<cse_id>/json` and `self/datasetManager/#` — this looks
    like an unimplemented feature, but confirming that needs the full spec
    text, not a test suite.
  - **QoS levels and retained-message handling** — not yet checked against
    the spec at all.
  - **MQTT-specific error mapping** — likewise unchecked.

  Encoding a guess about any of these as a passing test would be worse than
  leaving them untested: it would cement whatever mobius4 does today as
  though it were the standard, the same reasoning that keeps the `net=4`
  eviction question above as a `todo` rather than a silent choice.
  `test/mqtt.test.js` (added below) is now the harness that a future pass
  through the full TS-0010 text can use to settle them.

## v4.6.0 (2026-08-02)

**Also breaking**: the administrator no longer bypasses access control. See the
second item below — some resources the administrator could reach before are now
refused, and that is deliberate.

**Why MINOR, deliberately, despite being a breaking change**: mobius4 now refuses
to start until `cse.admin` is set to a value this deployment chose. Deployments
that never overrode it will not boot until they do, and the identity recorded in
the database has to be migrated as well. By the rule table above that is a
"compatibility break requiring manual intervention" and would be MAJOR. It is
released as MINOR by an explicit decision, so that the fix reaches deployments
that track minor versions rather than waiting on a major upgrade — the exposure
being closed is a full access-control bypass reachable over plain HTTP, and
delaying it is the worse outcome. **Read the upgrade steps below before
upgrading: this release does not start on an unchanged configuration.**

- **`cse.admin` no longer has a default, and `SM` is refused.** A request whose
  `From` parameter matches `cse.admin` is granted access to every resource:
  `cse/hostingCSE.js` returns "granted" before any `<accessControlPolicy>` is
  consulted, and that path is reached over plain HTTP exactly as over TLS. Up to
  v4.5.1 the shipped default was `SM`, and `config/local.json.example` did not
  mention the key at all — so a deployment that filled in the example kept a value
  published in this repository. Anyone who could reach the port and send
  `X-M2M-Origin: SM` had full control of the CSE, including DELETE.

  `config/default.json` no longer carries the key, and a new startup check
  (`config/validate.js`) exits with a fatal log when it is missing, blank, or `SM`.
  Only `SM` is refused: it is the one value that actually shipped, and refusing a
  value no deployment ever ran would break upgrades for no gain. The placeholder in
  `config/local.json.example` (`Superuser`) is warned about rather than refused,
  since anything printed in this repository is not secret either.

  The admin comparisons in `cse/hostingCSE.js` and `cse/authorization.js` are now
  guarded on the identity being set. That is not redundant: the `From` parameter is
  optional, so `req_prim.fr` is `undefined` for a request with no `X-M2M-Origin`,
  and an unset admin identity would have matched it — turning "no default" into a
  worse hole than the one being closed.

  **Upgrading**: set `cse.admin` in `config/local.json`, then run
  `db/migrations/v4.6.0.sql`. Configuration alone is not enough — `db/init.js` writes
  the admin identity into the database when it first creates the `<CSEBase>` and the
  default `<accessControlPolicy>` and never rewrites them, so the old value survives
  in every resource's `cr`/`int_cr` and in that ACP's `privileges`. Without the
  migration the new admin cannot modify the default ACP through the standard path.
  The migration is one transaction and is idempotent.

- **The administrator's privileges now come from an `<accessControlPolicy>`.**
  `cse/hostingCSE.js` used to grant the identity in `cse.admin` every operation
  before any policy was read. oneM2M has no such concept — privileges are expressed
  as `<accessControlPolicy>` resources — so `db/init.js` now creates an admin policy
  (`cb.admin_acp.rn`, default `cb_admin_acp`) granting `acop` 63, attaches it to the
  `<CSEBase>`, and the short-circuit is removed.

  **What changes for you.** The administrator now reaches a resource only through a
  policy that names it, or through the creator fallback when the resource carries no
  `acpi`. Two consequences are worth checking before upgrading:

  - A resource whose `acpi` names only the default policy is no longer deletable or
    updatable by the administrator: that policy grants `acop` 35 (create, retrieve,
    discovery) and nothing else.
  - A resource created by someone else with no `acpi` at all is governed by the
    creator fallback, and the administrator is not the creator.

  `db/migrations/v4.6.0.sql` creates the policy on an existing database and adds it
  to every resource that already carries an `acpi`. Resources with an **empty**
  `acpi` are deliberately left alone: giving them one would switch them from the
  creator fallback to policy evaluation, and their creator would lose the update and
  delete rights it has today.

  Also fixed while here: `create_cb` seeded the `<CSEBase>`'s `acpi` with the default
  policy and `create_default_acp` then appended it again, so the `<CSEBase>` listed it
  twice. New databases no longer do that, and the migration deduplicates existing ones.

## v4.5.1 (2026-08-02)

**Why PATCH**: none of the below adds oneM2M capability — it's regression test
coverage, a documentation update, and CI configuration.

- **Added regression coverage for the MQTT protocol binding.** Until now
  `bindings/mqtt.js` had zero automated tests. Six tests were added, backed by
  a dedicated test broker: `test/helpers/broker.js` spawns its own `mosquitto`
  instance on a free port for the duration of the run, so the suite never
  touches a developer's or CI's own broker — the broker itself is safe to run
  concurrently, though concurrent `npm test` runs still share the single
  `mobius4_test` database. `test/helpers/mqtt-onem2m.js` is a oneM2M-over-MQTT
  client helper used by the new tests.
- **`mosquitto` added as a test prerequisite.** Only the binary needs to be on
  `PATH` — the suite starts and stops its own broker itself, so, unlike
  running Mobius4 as a server, no running instance and no
  `mosquitto.conf`/listener configuration is needed. Documented in
  `test/README.md`.
- **CI**: `.github/workflows/ci.yml` installs `mosquitto` via `apt-get` before
  the test step (not as a service container — the suite already manages its
  own broker lifecycle, so a service container would just be a second, unused
  broker). The regression-count baseline (`BASELINE` in the same file) rose
  from 55 to 61 (36 from v4.4.0 + 19 for `<flexContainer>` + 6 for this MQTT
  coverage).
- **Corrected out-of-sync `package-lock.json` version fields (4.4.1 → 4.5.1).** The lockfile's `version` fields remained at 4.4.1 through the v4.5.0 release, mismatched with `package.json`. This release synced them to 4.5.1. This is a metadata-only change to version fields in `package-lock.json`; no dependency tree or installed packages changed.
- One test remains `todo`: whether CIN eviction should fire `net=4` (carried
  over from v4.4.0, see "Unresolved — pending spec clarification" above — no
  new `todo` test was added by this release).

## v4.5.0 (2026-08-02)

**Why MINOR**: `<flexContainer>` is a oneM2M resource type that did not exist
here before, and `db/migrations/v4.5.0.sql` is a backward-compatible schema
change. The rest is a bug fix and a dependency upgrade.

- **Added `<flexContainer>` (ty=28): CRUD and discovery.** The type was
  half-wired — `config/enums.js` already mapped `28: "flx"`, and `<container>`
  and `<subscription>` already accepted `flx` as a parent, but all eight
  dispatch sites in `cse/hostingCSE.js` were commented out. In that state a
  `ty=28` request fell through to a `ReferenceError` and no response was ever
  sent, the same failure mode as the unwired `ty=24`/`ty=34` entries.

  Three things about this resource type do not follow the pattern the other
  handlers use:

  - **The envelope key is not `m2m:`.** TS-0004:7.4.37.1 lets a specialization's
    XSD use a targetNamespace other than `m2m:`, so real payloads look like
    `{"sc:parkingBlock": {...}}`. The key is read generically from the request,
    stored on the resource (`flx.ek`), and replayed on RETRIEVE — nothing else
    in the record preserves it. The surrounding plumbing already read the
    envelope key generically, so only the handler needed changing.
  - **`stateTag` tracks custom attributes, not every update.** TS-0001:9.6.35 —
    "This *stateTag* attribute value shall be incremented when a custom
    attribute of the flexContainer is modified." `<container>` bumps `st` on
    every UPDATE; copying that here would be non-conformant. `contentSize` is
    recomputed on the same trigger (TS-0004:7.4.37.2.3 step 2b).
  - **`containerDefinition` is validated against a registry, not an XSD.**
    TS-0004:7.4.37.2.1 requires validating the representation against the schema
    named by `cnd` and answering `SPECIALIZATION_SCHEMA_NOT_FOUND` when that
    schema is unavailable. Fetching an arbitrary XSD on the CREATE path would
    add an external network dependency, so the contract is declared locally in
    `config/specializations.json`: an unregistered `cnd` is 4125, and an
    undeclared or mistyped custom attribute is 4000. That registry is its own
    file, read directly by `cse/specialization.js` rather than through the
    `config` package — it describes the deployment's information model rather
    than CSE settings, and it grows one entry per specialization, so adding one
    never touches `default.json`. A missing or unparseable file is not fatal:
    the CSE starts, logs a warning, and rejects every `cnd` with 4125.

  `[customAttribute]` values live in a single `custom` JSONB column — the
  attribute set is defined by whatever `cnd` points at and is unknown at
  schema-design time, so it cannot be modelled as columns. A GIN index keeps
  them queryable.

  **Not included: `<flexContainerInstance>` (ty=58)**, and therefore no
  `<latest>`/`<oldest>` and no retention policy. TS-0004:7.4.37.2.1 step 3 makes
  instance creation conditional on a non-zero `mni`/`mbs`/`mia`, so `mni`, `mbs`
  and `mia` are rejected with 5001 rather than stored — storing them would
  report success for a retention policy that does not run.

- **Fixed requests hanging when a response status code had no HTTP mapping.**
  Each verb handler in `bindings/http.js` is an `if`/`else if` chain over known
  RSC values with no final `else`, so any unmapped code left the request with no
  response at all and the client blocked until its own timeout. Added a
  fallback that answers 500 and logs, mapped 4125 to 501 per TS-0009:6.3.2 (the
  same group as 4001/5001/5206), added the missing 501 branch to PUT, and turned
  a stray `if` into `else if` in the DELETE chain so the new fallback cannot
  double-send on a 2002.

- **Fixed outbound notifications double-encoding their payload, and upgraded
  `axios` 0.19.0 → 1.19.0.** An external contributor's automated PR upgraded
  `axios` to 0.21.2 to fix CVE-2021-3749 (ReDoS in axios's `trim` polyfill,
  real vulnerability, fixed upstream in 0.21.1). That exact bump broke 8
  notification tests. Root cause: `cse/noti.js`'s `http_noti` manually
  `JSON.stringify`'d the payload *and* set `Content-Type: application/json`.
  Axios's `transformRequest` changed between 0.19.2 and 0.21.2 — from 0.21.x
  onward, that header alone is enough to trigger a second `JSON.stringify` on
  data that's already a string, double-encoding the body. The receiver's
  `JSON.parse` then returns a string, not an object, so every notification
  field reads back `undefined`. Fixed by passing the plain object and letting
  axios serialize it once (matching the pattern already used correctly in
  `cse/reqPrim.js` and `cse/registree.js`), then upgraded all the way to the
  current `1.19.0` rather than stopping at the CVE-fix minimum — this
  repository's dependency-modernization plan already had that queued.
  `follow-redirects` (axios's own HTTP dependency) moved 1.5.10 → 1.16.0 as
  part of the same tree; `hasown` (pre-existing, shared via `get-intrinsic`)
  and `debug` (pre-existing, shared via `mqtt`/`sequelize`/etc.) each picked
  up a same-range patch bump as npm's resolver deduped them against axios's
  new transitive dependencies — neither changed its own declared dependency
  range.

## v4.4.1 (2026-08-01)

**Why PATCH**: none of the below adds oneM2M capability — it's CI
infrastructure, dependency cleanup, and Node 24 compatibility.

- **Introduced CI** — `.github/workflows/ci.yml`. Node 22/24 matrix,
  PostgreSQL 17 + PostGIS 3.6 service containers. (PR #9, #12)
- **Added `engines: { node: ">=22" }`** and a new `.nvmrc` = `24`. Support for
  22 is retained.
- **`config` 1.31.0 → 3.3.12.** `config` 1.x calls `util.isRegExp`, which Node
  24 removed, so the server **could not even start** on Node 24. 3.3.12 is the
  first version that replaced that call with `parent instanceof RegExp`, and
  the 2.x line ends at 2.0.2 and is still affected, so there was no smaller
  step available. No source changes were needed — this repository only uses
  config via `config.get(...)` and direct property reads.

  **⚠️ Caution**: config 1.x made nested properties non-writable, so a bad
  assignment was silently ignored; 3.x `Object.freeze`s arrays and wraps
  nested objects in a Proxy, so **assignment throws**. From now on, do not
  hand an object or array returned by `config.get()` straight to a library —
  any library that normalizes an options object in place will raise a runtime
  exception.
- **Removed 13 unused dependencies** — `fast-xml-parser` `shortid`
  `sync-request` `path-to-regexp` `query-string` `urlencode` `bson-objectid`
  `base-64` `debug` `morgan` `rdfxml-streaming-parser` `fs` `https`. `fs` and
  `https` are shim packages that share a name with Node built-in modules, so
  there was no code path that would ever load them. `pg-hstore` (loaded by
  sequelize at runtime) and `pino-roll` (a transport target string at
  `logger.js:53`) have zero `require`s but were kept. (PR #10)
- **Pinned the test reporter to `--test-reporter=tap`.** Node 24 changed the
  default reporter for `node --test` from tap to spec, which broke the
  `not ok … # TODO` / `ok … # TODO` reading procedure documented in
  `test/README.md` on Node 24.
- Removed 3 tracked `.DS_Store` files and added them to `.gitignore`.
- **Removed the unreachable DAS/`jose` dead code.** `parse_dynamic_auth_resp`
  (`cse/hostingCSE.js`) read `config.das.private_key`, but `das` was never
  defined anywhere in `config/default.json` or `config/local.json`
  (`config.has('das') === false`), so the call threw `TypeError` before
  `jose.JWE.decrypt` was ever reached — on both Node 22 and Node 24. The
  function was called from nowhere and exported nowhere; the DAS (Dynamic
  Authorization Server) integration never had a working path. Removed the
  function, the `jose` dependency (its only call site), and the file-local
  `axios` `require` (its only use in this file — the `axios` package itself
  is still used by `noti.js`, `reqPrim.js`, and `registree.js`). Dropped
  rather than upgraded a 5-major-version-behind dependency for code that
  never worked. (PR #14)
- **Updated README.md and docs/installation.md** (Windows/macOS/Linux) to
  reflect that both Node 22 and 24 are supported. (PR #15)

## v4.4.0 (2026-07-26)

**Why MINOR**: the `net=4` notification and the `lvl` filter are **oneM2M
capabilities that did not exist before** (not bug fixes). This release also
includes `db/migrations/v4.4.0.sql` (a backward-compatible schema change).

**Summary**

| Category | Contents |
|---|---|
| Capability added | `net=4` (Delete of Direct Child Resource) notification, `lvl` (level) filter criteria |
| Bug fixes | 3 paths where discovery silently returned wrong results |
| Dev infrastructure | New test harness (0 tests → 36 tests) |
| Schema | `db/migrations/v4.4.0.sql` |

**⚠️ Behavior changes — visible to existing clients**

- **Discovery failures no longer masquerade as success.** Until now, a failure
  such as a SQL error still produced an empty list and RSC 2000. It now
  produces 5000 (or 5001 for an unimplemented parameter). This makes "no
  results" distinguishable from "failed," but code that expected 2000 is
  affected.
- **`gmty` is now range-checked.** Outside the valid range in the
  specification (1..6) it is 4000; inside the range but 4–6, which mobius4
  does not implement, it is 5001. Previously it was silently ignored.
- **`lvl` actually works now.** Previously it was only parsed and validated,
  never applied to the results. If any code sends `lvl` while relying on
  getting the full result set back, its result set will shrink.
- **Name matching in discovery and deletion is now exact.** Fixed resources
  with `_` in their name pulling in their siblings — previously, querying for
  `a_c` also returned the descendants of `abc`.


### New test harness (2026-07-25, branch `test/harness-foundation`)

This repository **has tests for the first time**. Until now `npm run
test:basic` was an `echo "Error: no test specified" && exit 1` stub and
`devDependencies` was an empty object.

**What was added**

- `test/` — an HTTP black-box regression suite built on Node 22's built-in
  `node:test`. **25 tests** (19 pass / 0 fail / 6 todo), about 15 seconds.
  - `test/helpers/server.js` — the tests **start mobius4 directly as a child
    process**. Configuration is injected through the `NODE_CONFIG` environment
    variable so it uses a dedicated DB (`mobius4_test`) and OS-assigned dynamic
    ports (one each for HTTP and HTTPS). This is safe even while a development
    instance is running on 7599. Startup completion is detected by receiving
    the `process.send('ready')` that `mobius4.js` emits over `ipc`.
  - `test/helpers/onem2m.js` — a oneM2M HTTP client. Each test creates its own
    unique root under `<CSEBase>` and deletes only that subtree when it
    finishes.
  - `test/helpers/noti-sink.js` — a notification receiver for a subscription's
    `nu` to point at.
  - `test/protocol.test.js` · `test/discovery.test.js` · `test/notification.test.js`
- `package.json` — added `scripts.test` (`node --test --test-concurrency=1 'test/**/*.test.js'`)
  and removed the `test:basic` stub.
- `test/README.md` — prerequisites (`createdb mobius4_test`) and how to read
  the results.

**What was deliberately not done**

- **Not a single new dependency was added.** Everything needed is built into
  Node 22 (`node:test`, `node:child_process`, `node:http`, `node:net`, global
  `fetch`).
- **Not a single line of existing source was modified.** The new `test/`
  directory and one `scripts` line in `package.json` are the whole change.
- No files were added under `config/`. Test configuration is injected through
  environment variables at run time (`config/test.json` does not work because
  `config/local.json` overrides it, and `config/local-test.json` cannot be
  committed because it is covered by `.gitignore`).

**Behavior the current suite pins down** — the following works today, and a
future change that breaks it will fail the tests.

| Area | What is pinned |
|---|---|
| Protocol | Response code arrives in the `X-M2M-RSC` **header** with no `rsc` in the body / create 2001, retrieve 2000, delete 2002, update 2004 / `con` round-trips as a JSON object / `<CSEBase>` cannot be DELETEd (4005) / fanout responses use the `{"m2m:agr":{"rsp":[…]}}` envelope |
| Discovery | `fu=1` returns everything / `ty` and `lbl` filters / `cra` and `crb` (`YYYYMMDDThhmmss`) / **everything is returned when `lvl` is unspecified** |
| Notification | `net=1` (update), `net=2` (deletion of the subscribed-to resource), `net=3` (creation of a direct child) fire / `enc.chty` filter / notification envelope (`sur`, `nev.rep`, `nev.net`) / **a subscription with only `net=[3]` set sends no notification on CIN deletion** |

### `lvl` (level) filter criteria applied (2026-07-26)

**Implemented.** Until now `lvl` was only parsed and validated, never applied
to the query, so a request would answer successfully with RSC 2000 while
**silently discarding the filter** and returning resources at every depth.

**Change**: one place in `cse/hostingCSE.js` — immediately after the `sid`
prefix condition in the discovery WHERE clause.

**Specification basis**: oneM2M `TS-0001:8.1.2` — *"The maximum level of
resource tree that the Hosting CSE shall perform the operation starting from
the target resource… The level of the target resource itself is zero and the
level of the direct children of the target is one."* That is, `lvl` is a
**depth relative to the target**. The same clause also states that there is no
depth limit when it is unspecified.

**Three points that needed care during implementation:**

- **Relative → absolute conversion.** The stored depth is an absolute value
  starting from `Mobius`=1, so the target's absolute depth has to be added to
  turn it into an upper bound. Omitting this conversion **happens to be correct
  only at the top of the tree and is wrong at lower nodes.**
- **The `lookup.lvl` column cannot be used.** Discovery does not query
  `lookup`; it queries the per-type tables (`cnt`, `cin`, `acp`…) individually,
  and those tables have no `lvl` column. Instead, the depth is counted in SQL
  from `sid`, which is common to all type tables
  (`array_length(string_to_array(sid,'/'),1)` — verified to match
  `sid.split("/").length` exactly for every sid).
- **Filter in the SQL WHERE clause.** Filtering in the application after the
  query would let `lim` (default 200) apply first, so deep nodes fill the quota
  and the shallow results actually wanted get truncated away.

**Side effect (intended)**: `rcn=4/8` nested retrieval goes through the same
path, so it now honors `lvl` as well. That matches `TS-0001:8.1.2` specifying
`offset`, `limit`, and `level` as one group.

**Known deviation**: `lvl=0` is rejected by `min(1)` in `prim_schema.js` and
becomes 4000. The specification says "the target resource itself is level 0,"
but discovery (`fu=1`) does not return the target itself, so `lvl=0` would be
an empty result anyway. A schema change was left out of scope.

**No conformance test**: a review of the entire ATS found not a single test
case that sets `level` (the templates all `omit` it). It is not required for
TTA or oneM2M certification, and the only automated verification is the 5
regression tests in this repository.

**Tests**: 5 in `test/discovery.test.js` (`lvl=1`, `lvl=2`, relative depth,
`lvl` + `ty` AND, unstructured-ID addressing).

### `net=4` (Delete of Direct Child Resource) notification implemented (2026-07-26)

**Implemented.** The comments in `cse/noti.js` had long claimed support for
`net` 1–4, but there was in fact no branch for 4; code and comments now agree.

**The structural cause** was that `check_and_send_noti()` looks up
subscriptions only by `pi === req_prim.ri` (children of the operation target).
That lookup is sufficient for net 1, 2, and 3, but for net=4 the operation
target is the **child being deleted** while the subscription sits under the
**parent**, so the lookup key did not line up.

**Change**: one file, `cse/noti.js`. Added
`notify_parent_of_child_deletion(deleted_pc, deleted_ty)` and call it at the
entry of `check_and_send_noti`. `delete_a_res`, `cin.js`, and `hostingCSE.js`
were **left untouched**.

Three points that needed care during implementation:

- **It has to come before the early return.** `check_and_send_noti` returns
  immediately when the operation target itself has zero subscriptions, and
  there is usually no subscription under a `<contentInstance>`. Putting the
  net=4 handling after that point would mean it never runs in the primary use
  case.
- **Fire the resource's own subscription lookup first.** `delete_a_res` runs
  notification and cascade deletion concurrently, so if the SELECT for the
  resource's own subscriptions is pushed behind the net=4 lookup,
  `delete_resources`'s `SUB.destroy` arrives first and **that resource's net=2
  notification silently disappears.**
- **Isolate net=4 failures.** A `.catch` prevents a broken parent subscription
  (a bad `nu`, for example) from also killing the deleted resource's own
  net=1/2/3 notifications.

**Specification basis**: oneM2M `TS-0004:6.3.4.2.19` (`4 =
Delete_of_Direct_Child_Resource`), `TS-0004:7.5.1.2.2` Step 1.0 (the
`childResourceType` filter follows the same rule as net=3; with no filter it
fires for every child type / when `notificationEventType` is unset the default
is `Update_of_Resource`), and Step 2.1 of the same clause (the notification
content is the representation of the **child** resource). The conformance test
is `TC_CSE_SUB_DEL_003`.

**Implementation scope — direct DELETE only.** The two below were
**deliberately excluded**.

| Deletion type | Behavior | Reason |
|---|---|---|
| Direct DELETE | **Notifies** | In conformance test scope, specification is clear |
| CIN eviction (`mni`/`mbs` exceeded) | Does not notify | Excluded by the `int_cr_req !== true` guard — see below |
| Cascaded descendants (deleted along with the parent) | Does not notify | `delete_resources` does not call the notification function (existing behavior preserved) |

**⚠️ Open question**: in oneM2M standardization discussion, **indirect
deletion** (a deletion that occurs as a side effect of deleting a different
resource) has been treated as not raising a notification event. Cascaded
descendant deletion falls under this. **Whether CIN eviction is included needs
confirmation** — what triggers eviction is CREATE, not DELETE, so taken
literally it does not qualify. It was excluded conservatively pending
confirmation, and the regression test is left as `todo` to keep the question
visible.

The answer determines the nature of the problem where **collected data
disappears without notification once `mni` is exceeded** — either it is
correct per the specification, or it is a defect that still stands.

**Tests**: 6 in `test/notification.test.js` (firing, `nev.rep` content, `chty`
in both directions, no firing at the grandparent, no notification on cascade).
The 1 eviction test is kept as `todo`.

### Fixed 3 paths where discovery silently returned wrong results (2026-07-26)

These are three different bugs, but the symptom had the same character —
**they returned wrong results silently, without raising an error.**

**1. A bad `gmty` disabled the scope restriction entirely** (silently too much)

The contract of `set_where_clause` is `{ where, has_geo_query }`, but two
`default:` cases in the geo-query branch exited with `return where;`. Since the
caller destructures, `where` became `undefined`, and
`findAll({ where: undefined })` returns **the entire table with no
conditions** — the `sid` condition that narrows to the target subtree
disappears along with everything else. Joi was constraining `gsf` to 1..3, but
`gmty` had no range validation, so `?fu=1&gmty=9&gsf=1&geom=[1,2]` reached it.

It was fixed in two layers — the contract was corrected so that the `sid`
restriction survives even in the worst case, and range validation against the
specification (`TS-0004:6.3.4.2.74` — 1..6) was added for `gmty`.

**2. Discovery failures masqueraded as success** (silently nothing)

The `fu1_discovery` call swallowed exceptions and only logged them, so an
**empty list + RSC 2000** went out even when the SQL failed. This defect had
already cost something — during the `lvl` implementation, a wrong WHERE
condition surfaced as an empty result rather than an error, which delayed
diagnosis. It was **a defect that hides other defects**.

**3. LIKE wildcards were not escaped** (silently the wrong thing)

The `_` in a `sid` prefix matched any single character in SQL LIKE, so
querying for `a_c` also returned the descendants of `abc`. Underscores are
common in resource names — the entity instance container in the Part 3
standard has the form `{modelId}_{version}_{instanceId}`, and the default ACP
is `cb_default_acp`. It was fixed in **both places: discovery and the
descendant collection in `delete_a_res`** (on the deletion side, over-matching
means deleting someone else's resources).

**Tests**: 5 added (scope preserved, `gmty` code, failure is not 2000,
underscore discovery, underscore deletion). All of them were **confirmed to
fail before the fix**, and then fixed.

### Other findings from verification (not fixed, no tests)

- **Descendant deletion in `delete_a_res` is fire-and-forget.** It calls
  `delete_resources(child_res_list)` without `await` (unchanged since the
  initial commit — not a regression). This creates a brief window in which
  descendants still exist at the moment DELETE returns 2002, and if the process
  dies during that window, orphans remain. The descendant deletion itself
  completes correctly if given time (confirmed by measurement).
- **There is a line that looks like a typo in the semantic discovery branch of
  `cse/reqPrim.js`** — `resp_prim.rsc = { "m2m:dbg": ... }` assigns to `rsc` a
  second time (it should be `pc`). It was out of scope this time and was left
  alone.

### Confirmed resolved (upstream)

- ~~Retrieving an orphaned resource by `ri` never terminates the response~~ —
  resolved by changing `return;` to `return resp_prim;` in `cse/reqPrim.js`.
  Reproduction attempt on 2026-07-26: infinite wait → **response in 10ms**.
