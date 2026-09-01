"use strict";
// The ten value-comparison conditions of eventNotificationCriteria, and the filterOperation that
// combines them.
//
// TS-0018 covers only half of this. TP/oneM2M/CSE/SUB/CRE/006 is parameterized over CONDITION_TAG
// and expands to _CRB _CRA _MS _US _STS _STB _EXB _EXA _SZA _SZB, and every one of those checks
// only that the CREATE is *accepted* (RSC 2001). Searching the whole of TS-0018 for a test purpose
// that exercises these tags actually filtering a notification returns nothing, and "filterOperation"
// and "XOR" do not appear in TS-0018 at all.
//
// So the acceptance tests below carry their TP identifiers, and the behaviour tests are derived
// from TS-0001:9.6.8 table 9.6.8-3 and its combination rules, with **TS-0018에 해당 TP 없음**
// stated on each. No SUB/NTF number is invented for them.
//
// The direction tests matter more than they look. modifiedSince matches a lastModifiedTime that is
// *after* the value and unmodifiedSince one that is *before* it -- the names read backwards, and
// mobius4's discovery path has had them swapped since they were written, undetected because no
// test ever asserted a direction.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, update, retrieve, uniqueRn, createRoot } = require("./helpers/onem2m");
const { startSink, netOf } = require("./helpers/noti-sink");

let srv, root, sink;

const PAST = "20200101T000000";
const FUTURE = "20990101T000000";

before(async () => {
  srv = await startServer();
  sink = await startSink();
  root = await createRoot(srv.baseUrl, "encc");
});
after(async () => {
  if (root) await root.remove();
  if (sink) await sink.stop();
  if (srv) await srv.stop();
});

// A fresh <container> with its own <subscription>, so one test's notifications cannot be mistaken
// for another's. et is set far out so the expireBefore/expireAfter conditions have a known value.
async function cntWithSub(enc) {
  const cnt = uniqueRn("c");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: cnt, et: "20991231T235959" } });
  const sub = uniqueRn("s");
  const res = await create(srv.baseUrl, `${root.sid}/${cnt}`, 23, {
    "m2m:sub": { rn: sub, nu: [sink.url], enc, nct: 1 },
  });
  return { cntSid: `${root.sid}/${cnt}`, subSid: `${root.sid}/${cnt}/${sub}`, res };
}

// Fires the event and answers whether the subscription notified. The update is asserted to have
// succeeded first: if it failed, "no notification" would be trivially true and the test would go
// green while checking nothing.
async function updateAndSee({ cntSid, subSid }, body = { lbl: ["poke"] }) {
  const upd = await update(srv.baseUrl, cntSid, { "m2m:cnt": body });
  assert.equal(upd.rsc, "2004", `the update must succeed: ${upd.raw.slice(0, 160)}`);
  const seen = sink.received.some((i) => i.body?.["m2m:sgn"]?.sur === subSid);
  if (seen) return true;
  try {
    await sink.waitFor((i) => netOf(i) === 1 && i.body["m2m:sgn"].sur === subSid, { timeoutMs: 1200 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- acceptance (TS-0018 TPs)

const ACCEPTANCE = [
  ["CRB", { crb: FUTURE }], ["CRA", { cra: PAST }],
  ["MS", { ms: PAST }], ["US", { us: FUTURE }],
  ["STS", { sts: 999 }], ["STB", { stb: 0 }],
  ["EXB", { exb: FUTURE }], ["EXA", { exa: PAST }],
  ["SZA", { sza: 0 }], ["SZB", { szb: 999 }],
];

for (const [tag, cond] of ACCEPTANCE) {
  test(`TP/oneM2M/CSE/SUB/CRE/006_${tag} — accepts a <subscription> carrying the ${tag} condition`, async () => {
    const { res, subSid } = await cntWithSub({ net: [1], ...cond });
    assert.equal(res.rsc, "2001", `should be created, got ${res.rsc}: ${res.raw.slice(0, 160)}`);
    // Acceptance alone would also be satisfied by a CSE that parses the condition and drops it.
    const got = await retrieve(srv.baseUrl, subSid);
    const key = Object.keys(cond)[0];
    assert.equal(got.body["m2m:sub"].enc[key], cond[key],
      `enc.${key} should survive the round trip: ${JSON.stringify(got.body["m2m:sub"].enc)}`);
  });
}

test("a condition value outside its data type is refused", async () => {
  // TS-0018에 해당 TP 없음. From TS-0004:6.3.5.7: sts and szb are xs:positiveInteger, so 0 is not a
  // valid value for either -- stateTagSmaller: 0 and sizeBelow: 0 can never be satisfied. stb and
  // sza are xs:nonNegativeInteger, where 0 is valid. The asymmetry is deliberate, so it is asserted.
  for (const bad of [{ sts: 0 }, { szb: 0 }]) {
    const { res } = await cntWithSub({ net: [1], ...bad });
    assert.equal(res.rsc, "4000", `${JSON.stringify(bad)} should be refused: ${res.raw.slice(0, 160)}`);
  }
  for (const ok of [{ stb: 0 }, { sza: 0 }]) {
    const { res } = await cntWithSub({ net: [1], ...ok });
    assert.equal(res.rsc, "2001", `${JSON.stringify(ok)} should be accepted: ${res.raw.slice(0, 160)}`);
  }
  const badTime = await cntWithSub({ net: [1], cra: "2020-01-01T00:00:00Z" });
  assert.equal(badTime.res.rsc, "4000", "an ISO-8601 extended timestamp is not m2m:timestamp");
  const fraction = await cntWithSub({ net: [1], cra: "20200101T000000,123456" });
  assert.equal(fraction.res.rsc, "2001", "m2m:timestamp permits up to six fractional digits");
});

// ---------------------------------------------------------------- direction (derived)

test("createdAfter / createdBefore compare against creationTime in the stated direction", async () => {
  // TS-0018에 해당 TP 없음. TS-0001:9.6.8 table 9.6.8-3.
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], cra: PAST })), true,
    "createdAfter with a past cutoff should match a resource created now");
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], cra: FUTURE })), false,
    "createdAfter with a future cutoff should not match");
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], crb: FUTURE })), true,
    "createdBefore with a future cutoff should match");
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], crb: PAST })), false,
    "createdBefore with a past cutoff should not match");
});

