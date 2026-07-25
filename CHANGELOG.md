# Changelog

이 저장소의 주목할 만한 변경을 기록한다. 최신 항목이 위에 온다.

## [Unreleased]

### 테스트 하니스 신설 (2026-07-25, 브랜치 `test/harness-foundation`)

이 저장소에 **처음으로 테스트가 생겼다**. 그 전까지 `npm run test:basic`은
`echo "Error: no test specified" && exit 1` 스텁이었고 `devDependencies`는 빈 객체였다.

**추가된 것**

- `test/` — Node 22 내장 `node:test` 기반 HTTP 블랙박스 회귀 스위트. **25개 테스트**
  (19 통과 / 0 실패 / 6 todo), 약 15초.
  - `test/helpers/server.js` — 테스트가 mobius4를 **자식 프로세스로 직접 기동**한다.
    설정은 `NODE_CONFIG` 환경변수로 주입해 전용 DB(`mobius4_test`)와 OS가 고른 동적
    포트(HTTP·HTTPS 각각)를 쓴다. 개발 인스턴스가 7599에서 돌고 있어도 안전하다.
    기동 완료는 `mobius4.js`가 보내는 `process.send('ready')`를 `ipc`로 받아 감지한다.
  - `test/helpers/onem2m.js` — oneM2M HTTP 클라이언트. 각 테스트가 `<CSEBase>` 아래에
    고유 루트를 만들고 끝나면 그 서브트리만 지운다.
  - `test/helpers/noti-sink.js` — 구독의 `nu`가 가리킬 통지 수신기.
  - `test/protocol.test.js` · `test/discovery.test.js` · `test/notification.test.js`
- `package.json` — `scripts.test` 추가(`node --test --test-concurrency=1 'test/**/*.test.js'`),
  `test:basic` 스텁 제거.
- `test/README.md` — 사전 준비(`createdb mobius4_test`)와 결과 읽는 법.

**의도적으로 하지 않은 것**

- **새 의존성을 하나도 추가하지 않았다.** 필요한 모든 것이 Node 22 내장에 있다
  (`node:test`, `node:child_process`, `node:http`, `node:net`, 전역 `fetch`).
- **기존 소스를 한 줄도 수정하지 않았다.** `test/` 신설과 `package.json`의 `scripts`
  한 줄이 변경의 전부다.
- `config/` 아래에 파일을 추가하지 않았다. 테스트 설정은 실행 시 환경변수로 주입한다
  (`config/test.json`은 `config/local.json`이 덮어써서 동작하지 않고,
  `config/local-test.json`은 `.gitignore` 대상이라 커밋할 수 없다).

**현재 스위트가 고정한 동작** — 아래는 지금 정상 동작하며, 앞으로의 수정이 이걸 깨면
테스트가 실패한다.

| 영역 | 고정한 것 |
|---|---|
| 프로토콜 | 응답 코드가 `X-M2M-RSC` **헤더**로 오고 바디에 `rsc`가 없음 / 생성 2001·조회 2000·삭제 2002·갱신 2004 / `con`이 JSON 객체로 왕복 / `<CSEBase>`는 DELETE 불가(4005) / fanout 응답이 `{"m2m:agr":{"rsp":[…]}}` 봉투 |
| 디스커버리 | `fu=1` 전체 반환 / `ty`·`lbl` 필터 / `cra`·`crb`(`YYYYMMDDThhmmss`) / **`lvl` 미지정 시 전체 반환** |
| 통지 | `net=1`(갱신)·`net=2`(구독 대상 삭제)·`net=3`(직속 자식 생성) 발화 / `enc.chty` 필터 / 통지 봉투(`sur`·`nev.rep`·`nev.net`) / **`net=[3]`만 설정된 구독은 CIN 삭제 시 무통지** |

### ⚠️ 알려진 미수정 결함 (이번 변경에서 고치지 않음)

아래 두 건은 **테스트로 기록만 했고 수정하지 않았다.** `{ todo: true }`로 달려 있어
스위트를 실패시키지 않지만, `not ok … # TODO`로 목록에 남는다.

**1. `lvl` 필터 크리테리아가 질의에 반영되지 않는다** (todo 4건)

