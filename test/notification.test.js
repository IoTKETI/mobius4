"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers/server");
const { create, update, remove, createRoot, uniqueRn } = require("./helpers/onem2m");
const { startSink, netOf } = require("./helpers/noti-sink");

let srv, root, sink;

before(async () => {
  srv = await startServer();
  sink = await startSink();
  root = await createRoot(srv.baseUrl, "noti");
});
after(async () => {
  if (root) await root.remove();
  if (sink) await sink.stop();
  if (srv) await srv.stop();
});

// 구독 붙은 컨테이너를 매번 새로 만든다 — 테스트 간 통지가 섞이지 않게.
async function cntWithSub(enc, extraCnt = {}) {
  const cnt = uniqueRn("c");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: cnt, ...extraCnt } });
  const sub = uniqueRn("s");
  const res = await create(srv.baseUrl, `${root.sid}/${cnt}`, 23, {
    "m2m:sub": { rn: sub, nu: [sink.url], enc, nct: 1 },
  });
  assert.equal(res.rsc, "2001", `구독 생성 실패: ${res.raw.slice(0, 200)}`);
  return { cntSid: `${root.sid}/${cnt}`, subSid: `${root.sid}/${cnt}/${sub}` };
}

test("net=3 — 직속 자식 생성 시 통지한다", async () => {
  const { cntSid, subSid } = await cntWithSub({ net: [3] });
  await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: { v: 1 } } });
  const got = await sink.waitFor((i) => netOf(i) === 3 && i.body["m2m:sgn"].sur === subSid);
  const sgn = got.body["m2m:sgn"];
  assert.equal(sgn.nev.net, 3);
  assert.equal(sgn.sur, subSid);
  assert.ok(sgn.nev.rep["m2m:cin"], `nev.rep에 생성된 리소스가 담겨야 한다: ${JSON.stringify(sgn.nev.rep)}`);
});

test("net=1 — 구독 대상 갱신 시 통지한다", async () => {
  const { cntSid, subSid } = await cntWithSub({ net: [1] });
  await update(srv.baseUrl, cntSid, { "m2m:cnt": { lbl: ["changed"] } });
  const got = await sink.waitFor((i) => netOf(i) === 1 && i.body["m2m:sgn"].sur === subSid);
  assert.equal(got.body["m2m:sgn"].nev.net, 1);
});

test("net=2 — 구독 대상 삭제 시 통지한다", async () => {
  const { cntSid, subSid } = await cntWithSub({ net: [2] });
  await remove(srv.baseUrl, cntSid);
  const got = await sink.waitFor((i) => netOf(i) === 2 && i.body["m2m:sgn"].sur === subSid);
  assert.equal(got.body["m2m:sgn"].nev.net, 2);
});

test("enc.chty가 net=3의 자식 타입을 걸러낸다", async () => {
  // chty=[4](CIN)만 허용 → CIN 생성은 통지, 컨테이너 자식 생성은 무통지.
  const { cntSid, subSid } = await cntWithSub({ net: [3], chty: [4] });
  await create(srv.baseUrl, cntSid, 3, { "m2m:cnt": { rn: uniqueRn("nested") } });
  await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: { v: 2 } } });

  const got = await sink.waitFor((i) => netOf(i) === 3 && i.body["m2m:sgn"].sur === subSid);
  assert.ok(got.body["m2m:sgn"].nev.rep["m2m:cin"], "통지된 것은 CIN이어야 한다");

  const mine = sink.received.filter((i) => i.body?.["m2m:sgn"]?.sur === subSid);
  assert.equal(mine.length, 1, `이 구독의 통지는 1건이어야 한다(컨테이너 생성은 걸러짐). 실제 ${mine.length}`);
});

