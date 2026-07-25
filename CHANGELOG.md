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

### `lvl` (level) 필터 크리테리아 적용 (2026-07-26)

**구현했다.** `lvl`은 그동안 파싱과 검증까지만 되고 질의에 반영되지 않아, 요청이 RSC 2000으로
성공 응답하면서 필터를 **조용히 버리고** 모든 깊이의 리소스를 돌려주고 있었다.

**변경**: `cse/hostingCSE.js` 한 곳 — 디스커버리 WHERE 절의 `sid` 접두어 조건 바로 다음.

**규격 근거**: oneM2M `TS-0001:8.1.2` — *"The maximum level of resource tree that the Hosting
CSE shall perform the operation starting from the target resource… The level of the target
resource itself is zero and the level of the direct children of the target is one."*
즉 `lvl`은 **대상으로부터의 상대 깊이**다. 미지정 시 깊이 제한이 없다는 것도 같은 절에 있다.

**구현 시 주의한 지점 셋:**

- **상대 → 절대 환산.** 저장된 깊이는 `Mobius`=1부터 시작하는 절대값이라, 대상의 절대 깊이를
  더해 상한으로 바꿔야 한다. 이 환산을 빠뜨리면 **트리 최상위에서만 우연히 맞고 하위
  노드에서 틀린다.**
- **`lookup.lvl` 컬럼은 쓸 수 없다.** 디스커버리는 `lookup`이 아니라 타입별 테이블
  (`cnt`·`cin`·`acp`…)을 각각 조회하는데 그 테이블들에는 `lvl` 컬럼이 없다. 대신 모든
  타입 테이블에 공통인 `sid`에서 SQL로 깊이를 센다
  (`array_length(string_to_array(sid,'/'),1)` — 모든 sid에서 `sid.split("/").length`와
  정확히 일치함을 검증했다).
- **SQL WHERE에서 거른다.** 조회 후 애플리케이션에서 거르면 `lim`(기본 200)이 먼저 적용돼
  깊은 노드가 정원을 채우고 정작 원하는 얕은 결과가 잘려나간다.

**부수 효과(의도됨)**: `rcn=4/8` 중첩 조회도 같은 경로를 타므로 `lvl`을 함께 존중하게 됐다.
`TS-0001:8.1.2`가 `offset`·`limit`·`level`을 한 묶음으로 규정하는 것과 맞는 동작이다.

**알려진 이탈**: `lvl=0`은 `prim_schema.js`가 `min(1)`로 거부해 4000이 된다. 규격은 "대상
자신이 level 0"이라고 하지만, 디스커버리(`fu=1`)는 대상 자신을 반환하지 않으므로 `lvl=0`은
어차피 빈 결과다. 스키마 변경은 범위 밖으로 두었다.

**공인 시험 없음**: ATS 전체를 확인한 결과 `level`을 세팅하는 테스트 케이스가 하나도 없다
(템플릿은 전부 `omit`). TTA·oneM2M 인증에는 필요하지 않으며, 자동 검증 수단은 이 저장소의
회귀 테스트 5건이 전부다.

**테스트**: `test/discovery.test.js`에 5건(`lvl=1`·`lvl=2`·상대 깊이·`lvl`+`ty` AND·
비구조화 ID 주소 지정).

### `net=4` (Delete of Direct Child Resource) 통지 구현 (2026-07-26)

**구현했다.** `cse/noti.js`의 주석이 오래도록 `net` 1~4 지원을 표방했으나 실제로는 4번
분기가 없었고, 이제 코드와 주석이 일치한다.

**구조적 원인**은 `check_and_send_noti()`가 구독을 `pi === req_prim.ri`(동작 대상의 자식)로만
조회한다는 점이었다. net 1·2·3은 이 조회로 충분하지만, net=4는 **삭제되는 자식**이 동작
대상이고 구독은 **부모** 아래 있어 조회 기준이 어긋났다.

**변경**: `cse/noti.js` 한 파일. `notify_parent_of_child_deletion(deleted_pc, deleted_ty)`를
신설하고 `check_and_send_noti` 진입부에서 호출한다. `delete_a_res`·`cin.js`·`hostingCSE.js`는
**건드리지 않았다.**

구현 시 주의한 지점 셋:

