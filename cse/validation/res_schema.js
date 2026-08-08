const Joi = require('joi');

// universal attributes

const create_universal_attr = {
    ty: Joi.forbidden(), // 'ty' is not allowed in create request, but included as request parameter
    // TS-0004:6.2.4 gives resourceName its own ABNF production, resolved through 6.2.3:
    //
    //   resource-name = 1*unreserved
    //   unreserved    = (ALPHA / DIGIT) *(ALPHA / DIGIT / "-" / "." / "_")
    //
    // So the first character must be a letter or a digit, and "-", "." and "_" are allowed
    // from the second onwards. TS-0001:7.2 describes resource identifiers more loosely, by
    // way of RFC 3986's unreserved set, which carries no first-character restriction; the
    // two documents disagree on paper and this deployment follows the protocol binding's
    // ABNF, as the one clause that names a resource-name production (see the decision log).
    //
    // The previous pattern, /^[-._a-zA-Z0-9@]+$/, was looser in two ways. It let a name
    // begin with any of those characters, and a leading "_" then collided with TS-0009's
    // "/_" path prefix in bindings/http.js: the resource was created and could never be
    // retrieved or deleted by its hierarchical path. It also permitted "@", which appears in
    // neither ABNF.
    rn: Joi.string().optional().regex(/^[a-zA-Z0-9][-._a-zA-Z0-9]*$/),
    ri: Joi.forbidden(), // 'ri' cannot be included in create request
    pi: Joi.forbidden(), // 'pi' cannot be included in create request
    ct: Joi.forbidden(), // 'ct' cannot be included in create request
    lt: Joi.forbidden(), // 'lt' cannot be included in create request
};

const update_universal_attr = {
    ty: Joi.forbidden(), // 'ty' cannot be updated
    rn: Joi.forbidden(), // 'rn' cannot be updated
    ri: Joi.forbidden(), // 'ri' cannot be updated
    pi: Joi.forbidden(), // 'pi' cannot be updated
    ct: Joi.forbidden(), // 'ct' cannot be updated
    lt: Joi.forbidden(), // 'lt' cannot be updated
};

// common attributes

const create_common_attr = {
    et: Joi.string().optional().regex(/^[0-9]{8}T[0-9]{6}$/),
    acpi: Joi.array().optional().items(Joi.string()),
    lbl: Joi.array().optional().items(Joi.string()),
    cr: Joi.string().allow(null),
    loc: Joi.object().optional().keys({
        typ: Joi.number().required(),
        crd: Joi.string().required()
    }),
    st: Joi.forbidden(), // 'st' cannot be included in create request
};

const update_common_attr = {
    et: Joi.string().optional().regex(/^[0-9]{8}T[0-9]{6}$/),
    acpi: Joi.array().optional().items(Joi.string()),
    lbl: Joi.array().optional().items(Joi.string()),
    cr: Joi.forbidden(), // 'cr' cannot be updated
    loc: Joi.object().optional().keys({
        typ: Joi.number().required(),
        crd: Joi.string().required()
    }),
    st: Joi.forbidden(), // 'st' cannot be updated
};

// schema for resource types

const acp_create_schema = Joi.object().keys({
    ...create_universal_attr,

    et: create_common_attr.et,
    acpi: create_common_attr.acpi,
    lbl: create_common_attr.lbl,

    pv: Joi.object().required().keys({
        acr: Joi.array().items(Joi.object().keys({
            acor: Joi.array().items(Joi.string()),
            acop: Joi.number().integer()
        }))
    }),
    pvs: Joi.object().required().keys({
        acr: Joi.array().items(Joi.object().keys({
            acor: Joi.array().items(Joi.string()),
            acop: Joi.number().integer()
        }))
    })
});

const acp_update_schema = Joi.object().keys({
    ...update_universal_attr,

    et: update_common_attr.et,
    acpi: update_common_attr.acpi,
    lbl: update_common_attr.lbl,

    pv: Joi.object().optional().keys({
        acr: Joi.array().items(Joi.object().keys({
            acor: Joi.array().items(Joi.string()),
            acop: Joi.number().integer()
        }))
    }),
    pvs: Joi.object().optional().keys({
        acr: Joi.array().items(Joi.object().keys({
            acor: Joi.array().items(Joi.string()),
            acop: Joi.number().integer()
        }))
    })
});

const ae_create_schema = Joi.object().keys({
    ...create_universal_attr,

    et: create_common_attr.et,
    acpi: create_common_attr.acpi,
    lbl: create_common_attr.lbl,
    cr: create_common_attr.cr,
    loc: create_common_attr.loc,

    // App-ID: 'N' for a non-registered App-ID, 'R' for a registered one (TS-0001:7.1.2). The
    // rule used to be a hand-written check inside create_an_ae, one screen below the call
    // that runs this schema — two places to keep in step, and the schema was the one a
    // reader would check first.
    api: Joi.string().regex(/^[NR]/).required(),
    rr: Joi.boolean().required(),
    aei: Joi.forbidden(),
    srv: Joi.array().optional().items(Joi.string()),
    csz: Joi.array().optional().items(Joi.string()),
    apn: Joi.string().optional(),
    poa: Joi.array().optional().items(Joi.string()),
});

