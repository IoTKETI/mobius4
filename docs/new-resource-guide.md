# 신규 리소스 타입 추가 가이드

이 문서는 Mobius4에 새로운 oneM2M 리소스 타입을 추가할 때 수정해야 하는 파일과 구체적인 코드 패턴을 정리합니다.  
예시로는 기존에 구현된 **type 106 (`dts`, dataset)** 을 참조합니다.

---

## 전체 체크리스트

```
[ ] 1. config/enums.js              — ty_str 맵에 타입 등록
[ ] 2. models/xyz-model.js          — Sequelize 모델 파일 생성
[ ] 3. db/init.js                   — CREATE TABLE DDL 추가
[ ] 4. cse/resources/xyz.js         — CRUD 핸들러 구현
[ ] 5. cse/hostingCSE.js            — 모델·핸들러 import, 4개 switch에 case 추가, 2개 맵에 등록
[ ] 6. cse/reqPrim.js               — 핸들러 import, 가상 자식 리소스(la/ol) 분기 추가 (해당되는 경우)
[ ] 7. cse/validation/res_schema.js — Joi 스키마 정의 (권장)
[ ] 8. cse/resources/sub.js         — 구독 허용 부모 타입 목록에 추가 (해당되는 경우)
[ ] 9. config/default.json          — supportedResourceType 목록에 추가 (표준 리소스인 경우)
```

---

## 단계별 상세 가이드

### 1. `config/enums.js` — 타입 코드 등록

**위치:** `ty_str` 객체 (line 24~44)

```javascript
const ty_str = {
    // 표준 리소스 (생략)
    // 비표준 리소스 — 아래에 추가
    101: "mrp",
    102: "mmd",
    // ...
    108: "xyz",  // ← 새 타입 추가
};
```

- 타입 코드(숫자)와 단축 이름(문자열) 매핑
- `ty_str` 하나만 추가하면 됨. 역방향 맵은 별도 존재하지 않음
- `get_a_new_rn(ty)`가 이 맵을 사용해 자동 리소스명(`xyz-abc123`) 생성

---

### 2. `models/xyz-model.js` — Sequelize 모델 생성

**위치:** `models/` 디렉토리에 신규 파일 생성

```javascript
const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const XYZ = sequelize.define('xyz', {
    // ── 필수 공통 속성 ──────────────────────────────
    ri: {
        type: DataTypes.STRING(24),
        primaryKey: true,
        allowNull: false,
    },
    ty: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 108,        // ← 타입 코드 지정
    },
    sid:    DataTypes.STRING,
    int_cr: DataTypes.STRING,
    rn:     DataTypes.STRING,
    pi:     DataTypes.STRING,
    et:     DataTypes.STRING(20),
    ct:     DataTypes.STRING(20),
    lt:     DataTypes.STRING(20),
    acpi: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        defaultValue: null,
    },
    lbl: {
        type: DataTypes.ARRAY(DataTypes.STRING),
        defaultValue: null,
    },
    cr: DataTypes.STRING,

    // ── 리소스 전용 속성 ────────────────────────────
    // 예시: 단일값
    some_attr: DataTypes.STRING,
    // 예시: 배열
    some_list: DataTypes.ARRAY(DataTypes.STRING),
    // 예시: JSON
    some_json: DataTypes.JSONB,
    // 예시: 위치 (geo 지원 시)
    loc: DataTypes.GEOMETRY('GEOMETRY', 4326),
}, {
    tableName: 'xyz',    // DB 테이블 이름 (ty_str 값과 일치)
    timestamps: false,
});

module.exports = XYZ;
```

**참고 모델:** `models/dts-model.js`, `models/mrp-model.js`

---

### 3. `db/init.js` — CREATE TABLE DDL 추가

**위치:** `create_tables()` 함수 내, 다른 `CREATE TABLE` 블록 바로 다음에 추가

```javascript
// create xyz table
await client.query(`
    CREATE TABLE IF NOT EXISTS xyz (
        ri      VARCHAR(${len.ri_max}) PRIMARY KEY,
        ty      INTEGER NOT NULL DEFAULT 108,
        sid     VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
        cr      VARCHAR(${len.str_token}),
        int_cr  VARCHAR(${len.str_token}),
        rn      VARCHAR(${len.str_token}) NOT NULL,
        pi      VARCHAR(${len.ri_max}),
        et      VARCHAR(${len.timestamp}),
        ct      VARCHAR(${len.timestamp}),
        lt      VARCHAR(${len.timestamp}),
        acpi    VARCHAR(${len.structured_res_id})[],
        lbl     VARCHAR(${len.str_token})[],

        -- 리소스 전용 컬럼
        some_attr   VARCHAR(${len.str_token}),
        some_list   VARCHAR(${len.str_token})[],
        some_json   JSONB
    );