- **조기 반환보다 앞에 둬야 한다.** `check_and_send_noti`는 동작 대상 자신의 구독이 0건이면
  즉시 반환하는데, `<contentInstance>` 아래에는 보통 구독이 없다. net=4 처리를 그 뒤에 두면
  주 사용 사례에서 영영 실행되지 않는다.
- **자기 구독 조회를 먼저 '발사'해 둔다.** `delete_a_res`가 통지와 캐스케이드 삭제를 동시에
  굴리므로, 자기 구독 SELECT가 net=4 조회 뒤로 밀리면 `delete_resources`의 `SUB.destroy`가
  먼저 도착해 **그 리소스의 net=2 통지가 조용히 사라진다.**
- **net=4 실패를 격리한다.** 부모 구독의 고장(예: 잘못된 `nu`)이 삭제된 리소스 자신의
  net=1/2/3 통지까지 죽이지 않도록 `.catch`로 막았다.

**규격 근거**: oneM2M `TS-0004:6.3.4.2.19`(`4 = Delete_of_Direct_Child_Resource`),
`TS-0004:7.5.1.2.2` Step 1.0(`childResourceType` 필터는 net=3과 동일 규칙, 없으면 모든 자식
타입에 발화 / `notificationEventType` 미설정 시 기본값은 `Update_of_Resource`),
같은 절 Step 2.1(통지 내용은 **자식** 리소스의 표현). 공인 시험은 `TC_CSE_SUB_DEL_003`.

**구현 범위 — 직접 DELETE만.** 아래 둘은 **의도적으로 제외**했다.

| 삭제 유형 | 동작 | 사유 |
|---|---|---|
| 직접 DELETE | **통지함** | 공인 시험 범위, 규격이 명확 |
| CIN eviction(`mni`/`mbs` 초과) | 통지 안 함 | `int_cr_req !== true` 가드로 배제 — 아래 참조 |
| 캐스케이드 자손(부모 삭제로 함께 삭제) | 통지 안 함 | `delete_resources`가 통지 함수를 호출하지 않음(기존 동작 유지) |

**⚠️ 열린 질문**: oneM2M 표준화 논의에서 **indirect deletion**(다른 리소스를 삭제하면서
부수적으로 발생하는 삭제)은 통지 이벤트를 발생시키지 않는 것으로 다뤄졌다. 캐스케이드
자손 삭제가 여기 해당한다. **CIN eviction이 여기 포함되는지는 확인이 필요하다** — eviction을
유발하는 것은 DELETE가 아니라 CREATE이므로 문자 그대로는 해당하지 않는다. 확인 전까지
보수적으로 제외했고, 회귀 테스트를 `todo`로 남겨 질문이 살아 있음을 표시했다.

이 답에 따라 **`mni` 초과 시 수집 데이터가 무통지로 사라지는 문제**의 성격이 갈린다 —
규격상 정상 동작이거나, 아직 남은 결함이거나.

**테스트**: `test/notification.test.js`에 6건(발화·`nev.rep` 내용·`chty` 양방향·조부모
미발화·캐스케이드 무통지). eviction 1건은 `todo`로 유지.

### 검증 중 발견한 그 밖의 사항 (미수정, 테스트 없음)

- **고아 리소스를 `ri`로 조회하면 응답이 종료되지 않는다.** 부모가 삭제된 리소스를
  비구조화 ID로 GET하면 요청이 끝나지 않는다(6초 타임아웃 실측 / 같은 서버의 CSEBase는
  98ms에 200). `access_decision()`이 부모를 조회하다 빈 `pc`를 역참조해 예외를 던지고,
  GET 라우트의 `try/catch`가 그것을 삼켜 응답을 끝내지 않는 것으로 보인다(정적 읽기 기준).
- **`delete_a_res`의 자손 삭제가 fire-and-forget이다.** `delete_resources(child_res_list)`를
  `await` 없이 호출한다(최초 커밋부터 동일 — 회귀 아님). DELETE가 2002를 반환한 시점에
  자손이 아직 남아 있는 짧은 창이 생기고, 그 도중 프로세스가 죽으면 고아가 영구화되어
  위 항목을 유발한다. 자손 삭제 자체는 시간을 주면 정상 완료한다(실측 확인).
