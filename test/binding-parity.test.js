"use strict";
// The same behaviour, asserted over both bindings.
//
// TS-0019:5.1 describes the oneM2M ATS as one set of test purposes over interchangeable lower
// layers, and TS-0019:7.3 carries `bindingProtocol` as a component parameter rather than forking
// the tests. This file is that arrangement in miniature: each test body runs once per binding, and
// the binding is a parameter of the fixture rather than a fork in the assertions.
//
// Until now the suite was HTTP with a few MQTT tests bolted on. Access control, discovery, rcn,
// retention, expiry and group fanout — every core behaviour — went over HTTP only, so a binding
// that derived `op` wrongly, mapped a response status code wrongly, or dropped filterCriteria on
// the floor would leave the suite green. That is not hypothetical for filterCriteria: the MQTT
// helper had nowhere to put `fc` at all, which is why no MQTT discovery test existed.
//
// Only the axes where the bindings actually diverge are here. TS-0009 path forms stay in
// addressing.test.js, topic naming in mqtt.test.js, broker connections in mqtt-outbound.test.js —
// running those twice would assert nothing, because there is no second binding for them to differ
// on. The parameters that do diverge:
//
//                     HTTP (TS-0009)                MQTT (TS-0010)
//   fu / ty / rcn     URL query string              request primitive fields (fc, rcn)
//   originator        X-M2M-Origin header           topic segment
//   operation         method + Content-Type;ty=     primitive `op`
//   correlation       the HTTP round trip           `rqi`
//
// Every TP identifier below was checked against the corpus before being written down, and two of
// the first drafts were wrong in a way worth recording: DMR/CRE/001 is "resource name **not**
// provided" and these tests provide one, so the right identifier is CRE/002_CNT; and DMR/UPD/001 is
// parameterized, so the real identifier carries the attribute -- UPD/001_CNT/LBL, not UPD/001_CNT.
// An identifier that reads as a citation and is not one is worse than none.
//
// The test purposes these assertions come from are named per test where one exists. Response codes
// follow TS-0004:6.3.4.2.6 and are the same numbers in both bindings — HTTP carries them in
// X-M2M-RSC, MQTT in the primitive, which test/helpers/binding.js normalizes so that the assertion
// is about the code and not about its JavaScript type.

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const { BINDINGS, startBindingContext } = require("./helpers/binding");
const { uniqueRn, CSE_BASE } = require("./helpers/onem2m");

