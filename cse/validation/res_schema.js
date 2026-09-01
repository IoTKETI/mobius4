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
    // ontologyRef, 0..1 RW (TS-0001 table 9.6.5-2). Rejecting it made
    // TP/oneM2M/CSE/REG/CRE/012_AE/OR fail: a registration carrying a perfectly valid optional
    // attribute was answered 4000.
    or: Joi.string().optional(),
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
    or: Joi.string().optional(),
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
    // .allow(null) on all six below: null is how oneM2M's UPDATE deletes an optional attribute,
    // and update_a_cnt (cse/resources/cnt.js) has always had a branch for each of them. None of
    // those branches could run — Joi rejected the null first, so a client asking to clear mni got
    // 4000 "mni must be a number" and the clearing code sat there looking correct. Measured
    // 2026-08-26 before this change: all six answered 4000 over HTTP. BACKLOG-046.
    //
    // The two groups mean different things, and cnt.js already distinguishes them: acpi, lbl and
    // loc are set to null (deleted), while mni, mbs and mia fall back to the deployment default
    // (config.default.container) rather than becoming unbounded, because a <container> with no
    // retention policy is not the same thing as one whose policy was never set.
    //
    // Scoped to <container> deliberately. update_common_attr is shared with <AE>, <subscription>,
    // <group>, <remoteCSE> and <accessControlPolicy>, and whether each of those handles a null is
    // not something this change checked -- letting null through to a handler that does not expect
    // it would replace a wrong rejection with a wrong acceptance. That sweep is the rest of
    // BACKLOG-046.
    acpi: update_common_attr.acpi.allow(null),
    lbl: update_common_attr.lbl.allow(null),
    cr: update_common_attr.cr,
    st: update_common_attr.st,
    loc: update_common_attr.loc.allow(null),

    // resource specific attributes
    mni: Joi.number().integer().min(0).allow(null),
    mbs: Joi.number().integer().min(0).allow(null),
    // mbis was clearable from the start (v4.9.0): it is the one attribute whose null branch was
    // reachable, because this .allow(null) was here and the others were not.
    mbis: Joi.number().integer().min(0).allow(null),
    mia: Joi.number().integer().min(0).allow(null)
});

// <timeSeries> — TS-0001:9.6.36. cni/cbs/mdc/mdlt are RO, so they are forbidden in a request
// rather than merely optional: accepting them silently would let a client set counters the CSE
// is supposed to compute. st is forbidden for a different reason — see below.
const ts_create_schema = Joi.object().keys({
    ...create_universal_attr,

    et: create_common_attr.et,
    acpi: create_common_attr.acpi,
    lbl: create_common_attr.lbl,
    cr: create_common_attr.cr,
    // TS-0001:9.6.36's attribute table has no stateTag entry for <timeSeries> — that attribute
    // belongs to <container>/<contentInstance> (9.6.6/9.6.7), not this resource type.
    st: Joi.forbidden(),
    loc: create_common_attr.loc,

    // retention
    mni: Joi.number().integer().min(0),
    mbs: Joi.number().integer().min(0),
    mia: Joi.number().integer().min(0),

    // missing-data detection
    pei: Joi.number().integer().min(1),
    peid: Joi.number().integer().min(0),
    mdd: Joi.boolean(),
    mdn: Joi.number().integer().min(1),
    mdt: Joi.number().integer().min(1),

    cnf: Joi.string().optional(),
    or: Joi.string().uri({ allowRelative: true }).optional(),

    cni: Joi.forbidden(),
    cbs: Joi.forbidden(),
    mdc: Joi.forbidden(),
    mdlt: Joi.forbidden(),
});

const ts_update_schema = Joi.object().keys({
    ...update_universal_attr,

    et: update_common_attr.et,
    acpi: update_common_attr.acpi,
    lbl: update_common_attr.lbl,
    loc: update_common_attr.loc,

    mni: Joi.number().integer().min(0).allow(null),
    mbs: Joi.number().integer().min(0).allow(null),
    mia: Joi.number().integer().min(0).allow(null),

    pei: Joi.number().integer().min(1).allow(null),
    peid: Joi.number().integer().min(0).allow(null),
    mdd: Joi.boolean(),
    mdn: Joi.number().integer().min(1).allow(null),
    mdt: Joi.number().integer().min(1).allow(null),

    // TS-0001:9.6.36 marks contentInfo WO (write-once): settable at CREATE, never changed
    // afterwards.
    cnf: Joi.forbidden(),
    or: Joi.string().uri({ allowRelative: true }).allow(null).optional(),

    cni: Joi.forbidden(),
    cbs: Joi.forbidden(),
    mdc: Joi.forbidden(),
    mdlt: Joi.forbidden(),
});

