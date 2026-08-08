"use strict";
// Result Content on DELETE.
//
// TS-0001:8.1.2 Table 8.1.2-1 marks rcn 4 (attributes and child resources), 5 (attributes and
// child resource references), 6 (child resource references) and 8 (child resources) valid for
// Delete as well as Retrieve. The Originator is asking to be shown what is about to disappear —
// which is the only chance to see it.
//
// mobius4 accepted those values and then answered with the target's own attributes, the same as
// rcn=1. Nothing said the request had been only half honoured.
//
// The snapshot is taken before the rows are removed, and separately from the object the
// notification path and the parent's cbs bookkeeping read — those expect the plain
// single-resource shape, and handing them a nested tree would break them quietly.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { create, retrieve, remove, request, createRoot, uniqueRn } = require("./helpers/onem2m");
const { startServer } = require("./helpers/server");

let srv, root;

before(async () => {
  srv = await startServer();
  root = await createRoot(srv.baseUrl, "delrcn");
});

after(async () => {
  if (root) await root.remove();
  if (srv) await srv.stop();
});

// A fresh subtree per test:  <rn>/ { temp01/{t1,t2}, humid01/{h1}, sub-a }
async function makeTree() {
  const rn = uniqueRn("t");
  const base = `${root.sid}/${rn}`;
  const mk = async (to, ty, body) => {
    const res = await create(srv.baseUrl, to, ty, body);
    assert.equal(res.rsc, "2001", `setup failed for ${to}: ${res.raw.slice(0, 160)}`);
  };
  await mk(root.sid, 3, { "m2m:cnt": { rn } });
  await mk(base, 3, { "m2m:cnt": { rn: "temp01" } });
  await mk(base, 3, { "m2m:cnt": { rn: "humid01" } });
  await mk(`${base}/temp01`, 4, { "m2m:cin": { rn: "t1", con: "1" } });
  await mk(`${base}/temp01`, 4, { "m2m:cin": { rn: "t2", con: "2" } });
  await mk(`${base}/humid01`, 4, { "m2m:cin": { rn: "h1", con: "3" } });
  await mk(base, 23, { "m2m:sub": { rn: "sub-a", nu: ["http://127.0.0.1:9/x"], nct: 2 } });
  return base;
}

const del = (to, query = "") =>
  request(srv.baseUrl, { method: "DELETE", to: query ? `${to}?${query}` : to });

test("rcn=4 returns the deleted resource with its children nested", async () => {
  const base = await makeTree();
  const res = await del(base, "rcn=4&lvl=2&lim=50");

  assert.equal(res.rsc, "2002", "the delete still succeeds");

  const top = res.body["m2m:cnt"];
  assert.ok(top.rn, "the target's own attributes are present");
  const temp01 = top["m2m:cnt"].find((c) => c.rn === "temp01");
  assert.deepEqual(temp01["m2m:cin"].map((c) => c.rn).sort(), ["t1", "t2"],
    "grandchildren nest inside their own parent, as on a retrieve");
  assert.deepEqual(top["m2m:sub"].map((c) => c.rn), ["sub-a"]);
});

test("the subtree is actually gone afterwards", async () => {
  // The snapshot must not turn the delete into a read.
  const base = await makeTree();
  assert.equal((await del(base, "rcn=4&lvl=2&lim=50")).rsc, "2002");

  const after_delete = await retrieve(srv.baseUrl, base);
  assert.equal(after_delete.rsc, "4004");
  assert.equal((await retrieve(srv.baseUrl, `${base}/temp01/t1`)).rsc, "4004");
});

test("rcn=8 returns the children without the target's attributes", async () => {
  const base = await makeTree();
  const res = await del(base, "rcn=8&lvl=2&lim=50");

  assert.equal(res.rsc, "2002");
  const top = res.body["m2m:cnt"];
  assert.equal(top.rn, undefined, "TS-0001:8.1.2 — the parent's attributes are not returned");
  const temp01 = top["m2m:cnt"].find((c) => c.rn === "temp01");
  assert.deepEqual(temp01["m2m:cin"].map((c) => c.rn).sort(), ["t1", "t2"]);
});

test("rcn=5 returns the target plus references to what went with it", async () => {
  const base = await makeTree();
  const res = await del(base, "rcn=5&lvl=1");

  assert.equal(res.rsc, "2002");
  const top = res.body["m2m:cnt"];
  assert.ok(top.rn);
  assert.deepEqual(top.ch.map((c) => c.nm).sort(), ["humid01", "sub-a", "temp01"]);
  for (const entry of top.ch) assert.deepEqual(Object.keys(entry).sort(), ["nm", "typ", "val"]);
});

test("rcn=6 returns references only", async () => {
  const base = await makeTree();
  const res = await del(base, "rcn=6&lvl=1");

  assert.equal(res.rsc, "2002");
  assert.equal(res.body["m2m:cnt"], undefined, "no representation of the target itself");
  assert.deepEqual(res.body["m2m:rrl"].rrf.map((r) => r.nm).sort(),
    ["humid01", "sub-a", "temp01"]);
});

test("rcn=1 still returns the target's attributes only", async () => {
  const base = await makeTree();
  const res = await del(base, "rcn=1");

  assert.equal(res.rsc, "2002");
  assert.ok(res.body["m2m:cnt"].rn);
  assert.equal(res.body["m2m:cnt"]["m2m:cnt"], undefined, "no children for rcn=1");
});

test("the default delete still returns nothing", async () => {
  // TS-0001:8.1.2 — "nothing" is the default Result Content for Delete.
  const base = await makeTree();
  const res = await del(base);

  assert.equal(res.rsc, "2002");
  assert.equal(res.body, null, `expected an empty body, got ${res.raw.slice(0, 120)}`);
});

test("an rcn that is n/a for Delete is still refused", async () => {
  const base = await makeTree();
  const res = await del(base, "rcn=2");

  assert.equal(res.rsc, "4000");
  assert.match(res.body["m2m:dbg"], /rcn/);
});

test("a truncated delete snapshot reports Content Status", async () => {
  // Same pagination rules as a retrieve: whole subtrees only, and the response says when it
  // could not carry them all (TS-0001:8.1.2, 8.1.3).
  const base = await makeTree();
  const res = await del(base, "rcn=4&lim=2");

  assert.equal(res.rsc, "2002");
  assert.equal(res.cnst, "1");
  assert.ok(res.cnot !== null, "a resume offset comes with it");
});

test("deleting a <contentInstance> with rcn=4 still keeps the parent's counters right", async () => {
  // The snapshot is built separately from the object the cbs bookkeeping reads. If those were
  // ever merged, this is the test that would catch it.
  const base = await makeTree();
  const before_del = await retrieve(srv.baseUrl, `${base}/temp01`);
  const cbs_before = before_del.body["m2m:cnt"].cbs;
  const cni_before = before_del.body["m2m:cnt"].cni;

  assert.equal((await del(`${base}/temp01/t1`, "rcn=4")).rsc, "2002");

  const after_del = await retrieve(srv.baseUrl, `${base}/temp01`);
  assert.equal(after_del.body["m2m:cnt"].cni, cni_before - 1);
  assert.equal(after_del.body["m2m:cnt"].cbs, cbs_before - 1, "one byte of content went away");
});
