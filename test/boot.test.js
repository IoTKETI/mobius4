"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");

let srv;
before(async () => { srv = await startServer(); });
after(async () => { if (srv) await srv.stop(); });

test("테스트 전용 인스턴스가 뜨고 CSEBase를 응답한다", async () => {
  const res = await fetch(`${srv.baseUrl}/Mobius`, {
    headers: { "X-M2M-Origin": "SM", "X-M2M-RI": "boot1", "X-M2M-RVI": "3", Accept: "application/json" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-m2m-rsc"), "2000");
  const body = await res.json();
  assert.equal(body["m2m:cb"].rn, "Mobius");
});

test("개발 포트(7599)가 아닌 동적 포트를 쓴다", () => {
  // 개발 인스턴스와 절대 겹치지 않아야 한다 — 겹치면 개발 DB를 두드리게 된다.
  assert.notEqual(srv.port, 7599);
  assert.ok(srv.port > 1024);
});
