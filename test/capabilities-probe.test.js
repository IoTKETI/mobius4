"use strict";
// The judgement calls in the capability probe — scripts/lib/capabilities.js.
//
// features/capabilities.json is enforced by CI: a change to what this CSE does fails the build
// until the file is regenerated. That makes the probe's own correctness load-bearing. If it
// judges wrongly, CI enforces the wrong answer, and the file looks exactly like a right one —
// there is nothing in its shape to suggest otherwise.
//
// This is not a hypothetical worry. The first run of the probe recorded net=3 notification as
// unsupported, because the wait passed a predicate over the array of received notifications
// while the sink hands its predicate each notification in turn. Notification delivery is
// implemented and covered by thirteen tests in test/notification.test.js; the probe simply said
// otherwise. It was caught by reading the output, which does not scale and does not repeat.
//
// The probe as a whole needs a server, a database and a sink, and running it is what
// `npm run probe-capabilities` already does. What is worth pinning down separately is the part
// that decides — and the sink contract that was misused.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  support,
  observedOf,
  hasDrifted,
  summarize,
  isReadableFormat,
} = require("../scripts/lib/capabilities");
const { startSink } = require("./helpers/noti-sink");

// ── support(): what counts as "this works" ────────────────────────────────────────────────────

test("a success-class status is support", () => {
  assert.deepEqual(support({ rsc: "2000" }), { supported: true, rsc: 2000 });
  assert.deepEqual(support({ rsc: "2001" }), { supported: true, rsc: 2001 });
  assert.deepEqual(support({ rsc: "2002" }), { supported: true, rsc: 2002 });
  assert.deepEqual(support({ rsc: "2004" }), { supported: true, rsc: 2004 });
});

test("a refusal keeps the status that came back rather than collapsing to false", () => {
  // A <CSEBase> UPDATE answering 4005 OPERATION_NOT_ALLOWED is correct behaviour, not a gap.
  // Recording only `supported: false` would make it indistinguishable from an unimplemented
  // operation, and the file would understate the CSE while looking definite about it.
  assert.deepEqual(support({ rsc: "4005" }), { supported: false, rsc: 4005 });
  assert.deepEqual(support({ rsc: "4004" }), { supported: false, rsc: 4004 });
  assert.deepEqual(support({ rsc: "5000" }), { supported: false, rsc: 5000 });
});

test("a response with no status header is marked as such, not silently unsupported", () => {
  // No X-M2M-RSC means the request did not reach the oneM2M layer at all — a prober or
  // transport problem. Writing it as a plain "unsupported" would blame the CSE for it.
  //
  // `fetch`'s headers.get returns null for a missing header and Number(null) is 0, so the
  // absent case has to be caught before the conversion. It was not, and a missing header was
  // being recorded as `rsc: 0` — a status code that does not exist, sitting exactly where a
  // real refusal would be.
  for (const missing of [null, undefined, ""]) {
    const got = support({ rsc: missing });

    assert.equal(got.supported, false, `${JSON.stringify(missing)}`);
    assert.equal(got.rsc, null, `${JSON.stringify(missing)} must not become 0`);
    assert.equal(got.note, "no X-M2M-RSC header");
  }
});

// ── hasDrifted(): what the CI gate compares ───────────────────────────────────────────────────

const manifest = (over = {}) => ({
  formatVersion: 1,
  probed_at: "2026-08-08",
  probed_against: { commit: "aaaaaaa", version: "4.13.1" },
  entries: [{ ty: 3, short_name: "cnt", long_name: "container", operations: { create: { supported: true, rsc: 2001 } } }],
  procedures: [{ id: "discovery.filter-usage", name: "d", supported: true, rsc: 2000, evidence: "e" }],
  ...over,
});

test("a new run of an unchanged CSE is not drift", () => {
  // probed_at and the commit move every time. Comparing them would fail the gate on every
  // build, and a gate that always fails gets switched off.
  const before = manifest();
  const after = manifest({ probed_at: "2026-09-01", probed_against: { commit: "bbbbbbb", version: "4.14.0" } });

  assert.equal(hasDrifted(before, after), false);
});

