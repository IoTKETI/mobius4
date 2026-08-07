"use strict";
// Result Content (rcn) for child resources, and the pagination signal that goes with it.
//
// Where the rules come from
// -------------------------
// The meaning of each rcn value is in TS-0001:8.1.2; the wire structure is not written out in
// prose anywhere — TS-0004:7.5.2 Table 7.5.2-2 says the Content of a R/1,4,5,6,7,8 response is
// the m2m:<resourceType> element and points at CDT-<resourceType>.xsd, and that XSD is where the
// shape actually lives:
//
//     <!-- Child Resources -->
//     <xs:choice minOccurs="0" maxOccurs="1">
//       <xs:element name="childResource" type="m2m:childResourceRef" maxOccurs="unbounded"/>
//       <xs:choice minOccurs="1" maxOccurs="unbounded">
//         <xs:element ref="m2m:contentInstance"/>
//         <xs:element ref="m2m:container"/>          <-- recursive
//         ...
//
// Two things follow. The reference form (rcn 5/6) and the inline form (rcn 4/8) sit in the same
// xs:choice, so a representation carries one or the other and never both. And the inline branch
// refers to *global elements*, so a child carries its own Child Resources block — descendants
// nest. TS-0004:8.4.3 EXAMPLE 3 states it outright: "the subscription resource (sub1) appears
// nested inside its parent (container2)".
//
// What this file covers, and what it deliberately does not
// -------------------------------------------------------
// rcn 5 and 6 were silently ignored before 2026-08-07: both returned exactly what rcn=1 returns,
// with RSC 2000. That is the worst failure mode available — a client asking "what children does
// this have" was told "none", successfully. Same for truncation: rcn 4/8 cut the result at lim
// without ever setting Content Status, so a partial answer was indistinguishable from a complete
// one. Those are what the tests below pin down.
//
// The nesting defect itself is NOT fixed here: rcn 4/8 still return descendants flattened by type
// at the top level. Fixing it changes the response shape for every existing client, so it is
// tracked separately. The test named "...flattens descendants (known deviation...)" asserts the
// *current* behaviour on purpose, so that the day someone implements nesting this file fails and
// makes them come update it rather than leaving a stale expectation behind.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { create, retrieve, createRoot } = require("./helpers/onem2m");
const { startServer } = require("./helpers/server");

let srv, root;
let sensors, temp01, humid01;

before(async () => {
  srv = await startServer();
  root = await createRoot(srv.baseUrl, "rcn");

  // root
  //  └── sensors            cnt   level 1 relative to root
  //      ├── temp01         cnt   level 2
  //      │   ├── t1         cin   level 3
  //      │   └── t2         cin   level 3
  //      ├── humid01        cnt   level 2
  //      │   └── h1         cin   level 3
  //      └── sub-a          sub   level 2
  sensors = `${root.sid}/sensors`;
  temp01 = `${sensors}/temp01`;
  humid01 = `${sensors}/humid01`;

  const mk = async (to, ty, body) => {
    const res = await create(srv.baseUrl, to, ty, body);
    assert.equal(res.rsc, "2001", `setup failed for ${to}: ${res.raw.slice(0, 200)}`);
  };
  await mk(root.sid, 3, { "m2m:cnt": { rn: "sensors" } });
  await mk(sensors, 3, { "m2m:cnt": { rn: "temp01" } });
  await mk(sensors, 3, { "m2m:cnt": { rn: "humid01" } });
  await mk(temp01, 4, { "m2m:cin": { rn: "t1", con: "23.8" } });
  await mk(temp01, 4, { "m2m:cin": { rn: "t2", con: "24.1" } });
  await mk(humid01, 4, { "m2m:cin": { rn: "h1", con: "61" } });
  await mk(sensors, 23, {
    "m2m:sub": { rn: "sub-a", nu: ["http://127.0.0.1:9/never"], nct: 2 },
  });
});

after(async () => {
  if (root) await root.remove();
  if (srv) await srv.stop();
});

