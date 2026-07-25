"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, discover, urils, createRoot, uniqueRn, CSE_BASE, remove } = require("./helpers/onem2m");

let srv, root, c1, g1, cinRn, c1Ri;

before(async () => {
  srv = await startServer();
  root = await createRoot(srv.baseUrl, "disc");
  // 3단 트리: root / c1 / g1 / <cin>
  c1 = uniqueRn("c1");
  const c1Res = await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: c1, lbl: ["depth1"] } });
  c1Ri = c1Res.body["m2m:cnt"].ri; // 비구조적(ri) 주소 지정 테스트용
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

test("lvl=1 → 직속 자식만 반환한다", async () => {
  // 구현 완료 — lvl이 파싱·검증된 뒤 WHERE 절(sid 깊이 환산)에 반영된다.
  // 2026-07-26: RSC 2000 응답에서 직속 자식(c1)만 반환됨을 확인.
  const list = urils(await discover(srv.baseUrl, root.sid, { lvl: "1" }));
  assert.deepEqual(list, [`${root.sid}/${c1}`]);
});

test("lvl=2 → 2단계까지 반환한다", async () => {
  const list = urils(await discover(srv.baseUrl, root.sid, { lvl: "2" }));
  assert.deepEqual(
    list.sort(),
    [`${root.sid}/${c1}`, `${root.sid}/${c1}/${g1}`].sort()
  );
});

test("lvl은 대상으로부터의 상대 깊이다 (하위 노드 기준)", async () => {
  // TS-0001:8.1.2 — 대상 자신이 level 0, 직속 자식이 1.
  // 절대 깊이로 잘못 구현하면 트리 최상위에서만 우연히 맞고 여기서 틀린다.
  const list = urils(await discover(srv.baseUrl, `${root.sid}/${c1}`, { lvl: "1" }));
  assert.deepEqual(list, [`${root.sid}/${c1}/${g1}`]);
});

test("lvl=1 → 비구조적 ID(ri)로 주소 지정해도 구조적 경로와 동일하게 동작한다", async () => {
  // Finding 1 회귀 방지: target_lvl을 req_prim.sid(항상 실제 절대 깊이)가 아니라
  // req_prim.to(주소 지정에 쓴 값)로 잘못 계산하면, ri로 주소 지정했을 때 to의 깊이(1)와
  // 실제 sid 깊이(3)가 달라 상한이 너무 작게 잡혀 직속 자식이 통째로 빠진다
  // (RSC 2000 + 빈 목록 — 이 기능이 없애려는 바로 그 무음 누락). c1을 ri로 조회해도
  // 구조적 경로(`${root.sid}/${c1}`)로 조회한 것과 같은 직속 자식 g1이 나와야 한다.
  const list = urils(await discover(srv.baseUrl, c1Ri, { lvl: "1" }));
  assert.deepEqual(list, [`${root.sid}/${c1}/${g1}`]);
});

test("lvl과 ty가 AND로 결합된다", async () => {
  // lvl=2 + ty=3 조합은 쓰지 않는다 — 이 트리에서 ty=3(cnt)인 리소스가 c1(1단)·g1(2단)
  // 뿐이라 lvl이 무시돼도(버그) ty 필터 단독 결과가 우연히 기대값과 같아져 결함을
  // 못 잡는다(2026-07-25 실측: ok # TODO로 관측 — 단정이 결함을 잡지 못함, 브리프의
  // "ok면 문제" 경고에 해당해 lvl=1로 교정). lvl=1 + ty=3이면 정답은 c1뿐이지만,
  // lvl이 버려지면 ty=3 전체(c1, g1)가 나와 실제로 어긋난다.
  const list = urils(await discover(srv.baseUrl, root.sid, { lvl: "1", ty: "3" }));
  assert.deepEqual(list, [`${root.sid}/${c1}`]);
});

test("지원하지 않는 gmty가 와도 대상 서브트리 밖 리소스가 새어나오지 않는다", async () => {
    // set_where_clause가 지오 분기에서 계약을 어기고 where만 반환하면 호출부에서
    // where가 undefined가 되어 sid 범위 제한까지 사라진다 → 테이블 전체 반환.
    // 이 테스트는 '범위가 지켜지는가'만 본다(오류 코드는 아래 별도 테스트).
    const outsider = uniqueRn("outsider");
    await create(srv.baseUrl, CSE_BASE, 3, { "m2m:cnt": { rn: outsider } });
    try {
        const res = await discover(srv.baseUrl, root.sid, { gmty: "9", gsf: "1", geom: "[1,2]" });
        const leaked = urils(res).filter((u) => !u.startsWith(`${root.sid}/`) && u !== root.sid);
        assert.deepEqual(leaked, [], `대상 밖 리소스가 반환됐다: ${JSON.stringify(leaked)}`);
    } finally {
        await remove(srv.baseUrl, `${CSE_BASE}/${outsider}`);
    }
});

test("gmty 범위 밖은 4000, 규격상 유효하나 미구현이면 5001", async () => {
    // TS-0004:6.3.4.2.74 — geometryType 유효값은 1..6. mobius4는 1..3만 구현한다.
    // 범위 밖(9)은 잘못된 요청이고, 4(MultiPoint)는 유효하지만 미구현이다.
    const bad = await discover(srv.baseUrl, root.sid, { gmty: "9", gsf: "1", geom: "[1,2]" });
    assert.equal(bad.rsc, "4000", `범위 밖 gmty는 4000이어야 한다. 실제 ${bad.rsc}`);

    const unimpl = await discover(srv.baseUrl, root.sid, { gmty: "4", gsf: "1", geom: "[1,2]" });
    assert.equal(unimpl.rsc, "5001", `미구현 gmty는 5001이어야 한다. 실제 ${unimpl.rsc}`);
});

test("디스커버리 실패는 2000으로 둔갑하지 않는다", async () => {
    // 예외가 삼켜지면 빈 목록 + 2000이 되어 '결과 없음'과 구별되지 않는다.
    const res = await discover(srv.baseUrl, root.sid, { gmty: "5", gsf: "1", geom: "[1,2]" });
    assert.notEqual(res.rsc, "2000", "실패가 성공으로 둔갑했다");
    assert.equal(res.rsc, "5001");
});
