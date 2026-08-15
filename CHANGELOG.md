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

## v4.16.0 (2026-08-16)

**Why MINOR**: `<timeSeries>` and `<timeSeriesInstance>` are oneM2M resource types that did
not exist here before, and `db/migrations/v4.16.0.sql` is a backward-compatible schema
change (two new tables, nothing altered). Both are MINOR triggers by the table above.

### Added `<timeSeries>` (ty=29) and `<timeSeriesInstance>` (ty=30): CRUD, retention, and the first layer of missing-data detection

`TS-0001:10.2.4.20` draws the line between `<timeSeries>` and `<container>` in one sentence:
"similar in function to `<container>` and `<contentInstance>`, however a `<timeSeries>`
provides missing data detection." Until now this CSE had no way to notice that a periodic
sensor stopped sending — data loss was silent.

What a client can do with this release:

- Create a `<timeSeries>` with a retention policy (`mni`/`mbs`/`mia`, same semantics as
  `<container>`) and read it back with `mdd`/`mdc` (missing-data-detect flag and current
  count) always present in the response, per `TS-0001:9.6.36`.
- Create `<timeSeriesInstance>` children under it (`TS-0001:9.6.37`); `dataGenerationTime`
  (`dgt`) is enforced unique among siblings, and retention eviction removes the instance with
  the oldest `dgt` first when `mni`/`mbs`/`mia` is exceeded (`TS-0001:10.2.4.25`).
- UPDATE on a `<timeSeriesInstance>` is refused — `TS-0001:10.2.4.27` says the operation does
  not apply to this type — and DELETE on the `<timeSeries>` itself stops the detection
  timers, per `TS-0001:10.2.4.24`.
- Retrieve `<latest>`/`<oldest>` virtual children, ordered by `dataGenerationTime` rather than
  arrival order — `<container>` orders by insertion (`stateTag`), but a `<timeSeries>` has no
  `stateTag` at all (absent from both attribute tables) and the data's own timestamp is the
  more meaningful axis for a time series.
- Set `periodicInterval`/`missingDataDetect` and get missing-data detection running: a
  periodic sweep (gated the same way the existing expired-resource cleanup is, so only one
  CSE instance runs it) computes the detection arithmetic of `TS-0001:10.2.4.29` and records
  missing points into `missingDataList`/`missingDataCurrentNr`, pushing out the oldest entry
  once `missingDataMaxNr` is reached. Toggling `missingDataDetect` clears and restarts the
  list, per `10.2.4.29`'s pause/resume rule. Changing `missingDataDetectTimer`,
  `missingDataMaxNr`, `periodicIntervalDelta` or `periodicInterval` while detection is paused
  also clears the list, per the same clause's addition to `10.2.4.23`'s "Processing at
  Receiver" row — and `10.2.4.23`'s **Exceptions** row requires an error instead of a clear when
  detection is running, which this release now returns (`BAD_REQUEST`) rather than clearing and
  continuing.

What it cannot do yet: **nothing subscribes to it.** `10.2.4.29` also defines a
`<subscription>`-side reporting path — a `missingData` condition in
`eventNotificationCriteria`, `notificationEventType=8`, a per-subscription window timer — and
none of that is built. `cse/noti.js` still only knows event types 1 through 4, so an AE has no
way to be told about a missing point short of polling `missingDataList` itself.
`TP/oneM2M/CSE/TS/003` through `005` (the notification test purposes) are consequently not
covered, and neither is the fuller TS-0018 DMR parameter-expansion catalogue for these two
types (67 for `_TS`, 6 for `_TSI` by our own count of the corpus) — this release carries over
one representative test purpose per CRUD operation, not the full set, since most of the rest
exercise addressing/filtering/`rcn`/error-code paths already covered by other resource types.
The feature inventory (`mobius4-dev-tool` `features/inventory.yaml`) accordingly records this
as partial (⚠️), not complete.

## v4.15.1 (2026-08-15)

### Discovery and `rcn=4`/`rcn=8` return child resources newest first — and in a fixed order

Reading a `<container>` used to hand back its **oldest** `<contentInstance>`s, so `lim=20` on a
sensor with a year of history returned twenty readings from a year ago. Nothing in the spec asked
for that: `TS-0001:8.1.2` gives *filterCriteria* a `limit`, an `offset` and
`createdBefore`/`createdAfter` but no sort condition, and neither TS-0001 nor TS-0004 states the
order of a result at all. It was an accident of the query — the per-type `SELECT` had a `LIMIT`
and no `ORDER BY`, and an unordered sequential scan follows physical row order.

`ORDER BY` was missing, not merely unsorted, and that is the part worth calling a bug: **a `LIMIT`
without an `ORDER BY` does not fix which rows come back**, only how many. Two requests with
different `ofst` could therefore skip a resource or return one twice, even with nothing writing in
between. Discovery is a snapshot, but it was not even a consistent one.

`<contentInstance>` is ordered by `stateTag` first, then `creationTime` — the key
`<latest>`/`<oldest>` and the eviction algorithm already use, so the three can no longer disagree
about which instance is the newest. `stateTag` is what makes the ordering exact: `creationTime`
has a one-second resolution (`TS-0004:6.3.3`), and a sensor writing at 10 Hz produces ten
instances that share one.

Every other type orders by `creationTime` alone. `stateTag` deliberately does not apply to them:
for `<container>` and `<flexContainer>` it counts the resource's *own* updates, so ordering by it
would put a busy container created last year ahead of one created this morning.

**Two siblings that are not `<contentInstance>`s and were created inside the same second are not
ordered by age, because nothing recorded says which is younger** — `creationTime` is the finest
age this CSE keeps and no table carries an insertion sequence. They fall in `sid` order, which is
name order: arbitrary with respect to age, but predictable, and the same sequence every time. The
sequence has to be total whatever it is, since `ofst` indexes into it.