test("modifiedSince matches a lastModifiedTime AFTER the value, unmodifiedSince one BEFORE it", async () => {
  // TS-0018에 해당 TP 없음. The two sentences of TS-0001:9.6.8 table 9.6.8-3 read backwards against
  // the names, which is exactly how they came to be swapped elsewhere in this codebase.
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], ms: PAST })), true,
    "modifiedSince(past): lastModifiedTime is after it, so it matches");
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], ms: FUTURE })), false,
    "modifiedSince(future): lastModifiedTime is not after it");
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], us: FUTURE })), true,
    "unmodifiedSince(future): lastModifiedTime is before it, so it matches");
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], us: PAST })), false,
    "unmodifiedSince(past): lastModifiedTime is not before it");
});

test("expireAfter / expireBefore compare against expirationTime", async () => {
  // TS-0018에 해당 TP 없음. The boundaries are derived from the et the CSE actually stored rather
  // than from the one the request asked for -- a deployment may cap expirationTime, and a test
  // that assumed its own value would then be asserting against a number that is not there.
  const probe = await cntWithSub({ net: [1] });
  const stored = (await retrieve(srv.baseUrl, probe.cntSid)).body["m2m:cnt"].et;
  assert.match(stored, /^[0-9]{8}T[0-9]{6}$/, `unexpected et format: ${stored}`);
  const beyond = "2" + String(Number(stored.slice(1, 8)) + 1).padStart(7, "0") + stored.slice(8);

  assert.equal(await updateAndSee(await cntWithSub({ net: [1], exa: PAST })), true,
    `et=${stored} is after ${PAST}`);
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], exa: beyond })), false,
    `et=${stored} is not after ${beyond}`);
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], exb: beyond })), true,
    `et=${stored} is before ${beyond}`);
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], exb: PAST })), false,
    `et=${stored} is not before ${PAST}`);
});

test("stateTagBigger / stateTagSmaller compare against stateTag", async () => {
  // TS-0018에 해당 TP 없음. A <container>'s st increments on update, so it is >= 1 by the time the
  // notification is judged and always < 999.
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], sts: 999 })), true);
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], sts: 1 })), false,
    "st is not smaller than 1 after an update");
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], stb: 0 })), true);
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], stb: 999 })), false);
});

test("a condition on an attribute the resource does not carry does not match", async () => {
  // TS-0018에 해당 TP 없음, and TS-0001:9.6.8 table 9.6.8-3 is silent on it. Decided in
  // cse/enc-conditions.js: a <container> has no contentSize -- it has currentByteSize, a different
  // attribute -- so a statement about its contentSize is not satisfied. The alternative reading
  // (skip the condition) would let an OR of two unevaluable conditions fire.
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], sza: 0 })), false,
    "sizeAbove:0 would match any contentSize, but a <container> has none");
});

// ---------------------------------------------------------------- size, on a resource that has cs

