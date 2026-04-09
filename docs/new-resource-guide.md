# Adding a New Resource Type

This guide covers every file to create or modify when adding a new oneM2M resource type to Mobius4.
**Type 106 (`dts`, dataset)** is used throughout as a concrete reference example.

---

## Checklist

```
[ ] 1. config/enums.js              — register type code in ty_str map
[ ] 2. models/xyz-model.js          — create Sequelize model file
[ ] 3. db/init.js                   — add CREATE TABLE DDL
[ ] 4. cse/resources/xyz.js         — implement CRUD handler
[ ] 5. cse/hostingCSE.js            — import model & handler, add cases to 4 switches, register in 2 maps
[ ] 6. cse/reqPrim.js               — import handler, add la/ol virtual resource dispatch (if applicable)
[ ] 7. cse/validation/res_schema.js — define Joi schemas (recommended)
[ ] 8. cse/resources/sub.js         — add to subscribable parent type list (if applicable)
[ ] 9. config/default.json          — add to supportedResourceType list (standard resources only)
```

---

## Step-by-Step Guide

### 1. `config/enums.js` — Register the type code

**Location:** `ty_str` object (lines 24–44)

```javascript
const ty_str = {
    // standard resources (omitted)
    // non-standard resources — add below
    101: "mrp",
    102: "mmd",
    // ...
    108: "xyz",  // ← add new type here
};
```

- Maps a numeric type code to a short string name.
- Only `ty_str` needs an entry — there is no separate reverse map.
- `get_a_new_rn(ty)` uses this map to auto-generate resource names like `xyz-abc123`.

---

### 2. `models/xyz-model.js` — Create the Sequelize model

**Location:** create a new file in the `models/` directory

```javascript
const { DataTypes } = require('sequelize');
const sequelize = require('../db/sequelize');

const XYZ = sequelize.define('xyz', {
    // ── Mandatory common attributes ─────────────────
    ri: {
        type: DataTypes.STRING(24),
        primaryKey: true,
        allowNull: false,
    },
    ty: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 108,        // ← set to your type code
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

    // ── Resource-specific attributes ─────────────────
    // single value
    some_attr: DataTypes.STRING,
    // array
    some_list: DataTypes.ARRAY(DataTypes.STRING),
    // JSON
    some_json: DataTypes.JSONB,
    // location (only if geo support is needed)
    loc: DataTypes.GEOMETRY('GEOMETRY', 4326),
}, {
    tableName: 'xyz',    // must match the ty_str value
    timestamps: false,
});

module.exports = XYZ;
```

**Reference models:** `models/dts-model.js`, `models/mrp-model.js`

---

### 3. `db/init.js` — Add CREATE TABLE DDL

**Location:** inside the `create_tables()` function, after the last existing `CREATE TABLE` block

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

        -- resource-specific columns
        some_attr   VARCHAR(${len.str_token}),
        some_list   VARCHAR(${len.str_token})[],
        some_json   JSONB
    );
`);
```

**Index location:** `-- Performance indexes ---` section (~line 470)

```javascript
// add if pi-based child lookups are frequent
await client.query(`
    CREATE INDEX IF NOT EXISTS idx_xyz_pi ON xyz (pi);
`);
```

**Column size constants (`len` object):**

| Constant | Used for |
|----------|----------|
| `len.ri_max` | ri, pi (resource ID) |
| `len.structured_res_id` | sid, acpi |
| `len.str_token` | rn, cr, lbl, and general strings |
| `len.timestamp` | et, ct, lt |

**Geo support column (if location filtering is needed):**
```sql
loc GEOMETRY(GEOMETRY, 4326)
```
Also set `no_geo: false` in `TYPE_MODEL` (see step 5).

---

### 4. `cse/resources/xyz.js` — Implement the CRUD handler

**Location:** create a new file in the `cse/resources/` directory

#### File structure

