"use strict";
// notificationContentType: what a notification carries, and which values go with which event.
//
// TS-0004:7.5.1.2.2 step 2.1 defines the five values, TS-0001:9.6.8 table 9.6.8-4 says which are
// valid for each notificationEventType, and the same step 2.1 says when subscribedTo must and must
// not be present. Only two of the five did anything before: "All Attributes" by being the
// fall-through, and "Modified Attributes" by sending back the request body -- which is not what
// the clause asks for.
//
// TS-0018에 해당 TP 없음 for everything in this file. TP/oneM2M/CSE/SUB/CRE/011_NCT and 012_NCT
// exist but check only that a <subscription> carrying a notificationContentType is accepted, not
// what the resulting notification contains.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, update, createRoot, uniqueRn } = require("./helpers/onem2m");
const { startSink, netOf } = require("./helpers/noti-sink");

let srv, root, sink;

before(async () => {
  srv = await startServer();
  sink = await startSink();
  root = await createRoot(srv.baseUrl, "nctc");
});
after(async () => {
  if (root) await root.remove();
  if (sink) await sink.stop();
  if (srv) await srv.stop();
});

// oneM2M timestamps have one-second resolution, so an update in the same second as the resource's
// last modification leaves lastModifiedTime with the same value -- it genuinely did not change,
// and a test that did not cross a second boundary would be asserting nothing about it.
async function crossSecondBoundary() {
  const start = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === start) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function cntWithSub(nct, enc = { net: [1] }, cntBody = {}) {
  const cnt = uniqueRn("c");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: cnt, ...cntBody } });
  const sub = uniqueRn("s");
  const res = await create(srv.baseUrl, `${root.sid}/${cnt}`, 23, {
    "m2m:sub": { rn: sub, nu: [sink.url], enc, nct },
  });
  return { res, cntSid: `${root.sid}/${cnt}`, subSid: `${root.sid}/${cnt}/${sub}` };
}

async function notified(subSid) {
  return (await sink.waitFor((i) => i.body?.["m2m:sgn"]?.sur === subSid, { timeoutMs: 4000 }))
    .body["m2m:sgn"];
}

test("Modified Attributes carries attributes the request never named", async () => {
  // The clause says "the partial resource containing modified attribute(s) only". Modified, not
  // requested: an UPDATE moves lastModifiedTime, and a <container> UPDATE moves stateTag too.
  // Sending back only what the Originator asked to change described a resource state that never
  // existed.
  const { res, cntSid, subSid } = await cntWithSub(2, { net: [1] }, { lbl: ["before"] });
  assert.equal(res.rsc, "2001", `setup failed: ${res.raw.slice(0, 160)}`);

  await crossSecondBoundary();
  const upd = await update(srv.baseUrl, cntSid, { "m2m:cnt": { lbl: ["after"] } });
  assert.equal(upd.rsc, "2004", `the update must succeed: ${upd.raw.slice(0, 160)}`);

  const rep = (await notified(subSid)).nev.rep["m2m:cnt"];
  const names = Object.keys(rep).sort();
  assert.ok(names.includes("lbl"), `the requested attribute: ${names}`);
  assert.ok(names.includes("lt"), `lastModifiedTime moved and must be reported: ${names}`);
  assert.ok(names.includes("st"), `a <container>'s stateTag moves on UPDATE: ${names}`);
  assert.deepEqual(rep.lbl, ["after"]);

  // Still partial. "Modified attributes only" is the other half of the sentence, and a full
  // representation would pass every assertion above.
  assert.ok(!names.includes("ri"), `unchanged attributes must not be included: ${names}`);
  assert.ok(!names.includes("ct"), `creationTime cannot have changed: ${names}`);
});

test("Modified Attributes reports a removed attribute as null", async () => {
  // The clause does not say how a partial resource spells a deletion. Omitting it would make
  // "removed" indistinguishable from "unchanged", and null is how an UPDATE asks for the removal
  // in the first place.
  const { cntSid, subSid } = await cntWithSub(2, { net: [1] }, { lbl: ["gone"] });
  await crossSecondBoundary();
  const upd = await update(srv.baseUrl, cntSid, { "m2m:cnt": { lbl: null } });
  assert.equal(upd.rsc, "2004", `the update must succeed: ${upd.raw.slice(0, 160)}`);

  const rep = (await notified(subSid)).nev.rep["m2m:cnt"];
  assert.ok("lbl" in rep, `the removal must be reported: ${Object.keys(rep)}`);
  assert.equal(rep.lbl, null);
});

