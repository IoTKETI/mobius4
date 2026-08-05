"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, retrieve, update, remove, createRoot, uniqueRn, CSE_BASE, waitForSubtreeGone } = require("./helpers/onem2m");

let srv, root;
before(async () => { srv = await startServer(); root = await createRoot(srv.baseUrl); });
after(async () => { if (root) await root.remove(); if (srv) await srv.stop(); });

test("the response code arrives in the X-M2M-RSC header, and the body carries no rsc", async () => {
  const res = await retrieve(srv.baseUrl, root.sid);
  assert.equal(res.rsc, "2000");
  assert.equal(res.body.rsc, undefined);
  assert.ok(res.body["m2m:cnt"], "the body should be a resource representation");
});

test("RSC values: create 2001 / retrieve 2000 / delete 2002", async () => {
  const rn = uniqueRn("rsc");
  const c = await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn } });
  assert.equal(c.rsc, "2001");
  assert.equal(c.status, 201);

  const r = await retrieve(srv.baseUrl, `${root.sid}/${rn}`);
  assert.equal(r.rsc, "2000");

  const d = await remove(srv.baseUrl, `${root.sid}/${rn}`);
  assert.equal(d.rsc, "2002");
});

test("the con attribute round-trips as a JSON object", async () => {
  const rn = uniqueRn("con");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn } });
  const payload = { temp: 21.5, unit: "C", nested: { ok: true } };
  const c = await create(srv.baseUrl, `${root.sid}/${rn}`, 4, { "m2m:cin": { con: payload } });
  assert.equal(c.rsc, "2001");
  assert.deepEqual(c.body["m2m:cin"].con, payload);

  const back = await retrieve(srv.baseUrl, `${root.sid}/${rn}/la`);
  assert.deepEqual(back.body["m2m:cin"].con, payload);
});

test("UPDATE works with PUT plus a Content-Type that carries no ty", async () => {
  // op is derived from the Content-Type, not from the HTTP method (code map L-2).
  // With no ';' present the method decides op, so PUT -> op=3 (UPDATE).
  const rn = uniqueRn("upd");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn } });
  const u = await update(srv.baseUrl, `${root.sid}/${rn}`, { "m2m:cnt": { lbl: ["tag-a"] } });
  assert.equal(u.rsc, "2004");
  const r = await retrieve(srv.baseUrl, `${root.sid}/${rn}`);
  assert.deepEqual(r.body["m2m:cnt"].lbl, ["tag-a"]);
});

test("the <CSEBase> cannot be DELETEd", async () => {
  // Code map G-1: the guard that actually takes effect is case 5 of the switch(to_ty) in
  // delete_a_res.
  const d = await remove(srv.baseUrl, CSE_BASE);
  assert.equal(d.rsc, "4005");
  // Confirm it really was not deleted — without this assertion one could read the code alone
  // and mistakenly believe the test passed.
  const still = await retrieve(srv.baseUrl, CSE_BASE);
  assert.equal(still.rsc, "2000");
});

// TP/oneM2M/CSE/REG/UPD/001 and TP/oneM2M/CSE/REG/DEL/001 send these from a registered AE, not
// from the administrator. TS-0004:7.4.3.2.3 and 7.4.3.2.4 both place the rejection at Recv-1.0
// "check the syntax of received message" — before access control — so the answer is 4005
// whoever asks. The test above only covers the administrator, who reaches the 4005 in
// delete_a_res because the admin ACP lets it through access control first.
test("a registered AE gets 4005, not 4103, on UPDATE and DELETE of the <CSEBase>", async () => {
  const rn = uniqueRn("ae");
  const reg = await create(srv.baseUrl, CSE_BASE, 2,
    { "m2m:ae": { rn, api: "Nconf", rr: false } }, { originator: "C" });
  assert.equal(reg.rsc, "2001", `AE registration failed: ${reg.raw.slice(0, 200)}`);
  const aei = reg.body["m2m:ae"].aei;

  try {
    const u = await update(srv.baseUrl, CSE_BASE,
      { "m2m:cb": { lbl: ["VALUE_1"] } }, { originator: aei });
    assert.equal(u.rsc, "4005", `UPDATE of the <CSEBase> answered ${u.rsc}`);

    const d = await remove(srv.baseUrl, CSE_BASE, { originator: aei });
    assert.equal(d.rsc, "4005", `DELETE of the <CSEBase> answered ${d.rsc}`);

    // The <CSEBase> must still be there — a rejected request that nevertheless mutated state
    // would pass the two assertions above.
    const still = await retrieve(srv.baseUrl, CSE_BASE);
    assert.equal(still.rsc, "2000");
  } finally {
    await remove(srv.baseUrl, `${CSE_BASE}/${rn}`);
  }
});

