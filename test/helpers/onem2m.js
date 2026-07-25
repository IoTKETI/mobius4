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

// 각 테스트 파일이 CSEBase 아래에 자기 루트를 하나 만들고, 끝나면 그 서브트리만 지운다.
async function createRoot(baseUrl, prefix = "t") {
  const rn = uniqueRn(prefix);
  const res = await create(baseUrl, CSE_BASE, 3, { "m2m:cnt": { rn } });
  if (res.rsc !== "2001") {
    throw new Error(`테스트 루트 생성 실패: rsc=${res.rsc} body=${res.raw.slice(0, 200)}`);
  }
  const sid = `${CSE_BASE}/${rn}`;
  return { rn, sid, remove: () => remove(baseUrl, sid) };
}

module.exports = {
  CSE_BASE, ADMIN,
  request, create, retrieve, update, remove, discover,
  uniqueRn, createRoot, urils,
};
