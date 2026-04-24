const config = require('config');
const { cin_create_schema } = require('../validation/res_schema');
const enums = require('../../config/enums');

const { generate_ri, get_cur_time, get_default_et, convert_loc_to_geoJson, get_loc_attribute } = require('../utils');

const sequelize = require('../../db/sequelize');
const Lookup = require('../../models/lookup-model');
const CNT = require('../../models/cnt-model');
const CIN = require('../../models/cin-model');

const logger = require('../../logger').forFile(__filename);

const cin_parent_res_types = ['cnt'];

async function create_a_cin(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:cin'];

    // validation for primitive resource attribute
    const validated = cin_create_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    const cin_pi = req_prim.ri;
    const cin_sid = req_prim.sid + '/' + prim_res.rn;

    // parent resource type check
    const parent_ty = req_prim.to_ty;
    if (cin_parent_res_types.includes(enums.ty_str[parent_ty.toString()]) === false) {
        resp_prim.rsc = enums.rsc_str['INVALID_CHILD_RESOURCE_TYPE'];
        resp_prim.pc = { 'm2m:dbg': 'parent of <cin> resource shall be <cnt> resource' };
        return;
    }

    // [C2] read only fields needed for validation — avoid SELECT *
    const cnt_res = await CNT.findByPk(cin_pi, {
        attributes: ['mbs', 'st']
    });
    if (!cnt_res) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': 'parent <cnt> resource not found' };
        return;
    }

    // content size 계산
    const { get_mem_size } = require('../hostingCSE');
    const content_size = get_mem_size(prim_res.con);

    // when mbs < cs, it is not acceptable
    if (content_size > cnt_res.mbs) {
        resp_prim.rsc = enums.rsc_str['NOT_ACCEPTABLE'];
        resp_prim.pc = { 'm2m:dbg': 'content size of a new <cin> is bigger than mbs of the parent container' };
        return;
    }

    const ri = generate_ri();
    const now = get_cur_time();
    const et = get_default_et();

    // process 'loc' attribute
    if (prim_res.loc) {
        await convert_loc_to_geoJson(prim_res, resp_prim);
        if (resp_prim.rsc)
            return;
    }

    const cin_res = {
        ri,
        ty: 4,
        rn: prim_res.rn,
        pi: cin_pi,
        sid: cin_sid,
        et: prim_res.et || et,
        ct: now,
        lt: now,
        cr: prim_res.cr === null ? req_prim.fr : null,
        acpi: prim_res.acpi || null,
        lbl: prim_res.lbl || null,
        loc: prim_res.loc,
        st: cnt_res.st + 1,
        cs: content_size,
        con: prim_res.con,
        cnf: prim_res.cnf || null,
    };

    try {
        // [C7] CIN INSERT + CNT UPDATE + Lookup INSERT in a single transaction
        const new_cnt = await sequelize.transaction(async (t) => {
            await CIN.create(cin_res, { transaction: t });

            // [C2] atomic CNT UPDATE — avoids separate findByPk + update and prevents race conditions
            const [, updated] = await CNT.update(
                {
                    cni: sequelize.literal('cni + 1'),
                    cbs: sequelize.literal(`cbs + ${content_size}`),
                    st:  sequelize.literal('st + 1'),
                },
                {
                    where: { ri: cin_pi },
                    returning: ['cni', 'cbs', 'mni', 'mbs'],
                    transaction: t,
                }
            );

            await Lookup.create({
                ri,
                ty: 4,
                rn: prim_res.rn,
                sid: cin_sid,
                lvl: cin_sid.split('/').length,
                pi: cin_pi,
                cr: prim_res.cr === null ? req_prim.fr : null,
                int_cr: req_prim.fr,
                et: prim_res.et || et,
                loc: prim_res.loc
            }, { transaction: t });

            return updated[0];
        });

        // eviction after transaction: delete oldest CIN(s) if mni or mbs exceeded
        if (new_cnt) {
            await evict_if_needed(new_cnt, cin_pi);
        }

        // [C1] build response directly from cin_res — no extra DB round trip
        resp_prim.pc = build_cin_response(cin_res);

    } catch (err) {
        logger.error({ err }, 'create_a_cin failed');
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': err.message };
    }
}