const ae_update_schema = Joi.object().keys({
    ...update_universal_attr,

    et: update_common_attr.et,
    acpi: update_common_attr.acpi,
    lbl: update_common_attr.lbl,
    cr: update_common_attr.cr,
    loc: update_common_attr.loc,

    api: Joi.forbidden(), // 'api' cannot be updated
    rr: Joi.boolean().optional(),
    aei: Joi.forbidden(),
    srv: Joi.array().optional().items(Joi.string()),
    csz: Joi.array().optional().items(Joi.string()),
    apn: Joi.string().optional(),
    poa: Joi.array().optional().items(Joi.string()),
});

const csr_create_schema = Joi.object().keys({
    ...create_universal_attr,

    et: create_common_attr.et,
    acpi: create_common_attr.acpi,
    lbl: create_common_attr.lbl,
    cr: create_common_attr.cr,
    loc: Joi.object().optional().keys({
        typ: Joi.number().required(),
        crd: Joi.string().required()
    }),

    cb: Joi.string().required(),
    rr: Joi.boolean().required(),
    srv: Joi.array().required().items(Joi.string()),
    csi: Joi.string().optional(),
    csz: Joi.array().optional().items(Joi.string()),
    cst: Joi.number().integer().min(1).max(3).optional(),
    poa: Joi.array().optional().items(Joi.string()),
    nl: Joi.string().optional(),
});

const csr_update_schema = Joi.object().keys({
    ...update_universal_attr,

    et: update_common_attr.et,
    acpi: update_common_attr.acpi,
    lbl: update_common_attr.lbl,

    cb: Joi.forbidden(),
    rr: Joi.boolean().optional(),
    srv: Joi.array().optional().items(Joi.string()),
    csi: Joi.forbidden(),
    cst: Joi.forbidden(),
    poa: Joi.array().optional().items(Joi.string()),
    nl: Joi.string().optional(),
});

const cnt_create_schema = Joi.object().keys({
    ...create_universal_attr,

    et: create_common_attr.et,
    acpi: create_common_attr.acpi,
    lbl: create_common_attr.lbl,
    cr: create_common_attr.cr,
    st: create_common_attr.st,
    loc: create_common_attr.loc,

    // resource specific attributes
    mni: Joi.number().integer().min(0),
    mbs: Joi.number().integer().min(0),
    mbis: Joi.number().integer().min(0),
    mia: Joi.number().integer().min(0)
});

const cnt_update_schema = Joi.object().keys({
    ...update_universal_attr,

    et: update_common_attr.et,
    acpi: update_common_attr.acpi,
    lbl: update_common_attr.lbl,
    cr: update_common_attr.cr,
    st: update_common_attr.st,
    loc: update_common_attr.loc,

    // resource specific attributes
    mni: Joi.number().integer().min(0),
    mbs: Joi.number().integer().min(0),
    // .allow(null): unlike mni/mbs/mia (whose null-clears-it branch in cnt.js is unreachable —
    // Joi rejects null before that code runs, a pre-existing defect tracked as BACKLOG-046 —
    // not fixed here), mbis is designed from the start to be clearable, and cnt.js's handling
    // of prim_res.mbis === null depends on this actually reaching it.
    mbis: Joi.number().integer().min(0).allow(null),
    mia: Joi.number().integer().min(0)
});

// <flexContainer> carries an open set of [customAttribute] members whose names are defined
// by the document referenced by cnd (TS-0001:9.6.35), so unknown keys must pass Joi and be
// checked against the specialization registry instead (cse/specialization.js).
const flx_create_schema = Joi.object().keys({
    ...create_universal_attr,

    et: create_common_attr.et,
    acpi: create_common_attr.acpi,
    lbl: create_common_attr.lbl,
    cr: create_common_attr.cr,
    st: create_common_attr.st,
    loc: create_common_attr.loc,

    // resource specific attributes — TS-0004:7.4.37.1 table 7.4.37.1-2
    cnd: Joi.string().required(), // M on Create
    or: Joi.string().optional(),
    nl: Joi.string().optional(),
    cs: Joi.forbidden(), // NP — set by the hosting CSE
    cni: Joi.forbidden(), // NP — no <flexContainerInstance> support
    cbs: Joi.forbidden(), // NP — no <flexContainerInstance> support
    mni: Joi.number().integer().min(0),
    mbs: Joi.number().integer().min(0),
    mia: Joi.number().integer().min(0),
}).unknown(true);

const flx_update_schema = Joi.object().keys({
    ...update_universal_attr,

    et: update_common_attr.et,
    acpi: update_common_attr.acpi,
    lbl: update_common_attr.lbl,
    cr: update_common_attr.cr,
    st: update_common_attr.st,
    loc: update_common_attr.loc,

    // resource specific attributes
    cnd: Joi.forbidden(), // NP on Update — containerDefinition is write-once
    or: Joi.string().optional().allow(null),
    nl: Joi.string().optional().allow(null),
    cs: Joi.forbidden(),
    cni: Joi.forbidden(),
    cbs: Joi.forbidden(),
    mni: Joi.number().integer().min(0),
    mbs: Joi.number().integer().min(0),
    mia: Joi.number().integer().min(0),
}).unknown(true);