`);
```

**인덱스 추가 위치:** `-- Performance indexes ---` 섹션 (line ~470)

```javascript
// xyz: pi 기반 자식 조회가 빈번하면 추가
await client.query(`
    CREATE INDEX IF NOT EXISTS idx_xyz_pi ON xyz (pi);
`);
```

**컬럼 크기 상수 (`len` 객체):**

| 상수 | 용도 |
|------|------|
| `len.ri_max` | ri, pi (리소스 ID) |
| `len.structured_res_id` | sid, acpi |
| `len.str_token` | rn, cr, lbl 등 일반 문자열 |
| `len.timestamp` | et, ct, lt |

**geo 지원 컬럼 (위치 필터 필요 시):**
```sql
loc GEOMETRY(GEOMETRY, 4326)
```
+ `TYPE_MODEL`에서 `no_geo: false`로 설정 (→ 5단계 참조)

---

### 4. `cse/resources/xyz.js` — CRUD 핸들러 구현

**위치:** `cse/resources/` 디렉토리에 신규 파일 생성

#### 파일 구조

```javascript
const { xyz_create_schema, xyz_update_schema } = require('../validation/res_schema');
const { generate_ri, get_cur_time, get_default_et } = require('../utils');
const enums = require('../../config/enums');
const XYZ = require('../../models/xyz-model');
const Lookup = require('../../models/lookup-model');
const logger = require('../../logger').child({ module: 'xyz' });

// 허용된 부모 리소스 타입 목록
const xyz_parent_res_types = ['cb', 'ae', 'cnt'];  // ← 타입에 맞게 설정

async function create_an_xyz(req_prim, resp_prim) { ... }
async function retrieve_an_xyz(req_prim, resp_prim) { ... }
async function update_an_xyz(req_prim, resp_prim) { ... }  // 필요 시
// 가상 자식 리소스를 가질 경우:
// async function retrieve_ol(req_prim, resp_prim) { ... }
// async function retrieve_la(req_prim, resp_prim) { ... }
// async function delete_ol(req_prim, resp_prim) { ... }
// async function delete_la(req_prim, resp_prim) { ... }

module.exports = {
    create_an_xyz,
    retrieve_an_xyz,
    update_an_xyz,
};
```

#### CREATE 패턴

```javascript
async function create_an_xyz(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:xyz'];

    // 1. 스키마 검증
    const validated = xyz_create_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    // 2. 부모 타입 확인
    const parent_ty = req_prim.to_ty;
    if (!xyz_parent_res_types.includes(enums.ty_str[parent_ty.toString()])) {
        resp_prim.rsc = enums.rsc_str['INVALID_CHILD_RESOURCE_TYPE'];
        resp_prim.pc = { 'm2m:dbg': 'cannot create <xyz> to this parent resource type' };
        return;
    }

    const ri = generate_ri();
    const now = get_cur_time();
    const et = get_default_et();
    const xyz_pi = req_prim.ri;
    const xyz_sid = req_prim.sid + '/' + prim_res.rn;

    try {
        // 3. 리소스 생성 (항상 두 테이블 동시에)
        await XYZ.create({
            ri, ty: 108, rn: prim_res.rn, pi: xyz_pi, sid: xyz_sid,
            int_cr: req_prim.fr,
            et: prim_res.et || et, ct: now, lt: now,
            cr: prim_res.cr === null ? req_prim.fr : null,
            acpi: prim_res.acpi || null,
            lbl:  prim_res.lbl  || null,
            // 리소스 전용 속성
            some_attr: prim_res.some_attr || null,
        });

        await Lookup.create({
            ri, ty: 108, rn: prim_res.rn, sid: xyz_sid,
            lvl: xyz_sid.split('/').length,
            pi: xyz_pi,
            cr: prim_res.cr === null ? req_prim.fr : null,
            int_cr: req_prim.fr,
            et: prim_res.et || et,
        });

        // 4. 생성된 리소스를 조회해 응답
        const tmp_req = { ri }, tmp_resp = {};
        await retrieve_an_xyz(tmp_req, tmp_resp);
        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        logger.error({ err }, 'create_an_xyz failed');
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': err.message };
    }
}
```

#### RETRIEVE 패턴

