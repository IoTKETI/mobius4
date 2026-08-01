# Changelog

이 저장소의 주목할 만한 변경을 기록한다. 최신 항목이 위에 온다.

## 버전 규칙

버전의 **정본은 `package.json`의 `version`** 하나다. 다른 곳에 하드코딩하지 않는다
(오래도록 `mobius4.js` 첫 줄이 `0.1.0`으로 남아 `package.json`의 4.x와 어긋나 있었다 —
지금은 `package.json`을 읽는다).

SemVer를 이 프로젝트 문맥으로 구체화하면:

| 자릿수 | 올리는 경우 |
|---|---|
| **MAJOR** | oneM2M 릴리스 축 변경, 수동 개입이 필요한 호환성 파괴 |
| **MINOR** | oneM2M 기능 추가(리소스 타입·오퍼레이션·필터 크리테리아·통지 이벤트 타입), 새 바인딩, 하위호환 DB 마이그레이션 |
| **PATCH** | 능력을 더하지 않는 버그 수정, 성능, 문서, 테스트 |

릴리스 시 `[Unreleased]`를 `## vX.Y.Z (YYYY-MM-DD)`로 끊고 `package.json`을 함께 올린다.

## [Unreleased]

_(Accumulate items here for the next release.)_

### Unresolved — pending spec clarification

- **Whether CIN eviction (`mni`/`mbs` exceeded) should fire `net=4`.** In oneM2M
  standardization discussion, **indirect deletion** (a deletion that happens as a
  side effect of deleting a different resource) is treated as not firing a
  notification. Whether eviction falls under this needs confirmation — what
  triggers eviction is CREATE, not DELETE. Excluded conservatively pending
  confirmation; the regression test is left as `todo` to keep the question visible.
  If the answer is "yes, notify," removing the `int_cr_req !== true` condition in
  `cse/noti.js` turns it on (at which point `int_cr`, carried by `retrieve_a_cin`,
  must be stripped from the notification).

## v4.4.1 (2026-08-01)

**PATCH인 근거**: 아래 전부가 oneM2M 능력을 더하지 않는다 — CI 인프라, 의존성 정리,
Node 24 호환이다.

