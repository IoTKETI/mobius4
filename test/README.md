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

## Tests transcribed from TS-0018

Most of this suite is written against mobius4's behaviour. Four files are not: they are
transcribed from the *test purposes* in TS-0018 (Test Suite Structure and Test Purposes), which
is what a certification body judges an implementation against. Each test name carries the TP
identifier it implements, and the assertions are that TP's *Expected behaviour* — so a failure
reads as a conformance failure rather than as a disagreement with a scenario someone invented.

| file | test purposes | configuration |
|---|---|---|
| `cse-registration.test.js` | `TP/oneM2M/CSE/REG/*` | CF01 — one CSE, test system acting as an AE |
| `cse-registration-remote.test.js` | `TP/oneM2M/CSE/REG/*` | CF04 — two CSEs |
| `group-management.test.js` | `TP/oneM2M/CSE/GMG/*` | CF01 |
| `group-remote-members.test.js` | `TP/oneM2M/CSE/GMG/*` | CF02 — member hosted on a second CSE |

Each of those files begins with a comment listing the test purposes it deliberately does **not**
implement and why. Read it before adding to the file: "there is no test for this TP" and "this
TP does not apply" are different situations and the file says which one holds.

**Do not invent TP identifiers.** If a behaviour has no test purpose covering it, derive the
test from the core specification and say so in the file. A made-up identifier reads like
evidence.

### The two-CSE configurations

`test/helpers/two-cse.js` starts an IN-CSE and an MN-CSE that register with each other, each
with a database of its own (`mobius4_test_reg_a`, `mobius4_test_reg_b`, created and dropped by
the helper). It waits for the registration to complete before returning — `registree()` is not
awaited by `mobius4.js`, so a server that reports "ready" has not necessarily registered yet.

The wait polls **as the registree**, not as the registrar's administrator: a `<remoteCSE>`
created by a registering CSE has no `acpi`, so the default access policy makes it visible to its
creator only. Polling as the registrar's admin waits out the timeout on a registration that in
fact succeeded.


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
