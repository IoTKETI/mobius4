"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, discover, urils, createRoot, uniqueRn } = require("./helpers/onem2m");

let srv, root, c1, g1, cinRn;

before(async () => {
  srv = await startServer();
  root = await createRoot(srv.baseUrl, "disc");
  // 3단 트리: root / c1 / g1 / <cin>
  c1 = uniqueRn("c1");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: c1, lbl: ["depth1"] } });
  g1 = uniqueRn("g1");
  await create(srv.baseUrl, `${root.sid}/${c1}`, 3, { "m2m:cnt": { rn: g1 } });
  const cin = await create(srv.baseUrl, `${root.sid}/${c1}/${g1}`, 4, { "m2m:cin": { con: { v: 1 } } });
  cinRn = cin.body["m2m:cin"].rn;
});

after(async () => { if (root) await root.remove(); if (srv) await srv.stop(); });

test("fu=1 기준선 — 하위 전체를 반환한다", async () => {
  const res = await discover(srv.baseUrl, root.sid);
  assert.equal(res.rsc, "2000");
  const list = urils(res);
  assert.equal(list.length, 3, `기대 3건, 실제 ${list.length}: ${JSON.stringify(list)}`);
  assert.ok(list.includes(`${root.sid}/${c1}`));
  assert.ok(list.includes(`${root.sid}/${c1}/${g1}`));
  assert.ok(list.includes(`${root.sid}/${c1}/${g1}/${cinRn}`));
});

test("ty 필터가 타입으로 좁힌다", async () => {
  const cnts = urils(await discover(srv.baseUrl, root.sid, { ty: "3" }));
  assert.deepEqual(cnts.sort(), [`${root.sid}/${c1}`, `${root.sid}/${c1}/${g1}`].sort());
  const cins = urils(await discover(srv.baseUrl, root.sid, { ty: "4" }));
  assert.deepEqual(cins, [`${root.sid}/${c1}/${g1}/${cinRn}`]);
});

test("lbl 필터가 라벨로 좁힌다", async () => {
  const list = urils(await discover(srv.baseUrl, root.sid, { lbl: "depth1" }));
  assert.deepEqual(list, [`${root.sid}/${c1}`]);
});

test("cra/crb 타임스탬프 형식(YYYYMMDDThhmmss)을 수용한다", async () => {
  // 콜론·Z 없는 형식만 받는다(리포트 §참고). 과거 기준 cra는 전부 통과,
  // 같은 시각 기준 crb는 아무것도 통과하지 못해야 한다.
  const after2020 = await discover(srv.baseUrl, root.sid, { cra: "20200101T000000" });
  assert.equal(after2020.rsc, "2000");
  assert.equal(urils(after2020).length, 3);

  const before2020 = await discover(srv.baseUrl, root.sid, { crb: "20200101T000000" });
  assert.equal(before2020.rsc, "2000");
  assert.equal(urils(before2020).length, 0);
});

test("lvl 미지정 시 전체 깊이를 반환한다 (회귀 방지)", async () => {
  // lvl 수정이 기본 동작을 바꾸지 않아야 한다. 이 테스트는 수정 전후 모두 통과해야 한다.
  const list = urils(await discover(srv.baseUrl, root.sid));
  assert.equal(list.length, 3);
});

test("lvl=1 → 직속 자식만 반환한다", { todo: true }, async () => {
  // 미구현: lvl이 파싱·검증되지만 WHERE 절에 반영되지 않는다.
  // 2026-07-25 실측 — RSC 2000으로 성공 응답하면서 필터를 조용히 버리고 3건을 반환.
  const list = urils(await discover(srv.baseUrl, root.sid, { lvl: "1" }));
  assert.deepEqual(list, [`${root.sid}/${c1}`]);
});

test("lvl=2 → 2단계까지 반환한다", { todo: true }, async () => {
  const list = urils(await discover(srv.baseUrl, root.sid, { lvl: "2" }));
  assert.deepEqual(
    list.sort(),
    [`${root.sid}/${c1}`, `${root.sid}/${c1}/${g1}`].sort()
  );
});

test("lvl은 대상으로부터의 상대 깊이다 (하위 노드 기준)", { todo: true }, async () => {
  // TS-0001:8.1.2 — 대상 자신이 level 0, 직속 자식이 1.
  // 절대 깊이로 잘못 구현하면 트리 최상위에서만 우연히 맞고 여기서 틀린다.
  const list = urils(await discover(srv.baseUrl, `${root.sid}/${c1}`, { lvl: "1" }));
  assert.deepEqual(list, [`${root.sid}/${c1}/${g1}`]);
});

test("lvl과 ty가 AND로 결합된다", { todo: true }, async () => {
  // lvl=2 + ty=3 조합은 쓰지 않는다 — 이 트리에서 ty=3(cnt)인 리소스가 c1(1단)·g1(2단)
  // 뿐이라 lvl이 무시돼도(버그) ty 필터 단독 결과가 우연히 기대값과 같아져 결함을
  // 못 잡는다(2026-07-25 실측: ok # TODO로 관측 — 단정이 결함을 잡지 못함, 브리프의
  // "ok면 문제" 경고에 해당해 lvl=1로 교정). lvl=1 + ty=3이면 정답은 c1뿐이지만,
  // lvl이 버려지면 ty=3 전체(c1, g1)가 나와 실제로 어긋난다.
  const list = urils(await discover(srv.baseUrl, root.sid, { lvl: "1", ty: "3" }));
  assert.deepEqual(list, [`${root.sid}/${c1}`]);
});