test("net=[3]만 설정된 구독은 CIN 삭제 시 통지하지 않는다 (회귀 방지)", async () => {
  // net=4를 구현할 때 net=3 전용 구독까지 삭제 통지를 받으면 안 된다.
  const { cntSid, subSid } = await cntWithSub({ net: [3] });
  const cin = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: { v: 3 } } });
  await sink.waitFor((i) => netOf(i) === 3 && i.body["m2m:sgn"].sur === subSid);

  // 삭제가 실제로 성공했는지 먼저 단정한다 — 삭제가 조용히 실패하면 "삭제 통지가 없다"가
  // 저절로 참이 되어, 아무것도 검증하지 못한 채 초록불이 뜬다.
  const del = await remove(srv.baseUrl, `${cntSid}/${cin.body["m2m:cin"].rn}`);
  assert.equal(del.rsc, "2002", `CIN 삭제가 성공해야 이 회귀 테스트가 의미를 갖는다: ${del.raw.slice(0, 200)}`);

  const deleteNotis = await sink.expectNone(
    (i) => i.body?.["m2m:sgn"]?.sur === subSid && [2, 4].includes(netOf(i))
  );
  assert.deepEqual(deleteNotis.map(netOf), [], "삭제 통지가 없어야 한다");
});

test("net=4 — 직속 자식을 명시적으로 DELETE하면 통지한다", async () => {
  // 구현 완료: check_and_send_noti 진입부에서 notify_parent_of_child_deletion으로
  // 삭제된 자식의 부모 아래 구독을 별도 조회해 net=4를 발화한다.
  const { cntSid, subSid } = await cntWithSub({ net: [4] });
  const cin = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: { v: 4 } } });
  await remove(srv.baseUrl, `${cntSid}/${cin.body["m2m:cin"].rn}`);
  const got = await sink.waitFor((i) => netOf(i) === 4 && i.body["m2m:sgn"].sur === subSid);
  assert.equal(got.body["m2m:sgn"].nev.net, 4);
});

test("net=4 — 통지 내용에 삭제된 자식의 표현이 담긴다", async () => {
  // DEC-038: nev.rep은 삭제되기 직전 자식의 전체 표현이다. ID만 담거나 비워 보내면
  // 응용이 '무엇을 잃었는지' 알 수 없어 이 기능의 목적을 잃는다.
  const { cntSid, subSid } = await cntWithSub({ net: [4] });
  const cin = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: { payload: "keep-me" } } });
  const rn = cin.body["m2m:cin"].rn;
  await remove(srv.baseUrl, `${cntSid}/${rn}`);

  const got = await sink.waitFor((i) => netOf(i) === 4 && i.body["m2m:sgn"].sur === subSid);
  const rep = got.body["m2m:sgn"].nev.rep;
  assert.ok(rep["m2m:cin"], `삭제된 CIN의 표현이 담겨야 한다: ${JSON.stringify(rep)}`);
  assert.equal(rep["m2m:cin"].rn, rn);
  assert.deepEqual(rep["m2m:cin"].con, { payload: "keep-me" });
});

test("net=4 — enc.chty가 자식 타입을 걸러낸다", async () => {
  // TS-0004:7.5.1.2.2 Step 1.0 — chty가 있으면 그 타입의 자식이 삭제될 때만 발화한다.
  // chty=[3](컨테이너)만 허용하므로 CIN 삭제는 통지되지 않아야 한다.
  const { cntSid, subSid } = await cntWithSub({ net: [4], chty: [3] });
  const cin = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: { v: 1 } } });
  const del = await remove(srv.baseUrl, `${cntSid}/${cin.body["m2m:cin"].rn}`);
  assert.equal(del.rsc, "2002", "삭제가 성공해야 이 테스트가 의미를 갖는다");

  const notis = await sink.expectNone((i) => i.body?.["m2m:sgn"]?.sur === subSid);
  assert.deepEqual(notis.map(netOf), [], "chty에 없는 타입이므로 통지가 없어야 한다");
});