// Collects every {key, rn} pair in the response together with how deeply it is nested, so a test
// can talk about structure without hard-coding paths.
function collect(pc) {
  const found = [];
  const walk = (node, depth, key) => {
    if (!node || typeof node !== "object") return;
    if (node.rn !== undefined) found.push({ key, rn: node.rn, depth });
    for (const [k, v] of Object.entries(node)) {
      if (!k.includes(":")) continue;
      for (const item of Array.isArray(v) ? v : [v]) walk(item, depth + 1, k);
    }
  };
  for (const [k, v] of Object.entries(pc)) walk(v, 0, k);
  return found;
}

const rnsAt = (found, depth) => found.filter((f) => f.depth === depth).map((f) => f.rn).sort();

test("rcn=5 returns child references as ch entries of {nm, typ, val}", async () => {
  // TS-0004:8.4.3 EXAMPLE 2 — "ch": [{"nm":"container1","typ":3,"val":"mn-cse/appname/container1"}]
  // The odd-looking "val" is not mobius4 invention: childResourceRef is a simple type carrying XML
  // attributes, and rule 10 of TS-0004:8.4.2 puts the element's own value under that name.
  const res = await retrieve(srv.baseUrl, `${sensors}?rcn=5&lvl=1`);
  assert.equal(res.rsc, "2000");

  const cnt = res.body["m2m:cnt"];
  assert.equal(cnt.rn, "sensors", "rcn=5 keeps the target's own attributes");

  const ch = cnt.ch;
  assert.ok(Array.isArray(ch), `expected a ch array, got ${JSON.stringify(cnt).slice(0, 200)}`);
  assert.deepEqual(
    ch.map((c) => c.nm).sort(),
    ["humid01", "sub-a", "temp01"],
    "lvl=1 means direct children only"
  );
  for (const entry of ch) {
    assert.deepEqual(Object.keys(entry).sort(), ["nm", "typ", "val"]);
    assert.equal(typeof entry.typ, "number", "typ is the numeric resource type");
  }
  assert.equal(ch.find((c) => c.nm === "sub-a").typ, 23);
  assert.equal(ch.find((c) => c.nm === "temp01").val, temp01, "val defaults to the structured ID");

  // The XSD puts the reference list and the inline children in the same xs:choice.
  assert.equal(cnt["m2m:cnt"], undefined, "references and inline children are mutually exclusive");
});

test("rcn=5 omits ch entirely when the target has no children", async () => {
  // An empty array would claim "no children" as a fact; the XSD makes the whole block optional,
  // and there is a real difference between "asked and there were none" and "not reported".
  const empty = `${root.sid}/lonely`;
  assert.equal((await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: "lonely" } })).rsc, "2001");

  const res = await retrieve(srv.baseUrl, `${empty}?rcn=5`);
  assert.equal(res.rsc, "2000");
  assert.equal(res.body["m2m:cnt"].ch, undefined);
});

test("rcn=6 returns m2m:rrl without any representation of the target", async () => {
  // TS-0001:8.1.2 — "without any representation of the actual requested resource". Table 7.5.2-2
  // names the element: m2m:resourceRefList (rrl), of type m2m:listOfChildResourceRef, whose
  // repeated member is resourceRef (rrf).
  const res = await retrieve(srv.baseUrl, `${sensors}?rcn=6&lvl=1`);
  assert.equal(res.rsc, "2000");

  assert.equal(res.body["m2m:cnt"], undefined, "the target's own attributes must not be returned");
  const rrf = res.body["m2m:rrl"].rrf;
  assert.deepEqual(rrf.map((r) => r.nm).sort(), ["humid01", "sub-a", "temp01"]);
});

test("rcn=6 with drt=2 returns unstructured IDs", async () => {
  const res = await retrieve(srv.baseUrl, `${sensors}?rcn=6&drt=2&lvl=1`);
  assert.equal(res.rsc, "2000");

  for (const ref of res.body["m2m:rrl"].rrf) {
    assert.ok(!ref.val.includes("/"), `expected an unstructured ID, got ${ref.val}`);
  }
});