```javascript
async function retrieve_an_xyz(req_prim, resp_prim) {
    const xyz_obj = { 'm2m:xyz': {} };  // ← 응답 키는 'mäm:' + ty_str 값
    const ri = req_prim.ri;

    try {
        const db_res = await XYZ.findByPk(ri);
        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': '<xyz> resource not found' };
            return;
        }

        // 내부 API 요청 시 int_cr 포함
        if (req_prim?.int_cr_req === true)
            xyz_obj['m2m:xyz'].int_cr = db_res.int_cr;

        // 필수 공통 속성
        xyz_obj['m2m:xyz'].ty = db_res.ty;
        xyz_obj['m2m:xyz'].ri = db_res.ri;
        xyz_obj['m2m:xyz'].rn = db_res.rn;
        xyz_obj['m2m:xyz'].pi = db_res.pi;
        xyz_obj['m2m:xyz'].et = db_res.et;
        xyz_obj['m2m:xyz'].ct = db_res.ct;
        xyz_obj['m2m:xyz'].lt = db_res.lt;

        // 선택적 공통 속성
        if (db_res.acpi?.length) xyz_obj['m2m:xyz'].acpi = db_res.acpi;
        if (db_res.lbl?.length)  xyz_obj['m2m:xyz'].lbl  = db_res.lbl;
        if (db_res.cr)           xyz_obj['m2m:xyz'].cr   = db_res.cr;

        // 리소스 전용 속성
        if (db_res.some_attr) xyz_obj['m2m:xyz'].some_attr = db_res.some_attr;

        resp_prim.pc = xyz_obj;
    } catch (err) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': '<xyz> resource not found' };
        throw err;
    }
}
```

#### UPDATE 패턴 (선택)

```javascript
async function update_an_xyz(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:xyz'];
    const ri = req_prim.ri;

    const validated = xyz_update_schema.validate(prim_res);
    if (validated.error) { ... }

    try {
        const db_res = await XYZ.findByPk(ri);
        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': '<xyz> resource not found' };
            return;
        }

        db_res.lt = get_cur_time();

        // 변경 가능한 속성만 갱신
        if (prim_res.et)   db_res.et   = prim_res.et;
        if (prim_res.acpi) db_res.acpi = prim_res.acpi;
        if (prim_res.lbl)  db_res.lbl  = prim_res.lbl;
        if (prim_res.some_attr) db_res.some_attr = prim_res.some_attr;

        // null 전송 시 속성 삭제
        if (prim_res.acpi === null) db_res.acpi = null;
        if (prim_res.lbl  === null) db_res.lbl  = null;

        await db_res.save();

        const tmp_req = { ri }, tmp_resp = {};
        await retrieve_an_xyz(tmp_req, tmp_resp);
        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        logger.error({ err }, 'update_an_xyz failed');
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': err.message };
    }
}
```

**참고 핸들러:** `cse/resources/dts.js`, `cse/resources/mrp.js`, `cse/resources/cnt.js`

---

### 5. `cse/hostingCSE.js` — 4개 switch + 2개 맵 등록

#### 5-A. import 추가 (line ~26~55)

```javascript
// 모델 import (상단 모델 섹션)
const XYZ = require('../models/xyz-model');       // line ~32

// 핸들러 import (하단 핸들러 섹션)
const xyz = require("./resources/xyz");           // line ~55
```

#### 5-B. CREATE switch (line ~122~178)

```javascript
case 108:
    await xyz.create_an_xyz(req_prim, resp_prim);
    break;
```

#### 5-C. RETRIEVE switch (line ~217~269)

```javascript
case 108:
    await xyz.retrieve_an_xyz(req_prim, resp_prim);
    break;
```

#### 5-D. UPDATE switch (line ~468~515) — 업데이트 가능한 경우에만

```javascript
case 108:
    await xyz.update_an_xyz(req_prim, resp_prim);
    break;
```

> UPDATE를 지원하지 않으면 추가하지 말 것. `default` case가 `OPERATION_NOT_ALLOWED`를 반환함.

#### 5-E. DELETE_MODEL 맵 (line ~607~610)

```javascript
const DELETE_MODEL = {
    // ... 기존 항목
    106: DTS, 107: DSF,
    108: XYZ,   // ← 추가
};
```

자식 리소스 포함 일괄 삭제 시 사용됨. **반드시 추가해야 함.**

#### 5-F. TYPE_MODEL 맵 (line ~653~668) — discovery 쿼리용

```javascript
const TYPE_MODEL = {
    // ... 기존 항목
    107: { model: DSF, no_geo: true },
    108: { model: XYZ, no_geo: true },   // ← 추가
    //                          ↑ 위치 속성(loc)이 없으면 true, 있으면 false
};
```

- `no_geo: true` — 위치 기반 Discovery 필터 미지원
- `no_geo: false` — loc 컬럼이 있고 geo 필터를 지원

---

### 6. `cse/reqPrim.js` — 가상 자식 리소스 분기 추가

**해당되는 경우:** 새 리소스가 `la` (latest) / `ol` (oldest) 가상 자식 리소스를 가질 때만 추가.  
예: `<container>`(`cnt`) ↔ `<contentInstance>`(`cin`) 관계처럼 자식 순서가 있는 경우.

