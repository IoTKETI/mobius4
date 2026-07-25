# mobius4 테스트

HTTP 블랙박스 회귀 스위트. 테스트가 mobius4를 전용 DB·동적 포트로 직접 띄우므로
개발 인스턴스가 돌고 있어도 안전하다.

## 사전 준비 (1회)

```bash
createdb mobius4_test
```

PostgreSQL과 PostGIS 확장이 필요하다(개발용 DB와 동일 요구사항). 테이블·CSEBase·기본 ACP는
첫 실행 때 자동 생성된다.

테스트는 `NODE_CONFIG`로 DB 이름·포트·MQTT·로깅만 덮어쓰고, 나머지 설정은 `config/`에서
그대로 가져온다. 따라서 `cse.admin`(기본 `SM`)·`cse.csebase_rn`(기본 `Mobius`)·
`cse.cse_type`(기본 `1`)을 **로컬 설정에서 바꿔 두었다면 테스트가 깨진다** —
오리지네이터와 CSEBase 이름이 테스트에 하드코딩돼 있고, `cse_type`이 2·3이면 부팅 시
원격 CSE 등록을 시도해 기동 대기가 타임아웃될 수 있다. DB 접속 계정도 `config/`에서 온다.

## 실행

```bash
npm test
```

## 읽는 법

- `# fail 0`이면 통과다.
- `not ok … # TODO`는 **알려진 미수정 결함**이다(스위트를 실패시키지 않는다).

### ⚠️ 결함을 고쳤다면 요약만 보지 말 것

`todo` 테스트는 통과해도 `# pass`가 아니라 `# todo`로 집계된다. 즉 **결함을 고쳐도
요약 줄과 종료 코드가 그대로다**(`# pass 19 / # todo 6`, exit 0). 성공 여부는 개별 줄에만
드러나므로 이렇게 확인한다:

```bash
npm test 2>&1 | grep "# TODO"
```

- `not ok … # TODO` → 아직 결함이 남아 있다.
- `ok … # TODO` → **고쳐졌다.** 해당 테스트의 `{ todo: true }` 플래그를 떼서 진짜
  회귀 테스트로 승격시킨다. 떼지 않으면 다음에 다시 깨져도 스위트가 초록으로 남는다.