// [C1] build response object from in-memory cin_res (avoids re-reading from DB)
function build_cin_response(cin_res) {
    const cin_obj = { 'm2m:cin': {
        ty:  cin_res.ty,
        ri:  cin_res.ri,
        rn:  cin_res.rn,
        pi:  cin_res.pi,
        ct:  cin_res.ct,
        lt:  cin_res.lt,
        et:  cin_res.et,
        st:  cin_res.st,
        cs:  cin_res.cs,
        con: cin_res.con,
    }};

    if (cin_res.acpi && cin_res.acpi.length) cin_obj['m2m:cin'].acpi = cin_res.acpi;
    if (cin_res.lbl && cin_res.lbl.length)  cin_obj['m2m:cin'].lbl  = cin_res.lbl;
    if (cin_res.cr)                          cin_obj['m2m:cin'].cr   = cin_res.cr;
    if (cin_res.cnf)                         cin_obj['m2m:cin'].cnf  = cin_res.cnf;
    if (cin_res.loc)                         cin_obj['m2m:cin'].loc  = get_loc_attribute(cin_res.loc);

    return cin_obj;
}

// [C4] evict oldest CIN(s) when mni or mbs is exceeded — runs after transaction commits
async function evict_if_needed(cnt, cin_pi) {
    const { delete_a_res } = require('../hostingCSE');

    let { cni, cbs, mni, mbs } = cnt.dataValues || cnt;

    const excess_mni = Math.max(0, cni - mni);
    if (excess_mni === 0 && cbs <= mbs) return;

    // fetch enough oldest CINs to cover both mni and mbs eviction
    const fetch_limit = Math.max(excess_mni + 10, 50);
    const candidates = await CIN.findAll({
        where: { pi: cin_pi },
        order: [['st', 'ASC']],
        limit: fetch_limit,
        attributes: ['ri', 'cs'],
    });

    const to_delete = [];

    // mni: remove oldest until within limit
    let i = 0;
    while (cni > mni && i < candidates.length) {
        to_delete.push(candidates[i]);
        cni--;
        cbs -= candidates[i].cs;
        i++;
    }

    // mbs: continue removing oldest until within size limit
    while (cbs > mbs && i < candidates.length) {
        to_delete.push(candidates[i]);
        cbs -= candidates[i].cs;
        i++;
    }

    if (to_delete.length === 0) return;

    // delete each evicted CIN (int_cr_req=true skips the per-CIN CNT update in delete_a_res)
    let cbs_reduction = 0;
    for (const old_cin of to_delete) {
        const tmp_resp = {};
        await delete_a_res(
            { fr: config.cse.admin, to: old_cin.ri, ri: old_cin.ri, rqi: 'evict_cin', to_ty: 4, int_cr_req: true },
            tmp_resp
        );
        cbs_reduction += old_cin.cs;
    }

    // update CNT to reflect evicted CINs
    await CNT.update(
        {
            cni: sequelize.literal(`cni - ${to_delete.length}`),
            cbs: sequelize.literal(`cbs - ${cbs_reduction}`),
        },
        { where: { ri: cin_pi } }
    );
}

async function retrieve_a_cin(req_prim, resp_prim) {
    const cin_obj = { 'm2m:cin': {} };
    const ri = req_prim.ri;

    try {
        const db_res = await CIN.findByPk(ri);
        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': '<cin> resource not found' };
            return;
        }

        // provide int_cr if required by internal API call
        if (req_prim && req_prim.int_cr_req === true)
            cin_obj['m2m:cin'].int_cr = db_res.int_cr;

        // copy mandatory attributes
        cin_obj['m2m:cin'].ty = db_res.ty;
        cin_obj['m2m:cin'].et = db_res.et;
        cin_obj['m2m:cin'].ct = db_res.ct;
        cin_obj['m2m:cin'].lt = db_res.lt;
        cin_obj['m2m:cin'].ri = db_res.ri;
        cin_obj['m2m:cin'].rn = db_res.rn;
        cin_obj['m2m:cin'].pi = db_res.pi;
        cin_obj['m2m:cin'].st = db_res.st;

        // optional attributes
        if (db_res.acpi && db_res.acpi.length) cin_obj['m2m:cin'].acpi = db_res.acpi;
        if (db_res.lbl && db_res.lbl.length) cin_obj['m2m:cin'].lbl = db_res.lbl;
        if (db_res.cr) cin_obj['m2m:cin'].cr = db_res.cr;
        if (db_res.cnf) cin_obj['m2m:cin'].cnf = db_res.cnf;
        if (db_res.cs !== undefined) cin_obj['m2m:cin'].cs = db_res.cs;
        if (db_res.con !== undefined) cin_obj['m2m:cin'].con = db_res.con;
        if (db_res.loc) cin_obj['m2m:cin'].loc = get_loc_attribute(db_res.loc);
    } catch (err) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': '<cin> resource not found' };
        throw err;
    }

    resp_prim.pc = cin_obj;
    return;
}

module.exports.create_a_cin = create_a_cin;
module.exports.retrieve_a_cin = retrieve_a_cin;
