const Joi = require('joi');

// universal attributes

const create_universal_attr = {
    ty: Joi.forbidden(), // 'ty' is not allowed in create request, but included as request parameter
    rn: Joi.string().optional().regex(/^[-._a-zA-Z0-9@]+$/),
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
    cr: Joi.boolean().optional(),
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

    api: Joi.string().required(),
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
    mia: Joi.number().integer().min(0)
});

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
        chty: Joi.array().items(Joi.number().integer())
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
    grp_create_schema, grp_update_schema,
    sub_create_schema, sub_update_schema,
    dsp_create_schema, dsp_update_schema
}
