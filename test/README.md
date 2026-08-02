# mobius4 tests

An HTTP black-box regression suite. The tests start mobius4 themselves on a dedicated DB and a
dynamic port, so they are safe to run even while a development instance is up.

## Prerequisites (one time)

```bash
createdb mobius4_test
```

PostgreSQL and the PostGIS extension are required (the same requirement as the development
DB). The tables, the `<CSEBase>`, and the default ACP are created automatically on the first
run.

The tests override only the DB name, ports, MQTT, and logging via `NODE_CONFIG`; everything
else is taken from `config/` as-is. So **the tests will break if you have changed
`cse.admin` (default `SM`), `cse.csebase_rn` (default `Mobius`), or `cse.cse_type`
(default `1`) in your local configuration** — the originator and the `<CSEBase>` name are
hardcoded in the tests, and with a `cse_type` of 2 or 3 the CSE tries to register with a
remote CSE at boot, which can make the startup wait time out. The DB credentials also come
from `config/`.

## Running

```bash
npm test
```

## How to read the output

- `# fail 0` means the suite passed.
- `not ok … # TODO` is a **known, unfixed defect** (it does not fail the suite).

### ⚠️ If you fixed a defect, do not just read the summary

A `todo` test is counted as `# todo`, not `# pass`, even when it passes. In other words,
**fixing a defect leaves the summary line and the exit code unchanged** (`# pass 19 /
# todo 6`, exit 0). Success shows up only on the individual line, so check it like this:

```bash
npm test 2>&1 | grep "# TODO"
```

- `not ok … # TODO` → the defect is still there.
- `ok … # TODO` → **it has been fixed.** Drop that test's `{ todo: true }` flag to promote it
  to a real regression test. If you leave the flag on, the suite stays green the next time it
  breaks.
