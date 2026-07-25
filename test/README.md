# mobius4 테스트

HTTP 블랙박스 회귀 스위트. 테스트가 mobius4를 전용 DB·동적 포트로 직접 띄우므로
개발 인스턴스가 돌고 있어도 안전하다.

## 사전 준비 (1회)

```bash
createdb mobius4_test
```

PostgreSQL과 PostGIS 확장이 필요하다(개발용 DB와 동일 요구사항). 테이블·CSEBase·기본 ACP는
첫 실행 때 자동 생성된다.

## 실행

```bash
npm test
```

## 읽는 법

- `# fail 0`이면 통과다.
- `not ok … # TODO`는 **알려진 미수정 결함**이다(스위트를 실패시키지 않는다).
  고치면 `ok … # TODO`로 바뀌므로, 그때 `{ todo: true }` 플래그를 떼야 한다.
