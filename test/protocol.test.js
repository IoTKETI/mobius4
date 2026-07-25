"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, retrieve, update, remove, createRoot, uniqueRn, CSE_BASE, waitForSubtreeGone } = require("./helpers/onem2m");

let srv, root;
before(async () => { srv = await startServer(); root = await createRoot(srv.baseUrl); });
after(async () => { if (root) await root.remove(); if (srv) await srv.stop(); });

test("응답 코드는 X-M2M-RSC 헤더로 오고 바디에는 rsc가 없다", async () => {
  const res = await retrieve(srv.baseUrl, root.sid);
  assert.equal(res.rsc, "2000");
  assert.equal(res.body.rsc, undefined);
  assert.ok(res.body["m2m:cnt"], "바디는 리소스 표현이어야 한다");
});

test("RSC 값: 생성 2001 / 조회 2000 / 삭제 2002", async () => {
  const rn = uniqueRn("rsc");
  const c = await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn } });
  assert.equal(c.rsc, "2001");
  assert.equal(c.status, 201);

  const r = await retrieve(srv.baseUrl, `${root.sid}/${rn}`);
  assert.equal(r.rsc, "2000");

  const d = await remove(srv.baseUrl, `${root.sid}/${rn}`);
  assert.equal(d.rsc, "2002");
});

test("con 속성이 JSON 객체로 왕복한다", async () => {
  const rn = uniqueRn("con");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn } });
  const payload = { temp: 21.5, unit: "C", nested: { ok: true } };
  const c = await create(srv.baseUrl, `${root.sid}/${rn}`, 4, { "m2m:cin": { con: payload } });
  assert.equal(c.rsc, "2001");
  assert.deepEqual(c.body["m2m:cin"].con, payload);

  const back = await retrieve(srv.baseUrl, `${root.sid}/${rn}/la`);
  assert.deepEqual(back.body["m2m:cin"].con, payload);
});

test("UPDATE는 PUT + ty 없는 Content-Type으로 동작한다", async () => {
  // op은 HTTP 메서드가 아니라 Content-Type에서 유도된다(코드 지도 L-2).
  // ';'가 없으면 메서드로 op을 정하므로 PUT → op=3(UPDATE)이 된다.
  const rn = uniqueRn("upd");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn } });
  const u = await update(srv.baseUrl, `${root.sid}/${rn}`, { "m2m:cnt": { lbl: ["tag-a"] } });
  assert.equal(u.rsc, "2004");
  const r = await retrieve(srv.baseUrl, `${root.sid}/${rn}`);
  assert.deepEqual(r.body["m2m:cnt"].lbl, ["tag-a"]);
});

test("<CSEBase>는 DELETE되지 않는다", async () => {
  // 코드 지도 G-1: 실효 가드는 delete_a_res의 switch(to_ty) case 5다.
  const d = await remove(srv.baseUrl, CSE_BASE);
  assert.equal(d.rsc, "4005");
  // 삭제되지 않았음을 확인 — 이 단정이 없으면 코드만 보고 통과했다고 착각할 수 있다.
  const still = await retrieve(srv.baseUrl, CSE_BASE);
  assert.equal(still.rsc, "2000");
});

test("fanout 응답은 m2m:agr 봉투로 감싸인다", async () => {
  // 실측 결과 브리프의 가정과 다름: mobius4는 <grp>를 ae/rce/cb 하위에서만 생성할 수 있고
  // (cse/resources/grp.js의 grp_parent_res_types), cnt(root) 하위에 만들면 4108이 난다.
  // 그래서 그룹은 CSEBase 바로 아래 만들고, 멤버만 root 하위 컨테이너를 가리키게 한다.
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
    assert.ok(agr, `m2m:agr 봉투가 있어야 한다. 실제: ${fo.raw.slice(0, 300)}`);
    assert.ok(Array.isArray(agr.rsp), "agr.rsp는 배열이어야 한다");
    assert.equal(agr.rsp.length, 2);
    for (const r of agr.rsp) {
      assert.ok("rsc" in r && "rqi" in r && "pc" in r, `rsp 항목 형식: ${JSON.stringify(r)}`);
    }
  } finally {
    // root 서브트리 밖(CSEBase 직속)에 만들었으므로 root.remove()로는 지워지지 않는다 — 직접 정리.
    // delete_a_res는 대상 리소스 자신의 삭제도 fire-and-forget이라(hostingCSE.js:559),
    // grp 자신도 root와 같은 레이스에 걸린다 — 동일하게 폴링해서 실제로 지워졌는지 확인한다.
    await remove(srv.baseUrl, gsid);
    await waitForSubtreeGone(srv.baseUrl, gsid);
  }
});

test("이름의 밑줄이 형제 리소스를 끌어들이지 않는다 (삭제)", async () => {
  // delete_a_res의 자손 수집 LIKE 조건도 디스커버리와 같은 이스케이프 결함을 공유한다.
  // 'a_c-…'를 지울 때 '_' 자리가 어떤 문자든 매칭돼 'abc-…'의 자손까지 함께 지워지면
  // 남의 리소스가 삭제되는 사고다. 같은 이름 규칙(밑줄 위치가 형제와 정확히 겹치게)으로
  // 재현한다 — uniqueRn의 난수 접미어에 의존하면 우연히 안 겹쳐 결함을 놓친다.
  const tag = uniqueRn("t").slice(-6);
  const under = `a_c-${tag}`;
  const other = `abc-${tag}`;
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: under } });
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: other } });
  const cin = await create(srv.baseUrl, `${root.sid}/${other}`, 4, { "m2m:cin": { con: { v: "형제것" } } });

  const d = await remove(srv.baseUrl, `${root.sid}/${under}`);
  assert.equal(d.rsc, "2002");

  const stillThere = await retrieve(srv.baseUrl, `${root.sid}/${other}/${cin.body["m2m:cin"].rn}`);
  assert.equal(stillThere.rsc, "2000", "형제 자손이 함께 삭제됐다");
});
