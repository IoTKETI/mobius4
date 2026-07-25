"use strict";
// oneM2M HTTP 클라이언트. 테스트가 실제 클라이언트와 같은 경로(바인딩 → 접근제어 → DB)를
// 타도록 일부러 HTTP로 나간다.

const CSE_BASE = "Mobius";   // config.cse.csebase_rn
const ADMIN = "SM";          // config.cse.admin — 기본 ACP의 acop에는 delete 비트가 없어
                             // (코드 지도 G-2) 일반 오리지네이터로는 삭제가 4103이 된다.

let seq = 0;
function nextRqi() { return `t${process.pid.toString(36)}-${++seq}`; }

function uniqueRn(prefix = "t") {
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${Date.now().toString(36)}${rand}`;
}

async function request(baseUrl, { method, to, ty, body, originator = ADMIN, headers = {} }) {
  const url = `${baseUrl}/${String(to).replace(/^\/+/, "")}`;
  const h = {
    "X-M2M-Origin": originator,
    "X-M2M-RI": nextRqi(),
    "X-M2M-RVI": "3",
    Accept: "application/json",
    ...headers,
  };
  const init = { method, headers: h };
  if (body !== undefined) {
    // op은 Content-Type에서 유도된다(코드 지도 L-2): ';ty=N'이 있으면 CREATE(op=1),
    // 없으면 HTTP 메서드로 정해진다. 그래서 ty 유무로 Content-Type을 갈라 쓴다.
    h["Content-Type"] = ty === undefined ? "application/json" : `application/json;ty=${ty}`;
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const raw = await res.text();
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  return { status: res.status, rsc: res.headers.get("x-m2m-rsc"), body: parsed, raw };
}

const create   = (b, to, ty, body, o = {}) => request(b, { method: "POST",   to, ty, body, ...o });
const retrieve = (b, to, o = {})           => request(b, { method: "GET",    to, ...o });
const update   = (b, to, body, o = {})     => request(b, { method: "PUT",    to, body, ...o });
const remove   = (b, to, o = {})           => request(b, { method: "DELETE", to, ...o });

function discover(b, to, query = {}, o = {}) {
  const qs = new URLSearchParams({ fu: "1", ...query }).toString();
  return request(b, { method: "GET", to: `${to}?${qs}`, ...o });
}

// 디스커버리 응답의 URI 목록. 결과가 없을 때 mobius4가 키를 아예 생략할 수 있어
// 호출부마다 방어 코드를 쓰지 않도록 여기서 [] 로 정규화한다.
function urils(res) {
  const u = res && res.body && res.body["m2m:uril"];
  if (Array.isArray(u)) return u;
  if (typeof u === "string") return [u];
  return [];
}

// mobius4의 delete_a_res(cse/hostingCSE.js)는 대상 리소스는 물론 그 자손들까지도
// await 없이 fire-and-forget으로 지운다(2002 응답 후 백그라운드에서 삭제 진행).
// 테스트가 remove() 직후 srv.stop()으로 서버를 SIGTERM하면 이 비동기 삭제가 중간에
// 끊겨 고아 row가 DB에 남는다 — 그리고 고아를 ri로 조회하면 응답 자체가 오지 않아
// (타임아웃) 이후 테스트 실행까지 오염시킬 수 있다. 그래서 DELETE 후에는 고정 sleep이
// 아니라, 서브트리가 실제로 비었는지 discovery로 폴링해 확인한 뒤 반환한다.
const REMOVE_WAIT_TIMEOUT_MS = 5000;
const REMOVE_WAIT_INTERVAL_MS = 100;

// sid 아래(그리고 sid 자신)가 더 이상 조회되지 않을 때까지 폴링한다.
//
// 주의: discover(baseUrl, sid)를 sid 자신에 대고 쏘면 안 된다 — delete_a_res는 대상
// 리소스 자신의 삭제(hostingCSE.js:559)와 자손 삭제(hostingCSE.js:592)를 서로 다른
// fire-and-forget 태스크로 던지고, 자신의 삭제(단일 row)가 자손 삭제(N개 순차 처리)보다
// 먼저 끝나는 경우가 실제로 있다. sid 자신의 row가 먼저 사라지면 reqPrim.js의 set_ri_sid
// 조기 반환(hostingCSE.js:60-73, 'to'가 안 풀리면 discovery까지 가지도 않고 즉시 4004)
// 때문에, 자손이 아직 남아있어도 폴링이 "끝났다"고 오판하게 된다(실측: 이 방식으로는
// 3회 연속 실행 후 자손 컨테이너가 orphan으로 남았다). 그래서 항상 살아있는 CSE_BASE를
// discovery 대상으로 삼고, 응답을 클라이언트 쪽에서 sid 접두어로 걸러 판단한다.
async function waitForSubtreeGone(baseUrl, sid) {
  const deadline = Date.now() + REMOVE_WAIT_TIMEOUT_MS;
  for (;;) {
    const res = await discover(baseUrl, CSE_BASE);
    const remaining = urils(res).filter((u) => u === sid || u.startsWith(`${sid}/`));
    if (remaining.length === 0) return;
    // 타임아웃에 도달해도 절대 throw하지 않는다 — 정리 지연이 실제 테스트 실패를
    // 가리면 안 된다. 남은 고아는 다음 실행의 DB 카운트 증가로 드러난다.
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, REMOVE_WAIT_INTERVAL_MS));
  }
}

// 각 테스트 파일이 CSEBase 아래에 자기 루트를 하나 만들고, 끝나면 그 서브트리만 지운다.
async function createRoot(baseUrl, prefix = "t") {
  const rn = uniqueRn(prefix);
  const res = await create(baseUrl, CSE_BASE, 3, { "m2m:cnt": { rn } });
  if (res.rsc !== "2001") {
    throw new Error(`테스트 루트 생성 실패: rsc=${res.rsc} body=${res.raw.slice(0, 200)}`);
  }
  const sid = `${CSE_BASE}/${rn}`;
  return {
    rn, sid,
    remove: async () => {
      const res = await remove(baseUrl, sid);
      await waitForSubtreeGone(baseUrl, sid);
      return res;
    },
  };
}

module.exports = {
  CSE_BASE, ADMIN,
  request, create, retrieve, update, remove, discover,
  uniqueRn, createRoot, urils, waitForSubtreeGone,
};