// <timeSeriesInstance> — TS-0001:9.6.37. dgt and con are multiplicity 1; cs is RO (the CSE
// computes it from con). There is no update schema: TS-0001:10.2.4.27 says "The Update
// operation shall not apply to <timeSeriesInstance> resource."
const tsi_create_schema = Joi.object().keys({
    ...create_universal_attr,

    et: create_common_attr.et,
    // TS-0001:9.6.37: "<timeSeriesInstance> ... does not have its own accessControlPolicyIDs
    // attribute" — it inherits the parent <timeSeries>'s. Without this, acpi would pass
    // validation, be silently dropped (no acpi column on the tsi model/table), and the client
    // would never know.
    acpi: Joi.forbidden(),
    lbl: create_common_attr.lbl,
    cr: create_common_attr.cr,
    // TS-0001:9.6.37's attribute table has no stateTag entry for <timeSeriesInstance> either.
    st: Joi.forbidden(),
    loc: create_common_attr.loc,

    // Same house pattern as et above (create_common_attr.et). TS-0004 types dataGenerationTime
    // as m2m:absRelTimestamp, a union that also permits fractional seconds and a relative
    // integer offset — this regex is narrower than that (BACKLOG-108 in mobius4-dev-tool tracks
    // the gap). Chosen deliberately over no validation at all: an unparseable dgt used to reach
    // the missing-data sweep's parser and throw, and it sorts arbitrarily in `ORDER BY dgt`
    // (find_edge_tsi's <latest>/<oldest>, EVICT_TSI_SQL's eviction order), so a malformed value
    // could pick the wrong eviction victim.
    dgt: Joi.string().required().regex(/^[0-9]{8}T[0-9]{6}$/),
    con: Joi.any().required(),
    snr: Joi.number().integer().min(0),
    cs: Joi.forbidden(),
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

// xs:duration, the type of m2m:missingData's duration element (CDT-commonTypes.xsd:1049).
// ISO 8601 basic duration: an optional sign, P, then at least one component, and if T is present
// at least one time component after it. "P" and "PT" alone are not valid values.
const XS_DURATION = /^-?P(?!$)(\d+Y)?(\d+M)?(\d+D)?(T(?!$)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;

// m2m:missingData (CDT-commonTypes.xsd:1046). Both members are minOccurs=1, so both are required
// whenever the condition is present at all.
const MISSING_DATA_CONDITION = Joi.object().keys({
    num: Joi.number().integer().min(1).required(),
    dur: Joi.string().regex(XS_DURATION).required(),
});

// m2m:timestamp as used by the eventNotificationCriteria comparison conditions.
const TIMESTAMP_CONDITION = Joi.string().regex(/^[0-9]{8}T[0-9]{6}(,[0-9]{1,6})?$/);

const sub_create_schema = Joi.object().keys({
    ...create_universal_attr,

    et: create_common_attr.et,
    acpi: create_common_attr.acpi,
    lbl: create_common_attr.lbl,
    cr: create_common_attr.cr,

    nu: Joi.array().required().items(Joi.string()),
    enc: Joi.object().optional().keys({
        // Only the type is checked here. Both range decisions -- outside the eight enumerations of
        // m2m:notificationEventType (BAD_REQUEST) and defined-but-unimplemented (NOT_IMPLEMENTED)
        // -- are made after validation in cse/notification-event-types.js, so that each can name
        // the offending value. Joi reports an item failure by its array position, which made
        // {"net":[9]} and {"net":[99]} produce the same message (M4-009).
        net: Joi.array().items(Joi.number().integer()),
        chty: Joi.array().items(Joi.number().integer()),
        // atr (attribute) restricts which attribute updates fire a net=1 notification --
        // TS-0001:9.6.8 table 9.6.8-3. m2m:attributeList is an xs:list of xs:NCName carrying
        // xs:minLength 1 (CDT-commonTypes.xsd:383), so an empty list is not a valid value and is
        // refused here rather than being read as "no condition".
        atr: Joi.array().min(1).items(Joi.string()),
        // om (operationMonitor) is deliberately absent. It was accepted as Joi.any() and then read
        // by nothing: a subscriber who asked to be notified only about, say, DELETEs from one
        // Originator was answered 2001 and notified about everything. Refusing it says so.
        // The ten value-comparison conditions of TS-0001:9.6.8 table 9.6.8-3, combined by fo.
        // Types are TS-0004:6.3.5.7 table 6.3.5.7-1; the positiveInteger/nonNegativeInteger split
        // is not symmetric and is deliberate -- stateTagSmaller: 0 and sizeBelow: 0 can never be
        // satisfied, so the schema forbids them, while stateTagBigger: 0 and sizeAbove: 0 can.
        // m2m:timestamp is YYYYMMDDThhmmss with an optional comma and up to six fractional digits
        // and no timezone suffix (CDT-commonTypes.xsd:213); the fraction is accepted because the
        // spec permits it, even though nothing this CSE stores carries one.
        crb: TIMESTAMP_CONDITION,
        cra: TIMESTAMP_CONDITION,
        ms: TIMESTAMP_CONDITION,
        us: TIMESTAMP_CONDITION,
        exb: TIMESTAMP_CONDITION,
        exa: TIMESTAMP_CONDITION,
        sts: Joi.number().integer().min(1),
        stb: Joi.number().integer().min(0),
        sza: Joi.number().integer().min(0),
        szb: Joi.number().integer().min(1),
        // m2m:filterOperation: 1 AND, 2 OR, 3 XOR (CDT-enumerationTypes.xsd:1366). Absent means
        // AND. A single scalar, matching "No mixed AND/OR/XOR filter operation will be supported".
        fo: Joi.number().integer().min(1).max(3),
        // Only meaningful with net=8; TS-0001:9.6.8 table 9.6.8-3 says it is *ignored* otherwise,
        // so md without net=8 is accepted and simply never fires rather than being refused.
        md: MISSING_DATA_CONDITION
    }),
    exc: Joi.number().integer().min(1),
    // m2m:notificationContentType is restricted to five enumerations
    // (CDT-enumerationTypes.xsd:967). Only min(1) was checked before, so nct=99 was accepted and
    // then ignored -- the same shape of hole net had.
    nct: Joi.number().integer().min(1).max(5),
    su: Joi.string().optional(),
});

const sub_update_schema = Joi.object().keys({
    ...update_universal_attr,

    et: update_common_attr.et,
    acpi: update_common_attr.acpi,
    lbl: update_common_attr.lbl,
    cr: update_common_attr.cr,

    nu: Joi.array().optional().items(Joi.string()),
    // enc is RW (TS-0001 table 9.6.8-2), so every condition that can be set at creation has to be
    // changeable afterwards. The conditions here mirror the create schema exactly; letting the two
    // drift is what left om acceptable on create and refused on update for as long as it did.
    enc: Joi.object().optional().keys({
        net: Joi.array().items(Joi.number().integer()),
        chty: Joi.array().items(Joi.number().integer()),
        atr: Joi.array().min(1).items(Joi.string()),
        // The ten value-comparison conditions of TS-0001:9.6.8 table 9.6.8-3, combined by fo.
        // Types are TS-0004:6.3.5.7 table 6.3.5.7-1; the positiveInteger/nonNegativeInteger split
        // is not symmetric and is deliberate -- stateTagSmaller: 0 and sizeBelow: 0 can never be
        // satisfied, so the schema forbids them, while stateTagBigger: 0 and sizeAbove: 0 can.
        // m2m:timestamp is YYYYMMDDThhmmss with an optional comma and up to six fractional digits
        // and no timezone suffix (CDT-commonTypes.xsd:213); the fraction is accepted because the
        // spec permits it, even though nothing this CSE stores carries one.
        crb: TIMESTAMP_CONDITION,
        cra: TIMESTAMP_CONDITION,
        ms: TIMESTAMP_CONDITION,
        us: TIMESTAMP_CONDITION,
        exb: TIMESTAMP_CONDITION,
        exa: TIMESTAMP_CONDITION,
        sts: Joi.number().integer().min(1),
        stb: Joi.number().integer().min(0),
        sza: Joi.number().integer().min(0),
        szb: Joi.number().integer().min(1),
        // m2m:filterOperation: 1 AND, 2 OR, 3 XOR (CDT-enumerationTypes.xsd:1366). Absent means
        // AND. A single scalar, matching "No mixed AND/OR/XOR filter operation will be supported".
        fo: Joi.number().integer().min(1).max(3),
        // Only meaningful with net=8; TS-0001:9.6.8 table 9.6.8-3 says it is *ignored* otherwise,
        // so md without net=8 is accepted and simply never fires rather than being refused.
        md: MISSING_DATA_CONDITION
    }),
    exc: Joi.number().integer().min(1),
    // m2m:notificationContentType is restricted to five enumerations
    // (CDT-enumerationTypes.xsd:967). Only min(1) was checked before, so nct=99 was accepted and
    // then ignored -- the same shape of hole net had.
    nct: Joi.number().integer().min(1).max(5),
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
    ts_create_schema, ts_update_schema,
    tsi_create_schema,
    flx_create_schema, flx_update_schema,
    grp_create_schema, grp_update_schema,
    sub_create_schema, sub_update_schema,
    dsp_create_schema, dsp_update_schema
}
