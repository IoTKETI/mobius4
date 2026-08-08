"use strict";
// contentSize is a count of bytes, not of JavaScript string units.
//
// TS-0001:9.6.7 Table 9.6.7-2 defines contentSize as "Size in bytes of the content attribute".
// mobius4 reported the in-memory footprint instead (string.length * 2), which is neither the
// UTF-8 nor the UTF-16 byte count of anything on the wire:
//
//   "abc"   3 UTF-8 bytes  ->  reported 6
//   "한글"   6 UTF-8 bytes  ->  reported 4
//
// It was not only cosmetic. Reported from a deployment: a <container> with maxByteSizePerInstance
// of 10 refused a 10-byte ASCII payload with 5207 NOT_ACCEPTABLE, because 10 characters counted
// as 20. cbs, mbs and the sizeAbove/sizeBelow filters read the same figure.
//
// What the standard means by "size in bytes" is still open where structured content is concerned
// (which serialization? — SQ-003 in mobius4-dev-tool). These tests pin down only what is not in
// doubt: a string's own UTF-8 bytes.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { create, retrieve, createRoot } = require("./helpers/onem2m");
const { startServer } = require("./helpers/server");

let srv, root, cnt;

before(async () => {
  srv = await startServer();
  root = await createRoot(srv.baseUrl, "cs");
  cnt = `${root.sid}/c`;
  assert.equal((await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: "c" } })).rsc, "2001");
});

after(async () => {
  if (root) await root.remove();
  if (srv) await srv.stop();
});

const cases = [
  { con: "abc", bytes: 3, note: "ASCII" },
  { con: "0123456789", bytes: 10, note: "ASCII, exactly the mbis boundary below" },
  { con: "한글", bytes: 6, note: "3 bytes per character in UTF-8" },
  { con: "가나다", bytes: 9, note: "the old sizer said 6" },
  { con: "", bytes: 0, note: "empty" },
];

for (const { con, bytes, note } of cases) {
  test(`cs is the UTF-8 byte count for ${JSON.stringify(con)} (${note})`, async () => {
    const res = await create(srv.baseUrl, cnt, 4, { "m2m:cin": { con } });
    assert.equal(res.rsc, "2001");
    assert.equal(res.body["m2m:cin"].cs, bytes);
    assert.equal(res.body["m2m:cin"].cs, Buffer.byteLength(con, "utf8"));
  });
}

test("a 10-byte payload is accepted by maxByteSizePerInstance of 10", async () => {
  // The interop failure that was actually observed. The boundary is inclusive:
  // TS-0004:7.4.7.2.1 step 1 refuses content *bigger* than the limit.
  const bounded = `${root.sid}/bounded`;
  assert.equal(
    (await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: "bounded", mbis: 10 } })).rsc,
    "2001"
  );

  const ok = await create(srv.baseUrl, bounded, 4, { "m2m:cin": { con: "0123456789" } });
  assert.equal(ok.rsc, "2001", "10 bytes must fit a 10-byte limit");
  assert.equal(ok.body["m2m:cin"].cs, 10);

  const over = await create(srv.baseUrl, bounded, 4, { "m2m:cin": { con: "01234567890" } });
  assert.equal(over.rsc, "5207", "11 bytes must not");
});

test("currentByteSize is the sum of the instances' byte counts", async () => {
  const acc = `${root.sid}/acc`;
  assert.equal((await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: "acc" } })).rsc, "2001");

  for (const con of ["abc", "한글"]) {
    assert.equal((await create(srv.baseUrl, acc, 4, { "m2m:cin": { con } })).rsc, "2001");
  }

  const res = await retrieve(srv.baseUrl, acc);
  assert.equal(res.body["m2m:cnt"].cbs, 9, "3 + 6");
  assert.equal(res.body["m2m:cnt"].cni, 2);
});