test("All Attributes is unchanged — the whole resource", async () => {
  const { cntSid, subSid } = await cntWithSub(1);
  await update(srv.baseUrl, cntSid, { "m2m:cnt": { lbl: ["x"] } });
  const rep = (await notified(subSid)).nev.rep["m2m:cnt"];
  for (const attr of ["ri", "rn", "pi", "ct", "lt", "ty"]) {
    assert.ok(attr in rep, `${attr} should be there: ${Object.keys(rep)}`);
  }
});

test("ResourceID sends the URI of the resource, not the resource", async () => {
  // "the Notify request primitive shall include the URI of the resource". It used to send the
  // whole representation -- a subscriber that asked for an identifier got the payload it was
  // trying to avoid, and nothing in the response said so.
  const { cntSid, subSid } = await cntWithSub(3);
  await update(srv.baseUrl, cntSid, { "m2m:cnt": { lbl: ["y"] } });
  const sgn = await notified(subSid);
  assert.deepEqual(Object.keys(sgn.nev.rep), ["m2m:uri"]);
  assert.equal(sgn.nev.rep["m2m:uri"], cntSid, "the subscribed-to resource for net=1");
});

test("ResourceID names the child, not the parent, for a child event", async () => {
  const { cntSid, subSid } = await cntWithSub(3, { net: [3], chty: [4] });
  const cin = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: "z" } });
  assert.equal(cin.rsc, "2001", `setup failed: ${cin.raw.slice(0, 160)}`);
  const sgn = await notified(subSid);
  assert.equal(sgn.nev.rep["m2m:uri"], `${cntSid}/${cin.body["m2m:cin"].rn}`);
});

test("subscribedTo is present exactly when the clause says it is", async () => {
  // "if notificationContentType is set to one of Modified Attributes, Trigger Payload or TimeSeries
  // notification then the subscribedTo attribute ... shall contain the resource ID of the
  // subscribed-to resource. Otherwise, the subscribedTo attribute shall not be present."
  // Both halves. It was never sent at all.
  const modified = await cntWithSub(2);
  await crossSecondBoundary();
  await update(srv.baseUrl, modified.cntSid, { "m2m:cnt": { lbl: ["m"] } });
  assert.equal((await notified(modified.subSid)).sut, modified.cntSid);

  for (const nct of [1, 3]) {
    const other = await cntWithSub(nct);
    await update(srv.baseUrl, other.cntSid, { "m2m:cnt": { lbl: ["o"] } });
    const sgn = await notified(other.subSid);
    assert.equal(sgn.sut, undefined, `nct=${nct} must not carry subscribedTo: ${JSON.stringify(sgn.sut)}`);
  }
});

test("a notificationContentType invalid for the event type is refused", async () => {
  // TS-0001:9.6.8 table 9.6.8-4. Every one of these was accepted and then ignored.
  const invalid = [
    [2, { net: [3] }, "Modified Attributes says nothing about a child that was created"],
    [2, { net: [2] }, "nor about a resource that was deleted"],
    [4, { net: [1] }, "Trigger Payload belongs to net=6"],
    [5, { net: [1] }, "TimeSeries notification belongs to net=8"],
    [2, { net: [1, 3] }, "valid for one event type is not valid for the subscription"],
  ];
  for (const [nct, enc, why] of invalid) {
    const { res } = await cntWithSub(nct, enc);
    assert.equal(res.rsc, "4000", `nct=${nct} with net=${JSON.stringify(enc.net)} — ${why}: got ${res.rsc}`);
  }
});

test("the combinations the table allows are accepted", async () => {
  for (const [nct, enc] of [[1, { net: [1] }], [2, { net: [1] }], [3, { net: [1] }],
                            [1, { net: [3] }], [3, { net: [3] }],
                            [1, { net: [2] }], [3, { net: [2] }]]) {
    const { res } = await cntWithSub(nct, enc);
    assert.equal(res.rsc, "2001", `nct=${nct} with net=${JSON.stringify(enc.net)} should be accepted: ${res.raw.slice(0, 160)}`);
  }
});

test("an omitted notificationContentType behaves as All Attributes for net=1", async () => {
  // Table 9.6.8-4 makes "All Attributes" the default for event types A to E.
  const { cntSid, subSid } = await cntWithSub(undefined);
  await update(srv.baseUrl, cntSid, { "m2m:cnt": { lbl: ["d"] } });
  const sgn = await notified(subSid);
  assert.ok("ri" in sgn.nev.rep["m2m:cnt"], "the default is the whole resource");
  assert.equal(sgn.sut, undefined, "and it carries no subscribedTo");
});