test("an operation that stopped working is drift", () => {
  const after = manifest();
  after.entries[0].operations.create = { supported: false, rsc: 4005 };

  assert.equal(hasDrifted(manifest(), after), true);
});

test("a procedure that stopped working is drift", () => {
  const after = manifest();
  after.procedures[0].supported = false;

  assert.equal(hasDrifted(manifest(), after), true);
});

test("a newly supported operation is drift too", () => {
  // Drift is "the file no longer describes the CSE", in either direction. Letting new support
  // through silently would leave the file understating what works, which is the failure this
  // whole arrangement exists to prevent.
  const after = manifest();
  after.entries[0].operations.retrieve = { supported: true, rsc: 2000 };

  assert.equal(hasDrifted(manifest(), after), true);
});

test("observedOf tolerates a manifest with neither section", () => {
  // A truncated or hand-edited file must not crash the gate — it has to fail it.
  assert.equal(
    observedOf({}),
    JSON.stringify({ formatVersion: null, entries: [], procedures: [] })
  );
  assert.equal(hasDrifted({}, manifest()), true);
});

test("a format version bump is drift, so the file cannot claim a shape it does not have", () => {
  // The version is producer-controlled, so bumping it without regenerating would leave a file
  // announcing a shape it was not written in — and a consumer trusting that announcement is
  // exactly what the version exists to protect.
  const after = manifest({ formatVersion: 2 });

  assert.equal(hasDrifted(manifest(), after), true);
});

test("isReadableFormat accepts only the version the consumer was written for", () => {
  // Newer may have moved a field or changed what one means; older is a shape nobody tested
  // against. Guessing in either direction does not crash — it produces a plausible wrong
  // answer, in a file whose whole purpose is to be trusted.
  assert.equal(isReadableFormat(1, 1), true);
  assert.equal(isReadableFormat(2, 1), false);
  assert.equal(isReadableFormat(undefined, 1), false, "a file with no version is not version 1");
});

// ── summarize(): unasked is not unsupported ───────────────────────────────────────────────────

test("a procedure that was not probed is counted apart from the ones that failed", () => {
  // Registration with another CSE needs a second CSE and is left to test/. Counting it with
  // the failures would report the CSE as doing less than it does.
  const m = manifest({
    procedures: [
      { id: "a", supported: true, rsc: 2000 },
      { id: "b", supported: false, rsc: 4005 },
      { id: "c", supported: null, rsc: null, evidence: "not probed — needs a second CSE" },
    ],
  });

  const s = summarize(m);

  assert.equal(s.procedures, 3);
  assert.equal(s.supportedProcedures, 1);
  assert.equal(s.unprobedProcedures, 1, "null is 'not asked', not 'answered no'");
});

test("summarize counts supported operations across resource types", () => {
  const m = manifest({
    entries: [
      { ty: 3, operations: { create: { supported: true, rsc: 2001 }, update: { supported: false, rsc: 4005 } } },
      { ty: 4, operations: { create: { supported: true, rsc: 2001 } } },
    ],
  });

  const s = summarize(m);

  assert.equal(s.resourceTypes, 2);
  assert.equal(s.supportedOperations, 2);
});

// ── the sink contract the probe got wrong ─────────────────────────────────────────────────────

test("the notification sink hands its predicate one notification, not the array of them", async () => {
  // This is the exact mistake that made the probe record a working feature as unsupported:
  // `waitFor((items) => items.length > 0)` reads `.length` off a single notification object,
  // gets undefined, and never matches — so the wait times out and the probe concludes the CSE
  // does not notify. Pinning the contract here means the next person writing a wait cannot make
  // the same assumption without a test telling them.
  const sink = await startSink();
  try {
    const seen = [];
    const waiting = sink.waitFor((item) => {
      seen.push(item);
      return true;
    }, { timeoutMs: 2000 });

    await fetch(sink.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ "m2m:sgn": { nev: { net: 3 } } }),
    });
    await waiting;

    assert.equal(seen.length > 0, true, "the predicate must be called at all");
    assert.equal(Array.isArray(seen[0]), false, "it receives a notification, not the list");
    assert.equal(seen[0].body["m2m:sgn"].nev.net, 3, "and the notification is the parsed body");
  } finally {
    await sink.stop();
  }
});