test("a fanout response is wrapped in an m2m:agr envelope", async () => {
  // Measured behavior differs from the brief's assumption: mobius4 can only create a <grp>
  // under ae/rce/cb (grp_parent_res_types in cse/resources/grp.js), and creating one under a
  // cnt (root) yields 4108. So the group is created directly under the <CSEBase>, and only
  // its members point at containers below root.
  const a = uniqueRn("m1"), b = uniqueRn("m2"), g = uniqueRn("grp");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: a } });
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: b } });
  const grp = await create(srv.baseUrl, CSE_BASE, 9, {
    "m2m:grp": { rn: g, mt: 3, mnm: 10, mid: [`${root.sid}/${a}`, `${root.sid}/${b}`] },
  });
  assert.equal(grp.rsc, "2001");
  const gsid = `${CSE_BASE}/${g}`;

  try {
    const fo = await retrieve(srv.baseUrl, `${gsid}/fopt`);
    const agr = fo.body["m2m:agr"];
    assert.ok(agr, `an m2m:agr envelope should be present. actual: ${fo.raw.slice(0, 300)}`);
    // 'm2m:rsp', not 'rsp' — it is m2m:responsePrimitive in the TS-0004 symbol table, namespaced
    // like the m2m:agr envelope around it.
    const rsp = agr["m2m:rsp"];
    assert.ok(Array.isArray(rsp), `agr["m2m:rsp"] should be an array. actual keys: ${Object.keys(agr)}`);
    assert.equal(rsp.length, 2);
    for (const r of rsp) {
      assert.ok("rsc" in r && "rqi" in r && "pc" in r, `rsp entry shape: ${JSON.stringify(r)}`);
    }
  } finally {
    // It was created outside the root subtree (directly under the <CSEBase>), so root.remove()
    // will not clear it — clean it up here. Since delete_a_res deletes the target resource
    // itself fire-and-forget too (hostingCSE.js:559), the grp is subject to the same race as
    // root — poll the same way to confirm it really is gone.
    await remove(srv.baseUrl, gsid);
    await waitForSubtreeGone(srv.baseUrl, gsid);
  }
});

test("an underscore in a name does not drag in sibling resources (deletion)", async () => {
  // The LIKE condition that delete_a_res uses to collect descendants shares the same
  // escaping defect as discovery. When deleting 'a_c-…', the '_' position matches any
  // character, so if the descendants of 'abc-…' get deleted along with it, someone else's
  // resources are destroyed. Reproduce it with the same naming rule (the underscore position
  // lining up exactly with the sibling) — relying on uniqueRn's random suffix would let the
  // names miss each other by chance and the defect would slip through.
  const tag = uniqueRn("t").slice(-6);
  const under = `a_c-${tag}`;
  const other = `abc-${tag}`;
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: under } });
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: other } });
  const cin = await create(srv.baseUrl, `${root.sid}/${other}`, 4, { "m2m:cin": { con: { v: "sibling-owned" } } });

  const d = await remove(srv.baseUrl, `${root.sid}/${under}`);
  assert.equal(d.rsc, "2002");

  const stillThere = await retrieve(srv.baseUrl, `${root.sid}/${other}/${cin.body["m2m:cin"].rn}`);
  assert.equal(stillThere.rsc, "2000", "the sibling's descendant was deleted along with it");
});