const cin_create_schema = Joi.object().keys({
    ...create_universal_attr,

    et: create_common_attr.et,
    acpi: create_common_attr.acpi,
    lbl: create_common_attr.lbl,
    cr: create_common_attr.cr,
    st: create_common_attr.st,
    loc: create_common_attr.loc,

    cnf: Joi.string().optional(),
    cs: Joi.forbidden(),
    con: Joi.any().required()
});

const grp_create_schema = Joi.object().keys({
    ...create_universal_attr,

    et: create_common_attr.et,
    acpi: create_common_attr.acpi,
    lbl: create_common_attr.lbl,
    cr: create_common_attr.cr,

    mt: Joi.number().integer().min(0),
    cnm: Joi.forbidden(),
    mnm: Joi.number().required().integer().min(0),
    csy: Joi.number().integer().min(1),
    mid: Joi.array().required().items(Joi.string()),
    macp: Joi.array().optional().items(Joi.string()),
    gn: Joi.string().optional(),
});

const grp_update_schema = Joi.object().keys({
    ...update_universal_attr,

    et: update_common_attr.et,
    acpi: update_common_attr.acpi,
    lbl: update_common_attr.lbl,
    cr: update_common_attr.cr,

    mt: Joi.forbidden(),
    cnm: Joi.forbidden(),
    mnm: Joi.number().integer().optional().min(0),
    csy: Joi.forbidden(),
    mid: Joi.array().optional().items(Joi.string()),
    macp: Joi.array().optional().items(Joi.string()),
    gn: Joi.string().optional(),
});

const sub_create_schema = Joi.object().keys({
    ...create_universal_attr,

    et: create_common_attr.et,
    acpi: create_common_attr.acpi,
    lbl: create_common_attr.lbl,
    cr: create_common_attr.cr,

    nu: Joi.array().required().items(Joi.string()),
    enc: Joi.object().optional().keys({
        net: Joi.array().items(Joi.number().integer()),
        chty: Joi.array().items(Joi.number().integer()),
        om: Joi.any()
    }),
    exc: Joi.number().integer().min(1),
    nct: Joi.number().integer().min(1),
    su: Joi.string().optional(),
});

const sub_update_schema = Joi.object().keys({
    ...update_universal_attr,

    et: update_common_attr.et,
    acpi: update_common_attr.acpi,
    lbl: update_common_attr.lbl,
    cr: update_common_attr.cr,

    nu: Joi.array().optional().items(Joi.string()),
    enc: Joi.object().optional().keys({
        net: Joi.array().items(Joi.number().integer()),
        chty: Joi.array().items(Joi.number().integer())
    }),
    exc: Joi.number().integer().min(1),
    nct: Joi.number().integer().min(1),
    su: Joi.string().optional(),
});

const dsp_create_schema = Joi.object().keys({
    ...create_universal_attr,

    et: create_common_attr.et,
    acpi: create_common_attr.acpi,
    lbl: create_common_attr.lbl,

    // resource specific attributes
    sri: Joi.array().items(Joi.string()),
    dst: Joi.string().optional().regex(/^[0-9]{8}T[0-9]{6}$/),
    det: Joi.string().optional().regex(/^[0-9]{8}T[0-9]{6}$/),
    tcst: Joi.string().optional().regex(/^[0-9]{8}T[0-9]{6}$/),
    tcd: Joi.number().integer().min(0),
    nvp: Joi.number().integer().min(0),
    dsfm: Joi.number().integer().min(0),
    hdi: Joi.forbidden(),
    ldi: Joi.forbidden(),
    nrhd: Joi.number().integer().min(0),
    nrld: Joi.number().integer().min(0)
});

const dsp_update_schema = Joi.object().keys({
    ...update_universal_attr,

    et: update_common_attr.et,
    acpi: update_common_attr.acpi,
    lbl: update_common_attr.lbl,

    // resource specific attributes
    sri: Joi.forbidden(),
    dst: Joi.forbidden(),
    det: Joi.forbidden(),
    tcst: Joi.forbidden(),
    tcd: Joi.forbidden(),
    nvp: Joi.forbidden(),
    dsfm: Joi.forbidden(),
    hdi: Joi.forbidden(),
    ldi: Joi.forbidden(),
    nrhd: Joi.forbidden(),
    nrld: Joi.forbidden()
});

module.exports = {
    acp_create_schema, acp_update_schema,
    ae_create_schema, ae_update_schema,
    csr_create_schema, csr_update_schema,
    cnt_create_schema, cnt_update_schema,
    cin_create_schema,
    flx_create_schema, flx_update_schema,
    grp_create_schema, grp_update_schema,
    sub_create_schema, sub_update_schema,
    dsp_create_schema, dsp_update_schema
}