test("net=4 — 조부모 구독은 발화하지 않는다 (직속 부모만)", async () => {
  // DEC-038: 이벤트 이름이 'Delete of *Direct* Child Resource'다. 조상까지 전파하면
  // 깊은 트리에서 삭제 1건이 깊이만큼의 통지를 만든다.
  const gp = uniqueRn("gp");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: gp } });
  const gpSub = uniqueRn("gpsub");
  await create(srv.baseUrl, `${root.sid}/${gp}`, 23, {
    "m2m:sub": { rn: gpSub, nu: [sink.url], enc: { net: [4] }, nct: 1 },
  });
  const gpSubSid = `${root.sid}/${gp}/${gpSub}`;

  // 손자: 조부모 → 자식 컨테이너 → CIN
  const mid = uniqueRn("mid");
  await create(srv.baseUrl, `${root.sid}/${gp}`, 3, { "m2m:cnt": { rn: mid } });
  const cin = await create(srv.baseUrl, `${root.sid}/${gp}/${mid}`, 4, { "m2m:cin": { con: { v: 1 } } });
  const del = await remove(srv.baseUrl, `${root.sid}/${gp}/${mid}/${cin.body["m2m:cin"].rn}`);
  assert.equal(del.rsc, "2002");

  const notis = await sink.expectNone((i) => i.body?.["m2m:sgn"]?.sur === gpSubSid);
  assert.deepEqual(notis.map(netOf), [], "조부모 구독은 발화하지 않아야 한다");
});

test("캐스케이드 자손 삭제는 통지를 발생시키지 않는다 (indirect deletion)", async () => {
  // DEC-039 / SQ-001: 부모를 지워 자손이 함께 사라질 때, 그 자손에 대한 net=4는
  // 발화하지 않는다. 현재 delete_resources가 통지 함수를 아예 호출하지 않는다는
  // 사실을 테스트로 고정해, 나중에 누가 그 경로에 통지를 붙이면 여기서 걸리게 한다.
  const outer = uniqueRn("outer");
  await create(srv.baseUrl, root.sid, 3, { "m2m:cnt": { rn: outer } });
  const inner = uniqueRn("inner");
  await create(srv.baseUrl, `${root.sid}/${outer}`, 3, { "m2m:cnt": { rn: inner } });

  // inner 아래 CIN이 삭제될 때 발화할 net=4 구독을 inner에 단다
  const innerSub = uniqueRn("isub");
  await create(srv.baseUrl, `${root.sid}/${outer}/${inner}`, 23, {
    "m2m:sub": { rn: innerSub, nu: [sink.url], enc: { net: [4] }, nct: 1 },
  });
  const innerSubSid = `${root.sid}/${outer}/${inner}/${innerSub}`;
  await create(srv.baseUrl, `${root.sid}/${outer}/${inner}`, 4, { "m2m:cin": { con: { v: 1 } } });

  // outer를 삭제하면 inner와 그 CIN이 캐스케이드로 사라진다
  const del = await remove(srv.baseUrl, `${root.sid}/${outer}`);
  assert.equal(del.rsc, "2002");

  const notis = await sink.expectNone((i) => i.body?.["m2m:sgn"]?.sur === innerSubSid);
  assert.deepEqual(notis.map(netOf), [], "캐스케이드 자손 삭제는 통지하지 않아야 한다");
});

test("net=4 — mni 초과 eviction에서도 통지한다", { todo: true }, async () => {
  // 미구현이 아니라 규격 확인 대기(SQ-001): eviction(int_cr_req:true)이 indirect
  // deletion으로서 통지를 발생시켜야 하는지 oneM2M 규격상 확정되지 않았다(DEC-039).
  // check_and_send_noti는 int_cr_req !== true 조건으로 eviction을 의도적으로 제외하므로
  // 지금은 통지 0건이 맞다 — 확인되면 조건을 조정하고 이 테스트를 뒤집는다.
  const { cntSid, subSid } = await cntWithSub({ net: [4] }, { mni: 3 });
  for (let i = 1; i <= 4; i++) {
    const r = await create(srv.baseUrl, cntSid, 4, { "m2m:cin": { con: { seq: i } } });
    assert.equal(r.rsc, "2001");
  }
  const got = await sink.waitFor((i) => netOf(i) === 4 && i.body["m2m:sgn"].sur === subSid);
  assert.equal(got.body["m2m:sgn"].nev.net, 4);
});
