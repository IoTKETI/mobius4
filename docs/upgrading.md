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
