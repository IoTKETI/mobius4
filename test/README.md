# mobius4 tests

A black-box regression suite over both protocol bindings (HTTP and MQTT). The tests start
mobius4 themselves on a dedicated DB and a dynamic port, so they are safe to run even while a
development instance is up.

## Prerequisites (one time)

```bash
createdb mobius4_test
```

PostgreSQL and the PostGIS extension are required (the same requirement as the development
DB). The tables, the `<CSEBase>`, and the default ACP are created automatically on the first
run.

The `mosquitto` binary is also required, for the MQTT binding tests
(`brew install mosquitto` on macOS, `sudo apt install -y mosquitto` on Debian/Ubuntu). Unlike
running Mobius4 itself, **the tests do not need a running or configured broker** — no
`mosquitto.conf`, no listener setup, none of what
[docs/installation.md](../docs/installation.md) describes for the development server. Each
test run starts its own dedicated `mosquitto` instance on a free port and shuts it down when
the suite finishes (`test/helpers/broker.js`); it only needs the binary to be on `PATH`.

The tests override the DB name, ports, MQTT, logging, and `cse.admin` via `NODE_CONFIG`;
everything else is taken from `config/` as-is. `cse.admin` is overridden because
`config/default.json` no longer ships one and `config/validate.js` refuses to start without
it — the tests set `test-admin`, which `test/helpers/onem2m.js` sends as `X-M2M-Origin`.
So **the tests will break if you have changed `cse.csebase_rn` (default `Mobius`),
`cse.cse_type` (default `1`), or `cse.cse_id` (default `/Mobius4`) in your local
configuration** — the
originator and the `<CSEBase>` name are hardcoded in the tests, `test/helpers/mqtt-onem2m.js`
hardcodes `cse_id` to build every MQTT request/response topic, and with a `cse_type` of 2 or 3
the CSE tries to register with a remote CSE at boot, which can make the startup wait time out.
The DB credentials also come from `config/`.

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