**What to do about it:** [docs/upgrading.md](docs/upgrading.md#v4151).

## v4.15.0 (2026-08-15)

Two unrelated bodies of work land together here, because the administrator change below was
already on `master` unreleased when the AI/ML work was cut.

oneM2M's TR-0071 (Technical Report on AI/ML enablement) describes seven candidate resource
types — `<modelRepo>`, `<mlModel>`, `<modelDeploymentList>`, `<modelDeployment>`,
`<mlDatasetPolicy>`, `<dataset>`, `<datasetFragment>` — and this CSE has carried code for all
seven since its first commit, unreleased-note and untested. This release is the first time
they were put in front of a capability probe, a conformance test suite derived from TR-0071
itself, and a client that actually trains and serves a model through them end to end. All
three surfaced real defects; most of what follows is fixing what they found.

### ⚠️ The administrator bypasses access control again

_This section landed on `master` as #41 before the AI/ML work merged; it is released here._

v4.6.0 removed the short-circuit in `cse/hostingCSE.js` that granted `cse.admin` every
operation before any `<accessControlPolicy>` was read, and replaced it with an admin policy
(`cb.admin_acp`) granting `acop` 63. The reasoning still holds — oneM2M has no superuser
identity, privileges are `<accessControlPolicy>` resources and nothing else — but the
replacement does not cover the case that matters most in operation.

A resource created with no `accessControlPolicyIDs` is governed by the creator comparison
(Case D in `access_decision`). The admin policy is never consulted for it, because the
resource names no policy at all. So an AE that creates a `<flexContainer>` or `<container>`
without an `acpi` owns it outright, and the administrator gets 4103 on RETRIEVE, UPDATE and
DELETE alike.

What makes that worse than a bad default is that **there is no request that repairs it**. The
obvious fix — attach the admin policy to the resource — goes through the `acpi` branch of
`access_decision`, which decides by reading `selfPrivileges` off the policies the resource
already names. A resource with an empty `acpi` names none, the loop body never runs, and the
UPDATE is refused for every originator including the creator. `db/migrations/v4.6.0.sql`
deliberately leaves such resources alone, so an upgraded deployment keeps producing them.
Recovery meant writing to the `acpi` column in PostgreSQL by hand.

The short-circuit is therefore restored, at its original position and with one addition: it is
guarded on `cse.admin` being set. `fr` is `undefined` on a request carrying no `X-M2M-Origin`,
and an unset admin identity would otherwise match every anonymous request — `config/validate.js`
already refuses to start without `cse.admin`, so this is unreachable in a running CSE, but the
cost of being wrong is total.

**This is non-conformant, deliberately.** Everything v4.6.0 said about the value remains true
and matters more now, not less: whoever sends `cse.admin` as `X-M2M-Origin` has full control of
the CSE over plain HTTP, on every resource, regardless of policy. It is a credential. The
startup refusals from v4.6.0 (no default, `SM` rejected, `Superuser` warned) are unchanged, and
so is the admin `<accessControlPolicy>` — it is still created and still evaluated for anyone
else named in it; it is simply no longer the only way the administrator gets in.

Nothing is required to upgrade. No DB migration, no configuration change. Deployments that
worked around the v4.6.0 behaviour by naming `cb_admin_acp` in every resource's `acpi` can stop
doing so, but nothing breaks if they do not.

Pinned by `test/access-control.test.js` — "the administrator gets through a policy that grants
it nothing", "the administrator gets through the creator fallback of a resource it did not
create", and "the creator fallback still governs everyone else", the last of which is what
would notice if the restoration had widened access for anybody but the administrator.

### ⚠️ Breaking, but only where the two new descriptor attributes below are actually used: `<modelDeployment>` CREATE can now reject an incompatible deployment

If a `<mlModel>`'s `inputDescriptor` (`ipd`, new in this release — see below) names a required
input feature that the deployment's `inputResource` — when it resolves to a `<dataset>` — does
not supply, `<modelDeployment>` CREATE is now rejected with `5207 NOT_ACCEPTABLE`
(`cse/resources/dpm.js`, `create_a_dpm`). Before this release there was no such check at all.

This cannot affect anything already running. `inputDescriptor` did not exist before this
release, so no existing `<mlModel>` has one populated, and the check runs only when it is
present — an omitted `inputDescriptor` (every deployment created before upgrading, and any
created after upgrading that doesn't set one) skips the check exactly as before. The check is
also narrower than "every deployment": it only fires when `inputResource` resolves to a
`<dataset>`, since that is the only resource type in this interface that declares a feature
list (`listOfFeatures`, `TR-0071:7.2.2.2`) to compare against — a plain `<container>` target,
which is most deployments today, is never checked.

### Fixed: five of the seven AI/ML resource types were unusable past CREATE

`features/capabilities.json` — this CSE's own probed record of what it answers, not a claim —
shows the before/after directly. Before this release: `<modelRepo>` CREATE always failed
(`db/init.js` created its table with a column named `mid`, copied from `<group>`, while the
Sequelize model in `models/mrp-model.js` had always called the same column `mmd_list` — every
INSERT referenced a column that did not exist), which also made `<mlModel>` unobservable since
it had no parent to attach to. `<modelDeployment>` and `<mlDatasetPolicy>` supported CREATE
only. `<dataset>` and `<datasetFragment>` were unobservable outright. Two defects caused this:

1. **The `<modelRepo>` schema mismatch above** — fixed in `db/init.js` for new installs;
   `db/migrations/v4.15.0.sql` renames the column for existing ones.
2. **Five retrieve handlers refused the resource's own creator.** `<mlModel>`,
   `<modelDeployment>`, `<mlDatasetPolicy>`, `<dataset>` and `<datasetFragment>` were, alone
   among this CSE's resource types, missing the branch that tells `access_decision` who
   created a resource when it has no explicit `acpi` — which is true of every AI/ML resource
   created through the normal flow. The result was `RSC 4103`: a client could create its own
   `<mlModel>` and then be refused permission to read it back. Fixed by adding the same
   `int_cr_req` branch every sibling handler (`<modelRepo>`, `<modelDeploymentList>`) already
   had.

After both fixes, `features/capabilities.json` shows full CRUD on `<modelRepo>` through
`<mlDatasetPolicy>`, and RETRIEVE/DELETE on `<dataset>`/`<datasetFragment>` — their CREATE
stays CSE-internal only, per `TR-0071:7.2.3.2`/`7.2.3.3`, unchanged from before.

### Migration required: `<mlModel>`'s stored bytes, not its base64 text

`mlModelSize` (`mms`) used to measure the base64 *text* stored in `mmd.mmd` — base64 inflates
by 4/3, so `mms`, and the `currentByteOfModels`/`maxByteOfModels` budget it feeds, was
consistently about a third larger than the model actually is. `mmd.mmd` is now `BYTEA`:
`cse/resources/mmd.js` decodes on CREATE/UPDATE and re-encodes to base64 on RETRIEVE, so `mms`
falls out as the stored buffer's own length. `db/migrations/v4.15.0.sql` converts every
existing row's base64 text to the bytes it encodes (`decode(mmd, 'base64')`); a row whose
stored text is not valid base64 — never enforced before this release — fails the migration
outright rather than being silently decoded to garbage.

### Added, not part of any oneM2M specification: five `<mlModel>` attributes

`trainingDatasetID` (`tdi`, write-once), `inputDescriptor` (`ipd`), `outputDescriptor` (`oud`),
`preprocessingRef` (`ppr`) and `modelSignatureRef` (`msr`). **These are not in TR-0071 or any
oneM2M TS** — they are this project's own proposal, written up for standards contribution in
the development repository at `docs/tr-0071-revision-proposal.md` (section F). The short names
are provisional and not registered in `TS-0004`. All five are optional (0..1); an `<mlModel>`
that sets none of them behaves exactly as before, including the deployment check above, which
only runs when `inputDescriptor` is present.

### Fixed: nine further implementation defects found while writing TR-0071 conformance tests and a proof-of-concept client

Building the first tests and the first real client for these resource types (a working linear
regression trained on synthetic sensor data, deployed, and run end to end — see
`docs/tr-0071-poc-report.md` in the development repository) is what found the following, none
of which were caught by any existing test because none existed for this interface before this
release.

**Guards `<mlModel>`/`<modelDeployment>` CREATE and UPDATE should have had and didn't:**
- `<mlModel>` CREATE accepted both `mmd` and `mmu` together, or neither, though
  `TR-0071:7.1.2.2` says they are mutually exclusive. CREATE now rejects unless exactly one is
  present. (BACKLOG-086)
- `<modelDeployment>` UPDATE stored an out-of-range `modelCommand` (anything outside 0/stop or
  1/run) silently and answered `2004 UPDATED` instead of rejecting it. (BACKLOG-091)

**Parent bookkeeping that never ran for these resource types:**
- Deleting an `<mlModel>` directly did not decrement its parent `<modelRepo>`'s
  `currentNumberOfModels`/`currentByteOfModels` — only the eviction path did, so the counters
  could drift upward and mis-trigger eviction later. (BACKLOG-088)
- `mmd`/`dts`/`dsf`'s Sequelize `ty` column defaults disagreed with `config/enums.js`'s type
  table (e.g. `mmd`'s default was 107, the number for `<datasetFragment>`, not 102). Every
  CREATE path sets `ty` explicitly, so this was latent, not user-visible — but a landmine for
  any future path that trusts the model default instead. `config/enums.js` now derives one
  table from the other so they cannot drift again. (BACKLOG-096)

**The live-dataset pipeline, which the proof-of-concept found was the least finished part of
this interface:**
- A single undefined variable (`dsp_ri` referenced outside the callback scope that defines it)
  meant `<mlDatasetPolicy>` CREATE for a **live** dataset always threw and was reported as a
  generic `4000` — the entire live-inference path that `TR-0068`'s use case #7 depends on was
  unreachable, not merely buggy. (BACKLOG-092)
- A policy's own `datasetStartTime`/`datasetEndTime` were stored and echoed back on RETRIEVE
  but never consulted when building `<datasetFragment>`s — the CSE always used the full
  auto-detected source range instead, so narrowing the window had no effect. (BACKLOG-093)
- `<dataset>` (`ty=106`) was missing from the set of resource types a `<subscription>` can
  target, so the notification path `TR-0071:7.2.2.1` describes ("newly created inference input
  data can be ... notified with subscription") could not be used at all. (BACKLOG-094)
- Internally created `<datasetFragment>`s (live or historical) never triggered a CREATE
  notification, because the code that creates them calls the resource layer directly instead
  of going through the function that fires notifications. Found and fixed in the same pass as
  the two defects above; the same gap on `<dataset>` itself is still open (BACKLOG-097).
- The live dataset path never applied `nullValuePolicy`: each `<datasetFragment>` row came from
  a single MQTT notification (one source's attribute), so a live policy merging more than one
  source could never produce a row with more than one source's feature filled in — found by
  running the proof-of-concept's live loop against real sensor data. Live fragments now share
  the same forward-fill the historical path already had. (BACKLOG-101)

Known gaps this release does **not** close — deferred to spec discussion rather than fixed
outright, and each tracked in the development repository's `.claude/workspace/todo.md`:
`<dataset>` still does not inherit `custodian` from its `<mlDatasetPolicy>` (BACKLOG-089,
requires a schema change to a common attribute — out of AI/ML's own scope); direct client
CREATE of `<dataset>`/`<datasetFragment>` is still open, guarded only by a source comment
saying "temporary for testing" (BACKLOG-090); `<mlModel>` eviction's same-second tie-break is
effectively random (BACKLOG-095); and `<dataset>` creation itself (as opposed to the fragments
inside it) still bypasses CREATE notifications (BACKLOG-097).

**Why MINOR** — the table above lists "backward-compatible DB migration" on its own as a MINOR
trigger, and `db/migrations/v4.15.0.sql` is exactly that: every statement in it either affects
columns no release has ever stored live data in (the `mrp`/`mdp`/`dts` list columns, and the
`<modelRepo>` CREATE that was broken until this same release) or converts existing rows in
place. Separately, the five `<mlModel>` attributes above are a genuine schema addition, even
though they are not a oneM2M-standard capability. Everything else in this entry — the
`5207` compatibility check and the defect fixes — would be PATCH on its own (bug fixes adding
no new capability), but they ship in the same commit as the migration and the schema addition,
so the release as a whole is MINOR.

The administrator change is the one that looks like it should force MAJOR and does not. The
table reserves MAJOR for a "compatibility break requiring manual intervention", and this
requires none: no migration, no configuration change, and a deployment that worked around the
v4.6.0 behaviour keeps working untouched. It widens what one already-privileged identity can
do; it takes nothing away. That is why it sits here rather than in a 5.0.0.

## v4.14.0 (2026-08-11)

### ⚠️ Breaking for clients that compute `ofst` themselves: the offset filter is 1-based

`TS-0004:7.3.3.17.15` says it outright — "An **offset of 1** shall indicate the **first** direct
child resource" — and `TS-0001:8.1.2` agrees: "The offset shall start at 1". mobius4 instead read
`ofst` as a count of results to skip, so `ofst=1` returned the *second* result onward. Since the
request schema also rejects `ofst=0`, the two together left **the first result unreachable by any
legal value** — a client that wanted it had to omit `ofst` entirely.

`X-M2M-CTO` (Content Offset) moves with it, since `TS-0001:8.1.3` makes it the same filter
condition travelling back. Every value the CSE emits is therefore one higher than before. That
also fixes a case where the round trip was not merely off by one but invalid: for `rcn=4`/`rcn=8`,
`X-M2M-CTO` could be `0`, and echoing it back — the usage
[docs/upgrading.md](docs/upgrading.md#v4100) tells clients to prefer — was answered with 4000.

**If your client echoes `X-M2M-CTO` back as `ofst`, nothing changes for you.** If it computes
offsets by adding `lim` to a counter, it now overlaps by one result per page rather than paging
cleanly. Overlap, not a gap — the same result arrives twice instead of being skipped — so a client
that keys on resource ID recovers on its own.

Both readings are present in the specification, in the same clauses; the contradiction is recorded
as SQ-005 in the development repository and DEC-078 held the old reading pending its resolution.
It is settled in favour of the explicit statements, because a skip-count reading makes "shall start
at 1" false and cannot address the first result at all (DEC-096).

### Fixed: an expired `<subscription>` no longer publishes notifications

Reported from a client that creates `<subscription>` resources for monitoring and sets a short
`et` as a lease, so that a crash cannot leave them behind: notifications kept being published for
the whole sweep interval — by default a day — to a target that had gone away. Measured on 4.13.1:
a subscription 2 minutes past its `et` still notified, still answered RETRIEVE with 2000, and was
still discoverable.

`TS-0004:7.5.1.2.2` does not name `expirationTime` among the steps of the notification procedure,
so this is not a clause being violated. It is `TS-0001:9.6.1.3.2` calling the resource **obsolete**
from the moment its `et` passes, and a notification being the one externally visible claim that a
subscription is live. The specification makes exactly this pairing elsewhere:
`TS-0004:7.5.1.2.6` gates aggregation on "while the `<group>` resource **has not expired**"
(DEC-094).

Both notification paths are gated: a subscription's own events (`net` 1/2/3) and the parent-based
`net=4` lookup. A subscription with no `et` is unaffected — that case is a test of its own, since
in SQL `et > now` is neither true nor false for those rows.

### Fixed: an obsolete `<contentInstance>` is no longer served as content

`TS-0001:10.2.4.4` treats a `<container>` whose content instances are all obsolete exactly like one
that has none — "there is no `<contentInstance>` resource in the parent **or if all existing ones
are obsolete**". `<latest>`, `<oldest>` and the `rcn=4`/`rcn=8` child list ignored `et` and served
them anyway.

This mattered more than the window suggests, because since 4.9.0 `maxInstanceAge` **is** enforced
by capping a `<contentInstance>`'s `et`. An obsolete instance is therefore precisely one that `mia`
has retired, so `<latest>` was returning content older than the `<container>`'s own `mia` allows —
`mia` was enforced on writes and ignored on reads.

`<latest>` and `<oldest>` now answer with the newest or oldest instance that is not obsolete, and
4004 when there is none. `cni` and `cbs` still count obsolete instances until the sweep removes
them; they are maintained by the write path and are not recomputed on read.

Deliberately unchanged: an obsolete resource is still retrievable at its own address and still
listed by `fu=1` discovery. `TS-0001:9.6.1.3.2` sets no deadline for the deletion, so neither is a
violation, and the reporting client uses discovery to find its own leftovers after a crash
(DEC-095). The whole boundary is tabulated in
[docs/configuration.md § expirationTime](docs/configuration.md#expirationtime).

### Fixed: the expired-resource sweep runs at startup

It was scheduled with `setInterval` alone, which first fires after a full interval. With the
default interval of one day and `restart: unless-stopped` in `docker-compose.yml`, a deployment
that restarts more often than daily **never swept at all** — and "expired resources are cleaned up
daily" was not a true statement about it.

A sweep now runs once at startup as well. It is not awaited, so readiness does not wait on it. The
first sweep after upgrading from a version that never swept can be large, since it is proportional
to what accumulated rather than to a day's worth.

### Fixed: internal error text no longer reaches the client in `m2m:dbg`

Reported as `RSC 5000` with `{"m2m:dbg":"column \"or\" does not exist"}` — a raw PostgreSQL message,
and with it a schema detail, going to an unauthenticated requester who can do nothing with it. The
5000 was correct (fixed in 4.11.0); the message was whatever the failing layer happened to say.

Unanticipated failures now answer with a fixed `"internal server error"`, while errors this code
raises deliberately for the client keep their message (`"unsupported geometry type"`, for
instance). The full error and its stack are logged with the request identifier, so an operator can
still tie a client's report to the cause.

### Removed: `docs/openapi.yaml`

The published OpenAPI document described two things at once — the shape the oneM2M standard
defines, and what this CSE actually answers — and nothing kept it honest. The drift check that
was supposed to guard it looked at the development repository's copy, not this one, so the
copy here stayed green while falling nine releases behind.

The two questions are now answered by two files. The standard-only document is generated from
the specification corpus and lives in the development repository at
`features/onem2m-standard.yaml`; it covers every resource type the standard defines, whether or
not any implementation exists. What this CSE supports stays here, in
[`features/capabilities.json`](features/capabilities.json), which is observed rather than
written down and is enforced by CI. Join the two on `operationId`.

This supersedes the sentence in the entry below that calls `docs/openapi.yaml` "the third
thing" — that was true when it was written, earlier in this same release cycle.


### Added: a format version on `features/capabilities.json`

The file is produced here and read by tooling in the development repository — it crosses a
repository boundary. Inside one repository a producer and its consumer change in the same
commit; across two they do not, so the consumer can meet a shape it was not written for. What
comes out of guessing at that point is not a crash but a plausible wrong answer: a supported
operation missing from the generated specification, or an unsupported one present. That is the
exact failure this file exists to prevent.

`formatVersion: 1` now names the shape, and the consumer refuses a version it does not know
rather than interpreting it. The version is part of the drift check too: bumping it in the
producer without regenerating would leave a file announcing a shape it was not written in.


### Added: a machine-checked record of what this CSE supports

Two files under `features/`, and a CI step that keeps the first one honest.

- **[`features/capabilities.json`](features/capabilities.json)** — what a running instance
  *answered*, not what anyone wrote down. `npm run probe-capabilities` starts an isolated
  instance on its own database, sends real requests and records the Response Status Codes;
  `npm run probe-capabilities -- --check` fails when the committed file no longer matches, and
  CI runs it on every change. It covers 9 resource types and 18 procedures — discovery filters,
  Result Content values, `<latest>`/`<oldest>`, group fan-out, notification delivery.
  Procedures that need a second CSE (registration, forwarding, fan-out to remote members) are
  listed with `supported: null` and the reason rather than left out: not having asked and having
  been told no are different facts.
- **[`features/support-matrix.md`](features/support-matrix.md)** — how far the implementation
  reaches across the standard, by functional area of the oneM2M test suite structure
  (TS-0018 clause 6.2), with the number of test purposes demonstrated by tests in this
  repository. Generated from the development repository's feature inventory; regenerate rather
  than edit.

The two answer different questions and neither replaces the README's prose: capabilities is
observation, the matrix is coverage. `docs/openapi.yaml` remains the third thing — the shape of
a request.

Because CI enforces `capabilities.json`, the probe's own judgement is load-bearing: if it
decides wrongly, CI enforces the wrong answer and the file looks exactly like a right one. The
decisions are therefore separated into `scripts/lib/capabilities.js` and covered by
`test/capabilities-probe.test.js` (11 tests). Writing those tests found two defects in the
probe before any of this was committed — a notification wait that could never match, so a
working feature was recorded as unsupported; and a missing `X-M2M-RSC` header being written as
`rsc: 0`, a status code that does not exist, sitting where a real refusal would be.

Test count 289 → 300.


### Fixed (tests only, no runtime change)

- **The two-CSE test helper hardcoded its database names.** `test/helpers/two-cse.js` used
  `mobius4_test_reg_a`/`_b`, so running both files that need it in one command —
  `node --test test/cse-registration-remote.test.js test/group-remote-members.test.js`, which
  is the natural thing to do — failed with
  `Key (datname)=(mobius4_test_reg_a) already exists`. `npm test` passes
  `--test-concurrency=1` and was never affected, but the failure read as the *feature* being
  broken rather than the fixture colliding. The names now carry the process id.

**Why MINOR** — by the table above these are bug fixes, which would make them PATCH: no resource
type, operation, filter condition or notification event type is added. But three of them change
what an existing client sees for a request it already sends. `ofst` shifts by one, `<latest>` can
return a different instance than it did yesterday, and a subscription that used to keep notifying
stops. As in v4.11.0, that is more than a bug fix from a client's point of view, and the version
number is where a client is entitled to see it.


## v4.13.1 (2026-08-08)

**Why PATCH** — a container could not be configured to do something it already
knew how to do. No new oneM2M capability, no schema change.

### Fixed: a containerised CSE could not register with another CSE

`cse/registree.js` reads `config.cse.registrar` (`cse_type`, `cse_id`,
`csebase_rn`, `ip`, `port`) to find the CSE it should register with.
`docker/entrypoint.js` assembles `NODE_CONFIG` from the environment and **that
block was missing entirely** — and because the entrypoint overwrites
`process.env.NODE_CONFIG`, it could not be injected from outside either. There
was also no `CSE_TYPE`, and `mobius4.js` only calls `registree()` when
`cse.cse_type` is 2 or 3, so a container could never be anything but a
standalone IN-CSE. Found on 2026-08-08 while building a two-CSE test
environment, which had to be run from source instead.

Six new variables, all optional — leave them out and the container is a
standalone IN-CSE exactly as before:

`CSE_TYPE`, `REGISTRAR_CSE_ID`, `REGISTRAR_CSE_BASE_RN`, `REGISTRAR_HOST`,
`REGISTRAR_PORT`, `REGISTRAR_CSE_TYPE`.

[`docker/compose.two-cse.yml`](docker/compose.two-cse.yml) is a working example
of an IN-CSE and an MN-CSE registering with each other, and
[docs/docker.md](docs/docker.md) explains the two settings that are easy to get
wrong (`CSE_SP_ID` has to match on both; `CSE_POA` has to be reachable from the
*other* container).

**Verified end to end, in containers** on 2026-08-08: the MN-CSE registered at
startup (`remoteCSE resource created on registrar` in its log, and the
`<remoteCSE>` retrievable on the registrar), and a `<container>` created on one
CSE was readable from the other by SP-relative address in **both** directions,
2000 each way.

The `NODE_CONFIG` assembly moved to `docker/node-config.js` so it can be tested
without the entrypoint's identity file, database connection and handover to
`mobius4.js`. `test/docker-node-config.test.js` covers it, including the rule
that matters most here: a variable that is not set must not appear in the output,
because `NODE_CONFIG` is merged *over* `config/default.json` and an empty string
does not mean "use the default".

Test count 282 → 289.


## v4.13.0 (2026-08-08)

**Why MINOR** — a new `<AE>` attribute (`ontologyRef`) with a backward-compatible
DB migration, plus group members on remote CSEs, which is an oneM2M capability
that did not work before.

### Conformance tests taken from TS-0018

The test purposes in TS-0018 (Test Suite Structure and Test Purposes) are what a
certification body judges an implementation against, so the tests here are now
transcribed from them rather than invented. Each test name carries the TP
identifier it implements and asserts that TP's *Expected behaviour*.

- `TP/oneM2M/CSE/REG/*` — registration. 24 cases in `test/cse-registration.test.js`
  (CF01, one CSE) and 22 in `test/cse-registration-remote.test.js` (CF04, two CSEs).
- `TP/oneM2M/CSE/GMG/*` — group management. 18 cases in
  `test/group-management.test.js` (CF01) and 7 in
  `test/group-remote-members.test.js` (CF02, member on another CSE).
- `test/helpers/two-cse.js` stands up an IN-CSE and an MN-CSE that register with
  each other, each with its own database, for the configurations that need two.

Test count 209 → 282.

Deliberately not implemented, and why, is recorded at the top of each test file.
The largest exclusion is everything that depends on service subscription
profiles and `<serviceSubscribedAppRule>` (the 4126 APP_RULE_VALIDATION_FAILED
cases) and on `<AEAnnc>` announcement: neither exists in mobius4 and neither is
planned.

### Fixed — found by those test purposes

- **`<AE>` rejected `ontologyRef`.** TS-0001 table 9.6.5-2 lists it as a 0..1 RW
  attribute; mobius4 had no column, no model field and no schema entry, so a
  registration carrying it was answered 4000 "or is not allowed". Adds the
  attribute across the resource (`db/migrations/v4.13.0.sql`).
- **An `<AE>` UPDATE silently dropped `contentSerialization`.** `update_an_ae`
  had a delete branch for `csz` but no set branch, so a client that changed it
  got 2004 and the old value stayed.
- **A group fanout with no members answered 2000 with an empty list.**
  TS-0004:7.4.14.2.4 requires NO_MEMBERS. Two things had to change: `fanout()`
  now distinguishes "no members" from "no responses", and `reqPrim` no longer
  overwrites the handler's status code with OK unconditionally — that assignment
  had been turning every refusal the fanout could make into a success.
- **Forwarded responses carried the Response Status Code as a string.**
  `responseStatusCode` is `xs:integer`; the HTTP header was passed through
  verbatim, so a group fanout aggregation held `2000` for a local member and
  `"2000"` for a remote one, and a client had to accept both spellings.

### Group members hosted on other CSEs

`memberType_validation` looked a member's `resourceType` up locally and nowhere
else. A member on another CSE therefore resolved to type 0 — indistinguishable
from a type mismatch — so the default consistency strategy (ABANDON\_MEMBER)
dropped it, and the group was still returned with `memberTypeValidated` = true.
Measured against two CSEs on 2026-08-08: a `<group>` created with one local and
one remote `<container>` came back with the remote one gone and claimed the
members had been validated.

The three outcomes TS-0004:7.4.13.2.1 defines are now distinguished, on CREATE
and on UPDATE alike:

| the member's type is | mobius4 now |
|---|---|
| readable (locally or by retrieving it from its Hosting CSE) | uses that type, then applies the consistency strategy |
| refused for lack of privilege | rejects the request, RECEIVER\_HAS\_NO\_PRIVILEGE |
| unreachable | keeps the member, sets `memberTypeValidated` to false |

Retrieval goes through the normal request path, so a member ID that is
SP-relative to a registered CSE is forwarded using that `<remoteCSE>`'s
`pointOfAccess`. Fanout to remote members works through the same path and was
verified end to end.

Two related fixes fell out of this: `memberTypeValidated` = false was being
stored as null and omitted from responses, because both places tested it for
truthiness. TS-0001:9.6.13 requires the attribute to be set whenever
`memberType` is not 'mixed', and false is precisely what an unvalidated group
has to report.

### Known specification inconsistency

`TP/oneM2M/CSE/REG/CRE/023` expects **4105 CONFLICT** when an AE re-registers
with an AE-ID-Stem already in use. TS-0004:7.4.5.2.1 names
**ORIGINATOR\_HAS\_ALREADY\_REGISTERED** for that exact check, and
TS-0001:10.2.2.2 step 004 says only "shall respond with an error". mobius4
follows TS-0004 and answers 4117. Recorded so that a failure on this TP in a
certification run is recognised as the known disagreement it is, not as a
regression.


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


## v4.12.0 (2026-08-08)

### Added — Result Content on DELETE

`TS-0001:8.1.2` Table 8.1.2-1 marks rcn **4** (attributes and child resources), **5** (attributes
and child resource references), **6** (child resource references) and **8** (child resources) valid
for Delete as well as Retrieve. The Originator is asking to be shown what is about to disappear,
which is the only chance to see it.

mobius4 accepted those values and then answered with the target's own attributes — the same as
rcn=1 — with nothing to say the request had been half honoured.

```bash
DELETE /Mobius/sensors?rcn=4&lvl=2
```

```jsonc
{"m2m:cnt": {"rn": "sensors", /* ... */
   "m2m:cnt": [{"rn": "humid01", /* ... */ "m2m:cin": [{"rn": "h1"}]},
               {"rn": "temp01",  /* ... */ "m2m:cin": [{"rn": "t1"}, {"rn": "t2"}]}],
   "m2m:sub": [{"rn": "sub-a"}]}}
```

The snapshot follows the same rules as the equivalent retrieve: descendants nest under their own
parent (`TS-0004:8.4.3` EXAMPLE 3), `lvl` bounds the depth, `lim` cuts on subtree boundaries, and a
truncated result carries `X-M2M-CTS`/`X-M2M-CTO`.

Unchanged: the default Result Content for Delete is still "nothing", rcn=1 still returns the
target's attributes alone, and rcn 2, 3, 7, 9, 10 and 12 are still refused as n/a for this
operation.

### Added — notifications reach the broker their URL names

A `<subscription>` whose `notificationURI` is `mqtt://…` was published through the one broker this
CSE is itself connected to, whatever host the URL named. The topic was right and the server was
wrong, which looks identical in the logs and delivers nothing.

Outbound connections are now opened per broker and reused, with `TS-0010:6.6.2`'s default ports
(1883 for `mqtt`, 8883 for `mqtts`) and `6.6.4`'s rule that the URL's path **is** the topic, whole.
A URL naming this CSE's own broker still goes through the existing client rather than opening a
second connection to it.

**Connections are kept warm.** Opening one per message would turn MQTT into a slower HTTP and
throw away the reason to use it, so a connection is opened on first use and stays. It is reclaimed
two ways, both slow enough not to disturb an active path: a connection that has carried nothing for
thirty minutes is closed, and at the ceiling of twenty a new broker evicts the least recently used
idle one. Nothing with a request in flight is ever closed. Reconnection is automatic, and any
response topic being listened on is re-subscribed, since MQTT subscriptions do not survive a
session.

### Added — forwarding to a `<remoteCSE>` over MQTT

A `pointOfAccess` of `mqtt://…` fell into an empty branch and out through an unconditional `OK`, so
**a request that was never sent anywhere was reported as having succeeded** (v4.11.1 made it an
honest failure; this release makes it work).

The request goes out on `TS-0010:6.4.2`'s request topic and the answer comes back on the matching
response topic of `6.4.3`, matched by `rqi` because one subscription carries the answers to every
request in flight to that CSE. That subscription is made once and left in place: subscribing per
request would cost two extra round trips each time, and — worse — two concurrent forwards to the
same CSE share the topic, so the first to finish would have unsubscribed the second. Identifiers are written into the topic as the clause requires — an
SP-relative ID drops its leading `/`, an Absolute-CSE-ID's leading `//` becomes `:`, and every
remaining `/` becomes `:`. A request that gets no answer within the timeout falls through to the
next `pointOfAccess`, and then to 5103 TARGET_NOT_REACHABLE.

**Why MINOR**: three oneM2M capabilities added — Result Content on an operation that lacked it, and
two MQTT paths that did not work. All additive: a client that does not use them sees no difference,
and nothing needs doing on upgrade. Deployments that never had a second broker are unaffected.

## v4.11.1 (2026-08-08)

A sweep of the `to-do` comments left in the source. Twenty-six of them; roughly half described
work that had already been done or was never true. Two of the ones that were still true turned out
to be silent wrong answers.

### Fixed — a forwarded response kept its status

The HTTP forwarding branch read `x-m2m-rsc` from the remote CSE into the response primitive and
then fell through to an unconditional `OK` at the end of the function. **A forwarded 4004 reached
the Originator as 2000**, with the remote CSE's error payload still attached — which is how it went
unnoticed. Any status a `<remoteCSE>` returned was replaced.

### Fixed — every pointOfAccess is tried, and an unreachable CSE says so

Only `poa[0]` was used. A `<remoteCSE>` advertising several access points became unreachable
through this CSE as soon as the first stopped answering. Each is now tried in turn, and when none
answers the response is **5103 TARGET_NOT_REACHABLE** (`TS-0004:6.6.3.6`) rather than a transport
error dressed as 5000.

A transport failure is the only reason to move on: an answer from the remote CSE, including a
4xxx, is the answer to that request and is passed back as it stands.

An `mqtt:` `poa` used to fall into an empty branch and out through the same unconditional `OK`, so
**a request that was never sent anywhere was reported as having succeeded**. It is now refused.
Implementing it needs the ability to connect to a broker other than this CSE's own, which is
tracked separately.

### Fixed — a generated resourceName is checked before use

`TS-0001:9.6.1.3.1` leaves the name to the Hosting CSE when the Originator does not supply one.
mobius4 generated a random name and used it without looking, so a collision surfaced as **4105
CONFLICT about a name the client never chose and could not change**. The name is now checked and
regenerated. Concurrent creates are still settled by the unique index — this removes the ordinary
collision, not the race.

### Changed — `<AE>` mandatory attributes are validated in one place

Two hand-written checks sat inside `create_an_ae`, one screen below the call that validates against
the Joi schema. One was unreachable (the schema already required `rr` and rejected it first); the
other, the App-ID `N`/`R` prefix rule of `TS-0001:7.1.2`, existed only there — so the schema a
reader checks first did not describe what the CSE enforced. Both now live in the schema. No
observable change.

### Removed

`cse/routing.js` — nothing required it, and its `request_forwarding` was an empty function. The
real forwarding lives in `cse/reqPrim.js`.

### Housekeeping

The remaining `to-do` comments carry the backlog number that tracks them, so a reader can find out
whether anyone is on it. Comments that described completed work were replaced with a description of
what the code does; one that read like a missing error path was measured, found correct, and
annotated with why it is fragile rather than deleted.

**Why PATCH**: bug fixes and one refactor. No oneM2M capability is added, no resource type or
operation changes, and no deployment needs to do anything.

## v4.11.0 (2026-08-08)

Five conformance and robustness defects reported from an external proof of concept (a TR-0079
oneM2M–ROS 2 interworking proxy), each reproduced against a live instance and checked against the
core specification. Four are fixed here; the fifth is diagnosed but not solved.

### ⚠️ `contentSize` values change

`contentSize` was reporting the JavaScript in-memory footprint of the content — `string.length * 2`
— rather than a byte count. `TS-0001:9.6.7` Table 9.6.7-2 defines it as "**Size in bytes** of the
content attribute".

| content | UTF-8 bytes | reported before | reported now |
|---------|-------------|-----------------|--------------|
| `"abc"` | 3 | 6 | 3 |
| `"0123456789"` | 10 | 20 | 10 |
| `"한글"` | 6 | 4 | 6 |
| `"가나다"` | 9 | 6 | 9 |

**This was breaking real requests, not just reporting.** A `<container>` with
`maxByteSizePerInstance` of 10 refused a 10-byte ASCII payload with 5207 NOT_ACCEPTABLE, because
ten characters counted as twenty. `currentByteSize`, `maxByteSize` and the `sizeAbove`/`sizeBelow`
filter conditions all read the same figure.

**What to expect on an existing deployment**: instances created before this release keep the old
`cs`, and their parent's `cbs` is the sum of those old values, so a container's `cbs` will be a
mix until its instances turn over. Retention limits (`mni`/`mbs`) are enforced against that mixed
figure. Nothing needs to be migrated — the numbers converge as content rotates — but a deployment
sitting close to a `mbs` ceiling may see eviction behave differently for a while.

Structured content is measured as its JSON serialization. Which serialization the standard
intends is genuinely undefined — the same resource has different sizes in JSON, XML and CBOR while
`contentSize` is one value — and that question stays open. What is settled is that the previous
figure was not a byte count under any reading.

### Fixed — a database failure is no longer reported as a missing resource

During a database outage, requests came back **4004 "target resource does not exist"**, for
resources that existed. Three lookup helpers caught their own query errors and returned the value
they also use for "no such row", so a failure to *read* the tree was reported as a fact *about*
the tree.

`TS-0004:6.6.2` Table 6.6.2-1 reserves 4xxx for "the request was malformed by the Originator" and
5xxx for "an error condition at the Receiver CSE"; `6.6.3.6` gives 5000 INTERNAL_SERVER_ERROR. The
distinction decides what a client does next — the reporting proxy treated 4004 as "it is not
there, create it" and tried to recreate live resources, leaving unique-constraint violations
behind, while a 5xxx would have been retried with backoff.

The same outage produced different codes on different paths. All four now answer 5000:

| path | before | now |
|------|--------|-----|
| resource lookup (`cse/hostingCSE.js`) | 4004 | 5000 |
| create (`cse/create-error.js`) | 4000 | 5000 |
| `<CSEBase>` retrieve (`cse/resources/cb.js`) | **4103 access denied** | 5000 |
| request handling (`cse/reqPrim.js`) | 5000 | unchanged |

### Fixed — `/health` is a readiness check

It reported only that the process was up. Compose already uses it as the container healthcheck, so
a container that had lost its database stayed `healthy` while failing every request — observed
lasting two and a half hours in the reporting deployment, ending only with a manual restart.

`/health` now reads one row from the `lookup` table and answers `503` with
`{"status":"unavailable","db":"unreachable"}` when it cannot. It reads a table rather than issuing
`SELECT 1` so that a reachable database with a missing or unmigrated schema also fails the check.

`db.pool.connectionTimeoutMs` is raised from 2000 to 5000, and `DB_POOL_MAX`,
`DB_POOL_CONNECTION_TIMEOUT_MS` and `DB_POOL_STATEMENT_TIMEOUT_MS` are now settable on the
container. v4.6.3 left this value alone on the grounds that no measurement showed it causing a
failure; this report is that measurement.

### Fixed — `<subscription>` sets `creator`, and notifications carry it

`TS-0004:7.4.8.2.1` (Recv-6.5, step 2): "If the _notificationURI_ is not the Originator, the
Hosting CSE **shall** set the Originator's ID as the `<subscription>` resource's _creator_
attribute." Only the explicit form was implemented — a request carrying `"cr": null` got the
Originator, and a request that simply omitted it got nothing.

`TS-0004:7.5.1.2.2` (step 2.1): "if the `<subscription>` resource instance has the _creator_
attribute, the Originator **shall** set the _creator_ element of the notification data object to
the value of the `<subscription>` resource's _creator_ attribute." `m2m:sgn` carried `nev` and
`sur` only, so a consumer could not tell which subscription had produced a notification — the
thing an interworking proxy needs in order to drop the echo of its own writes. (This is the
subscription's `creator`; the changed resource's own `cr` travels inside `nev.rep` and always
worked.)

Both are now implemented. When every `nu` names the Originator itself the clause does not apply
and `creator` stays unset.

### Fixed — `creator` cannot be set to another entity's identity

Found while implementing the above. A supplied `cr` was stored verbatim, and `creator` is defined
as "the AE-ID or CSE-ID of the entity **which created** the resource" (`TS-0001:9.6.1.3.2`) — not
a field a requester fills in freely.

It was a privilege question, not only an accuracy one: on a resource that defines
`accessControlPolicyIDs` but has none set, the default access policy gives the creator full
control, so a client could hand that control to a third party by writing its ID into `cr`. An
empty value still means "fill it in for me", the Originator's own ID is accepted as the no-op it
is, and anything else is refused with 4000.

### Known gap — the connection pool does not appear to recover on its own

The reported outage had PostgreSQL recover completely while mobius4 stayed unusable for two and a
half hours; `docker compose restart` fixed it in eighteen seconds with no action taken on the
database. The logs point at connections that were never re-established
(`SequelizeConnectionAcquireTimeoutError`, `Connection terminated due to connection timeout`), but
the pool's internal state was not observed and the mechanism is not confirmed.

**What this release changes is the consequence, not the cause**: the health check now fails in
that situation, so an orchestrator restarts the container instead of leaving it in rotation. That
is automatic recovery, not a fix. Reproducing it needs a real interruption of PostgreSQL rather
than the schema-level failure the tests use, and is tracked separately.

**Why MINOR**: no oneM2M capability is added and no resource type or operation changes, which
would make this PATCH by the table above. But `contentSize` values change, and with them the
thresholds `mbis`/`mbs` enforce, so an existing deployment can see requests accepted or refused
differently after the upgrade. That is more than a bug fix from a client's point of view.

## v4.10.0 (2026-08-07)

### ⚠️ Breaking: `rcn=4` and `rcn=8` change shape *and* pagination

**This is a MINOR release that breaks clients.** The version number is not the warning — this
entry is. Major versions are reserved because `mobius4` is the product name and moving to 5 would
collide with it, so a compatibility break has to be announced here instead. Read this before
upgrading.

Two independent changes, either of which can break you:

1. **Response shape.** Descendants are now nested inside their own parent instead of being
   grouped by type at the top level.
2. **Pagination.** `lim` now cuts on subtree boundaries and `ofst` counts direct children, not
   resources.

**Both fail silently.** A client reading the old flat shape finds no children — an empty result,
not an error. A client computing its own `ofst` skips or repeats subtrees without any error
either.

**Are you affected?** Grep your client for `rcn=4`, `rcn=8`, `rcn%3D4`, or a plain
`resultContent` of 4 or 8. If nothing matches, this release is safe for you.

**Not affected**: plain retrieves (`rcn=1` or no `rcn`), discovery (`fu=1`, which still returns a
flat `m2m:uril`), notifications, and CREATE/UPDATE/DELETE responses. `rcn=5`/`rcn=6` are new in
this release, so nothing can depend on their old behaviour — they did not work at all before.

Before (what 4.9.0 and earlier returned):

```json
{"m2m:cnt": {"rn": "sensors", ...,
   "m2m:cnt": [{"rn": "humid01", ...}, {"rn": "temp01", ...}],
   "m2m:cin": [{"rn": "h1", ...}, {"rn": "t1", ...}, {"rn": "t2", ...}],
   "m2m:sub": [{"rn": "sub-a", ...}]}}
```

After:

```json
{"m2m:cnt": {"rn": "sensors", ...,
   "m2m:cnt": [{"rn": "humid01", ..., "m2m:cin": [{"rn": "h1", ...}]},
               {"rn": "temp01",  ..., "m2m:cin": [{"rn": "t1", ...}, {"rn": "t2", ...}]}],
   "m2m:sub": [{"rn": "sub-a", ...}]}}
```

**What a client must change**: walk the tree recursively instead of reading one flat array per
type. The parent-child relationship no longer has to be reconstructed from `pi`.

**Why**: `TS-0004:7.5.2` Table 7.5.2-2 makes the response element `m2m:<resourceType>` and points
at `CDT-<resourceType>.xsd` for its structure; that XSD refers to child resources by *global*
element reference, so a child carries its own Child Resources block and nesting is recursive by
construction. `TS-0004:8.4.3` EXAMPLE 3 shows the resulting JSON and states it plainly — "the
subscription resource (sub1) appears nested inside its parent (container2)". `TS-0001:8.1.2`
requires "proper nesting representation" and parents listed before children.

### ⚠️ Pagination of `rcn=4` / `rcn=8` also changed

**Existing requests can start returning fewer children than before — including none.** The
default `lim` is `cse.discovery_limit` (200). Where a request previously got 200 resources cut at
an arbitrary point, it now gets only the whole subtrees that fit within 200.

The case to watch for is **one direct child whose own subtree is larger than `lim`**. Retrieving
an `<AE>` that has a `<container>` holding 250 `<contentInstance>`s makes that container's subtree
251 resources, so it does not fit and is dropped whole — the `<AE>` comes back with **no children
at all**, where 4.9.0 returned 200 of them. Raising `ofst` does not help; only a larger `lim`
does. Nothing in the response body says why, so check the server log for the warning described
below. (Retrieving that `<container>` directly is fine: its 250 children are 250 separate
subtrees of one resource each, and 200 of them fit.)

- **`lim` now cuts on subtree boundaries.** `TS-0001:8.1.2` requires that if a direct child and
  all its descendants cannot be included, the direct child is left out entirely — half a subtree
  is not a legal answer. **Consequence**: if the first subtree alone is larger than `lim`, the
  response contains no children at all and raising `ofst` cannot help; only a larger `lim` can.
  The default `lim` is `cse.discovery_limit` (200). A warning is logged when this happens,
  because it is otherwise undiagnosable from the response.
- **`ofst` counts direct children** for these two rcn values (it counts resources for `fu=1`
  discovery). Nesting cannot be resumed mid-subtree without duplicating or orphaning nodes.
  **Send back the `X-M2M-CTO` value you received rather than computing an offset yourself.**

### Added

- **`rcn=5` (attributes and child resource references) and `rcn=6` (child resource references)
  are implemented.** They were previously **ignored**: both returned exactly what `rcn=1` returns,
  with RSC 2000 — a client asking which children existed was told "none", successfully.
  `rcn=5` adds a `ch` array of `{"nm","typ","val"}` to the target's representation
  (`TS-0004:8.4.3` EXAMPLE 2; the `val` name comes from the serialization rule for simple types
  with XML attributes in `8.4.2`). `rcn=6` returns `m2m:rrl` with an `rrf` array and no
  representation of the target (`TS-0001:8.1.2`). `drt=2` yields unstructured IDs. When the
  target has no children the `ch` member is omitted rather than sent empty.
- **Partial results are now signalled.** `X-M2M-CTS` (Content Status, `1` = PARTIAL_CONTENT per
  `TS-0004:6.3.4.2.44`) and `X-M2M-CTO` (Content Offset) are set whenever `lim` truncates a
  child-resource result, for `rcn=4/5/6/8`. `TS-0001:8.1.2` requires the indication and `8.1.3`
  names the two parameters. Previously a truncated result was indistinguishable from a complete
  one.

**Why MINOR**: by the table above this release both fixes conformance defects and changes an
interface. The compatibility break would put it at MAJOR, but the major version is reserved —
`mobius4` is the product name and moving to 5 would collide with it. The break is documented at
the top of this entry instead of being signalled by the number.

### Known gaps

- `DELETE` with `rcn=4/5/6/8` still returns only the target's own attributes, though
  `TS-0001:8.1.2` Table 8.1.2-1 marks them valid for Delete. Returning child representations
  requires a pre-delete snapshot; tracked separately.
- The base of the `ofst` filter condition (0 or 1) is ambiguous in `TS-0001:8.1.2`: the prose says
  "The offset shall start at 1" while the Filter Criteria table describes it as a count of
  resources to skip over. Mobius4 treats it as 0-based, matching the table. Pending clarification.


## v4.9.0 (2026-08-07)

### Fixed — a `<container>`'s `maxInstanceAge` now actually bounds its instances' `expirationTime`

`TS-0004:7.4.7.2.1` step 2 e) requires the Hosting CSE to set a new `<contentInstance>`'s
`expirationTime` so that it is no more than `maxInstanceAge` past `creationTime`, when the
parent `<container>` has one. `mia` was read from the parent and stored, but nothing compared
it against `et` — every instance got the deployment's far-future default
(`config.default.common.et_month`, 12 months) regardless of what the container declared.

`cse/resources/cnt.js` fills in a deployment default for `mia` on every `<container>` creation
that does not explicitly clear it, and that default was `2,592,000` seconds (30 days) — a
number that was harmless while `mia` went unenforced, but would have quietly capped every
`<contentInstance>`'s lifetime to 30 days once it started being enforced. That is a real risk
for anything that treats a `<container>` as its only copy of the data rather than backing it
up elsewhere. So the default moves to `31,536,000` seconds (365 days) in the same change that
turns enforcement on, chosen to track `default.common.et_month`'s 12 months: at most it caps
the previous unenforced default short by about a day, only in spans that cross a leap day
(measured: `31,622,400` seconds for a calendar 12 months that includes 29 February, `86,400`
seconds — one day — more than the new default). A deployment that already set its own `mia`
explicitly is unaffected by this default and gets the enforcement it should have had from the
start.

The cap is computed in the same statement that already writes the `<contentInstance>`
(`cse/resources/cin.js`'s `WRITE_CIN_SQL`, introduced for throughput in `v4.6.2`): the parent's
`mia` comes back from the same row the write already touches, so no extra round trip is added.

### Added — `<container>.maxByteSizePerInstance` (`mbis`)

The other half of `TS-0004:7.4.7.2.1` step 1: content bigger than `mbis`, when the parent
`<container>` has one, is refused with `NOT\_ACCEPTABLE` — independently of `maxByteSize`, the
container's total budget. A container can have room overall and still refuse one instance for
being too big on its own. This attribute did not exist in this codebase at all; content of any
size was accepted as long as the container's total budget allowed it.

Its short name is `mbis`, confirmed against the symbol table rather than assumed — a name like
`mbsp` reads plausibly but is not what the spec uses. It applies to `<container>` only, not
`<flexContainer>` or `<timeSeries>`.

`mbis` has no deployment default, unlike `mni`/`mbs`/`mia`: `TS-0001:9.6.6` does not call for
one, so a container that never sets it behaves exactly as before this release.

**Known issue found while implementing this** (not fixed here, tracked separately): sending
`null` to clear `mni`, `mbs` or `mia` on a `<container>` UPDATE has never worked — the
validation schema rejects `null` for those fields before the code that would reset them ever
runs. `mbis` does not have this problem; its schema entry allows `null` explicitly. The
existing three, and whether the same gap reaches other resource types' UPDATE schemas, are
open questions.

Seven tests cover both changes in `test/container-retention.test.js`: `mbis` refuses oversized
content even when `mbs` alone would allow it, accepts content within it, round-trips through
create/update/clear, and a container with no `mbis` is unaffected; `mia` caps the default `et`
exactly to the container's value, keeps a client-requested `et` that is already shorter, and a
container whose `mia` is absent from storage (reachable only by writing `NULL` directly, since
nothing in the API can currently produce that state) leaves `et` uncapped. Confirmed to fail
without the fix: reverting the `et` assignment fails the `mia` test; reverting the `WHERE`
clause's `mbis` condition fails the oversized-content test.

Migration for existing databases: `db/migrations/v4.9.0.sql` (`ALTER TABLE cnt ADD COLUMN
mbis`). A fresh install needs nothing extra — `db/init.js` creates the column directly.

**Why MINOR, not PATCH**: the `mia` half of this release is a conformance bug fix on its own,
which the versioning table above would call PATCH. But `mbis` is a new optional attribute this
codebase did not have at all, and it ships with a schema migration — both are MINOR conditions
in the table by name ("oneM2M capability added", "backward-compatible DB migration"). The two
land in the same release because they are the same spec clause (`TS-0004:7.4.7.2.1`, steps 1
and 2 e), and a release takes the higher tier any part of it requires.

## v4.8.0 (2026-08-07)

### Added — `docker compose up` brings up the CSE, its database and a broker

Until now the only way to run Mobius4 was from source, which meant installing Node,
PostgreSQL 17, PostGIS 3.6 and an MQTT broker, and creating the database by hand. A `Dockerfile`
and a `docker-compose.yml` now do it in one command: `cp .env.example .env && docker compose up
-d`. One image is built here; PostgreSQL and Mosquitto are official images. Full documentation is
[docs/docker.md](docs/docker.md), and the README and `docs/installation.md` point at it.

The database and the broker are not published to the host — they are reachable on the compose
network and nowhere else. The image runs as an unprivileged user, contains no `certs/` and no
`config/local*.json`, and carries no test or documentation files. TLS material, when HTTPS is
enabled, is mounted read-only rather than built in.

**Configuration comes from `.env`**, which `docker/entrypoint.js` assembles into `NODE_CONFIG`.
Assembling it there rather than in the compose file means values do not have to survive two
levels of YAML quoting, and anything left out of `.env` keeps what `config/default.json` says
instead of being overridden with an empty string. `security.helmet` and `security.rateLimit`
default to on here and off in `config/default.json`, whose defaults suit a developer running
from source.

**The administrator identity is the part with a trap in it.** `config/validate.js` will not start
without `cse.admin`, so a container has to have one — but it also has to be the *same* one every
time, because `db/init.js` writes it into the admin `<accessControlPolicy>` on first boot and
skips the step forever after. An identity regenerated on the second start would leave the
deployment locked out of its own CSE: the policy would still name the first one and every
administrator request would come back 4103, with nothing in the log to say why.

So `CSE_ADMIN` in `.env` is the intended path, and when it is blank the container generates an
identity once, prints it, and keeps it on a Docker volume that later starts read back. Generated
identities are 12 characters beginning with `S` — `TS-0001:7.2` gives that first character the
meaning "assigned by the M2M-SP", which is what a deployment-chosen identity is; the length is a
security choice, since the value is a bearer credential, and is settable.

Because losing the identity volume while keeping the database is a real way to arrive at the
locked-out state, the entrypoint compares the identity it is about to use against the one the
admin policy records and **refuses to start** on a mismatch, naming both and the two ways out.

Ten tests cover the identity logic: the order of the three sources, that a blank `CSE_ADMIN`
from compose is not taken literally, that the file survives repeated starts, that an unreadable
file is an error rather than a reason to generate a second identity, the file mode, and that
generated values stay inside the character set `TS-0001:7.2` allows for an AE-ID-Stem. The stack
itself was verified by hand — CRUD round trip, `<flexContainer>` creation, an MQTT request
round trip, restart and `down`/`up` persistence, graceful shutdown, and that the image contains
neither certificates nor local configuration.

`config/production.js` is new and deliberately empty: node-config warns on every start when
`NODE_ENV` names an environment it has no file for, and the image sets `NODE_ENV=production`
while getting its configuration from `NODE_CONFIG`.

**Why MINOR**: a new way to deploy, no change to what Mobius4 does. Nothing changes for an
existing source deployment.

## v4.7.0 (2026-08-07)

### Changed — HTTPS is optional, serves server authentication only, and no longer ships certificates

Three changes to one listener, and all three can surprise an existing deployment. The upgrade
steps are in [docs/upgrading.md](docs/upgrading.md#v470); the procedures for obtaining,
installing and replacing a certificate are a new document, [docs/tls.md](docs/tls.md), which
`docs/configuration.md`, `config/local.json.example` and the README now point at.

**It is optional, and off by default.** `bindings/http.js` read `certs/ca.crt`, `certs/wdc.key`
and `certs/wdc.crt` at module load, with no condition and no error handling. There was no
setting to turn the listener off, and a checkout without those three files could not start at
all — which is what stopped `docker compose up` from being a single command. `https.enabled`
now governs it, and `https.key`, `https.cert` and `https.chain` say where the material lives
instead of three hardcoded paths.

Enabling it with an unreadable file **stops startup** rather than falling back to plain HTTP,
and the message names the setting rather than only the file. A silent downgrade is not
detectable from the client side either.

**Client certificates are no longer requested.** The listener set `requestCert: true` and
`rejectUnauthorized: true`, which reads as mutual TLS. Nothing ever looked at the certificate
that arrived: there is no `getPeerCertificate` call anywhere in this source, so the identity
proved by the handshake was never compared against the `X-M2M-Origin` the request claimed. Any
holder of a certificate signed by the configured CA could act as any originator, the
administrator included. The requirement is gone rather than left standing, because an assurance
that is not delivered is worse than a missing one — deployments plan around it. Clients that
present certificates still work; the certificate is ignored. Binding a certificate to the
originator it may claim is worth doing and is tracked as future work.

**The certificates in this repository were deleted**, `certs/wdc.key` and `certs/SAE1.key`
among them, and `certs/` is now gitignored. They remain in the git history, so both private keys
must be treated as disclosed: any deployment still serving `wdc.crt` should issue a new
certificate, and any client still holding `SAE1.key` should be reissued.

Two tests cover the listener: that enabling it serves oneM2M over TLS to a client presenting no
certificate, and that enabling it with an unreadable key exits with a message naming
`https.key`. The certificate is generated during the run rather than committed — committing one
is how this repository acquired a private key in its history. A third, in `test/boot.test.js`,
asserts the default: no listener, and the startup log saying so. The suite as a whole is the
wider proof, since CI has no `certs/` directory and every test now starts without one.

**Why MINOR**: no oneM2M capability changes, but an existing deployment that wants TLS must set
`https.enabled` and supply its own paths, and one that relied on the client-certificate
requirement loses it.

## v4.6.5 (2026-08-06)

**Why PATCH**: a conformance fix, a performance change and documentation. No oneM2M
capability is added and no interface changes, so by the table above this is a PATCH.
It is worth taking promptly all the same: any deployment that puts an
`<accessControlPolicy>` on its containers could not read back its own
`<contentInstance>` resources before this release.

### Performance — discovery decides access once per policy holder, not once per resource

Discovery evaluates every matching resource with `access_decision` before paginating, so the
cost scales with the number of matches rather than with `lim`. Most of those evaluations were
the same question: a `<contentInstance>` has no `accessControlPolicyIDs` of its own, so the
decision is really about its parent (`TS-0001:9.6.7`), and 150 CINs under one `<container>`
produced 150 identical parent decisions, each several DB round trips. The container itself,
when it appeared in the same result set, asked that question a 151st time.

`discovery_core` now memoizes each decision under the three things a decision is a function of:
the originator, the operation, and what decides for the resource. Only the third varies inside
one discovery — the originator and DISCOVERY are fixed for the whole request — but all three are
named, so the key is not correct merely for as long as that stays true.

The third component is not the resource itself: it is the parent's `ri` for a parent-governed
type and the resource's own `ri` otherwise. Those are one keyspace, because resourceIDs are
unique across the CSE (`TS-0001:9.6.1.3.1`), so a container and its content instances collapse
onto a single entry. The `pi` column the key needs comes from the type queries that were already
running.

Measured against a `<container>` carrying an `<accessControlPolicy>` (acop 63), concurrency 16,
one instance:

| Resources | Before | After |
|---|---|---|
| 50 CINs | 52 rps, p50 306 ms | 681 rps, p50 23 ms |
| 150 CINs | 18 rps, p50 886 ms | 614 rps, p50 25 ms |

The map lives and dies with one request, and that is what makes it sound rather than a cache: a
decision kept past the end of a request would keep granting the old answer after an
`<accessControlPolicy>`'s privileges changed. Within a request there is no such exposure, and
consistency improves — the old loop read policy state at 150 separate instants and could put
two different policy states into one response.

Sharing a decision also skips the read that produced it, and that read was quietly doing a
second job: `access_decision` answers false for a resource that is no longer there. With
decisions shared, only the first resource behind each key is confirmed to exist, so one deleted
between the type queries and the filter could stay in the URI list. The race is not new — a
resource deleted just after its check was always going to be listed, and a discovery result is
a snapshot either way — but the window went from per-resource to per-request, so the check is
put back explicitly: one indexed query over the survivors, asked of the lookup table because
discovery returns addresses and a row with no lookup entry has none. It answers with a count
first, since the answer is almost always "all of them". Measured cost of the guard: 652 → 614
rps at 150 CINs, about 6%.

Five tests pin this down. One asserts that content instances under differently-policed parents
do not bleed into each other; one that two originators get mirror-image answers over the same
containers, which is what the originator in the key is for; one that two originators asking back
to back get their own answers; and one that revoking an originator from an `<accessControlPolicy>`'s `pv`, and
granting it back, is felt on the very next request — through the `<container>` that names the
policy and through the `<contentInstance>` that inherits it, in retrieval and in discovery
alike; and one that a resource whose lookup row is gone is not returned. That third one is the
case that matters for anything cache-shaped in this path: it fails both when the memo is
promoted to process lifetime and when the `<acp>`'s `pv` itself is cached on the assumption that
an unchanged `acpi` means unchanged privileges. Nothing in mobius4 caches a privilege or a
decision beyond a single request, and this is what keeps it that way.

### Fixed — a `<contentInstance>` under a policy-carrying `<container>` was refused to everyone

`TS-0001:9.6.7`: "The `<contentInstance>` resource inherits the same access control policies of
the parent `<container>` resource, and does not have its own `accessControlPolicyIDs`
attribute." `access_decision` implements this by resolving the parent and asking the same
question about it (Case B) — but the request it built for that recursive call carried
`to_ty`, `ri` and `fr` and not `op`. Both `access_decision_acpi` and
`access_decision_privileges` switch on the operation to pick the acop bit, so an undefined
operation matched no case and every rule evaluated to false.

The effect, reproduced against a container carrying a policy that grants acop 63: RETRIEVE of
the container 2000, RETRIEVE of a `<contentInstance>` inside it **4103 — for the administrator
as well**, and discovery answering 2000 with the CIN silently absent from the URI list. Any
deployment that puts an `<accessControlPolicy>` on its containers could not read back its own
content instances.

It stayed hidden because a container created *without* an `acpi` takes the creator-comparison
branch instead, and `fr` was carried — so the ordinary shape, an AE reading back what it wrote
into its own container, kept working. No test covered a `<contentInstance>` under a policy at
all; four now do, three of which fail without the fix. The one that distinguishes "the
operation is carried" from "the operation is ignored" uses acop 35 (create + retrieve +
discovery, no delete bit) and asserts retrieve 2000 and delete 4103 on the same CIN.

### Changed — a deployment is told when its logging is costing it throughput

`config/default.json` already ships what a deployment wants (`level: "info"`,
`console.pretty: false`). The development settings live in
`config/local.json.example`, which is correct for development — and is also the
file every deployment is told to copy. Nothing said what carrying them over costs.

Measured 2026-08-05 (concurrency 32, 5 s, RETRIEVE `<container>`, one instance,
file logging off): pretty printing costs 18% (4,013 → 3,288 rps), `debug` a
further 7% on top because the HTTP binding logs one line per successful request
at that level. Together, 4,013 → 2,771 rps, i.e. −31%.

`NODE_ENV` cannot be relied on to catch this. `pretty` is suppressed under
`NODE_ENV=production`, but `ecosystem.config.js` sets `NODE_ENV=dev` unless PM2
is started with `--env production` — so the deployment most likely to be
misconfigured is the one `NODE_ENV` would not catch. `logger.js` therefore emits
one `warn` at startup naming whichever of the two is active and what it costs.
Suppressed under `NODE_ENV=test`.

No change to the request path, and no change to any default. `docs/logging-guide.md`
gains the measured table; `docs/configuration.md` had `logging.file.enabled`
documented as defaulting to `false` when `default.json` has it `true` — corrected.

**Why PATCH**: documentation, one startup log line, no capability and no behaviour
change for a correctly configured deployment.

## v4.6.4 (2026-08-05)

### Fixed — a name conflict is answered with 4105, not 4000

`create_a_res` checks up front whether the `resourceName` is taken and answers 4105 CONFLICT
(`TS-0001:9.6.1.3.1`, code from `TS-0004:6.6.3.5`). Requests that arrive together all pass that
check before any of them commits, so the loser was stopped by the unique index on `lookup.sid`
instead — and every create handler mapped any exception to 4000 BAD_REQUEST.

Nothing was ever created twice; the defect was what the client was told. It matters because
4000 says "your request was malformed", which an originator cannot tell apart from a payload it
should stop sending, while 4105 says "try another name". Measured on a **single** instance: of
24 losing requests, 21 got 4000. With two instances sharing a database it was every one of them.

All ten create handlers now classify through `cse/create-error.js`, which recognises both
Sequelize's `UniqueConstraintError` and PostgreSQL's raw `23505`.

### Changed — MQTT subscription and expired-resource cleanup run on one instance

Preparation for running more than one instance. Both are driven by something other than an
inbound HTTP request, so every process was doing them.

- **MQTT.** No client id is set, so each instance connects under its own and the broker
  delivers every request message to all of them. Measured with two instances: one `<container>`
  CREATE over MQTT was processed by both. Only one resource was stored — the unique index
  caught the second — but the work and the response were duplicated.
- **Cleanup.** `setInterval` fires in every process, so the same sweep ran N times. Deletes are
  idempotent, but concurrent deletes of the same rows contend.

Both now run only where `NODE_APP_INSTANCE` is `0` or absent (`cse/singleton-role.js`), so a
development run, the test suite and PM2 fork mode are unaffected. Instances that do not
subscribe keep their MQTT connection, which is what notifications are published through.

Known weakness, written down rather than hidden: if instance 0 is down, nobody is subscribed to
the MQTT request topic until PM2 restarts it. An MQTT 5 shared subscription (`$share/`) would
spread the load instead, and is the better answer once the broker in use is known to support it.

**This does not make cluster mode supported yet.** `ecosystem.config.js` still runs a single
instance in fork mode. The remaining blocker is that `lookupCache` invalidation does not cross
processes: after a resource is deleted and recreated under the same name on another instance, an
instance holding the old mapping answers 4004 for up to five minutes.

## v4.6.3 (2026-08-05)

### Changed — `db.pool.max` now means what it says, and defaults to 20

`db.pool.max` was read separately by each of the two connection pools this process runs —
Sequelize's for the models and the raw `pg` pool for the hand-written SQL — so the setting meant
twice what it said. A third pool in `db/init.js` took `pg`'s default of 10 on top of that and was
never closed. Measured: one process under load held **53 connections** with `max` set to 30.

That is not a tidiness problem. PostgreSQL's default `max_connections` is 100, so a *second*
instance already exceeded it: raising `max` to 60 produced `too many clients` and failed a fifth
of requests in measurement. Any plan to run more than one instance has to start from a number
that means what it says.

- `db.pool.max` is now the **process-wide total**, split evenly between the two pools
  (`db/pool-size.js`).
- `db/init.js` shares the process pool instead of opening a third.
- The default drops from 30 to **20**. Same process under the same load now holds **19**
  connections.

**No throughput cost.** At a concurrency of 100, 10 connections per pool reached 3,069 requests
per second against 3,139 for 30 — 2% for three times the connections. Measured before and after
the change back to back: 3,253/3,279 → 3,387/3,429 at concurrency 32, and the tail improved
(p99 22–24 ms → 15 ms).

**If you raised `db.pool.max` in `config/local.json`, halve it** — the old value now buys twice
the connections it used to.

Not changed, deliberately: `connectionTimeoutMs` (2000) and `statementTimeoutMs` (30000). Both
are worth revisiting, but no measurement here showed either causing a failure, and changing them
on that basis would be guessing.

## v4.6.2 (2026-08-05)

### Performance — `<contentInstance>` creation is one statement, and `stateTag` no longer races

The write path was four round trips: a SELECT for the parent's `maxByteSize` and
`stateTag`, then `BEGIN`, three statements and `COMMIT`. It saturated at a
concurrency of 8 because the ceiling was the round trips, not the work.

It is now a single statement — the parent's counters, the `<contentInstance>`
row and its lookup row in one `WITH`. A single statement is atomic without an
explicit transaction, and three things follow from the shape rather than being
arranged separately:

- The size check **is** the `UPDATE`'s `WHERE`. When the content does not fit no
  row is updated, so the two `INSERT`s, which select from that `UPDATE`, insert
  nothing. A refusal cannot leave the counters advanced for a row that was never
  written.
- `stateTag` comes back from the `UPDATE` that incremented it, so the instance
  carries the parent's post-increment value as `TS-0004:7.4.7.2.1` step 3
  requires.
- "Parent missing" and "content too large" are told apart by the statement's own
  result rather than by an earlier read.

**Fixed as a consequence**: `stateTag` collided under concurrent creates. The old
path read the parent's `st` before opening its transaction, so concurrent creates
copied the same value into several instances — measured at 20 concurrent creates
producing 8 distinct values, 11 of them sharing 1. Besides violating step 3 this
left eviction picking arbitrarily, since `evict_if_needed` orders by `st`. There
is no longer a read to race. The regression test that carried this as `todo` is
promoted to a real assertion.

Measured on the development machine, 5s per run, before → after:

| concurrency | 8 | 32 | 100 |
|---|---|---|---|
| CREATE `<cin>` | 1,025 → **2,723** | 903 → **3,366** | 882 → **3,383** |
| CREATE with eviction active | 808 → **1,457** | 686 → **1,681** | 561 → **1,515** |

The shape matters more than the multiple: throughput used to *fall* as
concurrency rose past 8. It now climbs to 32 and holds at 100, and p50 at
concurrency 32 went from 26 ms to 9 ms. Absolute numbers are specific to that
machine.

No API change. Eviction remains synchronous — the response is still only sent
once the container is back within its limits.

### Performance — eviction is also one statement

Eviction runs on the write path, so with creation itself fixed it became the
remaining cost: a container held at its limit ran at roughly half the throughput
of one that was not. It went through `delete_a_res` per evicted instance, which
retrieves the resource, deletes it, queries for descendants, deletes those, and
offers the deletion to the notification path — for a `<contentInstance>`, which
is always a leaf (no resource type accepts one as a parent) and whose eviction
must not notify anyway (`TS-0004:7.4.7.2.1` step 2 d).

It is now a single statement. What survives is expressed directly: ranking newest
first, an instance is kept while its position is within `maxNrOfInstances` and the
running total of sizes up to it is within `maxByteSize`; everything past either
boundary goes. Nothing is decided in JavaScript.

| concurrency | 8 | 32 | 100 |
|---|---|---|---|
| CREATE with eviction active | 808 → **1,774** | 686 → **1,571** | 561 → **1,606** |

The tail matters more than the throughput here: p99 at concurrency 100 was
3,006 ms and is now 108 ms.

Two defects were introduced and fixed while writing it, both worth recording
because neither is visible in ordinary use.

**Deadlock.** The first version took its locks in the opposite order from the
write — cin rows, then lookup rows, then the container, against the write's
container first. Two requests interleaving on one container deadlock, and
PostgreSQL fails one: a third of writes returned 4000 under sustained load. The
statement now locks the container first, which also serialises eviction per
container so two of them cannot choose overlapping victims. The write already
serialises on that row, so no contention is added. A regression test covers it —
a single burst of concurrent creates does not reproduce it, so the test applies
successive waves.

**Sequential scans.** The second version read the container's instances with
`WHERE pi = (SELECT ri FROM locked)` and deleted with `ri IN (SELECT ...)`.
Neither can use an index: the planner does not know the value until the CTE runs,
and the `IN` form plans as a hash semi-join. On a table of 16,000 rows holding an
11-row container that cost 14.5 ms per eviction against 0.58 ms, scaling with the
whole table rather than with the container. The parameter is now passed directly
and the deletes join with `USING`.


### Tests — `<container>` retention invariants (no behaviour change)

Groundwork for rewriting the `<contentInstance>` write path for throughput. That
rewrite collapses the three statements of `create_a_cin`'s transaction into one,
which is exactly the code that maintains `currentNrOfInstances`, `currentByteSize`
and `stateTag` — and none of it had a test. The suite would have stayed green
through a rewrite that stopped maintaining `cni`, evicted the wrong instance, or
double-counted `cbs`. Counters fail quietly: nothing errors, the numbers drift.

`test/container-retention.test.js` asserts what `TS-0004:7.4.7.2.1` requires —
`maxByteSize` refusal (5207, and no partial application), `maxNrOfInstances`
eviction of the oldest *by identity* rather than by count, `maxByteSize` eviction
repeating until the condition is met, `cni`/`cbs` agreeing with the stored
instances, `stateTag` propagation, and exactness under concurrent creates.
Verified by mutation: dropping the `cbs` update, reversing the eviction order,
removing eviction, and removing the size check each fail it.

### Fixed — a test that asserted nothing

`sink.expectNone` returned its matches instead of throwing, so
`await sink.expectNone(...)` without a following assertion passed no matter how
many notifications arrived. It now throws, reporting what did arrive. Found
because a newly written eviction test passed with the guard it was protecting
removed. The four pre-existing call sites were already asserting correctly and
are unaffected.

### Resolved — eviction notifications (was SQ-001, in part)

`TS-0004:7.4.7.2.1` step 2 d) states that removing the oldest
`<contentInstance>` **shall not** generate notifications, even where a
`<subscription>` on the parent `<container>` asks for
`Delete_of_Direct_Child_Resource`. mobius4 already behaved this way; what was
missing was the citation. The regression test that carried this as `todo` — on
the premise that the specification had not settled it — is inverted to assert the
silence, and gains a mirror case proving an ordinary client-issued DELETE of a
`<contentInstance>` still notifies, so the guard cannot be widened into "never
notify for this resource type".

Still open: whether a cascade delete fires `net=4` on descendants' subscriptions.
That clause does not cover it.

## v4.6.1 (2026-08-05)

Two conformance corrections. No configuration change and no DB migration.

### Fixed

- **UPDATE and DELETE of the `<CSEBase>` answer 4005 again, for every originator.**
  The guards in `cse/reqPrim.js` that reject these two operations tested
  `req_prim.ty`, the type of the resource to be *created*, which the HTTP binding
  fills in for CREATE only. Over HTTP they therefore never fired, and the request
  fell through to access control. That went unnoticed while the administrator
  short-circuited access control and reached the 4005 in `delete_a_res`; once
  v4.6.0 moved admin privileges into an ACP, a registered AE — which is what the
  conformance suite uses — was refused earlier and got **4103** instead.
  The guards now test `to_ty`, the type of the resource being addressed, so the
  rejection happens before access control, where TS-0004:7.4.3.2.3 and 7.4.3.2.4
  put it ("check the syntax of received message"). Restores
  TP/oneM2M/CSE/REG/UPD/001 and TP/oneM2M/CSE/REG/DEL/001. Regression test in
  `test/protocol.test.js`; the pre-existing case there only covered the
  administrator, so the suite passed throughout.

  **Why PATCH**: a bug fix that adds no capability.

- **The group fanout response names its member `m2m:rsp` again.** `rsp` is
  `m2m:responsePrimitive` in the TS-0004 symbol table, so inside the aggregated
  response it is namespaced the same way the enclosing `m2m:agr` envelope is.
  The member had been carried unprefixed for a time to accommodate an issue on the
  conformance tester side; that issue is being followed up separately, and the
  prefix is restored here so the implementation matches what the standard
  specifies. `cse/resources/grp.js` produces the key and nothing else in the CSE
  reads it, so the change is confined to the fanout response body; a client that
  parsed `agr.rsp` should read `agr["m2m:rsp"]`. Covered by the fanout case in
  `test/protocol.test.js`.

  **Why PATCH**: a conformance correction that adds no capability.

## v4.6.0 (2026-08-02)

**Also breaking**, in two further ways, both deliberate:

- The administrator no longer bypasses access control. See the second item below —
  some resources the administrator could reach before are now refused.
- `resourceName` is now checked against its ABNF. Names starting with `-`, `.` or
  `_`, or containing `@`, are refused with 4000 where they used to be accepted.
  See the last item below.

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

- **DELETE answered 2002 before the resource was actually gone, and a retrieve that
  landed in the gap got RSC 5000.** Unrelated to the admin change above. It dates to
  `4e977e0` (2026-04-09, on the 4.2.0 line), where the `await` was dropped from
  `delete_resources()` in `cse/hostingCSE.js` as a performance optimization — the
  comment on the line still said the deletion was waited for — so every tagged release
  in this repository carries it. A client that deleted a resource and retrieved it
  immediately could hit the window: `set_ri_sid` resolves the resource id and its type
  in two separate queries against `lookup`, so a deletion committing between them
  produced an id with type `0`; `retrieve_a_res` has no case for type `0` and left the
  content empty while still labelling the answer OK; `access_decision` then threw
  reading that content, and the failure surfaced as a server fault for a resource that
  was merely absent. Reproduced at roughly one request in 300, on any Node version.

  Three changes. `delete_a_res` now awaits the target's removal, so 2002 means gone —
  measured cost on the DELETE response: none (p50 5.3 ms before and after, 1000
  requests). `set_ri_sid` treats an id whose type will not resolve as an absent
  resource rather than passing it on. `access_decision` reports empty content as
  NOT_FOUND instead of throwing. **Descendants are still deleted asynchronously** — a
  deliberate choice so that deleting a large subtree does not hold the response open,
  and the reason `waitForSubtreeGone` exists in the test helpers.

  Performance is unchanged by design; the `await` only orders work that was already
  being done. `test/deletion.test.js` covers the contract, including a case that writes
  the mid-deletion state directly and so checks the guard on every run rather than
  waiting for the race to recur.

- **A resource named with a leading `_` was created, then answered 4004 to every retrieve
  and delete.** Reported by an integrating developer. Two defects met, and both are fixed.

  *The path parser.* `TS-0009:6.2.2.1` defines `/~` and `/_` as **prefixes** of the HTTP path
  component, marking the SP-Relative and Absolute forms of the *To* parameter; a server "shall
  apply the reverse operations" to recover *To*. `bindings/http.js` tested for them with
  `includes()` instead of at the start of the path, so any path holding a segment that begins
  with `_` took the Absolute branch. There the replacement found no `/_/` to act on and — the
  part that actually broke things — the leading slash was never stripped, because that happens
  only in the final branch. *To* kept its leading slash while every `sid` in the lookup table is
  stored without one, so the resource was unreachable by its hierarchical path. It stayed
  reachable by its unstructured resource ID, which is what made the report look contradictory.
  The prefixes are now matched at the start of the path.

  *The validation.* `TS-0004:6.2.4` gives `resourceName` an ABNF of its own, resolved through
  6.2.3: `resource-name = 1*unreserved`, `unreserved = (ALPHA / DIGIT) *(ALPHA / DIGIT / "-" /
  "." / "_")`. A leading `_` was never valid. `cse/validation/res_schema.js` accepted it, and
  also accepted `@`, which appears in no ABNF. Names are now checked against the ABNF and a
  violation is refused with 4000 BAD_REQUEST.

  **What changes for you.** `CREATE` now refuses a `resourceName` that starts with `-`, `.` or
  `_`, or that contains `@`. Clients relying on any of those get 4000 where they previously got
  2001. Existing resources are untouched and — thanks to the parser fix — are retrievable and
  deletable again, so a deployment holding such names can clean them up. `TS-0001:7.2` describes
  resource identifiers more loosely, via RFC 3986's unreserved set, which has no
  first-character restriction; the two documents disagree on paper and this release follows the
  protocol binding's ABNF as the one clause that names a `resource-name` production.

  `test/addressing.test.js` covers all six *To*/path combinations of table 6.2.2.1-1, which is
  what the defect slipped through; `test/resource-name.test.js` covers the ABNF and the
  already-stored case.

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

  **Hitting `TypeError: Utils.isRegExp is not a function` on Node 24 after
  upgrading?** That means the fix above is in your source tree but an old
  `config` is still installed. See
  [Upgrading Mobius4 — v4.4.1](docs/upgrading.md#utils-isregexp) for how to
  identify the installed version straight from the stack trace, and how to
  clear it.
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