test("sizeAbove is inclusive and sizeBelow is exclusive, against a <contentInstance>", async () => {
  // TS-0018에 해당 TP 없음. sizeAbove is the only inclusive one of the ten: "equal to or greater
  // than". An off-by-one here silently drops exactly the boundary case.
  const cnt = uniqueRn("c");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: cnt } });
  const cntSid = `${root.sid}/${cnt}`;

  // Measure the contentSize this CSE assigns rather than assuming it.
  const probe = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: "abcdefghij" } });
  assert.equal(probe.rsc, "2001", `setup failed: ${probe.raw.slice(0, 160)}`);
  const cs = probe.body["m2m:cin"].cs;
  assert.equal(typeof cs, "number", `the <cin> should report a contentSize: ${probe.raw.slice(0, 160)}`);

  async function cinAndSee(enc) {
    const sub = uniqueRn("s");
    const made = await create(srv.baseUrl, cntSid, 23, {
      "m2m:sub": { rn: sub, nu: [sink.url], enc, nct: 1 },
    });
    assert.equal(made.rsc, "2001", `sub setup failed: ${made.raw.slice(0, 160)}`);
    const subSid = `${cntSid}/${sub}`;
    const cin = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: "abcdefghij" } });
    assert.equal(cin.rsc, "2001", `the <cin> must be created: ${cin.raw.slice(0, 160)}`);
    try {
      await sink.waitFor((i) => netOf(i) === 3 && i.body["m2m:sgn"].sur === subSid, { timeoutMs: 1200 });
      return true;
    } catch {
      return false;
    }
  }

  assert.equal(await cinAndSee({ net: [3], sza: cs }), true,
    `sizeAbove is inclusive, so cs=${cs} must match sza=${cs}`);
  assert.equal(await cinAndSee({ net: [3], sza: cs + 1 }), false);
  assert.equal(await cinAndSee({ net: [3], szb: cs }), false,
    `sizeBelow is exclusive, so cs=${cs} must not match szb=${cs}`);
  assert.equal(await cinAndSee({ net: [3], szb: cs + 1 }), true);
});

// ---------------------------------------------------------------- filterOperation

test("filterOperation defaults to AND", async () => {
  // TS-0018에 해당 TP 없음. TS-0004:7.5.1.2.2 step 1.0: "By default, the logical AND operation shall
  // be used if the filterOperation condition is not present."
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], cra: PAST, stb: 0 })), true,
    "both true under AND");
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], cra: PAST, stb: 999 })), false,
    "one false under AND is false");
});

test("filterOperation=2 is OR", async () => {
  // TS-0018에 해당 TP 없음.
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], fo: 2, cra: PAST, stb: 999 })), true,
    "one true under OR is true");
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], fo: 2, cra: FUTURE, stb: 999 })), false,
    "none true under OR is false");
});

test("filterOperation=3 is XOR — odd parity, not exactly-one", async () => {
  // TS-0018에 해당 TP 없음. TS-0001:9.6.8: "The XOR operation evaluates to true if and only if an
  // odd number of its inputs are true." Two true inputs is even, so false -- an implementation
  // that read XOR as "exactly one" agrees here but disagrees at three.
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], fo: 3, cra: PAST, stb: 999 })), true,
    "one of two true is odd");
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], fo: 3, cra: PAST, stb: 0 })), false,
    "two of two true is even");
  assert.equal(await updateAndSee(await cntWithSub({ net: [1], fo: 3, cra: PAST, stb: 0, sts: 999 })), true,
    "three true is odd — this is where XOR and exactly-one part company");
});

test("an out-of-range filterOperation is refused", async () => {
  // TS-0018에 해당 TP 없음. m2m:filterOperation has exactly three enumerations
  // (CDT-enumerationTypes.xsd:1366). Accepting 4 and then silently falling back to AND would give
  // the subscriber an operation they did not ask for.
  for (const bad of [0, 4, 99]) {
    const { res } = await cntWithSub({ net: [1], fo: bad, cra: PAST });
    assert.equal(res.rsc, "4000", `fo=${bad} should be refused, got ${res.rsc}`);
  }
});

// ---------------------------------------------------------------- regression

test("a <subscription> with no comparison condition still notifies (regression guard)", async () => {
  // These conditions must not leak into subscriptions that never asked for them.
  assert.equal(await updateAndSee(await cntWithSub({ net: [1] })), true);
});

test("the conditions apply to net=2 as well, against the deleted resource", async () => {
  // TS-0018에 해당 TP 없음. TS-0001:9.6.8 table 9.6.8-3 scopes the conditions to the selected
  // notificationEventType; for net=2 that is the subscribed-to resource being deleted.
  const { cntSid, subSid } = await cntWithSub({ net: [2], cra: FUTURE });
  const { remove } = require("./helpers/onem2m");
  const del = await remove(srv.baseUrl, cntSid);
  assert.equal(del.rsc, "2002", `the delete must succeed: ${del.raw.slice(0, 160)}`);
  const noti = await sink.expectNone((i) => i.body?.["m2m:sgn"]?.sur === subSid, { graceMs: 1200 });
  assert.deepEqual(noti, [], "createdAfter(future) cannot match, so no deletion notification");
});