```javascript
const { xyz_create_schema, xyz_update_schema } = require('../validation/res_schema');
const { generate_ri, get_cur_time, get_default_et } = require('../utils');
const enums = require('../../config/enums');
const XYZ = require('../../models/xyz-model');
const Lookup = require('../../models/lookup-model');
const logger = require('../../logger').child({ module: 'xyz' });

// allowed parent resource types
const xyz_parent_res_types = ['cb', 'ae', 'cnt'];  // ← adjust as needed

async function create_an_xyz(req_prim, resp_prim) { ... }
async function retrieve_an_xyz(req_prim, resp_prim) { ... }
async function update_an_xyz(req_prim, resp_prim) { ... }  // optional
// if the resource has ordered virtual children:
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

#### CREATE pattern

```javascript
async function create_an_xyz(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:xyz'];

    // 1. schema validation
    const validated = xyz_create_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    // 2. parent type check
    const parent_ty = req_prim.to_ty;
    if (!xyz_parent_res_types.includes(enums.ty_str[parent_ty.toString()])) {
        resp_prim.rsc = enums.rsc_str['INVALID_CHILD_RESOURCE_TYPE'];
        resp_prim.pc = { 'm2m:dbg': 'cannot create <xyz> under this parent resource type' };
        return;
    }

    const ri = generate_ri();
    const now = get_cur_time();
    const et = get_default_et();
    const xyz_pi = req_prim.ri;
    const xyz_sid = req_prim.sid + '/' + prim_res.rn;

    try {
        // 3. create resource — always write both tables
        await XYZ.create({
            ri, ty: 108, rn: prim_res.rn, pi: xyz_pi, sid: xyz_sid,
            int_cr: req_prim.fr,
            et: prim_res.et || et, ct: now, lt: now,
            cr: prim_res.cr === null ? req_prim.fr : null,
            acpi: prim_res.acpi || null,
            lbl:  prim_res.lbl  || null,
            // resource-specific attributes
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

        // 4. retrieve and return the created resource
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

#### RETRIEVE pattern

```javascript
async function retrieve_an_xyz(req_prim, resp_prim) {
    const xyz_obj = { 'm2m:xyz': {} };  // response key = 'm2m:' + ty_str value
    const ri = req_prim.ri;

    try {
        const db_res = await XYZ.findByPk(ri);
        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': '<xyz> resource not found' };
            return;
        }

        // include int_cr for internal API calls
        if (req_prim?.int_cr_req === true)
            xyz_obj['m2m:xyz'].int_cr = db_res.int_cr;

        // mandatory common attributes
        xyz_obj['m2m:xyz'].ty = db_res.ty;
        xyz_obj['m2m:xyz'].ri = db_res.ri;
        xyz_obj['m2m:xyz'].rn = db_res.rn;
        xyz_obj['m2m:xyz'].pi = db_res.pi;
        xyz_obj['m2m:xyz'].et = db_res.et;
        xyz_obj['m2m:xyz'].ct = db_res.ct;
        xyz_obj['m2m:xyz'].lt = db_res.lt;

        // optional common attributes
        if (db_res.acpi?.length) xyz_obj['m2m:xyz'].acpi = db_res.acpi;
        if (db_res.lbl?.length)  xyz_obj['m2m:xyz'].lbl  = db_res.lbl;
        if (db_res.cr)           xyz_obj['m2m:xyz'].cr   = db_res.cr;

        // resource-specific attributes
        if (db_res.some_attr) xyz_obj['m2m:xyz'].some_attr = db_res.some_attr;

        resp_prim.pc = xyz_obj;
    } catch (err) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': '<xyz> resource not found' };
        throw err;
    }
}
```

#### UPDATE pattern (optional)

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

        // update only mutable attributes
        if (prim_res.et)   db_res.et   = prim_res.et;
        if (prim_res.acpi) db_res.acpi = prim_res.acpi;
        if (prim_res.lbl)  db_res.lbl  = prim_res.lbl;
        if (prim_res.some_attr) db_res.some_attr = prim_res.some_attr;

        // null value removes the attribute
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

**Reference handlers:** `cse/resources/dts.js`, `cse/resources/mrp.js`, `cse/resources/cnt.js`

---

### 5. `cse/hostingCSE.js` — 4 switches + 2 maps

#### 5-A. Add imports (~lines 26–55)

```javascript
// model import (top model section)
const XYZ = require('../models/xyz-model');

// handler import (bottom handler section)
const xyz = require("./resources/xyz");
```

#### 5-B. CREATE switch (~lines 122–178)

```javascript
case 108:
    await xyz.create_an_xyz(req_prim, resp_prim);
    break;
```

#### 5-C. RETRIEVE switch (~lines 217–269)

```javascript
case 108:
    await xyz.retrieve_an_xyz(req_prim, resp_prim);
    break;
```

#### 5-D. UPDATE switch (~lines 468–515) — only if the resource is updatable

```javascript
case 108:
    await xyz.update_an_xyz(req_prim, resp_prim);
    break;
```

> If UPDATE is not supported, do not add a case — the `default` branch already returns `OPERATION_NOT_ALLOWED`.

#### 5-E. DELETE_MODEL map (~lines 607–610)

```javascript
const DELETE_MODEL = {
    // ... existing entries
    106: DTS, 107: DSF,
    108: XYZ,   // ← add
};
```

Used for batch deletion of descendant resources. **Must be added.**

#### 5-F. TYPE_MODEL map (~lines 653–668) — for discovery queries

```javascript
const TYPE_MODEL = {
    // ... existing entries
    107: { model: DSF, no_geo: true },
    108: { model: XYZ, no_geo: true },   // ← add
    //                          ↑ true if no loc column, false if geo support needed
};
```

- `no_geo: true` — location-based discovery filters are not supported
- `no_geo: false` — resource has a `loc` column and supports geo filters

---

### 6. `cse/reqPrim.js` — Virtual child resource dispatch

**Only required when** the new resource has ordered virtual children (`la` = latest, `ol` = oldest),
similar to how `<container>` (`cnt`) contains `<contentInstance>` (`cin`).

#### Add import (~lines 17–19)

```javascript
const xyz = require("./resources/xyz");
```

#### `la` dispatch (~lines 144–170)

```javascript
else if ('la' === req_prim.vr) {
    switch (req_prim.op) {
        case 2:  // RETRIEVE latest
            // ... existing cases
            } else if (req_prim.parent_ty == 108) {
                await xyz.retrieve_la(req_prim, resp_prim);
            }
            break;
        case 4:  // DELETE latest
            // ... existing cases
            } else if (req_prim.parent_ty == 108) {
                await xyz.delete_la(req_prim, resp_prim);
            }
            break;
    }
}
```

#### `ol` dispatch (~lines 171–197)

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

### 7. `cse/validation/res_schema.js` — Define Joi schemas (recommended)

**Location:** add after the last existing schema definition in the file

```javascript
const xyz_create_schema = Joi.object().keys({
    ...create_universal_attr,     // rn, et, acpi, lbl, cr, etc.

    // required resource-specific attribute
    required_field: Joi.string().required(),

    // optional resource-specific attribute
    optional_field: Joi.string().optional(),

    // read-only at creation (client must not set this)
    read_only_field: Joi.forbidden(),
});

const xyz_update_schema = Joi.object().keys({
    ...update_universal_attr,     // et, acpi, lbl, etc.

    // mutable attribute
    optional_field: Joi.string().optional(),

    // immutable after creation
    required_field: Joi.forbidden(),
    read_only_field: Joi.forbidden(),
});
```

**Add to exports:**

```javascript
module.exports = {
    // ... existing exports
    xyz_create_schema, xyz_update_schema,
};
```

**Reference schemas:** `dsp_create_schema`, `cnt_create_schema` (~lines 285–336)

---

### 8. `cse/resources/sub.js` — Add to subscribable parent list (conditional)

To allow `<sub>` (Subscription) resources to be created under the new resource type:

**Location:** line 12

```javascript
const sub_parent_res_types = [
    "ae", "acp", "cb", "cnt", "csr", "grp", "flx",
    "mrp", "mmd", "mdp", "dpm",
    "xyz",  // ← add
];
```

---

### 9. `config/default.json` — Add to supportedResourceType list (conditional)

Only needed for standard resources that should be advertised in the CSEBase `srt` attribute:

```json
"supported_resource_types": [1, 2, 3, 4, 5, 9, 16, 23, 108]
```

Non-standard (proprietary extension) resources are generally not added here.

---

## Feature Decision Table

| Feature | When to add | Location |
|---------|-------------|----------|
| Location-based filter (geo) | Resource has a `loc` column | `TYPE_MODEL` `no_geo: false`, DDL `GEOMETRY` column |
| Subscription (`<sub>`) | Resource can be a subscription target | `sub.js` `sub_parent_res_types` |
| Virtual children (`la`/`ol`) | Resource contains ordered child resources | `reqPrim.js` la/ol dispatch, 4 handler functions |
| UPDATE support | Resource has mutable attributes | `hostingCSE.js` UPDATE switch, `update_an_xyz()` |
| Joi validation | (always recommended) | `res_schema.js` schema definition, called in handler |

---

## Reference Files

| Purpose | Reference file |
|---------|---------------|
| Simple non-standard resource | `cse/resources/dts.js`, `models/dts-model.js` |
| Resource with virtual children (`la`/`ol`) | `cse/resources/mrp.js`, `cse/resources/cnt.js` |
| Geo-enabled resource | `cse/resources/ae.js`, `cse/resources/cnt.js` |
| Complex Joi schema | `cse/validation/res_schema.js` — `dsp_create_schema` |
| Full DDL pattern | `db/init.js` — `create_tables()` function |
