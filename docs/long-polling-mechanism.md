# Long Polling Mechanism

## 개요

Client A가 보낸 요청의 대상(CSE 또는 AE)이 직접 도달 불가능(`rr === false`)하고,
해당 대상 리소스 하위에 `<pch>` (pollingChannel) 리소스가 존재할 때,
long polling을 통해 Client B(대상 엔티티)에게 요청을 전달하고 응답을 받아 Client A에게 반환하는 메커니즘.

---

## 관련 파일 및 함수

| 파일 | 함수 | 역할 |
|---|---|---|
| `cse/reqPrim.js` | `cse_forwarding()` | CSE 대상 long polling 분기 (rr 체크 → DB 저장) |
| `cse/reqPrim.js` | `ae_forwarding()` | AE 대상 long polling 분기 (rr 체크 → DB 저장) |
| `cse/resources/pch.js` | `store_request_for_long_polling()` | 요청을 pch 테이블의 `reqs` (JSONB) 컬럼에 저장 |
| `cse/resources/pch.js` | `wait_for_response()` | Promise Map에 rqi를 키로 등록하고 응답 대기 |
| `cse/resources/pch.js` | `notify_pcu()` | B의 응답이 도착하는 진입점 → pendingMap에서 resolve 호출 |
| `cse/resources/pch.js` | `retrieve_pcu()` | B가 polling할 때 호출 (미완성) |
| `models/pch-model.js` | - | pch 테이블 모델 (`reqs: JSONB, defaultValue: []`) |

---

## 전체 흐름 도표

```
 Client A                    Hosting CSE (this server)                    Client B
 (Originator)                                                            (Target: CSE or AE)
     │                                                                        │
     │  1. HTTP Request                                                       │
     ├──────────────────►  cse_forwarding() 또는 ae_forwarding()              │
     │                     ├─ rr === false 확인                               │
     │                     ├─ <pch> 리소스 존재 확인 (PCH.findOne)            │
     │                     ├─ store_request_for_long_polling()                │
     │                     │   └─ pch.reqs = [...reqs, req_prim]              │
     │                     │   └─ DB에 요청 저장                               │
     │                     │                                                   │
     │                     ├─ (미구현) wait_for_response(rqi) ◄── await 대기   │
     │                     │   └─ pendingMap.set(rqi, resolve)                │
     │                     │                                                   │
     │                     │        2. B가 Polling 요청                        │
     │                     │   ◄──────────────────────────────────────────────┤
     │                     │        retrieve_pcu() (미완성)                    │
     │                     │        └─ DB에서 reqs 조회 → B에게 전달           │
     │                     │   ──────────────────────────────────────────────►│
     │                     │                                                   │
     │                     │        3. B가 응답을 NOTIFY로 전송                │
     │                     │   ◄──────────────────────────────────────────────┤
     │                     ├─ notify_pcu(req_prim, resp_prim)                 │
     │                     │   └─ original_rqi = req_prim.pc.rqi              │
     │                     │   └─ pendingMap.get(rqi) → resolve(응답)          │
     │                     │                                                   │
     │                     ├─ wait_for_response()의 await 해제                │
     │                     │   └─ resp_prim에 B의 응답 매핑                    │
     │  4. HTTP Response   │                                                   │
     │◄─────────────────── ┤                                                   │
     │                                                                        │
```

---

## 구성 요소 상세

### 1. 요청 저장 (DB)

**역할**: B가 polling할 때 가져갈 수 있도록 요청을 영속적으로 보관

**위치**: `cse/resources/pch.js` → `store_request_for_long_polling(pch_ri, req_prim)`

```js
// Sequelize JSONB 배열은 스프레드로 새 배열을 할당해야 변경 감지됨
pch_res.reqs = [...pch_res.reqs, req_prim];
await pch_res.save();
```

- pch 테이블의 `reqs` 컬럼 (JSONB, 기본값 `[]`)에 저장
- `.push()` 사용 시 Sequelize가 변경을 감지 못하므로 스프레드 연산자 사용 필수