- **CI 도입** — `.github/workflows/ci.yml`. Node 22·24 매트릭스, PostgreSQL 17 +
  PostGIS 3.6 서비스 컨테이너. (PR #9, #12)
- **`engines: { node: ">=22" }`** 추가, `.nvmrc` = `24` 신설. 22 지원은 유지한다.
- **`config` 1.31.0 → 3.3.12.** Node 24가 제거한 `util.isRegExp`를 `config` 1.x가
  호출해 Node 24에서 **기동조차 하지 못했다**. 3.3.12가 그 호출을
  `parent instanceof RegExp`로 바꾼 최초 버전이고, 2.x 라인은 2.0.2에서 끝나며
  여전히 취약하므로 더 작은 단계는 없었다. 소스 수정은 필요 없었다 — 이 저장소의
  config 사용은 `config.get(...)`과 속성 직접 읽기뿐이다.

  **⚠️ 주의**: config 1.x는 중첩 속성을 비쓰기화해 잘못된 대입이 조용히 무시됐으나,
  3.x는 배열을 `Object.freeze`하고 중첩 객체를 Proxy로 감싸 **대입 시 예외를
  던진다.** 앞으로 `config.get()`이 돌려준 객체·배열을 라이브러리에 그대로 넘기면
  안 된다 — 옵션 객체를 제자리에서 정규화하는 라이브러리를 만나면 런타임 예외가 난다.
- **미사용 의존성 13개 제거** — `fast-xml-parser` `shortid` `sync-request`
  `path-to-regexp` `query-string` `urlencode` `bson-objectid` `base-64` `debug`
  `morgan` `rdfxml-streaming-parser` `fs` `https`. `fs`와 `https`는 Node 내장
  모듈과 이름이 같은 껍데기 패키지로, 로드될 경로가 없었다. `pg-hstore`
  (sequelize 런타임 로드)와 `pino-roll`(`logger.js:53` transport 타깃 문자열)은
  `require`가 0건이지만 존치했다. (PR #10)
- **테스트 리포터를 `--test-reporter=tap`으로 고정.** Node 24가 `node --test`의
  기본 리포터를 tap에서 spec으로 바꿔, `test/README.md`가 안내하는
  `not ok … # TODO` / `ok … # TODO` 판독 절차가 Node 24에서 깨졌다.
- 추적되던 `.DS_Store` 3개 제거 + `.gitignore` 등재.
- **Removed the unreachable DAS/`jose` dead code.** `parse_dynamic_auth_resp`
  (`cse/hostingCSE.js`) read `config.das.private_key`, but `das` was never
  defined anywhere in `config/default.json` or `config/local.json`
  (`config.has('das') === false`), so the call threw `TypeError` before
  `jose.JWE.decrypt` was ever reached — on both Node 22 and Node 24. The
  function was called from nowhere and exported nowhere; the DAS (Dynamic
  Authorization Server) integration never had a working path. Removed the
  function, the `jose` dependency (its only call site), and the file-local
  `axios` `require` (its only use in this file — the `axios` package itself
  is still used by `noti.js`, `reqPrim.js`, and `registree.js`). Dropped
  rather than upgraded a 5-major-version-behind dependency for code that
  never worked. (PR #14)
- **Updated README.md and docs/installation.md** (Windows/macOS/Linux) to
  reflect that both Node 22 and 24 are supported. (PR #15)

## v4.4.0 (2026-07-26)

**MINOR인 근거**: `net=4` 통지와 `lvl` 필터는 **없던 oneM2M 기능이 생긴 것**이다(버그
수정이 아니다). `db/migrations/v4.4.0.sql`(하위호환 스키마 변경)도 이 릴리스에 포함된다.

**요약**

| 분류 | 내용 |
|---|---|
| 기능 추가 | `net=4`(Delete of Direct Child Resource) 통지, `lvl`(level) 필터 크리테리아 |
| 버그 수정 | 디스커버리가 조용히 틀린 결과를 주던 경로 3종 |
| 개발 인프라 | 테스트 하니스 신설(테스트 0개 → 36개) |
| 스키마 | `db/migrations/v4.4.0.sql` |

**⚠️ 동작 변경 — 기존 클라이언트에 보입니다**

- **디스커버리 실패가 더는 성공으로 둔갑하지 않는다.** 지금까지 SQL 오류 등으로 실패해도
  빈 목록과 RSC 2000이 나갔다. 이제 5000(또는 미구현 파라미터면 5001)이 나간다.
  "결과 없음"과 "실패"를 구별할 수 있게 된 것이지만, 2000을 기대하던 코드는 영향을 받는다.
- **`gmty` 범위 검증이 생겼다.** 규격상 유효 범위(1..6) 밖이면 4000, 범위 안이지만
  mobius4가 구현하지 않은 4~6이면 5001이다. 그전에는 조용히 무시됐다.
- **`lvl`이 실제로 동작한다.** 그전에는 파싱·검증만 되고 결과에 반영되지 않았다.
  `lvl`을 보내면서 전체 결과를 받아 쓰던 코드가 있다면 결과 집합이 줄어든다.
- **디스커버리·삭제의 이름 매칭이 정확해졌다.** 이름에 `_`가 든 리소스가 형제를 끌어들이던
  문제를 고쳤다 — 그전에는 `a_c`로 조회할 때 `abc`의 자손까지 나왔다.


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

### 디스커버리가 조용히 틀린 결과를 주던 경로 3종 수정 (2026-07-26)

셋은 서로 다른 버그지만 증상의 성격이 같았다 — **오류를 내지 않고 조용히 틀린 결과를 준다.**

**1. 잘못된 `gmty`가 범위 제한을 통째로 무력화했다** (조용히 너무 많이)

`set_where_clause`의 계약은 `{ where, has_geo_query }`인데 지오쿼리 분기의 `default:`
두 곳이 `return where;`로 빠져나갔다. 호출부가 구조분해하므로 `where`가 `undefined`가 되고
`findAll({ where: undefined })`는 **조건 없이 테이블 전체**를 돌려준다 — 대상 서브트리로
좁히는 `sid` 조건까지 함께 사라진다. `gsf`는 Joi가 1..3으로 막고 있었지만 `gmty`에는
범위 검증이 없어 `?fu=1&gmty=9&gsf=1&geom=[1,2]`로 도달했다.

두 겹으로 고쳤다 — 계약을 바로잡아 최악의 경우에도 `sid` 제한이 살아남게 하고,
`gmty`에 규격 범위(`TS-0004:6.3.4.2.74` — 1..6) 검증을 더했다.

**2. 디스커버리 실패가 성공으로 둔갑했다** (조용히 아무것도 안)

`fu1_discovery` 호출이 예외를 삼키고 로그만 남겨, SQL이 실패해도 **빈 목록 + RSC 2000**이
나갔다. 이 결함은 이미 대가를 치렀다 — `lvl` 구현 중 잘못된 WHERE 조건이 에러가 아니라
빈 결과로 나타나 진단이 늦어졌다. **다른 결함을 숨기는 결함**이었다.

**3. LIKE 와일드카드가 이스케이프되지 않았다** (조용히 엉뚱한 걸)

`sid` 접두어의 `_`가 SQL LIKE에서 임의의 한 문자와 매칭돼, `a_c`로 조회하면 `abc`의
자손까지 나왔다. 리소스 이름에 밑줄은 흔하다 — 3부 표준의 엔티티 인스턴스 컨테이너가
`{modelId}_{version}_{instanceId}` 형식이고 기본 ACP도 `cb_default_acp`다.
**디스커버리와 `delete_a_res`의 자손 수집 두 곳** 모두 고쳤다(삭제 쪽은 과다 매칭이 곧
남의 리소스 삭제다).

**테스트**: 5건 추가(범위 유지·`gmty` 코드·실패가 2000이 아님·밑줄 디스커버리·밑줄 삭제).
전부 **수정 전에 실패하는 것을 확인**한 뒤 고쳤다.

### 검증 중 발견한 그 밖의 사항 (미수정, 테스트 없음)

- **`delete_a_res`의 자손 삭제가 fire-and-forget이다.** `delete_resources(child_res_list)`를
  `await` 없이 호출한다(최초 커밋부터 동일 — 회귀 아님). DELETE가 2002를 반환한 시점에
  자손이 아직 남아 있는 짧은 창이 생기고, 그 도중 프로세스가 죽으면 고아가 남는다.
  자손 삭제 자체는 시간을 주면 정상 완료한다(실측 확인).
- **`cse/reqPrim.js`의 시맨틱 디스커버리 분기에 오타로 보이는 줄이 있다** —
  `resp_prim.rsc = { "m2m:dbg": ... }`로 두 번째도 `rsc`에 대입한다(`pc`여야 한다).
  이번 범위 밖이라 손대지 않았다.

### 해소 확인 (업스트림)

- ~~고아 리소스를 `ri`로 조회하면 응답이 종료되지 않는다~~ — `cse/reqPrim.js`의
  `return;` → `return resp_prim;` 수정으로 해소됐다. 2026-07-26 재현 시도: 무한 대기 →
  **10ms 만에 응답**.