test("rcn=5 descends further when lvl allows it", async () => {
  // lvl counts from the target: TS-0001:8.1.2 filter criteria table — "The level of the target
  // resource itself is zero and the level of the direct children of the target is one."
  const one = await retrieve(srv.baseUrl, `${sensors}?rcn=5&lvl=1`);
  const two = await retrieve(srv.baseUrl, `${sensors}?rcn=5&lvl=2`);

  assert.deepEqual(one.body["m2m:cnt"].ch.map((c) => c.nm).sort(), ["humid01", "sub-a", "temp01"]);
  assert.deepEqual(
    two.body["m2m:cnt"].ch.map((c) => c.nm).sort(),
    ["h1", "humid01", "sub-a", "t1", "t2", "temp01"],
    "lvl=2 reaches the <contentInstance> grandchildren"
  );
});

test("a truncated rcn=4 result reports Content Status and Content Offset", async () => {
  // TS-0001:8.1.2 — "An indication shall be included in the response signalling if the returned
  // content is partial", and 8.1.3 names cnst/cnot. Before this was wired, lim silently cut the
  // result and the client had no way to tell.
  const res = await retrieve(srv.baseUrl, `${sensors}?rcn=4&lim=2`);
  assert.equal(res.rsc, "2000");

  assert.equal(res.cnst, "1", "1 = PARTIAL_CONTENT (TS-0004:6.3.4.2.44)");
  assert.equal(res.cnot, "2", "resume point for the next request's ofst");
});

test("a complete rcn=4 result reports no Content Status", async () => {
  // 8.1.3: "If Content Status parameter is complete, then this parameter shall not be included."
  const res = await retrieve(srv.baseUrl, `${sensors}?rcn=4&lim=50`);
  assert.equal(res.rsc, "2000");
  assert.equal(res.cnst, null);
  assert.equal(res.cnot, null);
});

test("a truncated rcn=6 result reports Content Status too", async () => {
  const res = await retrieve(srv.baseUrl, `${sensors}?rcn=6&lim=2`);
  assert.equal(res.rsc, "2000");
  assert.equal(res.body["m2m:rrl"].rrf.length, 2);
  assert.equal(res.cnst, "1");
});

test("rcn=8 omits the target's own attributes but keeps the children", async () => {
  const res = await retrieve(srv.baseUrl, `${sensors}?rcn=8&lvl=1`);
  assert.equal(res.rsc, "2000");

  const cnt = res.body["m2m:cnt"];
  assert.equal(cnt.rn, undefined, "TS-0001:8.1.2 — parent attributes are not returned for rcn=8");
  assert.deepEqual(cnt["m2m:cnt"].map((c) => c.rn).sort(), ["humid01", "temp01"]);
});

test("rcn=4 flattens descendants (known deviation from TS-0004:8.4.3 EXAMPLE 3)", async () => {
  // EXAMPLE 3 requires t1/t2 to sit inside temp01. mobius4 returns them as siblings of temp01,
  // grouped by type directly under the target, so the parent-child relationship is only
  // recoverable by reading each child's pi.
  //
  // This asserts the deviation rather than the rule on purpose: when nesting is implemented this
  // test fails, which is the point — it is a tripwire, not an endorsement.
  const res = await retrieve(srv.baseUrl, `${sensors}?rcn=4&lvl=2&lim=50`);
  assert.equal(res.rsc, "2000");

  const found = collect(res.body);
  assert.deepEqual(rnsAt(found, 0), ["sensors"]);
  assert.deepEqual(
    rnsAt(found, 1),
    ["h1", "humid01", "sub-a", "t1", "t2", "temp01"],
    "current behaviour: every descendant is one level deep, whatever its real parent"
  );
  assert.equal(rnsAt(found, 2).length, 0, "nothing is nested two deep today");

  // The relationship survives only in pi, which is what a client has to reconstruct from.
  const grand = found.find((f) => f.rn === "t1");
  assert.ok(grand, "t1 is present in the response");
  const t1 = res.body["m2m:cnt"]["m2m:cin"].find((c) => c.rn === "t1");
  const parent = res.body["m2m:cnt"]["m2m:cnt"].find((c) => c.rn === "temp01");
  assert.equal(t1.pi, parent.ri, "t1's real parent is temp01, not the target");
});