### 2. 응답 대기 (메모리 - Promise Map)

**역할**: A의 HTTP 핸들러를 B의 응답이 올 때까지 suspend/resume

**위치**: `cse/resources/pch.js` → `wait_for_response(rqi, timeout_ms)`

```js
const pendingMap = new Map();  // rqi → resolve 함수

function wait_for_response(rqi, timeout_ms = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingMap.delete(rqi);
      reject(new Error(`long polling timeout: ${rqi}`));
    }, timeout_ms);

    pendingMap.set(rqi, (resp_data) => {
      clearTimeout(timer);
      pendingMap.delete(rqi);
      resolve(resp_data);
    });
  });
}
```

- timeout (기본 30초) 내에 응답이 없으면 reject → A에게 에러 반환
- B의 응답이 도착하면 resolve → A의 await가 해제됨

### 3. 응답 수신 및 전달 (notify_pcu)

**역할**: B가 NOTIFY로 보낸 응답을 받아 pendingMap에서 A의 대기를 해제

**위치**: `cse/resources/pch.js` → `notify_pcu(req_prim, resp_prim)`

```js
const original_rqi = req_prim.pc.rqi;  // B가 포함시킨 원래 요청의 rqi
const resolve = pendingMap.get(original_rqi);
if (resolve) {
  resolve(req_prim.pc);  // A의 await 해제 + 응답 데이터 전달
}
```

- **`rqi`가 A의 요청과 B의 응답을 연결하는 핵심 키**
- B는 응답에 원래 요청의 rqi를 반드시 포함해야 함

---

## Long Polling 진입 조건

두 가지 조건을 **모두** 만족해야 함:

| 조건 | CSE 대상 | AE 대상 |
|---|---|---|
| 도달 불가 | `csr_res.rr === false` | `ae_res.rr === false` |
| pch 존재 | `PCH.findOne({ where: { pi: csr_res.ri } })` | `PCH.findOne({ where: { pi: ae_res.ri } })` |

---

## 현재 구현 상태

| 단계 | 상태 | 설명 |
|---|---|---|
| A → 요청 저장 (DB) | **완성** | `store_request_for_long_polling()` |
| A → 응답 대기 (await) | **미연결** | `wait_for_response()` 함수 존재, cse/ae_forwarding에서 아직 호출하지 않음 |
| B ← polling으로 요청 수신 | **미완성** | `retrieve_pcu()` 구현 필요 (DB에서 reqs 꺼내서 B에게 전달) |
| B → NOTIFY로 응답 전송 | **구현됨** | `notify_pcu()` 에서 pendingMap resolve 호출 |
| A ← 응답 반환 | **미연결** | `wait_for_response()`를 forwarding 함수에서 호출해야 함 |

### 남은 작업 (To-Do)

1. `cse_forwarding()` / `ae_forwarding()`에서 `wait_for_response(rqi)` 호출 연결
2. `retrieve_pcu()` 구현: DB에서 `pch.reqs`를 꺼내 B에게 전달하고, 전달된 요청은 reqs에서 제거
3. `notify_pcu()` 중복 정의 제거 (pch.js 라인 184와 218에 두 개 존재)
4. B가 응답에 원래 요청의 `rqi`를 포함하는 규약/포맷 확정

---

## 주의사항

- **pendingMap은 메모리 기반**: 서버 재시작 시 대기 중인 요청은 유실됨 (DB의 reqs는 유지)
- **Sequelize JSONB 변경 감지**: `reqs` 배열 수정 시 반드시 새 배열 할당 (`[...reqs, item]`)
- **notify_pcu 중복 정의**: 현재 pch.js에 `notify_pcu`가 두 번 정의되어 있음 (라인 184, 218). 후자가 export되므로 pendingMap 로직이 있는 전자(184)가 무시됨 — 수정 필요