for (const binding of BINDINGS) {
  describe(`binding=${binding}`, () => {
    let ctx, rootSid;

    before(async () => {
      // One server, and for MQTT one broker, for the whole group.
      ctx = await startBindingContext(binding);
      const rn = uniqueRn(`bp-${binding}`);
      const res = await ctx.create(CSE_BASE, 3, { "m2m:cnt": { rn } });
      assert.equal(res.rsc, "2001", `setup root: ${res.raw.slice(0, 200)}`);
      rootSid = `${CSE_BASE}/${rn}`;
    });

    after(async () => {
      if (ctx) {
        await ctx.remove(rootSid).catch(() => { /* the stop below is what matters */ });
        await ctx.stop();
      }
    });

    // --- operations -------------------------------------------------------------------------

    test(`TP/oneM2M/CSE/DMR/CRE/002_CNT — create a <container> with a name provided, and get it back [${binding}]`, async () => {
      const rn = uniqueRn("c");
      const created = await ctx.create(rootSid, 3, { "m2m:cnt": { rn } });
      assert.equal(created.rsc, "2001", `create: ${created.raw.slice(0, 200)}`);

      const got = await ctx.retrieve(`${rootSid}/${rn}`);
      assert.equal(got.rsc, "2000", `retrieve: ${got.raw.slice(0, 200)}`);
      assert.equal(got.pc["m2m:cnt"].rn, rn);
    });

    test(`TP/oneM2M/CSE/DMR/UPD/001_CNT/LBL — update a <container> label [${binding}]`, async () => {
      const rn = uniqueRn("u");
      await ctx.create(rootSid, 3, { "m2m:cnt": { rn } });

      const updated = await ctx.update(`${rootSid}/${rn}`, { "m2m:cnt": { lbl: ["parity"] } });
      assert.equal(updated.rsc, "2004", `update: ${updated.raw.slice(0, 200)}`);

      const got = await ctx.retrieve(`${rootSid}/${rn}`);
      assert.deepEqual(got.pc["m2m:cnt"].lbl, ["parity"]);
    });

    test(`TP/oneM2M/CSE/DMR/DEL/001_CNT — delete a <container> [${binding}]`, async () => {
      const rn = uniqueRn("d");
      await ctx.create(rootSid, 3, { "m2m:cnt": { rn } });

      const deleted = await ctx.remove(`${rootSid}/${rn}`);
      assert.equal(deleted.rsc, "2002", `delete: ${deleted.raw.slice(0, 200)}`);

      const got = await ctx.retrieve(`${rootSid}/${rn}`);
      assert.equal(got.rsc, "4004", "a deleted resource must not be retrievable");
    });

    // --- filterCriteria transport ------------------------------------------------------------
    //
    // The axis the two bindings most obviously differ on, and the one that had no MQTT coverage at
    // all because the helper could not express it.

    test(`discovery narrows by resource type [${binding}]`, async () => {
      const rn = uniqueRn("disc");
      await ctx.create(rootSid, 3, { "m2m:cnt": { rn } });
      const sid = `${rootSid}/${rn}`;
      await ctx.create(sid, 3, { "m2m:cnt": { rn: uniqueRn("child") } });
      await ctx.create(sid, 4, { "m2m:cin": { con: "parity" } });

      const all = await ctx.discover(sid);
      assert.equal(all.rsc, "2000", `discovery: ${all.raw.slice(0, 200)}`);
      assert.equal(ctx.urils(all).length, 2, `both children should be discoverable: ${all.raw.slice(0, 200)}`);

      // ty is a list in the primitive; the HTTP side repeats the query parameter and the MQTT side
      // sends the array. That difference is precisely what the adapter absorbs.
      const cinOnly = await ctx.discover(sid, { ty: [4] });
      assert.equal(cinOnly.rsc, "2000", `filtered discovery: ${cinOnly.raw.slice(0, 200)}`);
      const list = ctx.urils(cinOnly);
      assert.equal(list.length, 1, `only the <contentInstance> should match: ${JSON.stringify(list)}`);
    });

    test(`lim bounds a discovery result [${binding}]`, async () => {
      const rn = uniqueRn("lim");
      await ctx.create(rootSid, 3, { "m2m:cnt": { rn } });
      const sid = `${rootSid}/${rn}`;
      for (let i = 0; i < 3; i++) await ctx.create(sid, 4, { "m2m:cin": { con: `v${i}` } });

      const limited = await ctx.discover(sid, { ty: [4], lim: 2 });
      assert.equal(limited.rsc, "2000", `discovery: ${limited.raw.slice(0, 200)}`);
      assert.equal(ctx.urils(limited).length, 2);
    });

    // --- rcn transport -----------------------------------------------------------------------

    test(`rcn=4 returns the child resources [${binding}]`, async () => {
      const rn = uniqueRn("rcn");
      await ctx.create(rootSid, 3, { "m2m:cnt": { rn } });
      const sid = `${rootSid}/${rn}`;
      await ctx.create(sid, 4, { "m2m:cin": { con: "in-rcn" } });

      const got = await ctx.retrieve(sid, { rcn: 4 });
      assert.equal(got.rsc, "2000", `rcn=4: ${got.raw.slice(0, 200)}`);
      const cnt = got.pc["m2m:cnt"];
      assert.ok(cnt["m2m:cin"], `the child <contentInstance> should be nested in the response: ${got.raw.slice(0, 300)}`);
    });

    // --- virtual resources -------------------------------------------------------------------

    test(`TP/oneM2M/CSE/DMR/RET/012 — <latest> over both bindings [${binding}]`, async () => {
      const rn = uniqueRn("la");
      await ctx.create(rootSid, 3, { "m2m:cnt": { rn } });
      const sid = `${rootSid}/${rn}`;
      await ctx.create(sid, 4, { "m2m:cin": { con: "older" } });
      const newest = await ctx.create(sid, 4, { "m2m:cin": { con: "newest" } });

      const la = await ctx.retrieve(`${sid}/la`);
      assert.equal(la.rsc, "2000", `<latest>: ${la.raw.slice(0, 200)}`);
      assert.equal(la.pc["m2m:cin"].rn, newest.pc["m2m:cin"].rn);
    });

    // --- error paths -------------------------------------------------------------------------
    //
    // Response status codes are the one thing a binding can get wrong without any test noticing,
    // because each binding carries them differently: HTTP in X-M2M-RSC alongside a status line,
    // MQTT as a number in the primitive.

    test(`a missing target answers 4004 [${binding}]`, async () => {
      const got = await ctx.retrieve(`${rootSid}/${uniqueRn("nope")}`);
      assert.equal(got.rsc, "4004", `expected NOT_FOUND: ${got.raw.slice(0, 200)}`);
    });

    test(`a <CSEBase> UPDATE answers 4005 for every originator [${binding}]`, async () => {
      // TS-0004:7.4.3.2.3 rejects this at message-syntax time, before access control, so the
      // answer does not depend on who asks — which makes it a clean check that the binding
      // derived `op` correctly rather than falling through to something else.
      const got = await ctx.update(CSE_BASE, { "m2m:cb": { lbl: ["nope"] } });
      assert.equal(got.rsc, "4005", `expected OPERATION_NOT_ALLOWED: ${got.raw.slice(0, 200)}`);
    });

    test(`a malformed create answers 4000 [${binding}]`, async () => {
      // <AE> requires api (TS-0001:9.6.5). Omitting it must be a client error in either binding.
      const got = await ctx.create(CSE_BASE, 2, { "m2m:ae": { rn: uniqueRn("bad"), rr: true } }, { originator: "Cparitybad" });
      assert.equal(got.rsc, "4000", `expected BAD_REQUEST: ${got.raw.slice(0, 200)}`);
    });

    // --- registration ------------------------------------------------------------------------

    test(`TP/oneM2M/CSE/REG/CRE/001_CAE — an <AE> registers with a C-AE-ID-Stem in From [${binding}]`, async () => {
      // Sent as an originator that is not the administrator, which on the MQTT side means a
      // second client with its own topic pair — the originator lives in the topic there and in a
      // header over HTTP.
      const credential = `Cparity${binding}`;
      const rn = uniqueRn("ae");
      const got = await ctx.create(CSE_BASE, 2, { "m2m:ae": { rn, api: "Nparity.test", rr: true } }, { originator: credential });

      assert.equal(got.rsc, "2001", `registration: ${got.raw.slice(0, 200)}`);
      assert.ok(got.pc["m2m:ae"].aei, "an AE-ID must be assigned");
      await ctx.remove(`${CSE_BASE}/${rn}`);
    });
  });
}