`bindings/http.js`가 파싱하고 `cse/validation/prim_schema.js`가 검증하지만,
`cse/hostingCSE.js`에서 `const lvl = req_prim.fc.lvl;`로 선언만 하고 WHERE 절 구성에
쓰이지 않는다. 요청은 **RSC 2000으로 성공 응답하면서 필터를 조용히 버린다.**

실측(2026-07-25, 3단 트리): `fu=1` → 3건, `fu=1&lvl=1` → **3건**(기대 1건),
`fu=1&lvl=2` → **3건**(기대 2건).

규격: oneM2M TS-0001 §8.1.2 — *"The maximum level of resource tree that the Hosting CSE
shall perform the operation starting from the target resource… The level of the target
resource itself is zero and the level of the direct children of the target is one."*
즉 **대상으로부터의 상대 깊이**다. 저장된 `lvl` 컬럼은 절대 깊이(`sid.split("/").length`)
이므로 대상 깊이를 더해 비교해야 한다 — 이 환산을 빠뜨리면 트리 최상위에서만 우연히 맞고
하위 노드에서 틀린다(테스트가 이 경우를 구분한다).

**2. `net=4`(Delete of Direct Child Resource) 통지가 발화하지 않는다** (todo 2건)

`cse/noti.js`의 주석은 `net` 1~4를 지원한다고 적고 있으나 **코드에 4번 분기가 없다.**
구조적 원인은 `check_and_send_noti()`가 구독을 `pi === req_prim.ri`(동작 대상의 자식)로만
조회한다는 점이다. net 1·2·3은 이 조회로 충분하지만, net=4는 **삭제되는 자식**이 동작
대상이고 구독은 **부모** 아래 있어 조회 기준이 어긋난다.

실측(2026-07-25): `mni=3` 컨테이너에 CIN 4개 투입 → eviction 발생(cni 4→3), `net=3` 통지
4건 수신, **`net=4` 0건**. CIN 명시적 DELETE(RSC 2002) → **`net=4` 0건**. 대조로 구독이
달린 컨테이너 자체를 DELETE하면 `net=2`가 1건 온다 — **통지 파이프라인 자체는 정상이고
`net=4`만 없다.**

실피해: `cse/resources/cin.js`의 `mni`/`mbs` 초과 eviction이 이 경로를 타므로,
**컨테이너가 `mni`를 넘기면 수집 데이터가 아무 통지 없이 삭제되고 응용 서비스가 유실을
감지할 수단이 없다.**

참고로 eviction은 `int_cr_req: true` 내부 요청이지만, `delete_a_res`의 통지 호출은 그
플래그와 무관하게 실행된다 — 즉 **통지 함수는 호출되고 있고 구독을 못 찾을 뿐이다.**
수정 시 이 플래그는 건드릴 필요가 없다.

> 고친 뒤에는 `npm test 2>&1 | grep "# TODO"`로 확인한다. `ok … # TODO`로 바뀌면 성공이며,
> 해당 테스트의 `{ todo: true }` 플래그를 떼서 진짜 회귀 테스트로 승격시켜야 한다.
> `npm test`의 요약 줄과 종료 코드는 수정 전후가 동일하므로 요약만 보면 알 수 없다.

### 검증 중 발견한 그 밖의 사항 (미수정, 테스트 없음)

- **고아 리소스를 `ri`로 조회하면 응답이 종료되지 않는다.** 부모가 삭제된 리소스를
  비구조화 ID로 GET하면 요청이 끝나지 않는다(6초 타임아웃 실측 / 같은 서버의 CSEBase는
  98ms에 200). `access_decision()`이 부모를 조회하다 빈 `pc`를 역참조해 예외를 던지고,
  GET 라우트의 `try/catch`가 그것을 삼켜 응답을 끝내지 않는 것으로 보인다(정적 읽기 기준).
- **`delete_a_res`의 자손 삭제가 fire-and-forget이다.** `delete_resources(child_res_list)`를
  `await` 없이 호출한다(최초 커밋부터 동일 — 회귀 아님). DELETE가 2002를 반환한 시점에
  자손이 아직 남아 있는 짧은 창이 생기고, 그 도중 프로세스가 죽으면 고아가 영구화되어
  위 항목을 유발한다. 자손 삭제 자체는 시간을 주면 정상 완료한다(실측 확인).