#### import 추가 (line ~17~19)

```javascript
const xyz = require("./resources/xyz");
```

#### `la` 분기 (line ~144~170)

```javascript
else if ('la' === req_prim.vr) {
    switch (req_prim.op) {
        case 2:  // RETRIEVE latest
            // ... 기존
            } else if (req_prim.parent_ty == 108) {
                await xyz.retrieve_la(req_prim, resp_prim);
            }
            break;
        case 4:  // DELETE latest
            // ... 기존
            } else if (req_prim.parent_ty == 108) {
                await xyz.delete_la(req_prim, resp_prim);
            }
            break;
    }
}
```

#### `ol` 분기 (line ~171~197)

```javascript
else if ('ol' === req_prim.vr) {
    switch (req_prim.op) {
        case 2:  // RETRIEVE oldest
            } else if (req_prim.parent_ty == 108) {
                await xyz.retrieve_ol(req_prim, resp_prim);
            }
            break;
        case 4:  // DELETE oldest
            } else if (req_prim.parent_ty == 108) {
                await xyz.delete_ol(req_prim, resp_prim);
            }
            break;
    }
}
```

---

### 7. `cse/validation/res_schema.js` — Joi 스키마 정의 (권장)

**위치:** 파일 내 다른 스키마 정의 다음에 추가

```javascript
const xyz_create_schema = Joi.object().keys({
    ...create_universal_attr,     // rn, et, acpi, lbl, cr 등 공통 속성

    // 리소스 전용 속성 (필수)
    required_field: Joi.string().required(),

    // 리소스 전용 속성 (선택)
    optional_field: Joi.string().optional(),

    // 생성 시 읽기 전용 (클라이언트 설정 불가)
    read_only_field: Joi.forbidden(),
});

const xyz_update_schema = Joi.object().keys({
    ...update_universal_attr,     // et, acpi, lbl 등 공통 업데이트 속성

    // 업데이트 가능한 속성
    optional_field: Joi.string().optional(),

    // 생성 후 변경 불가 속성
    required_field: Joi.forbidden(),
    read_only_field: Joi.forbidden(),
});
```

**export에 추가:**

```javascript
module.exports = {
    // ... 기존
    xyz_create_schema, xyz_update_schema,
};
```

**참고 스키마:** `dsp_create_schema`, `cnt_create_schema` (line ~285~336)

---

### 8. `cse/resources/sub.js` — 구독 허용 부모 목록 추가 (조건부)

새 리소스에 `<sub>`(Subscription) 자식을 생성할 수 있게 허용하려면:

**위치:** line 12

```javascript
const sub_parent_res_types = [
    "ae", "acp", "cb", "cnt", "csr", "grp", "flx",
    "mrp", "mmd", "mdp", "dpm",
    "xyz",  // ← 추가
];
```

---

### 9. `config/default.json` — supportedResourceType 목록 (조건부)

표준(Standard) 리소스이고 CSEBase의 `srt` 속성에 광고해야 하는 경우:

```json
"supported_resource_types": [1, 2, 3, 4, 5, 9, 16, 23, 108]
```

비표준 리소스(사내 확장)는 일반적으로 추가하지 않음.

---

## 기능별 조건 분기표

| 기능 | 해당 조건 | 추가 위치 |
|------|-----------|-----------|
| 위치 기반 필터 (geo) | `loc` 컬럼이 있을 때 | `TYPE_MODEL`에 `no_geo: false`, DDL에 `GEOMETRY` 컬럼 |
| 구독 (`<sub>`) 생성 | 자식으로 구독 허용 시 | `sub.js` `sub_parent_res_types` |
| 가상 자식 (`la`/`ol`) | 순서 있는 자식을 가질 때 | `reqPrim.js` la/ol 분기, 핸들러에 4개 함수 구현 |
| UPDATE 지원 | 변경 가능한 속성이 있을 때 | `hostingCSE.js` UPDATE switch, `update_an_xyz()` 구현 |
| Joi 검증 | (항상 권장) | `res_schema.js` 스키마 정의, 핸들러에서 호출 |

---

## 참고 파일 목록

| 목적 | 참고 파일 |
|------|----------|
| 단순 비표준 리소스 | `cse/resources/dts.js`, `models/dts-model.js` |
| 가상 자식(`la`/`ol`)이 있는 리소스 | `cse/resources/mrp.js`, `cse/resources/cnt.js` |
| geo 지원 리소스 | `cse/resources/ae.js`, `cse/resources/cnt.js` |
| 복잡한 Joi 스키마 | `cse/validation/res_schema.js` — `dsp_create_schema` |
| DDL 패턴 전체 | `db/init.js` — `create_tables()` 함수 |
