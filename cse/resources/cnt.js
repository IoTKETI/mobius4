const config = require('config');
const { cnt_create_schema, cnt_update_schema } = require('../validation/res_schema');

const { generate_ri, get_cur_time, get_default_et, convert_loc_to_geoJson, get_loc_attribute } = require('../utils');
const sequelize = require('../../db/sequelize');

const enums = require('../../config/enums');
const cin = require('./cin');
const CIN = require('../../models/cin-model');
const CNT = require('../../models/cnt-model');
const Lookup = require('../../models/lookup-model');

const logger = require('../../logger').child({ module: 'cnt' });

const cnt_parent_res_types = ['ae', 'cnt', 'csr', 'cb', 'flx'];

async function create_a_cnt(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:cnt'];

    // validation for primitive resource attribute
    const validated = cnt_create_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    const cnt_pi = req_prim.ri;
    const cnt_sid = req_prim.sid + '/' + prim_res.rn;

    // parent resource type check
    const parent_ty = req_prim.to_ty;
    if (cnt_parent_res_types.includes(enums.ty_str[parent_ty.toString()]) == false) {
        resp_prim.rsc = enums.rsc_str['INVALID_CHILD_RESOURCE_TYPE'];
        resp_prim.pc = { 'm2m:dbg': 'cannot create <cnt> to this parent resource type' };
        return;
    }

    // check attribute values validity
    if (prim_res.mni < 0 || prim_res.mbs < 0 || prim_res.mia < 0) {
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': 'mni, mbs, and mia must be greater than 0' };
        return;
    }

    const ri = generate_ri();
    const now = get_cur_time();
    const et = get_default_et();

    // process 'loc' attribute
    if (prim_res.loc) {
        await convert_loc_to_geoJson(prim_res, resp_prim);
        if (resp_prim.rsc) // from the prev function, error code is set
            return;
    }

    try {
        await sequelize.transaction(async (t) => {
            await CNT.create({
                // mandatory attributes
                ri,
                rn: prim_res.rn,
                pi: cnt_pi,
                sid: cnt_sid,
                int_cr: req_prim.fr,
                et: prim_res.et || et,
                ct: now,
                lt: now,
                // optional attributes
                cr: prim_res.cr === null ? req_prim.fr : null,
                acpi: prim_res.acpi || null,
                lbl: prim_res.lbl || null,
                mni: prim_res.mni || config.default.container.mni,
                mbs: prim_res.mbs || config.default.container.mbs,
                mia: prim_res.mia || config.default.container.mia,
                loc: prim_res.loc || null,
            }, { transaction: t });

            await Lookup.create({
                ri,
                ty: 3,
                rn: prim_res.rn,
                sid: cnt_sid,
                lvl: cnt_sid.split("/").length,
                pi: cnt_pi,
                cr: prim_res.cr === null ? req_prim.fr : null,
                int_cr: req_prim.fr,
                et: prim_res.et || et,
                loc: prim_res.loc,
            }, { transaction: t });
        });

        logger.info({ ri, cnt_sid }, 'cnt created');

        // retrieve the created resource and respond
        const tmp_req = { ri }, tmp_resp = {};
        await retrieve_a_cnt(tmp_req, tmp_resp);
        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        logger.error({ err }, 'create_a_cnt failed');
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': err.message };
    } finally {
        req_prim._pendingCreate?.resolve();
    }

    return;
}

async function retrieve_a_cnt(req_prim, resp_prim) {
    const cnt_obj = { 'm2m:cnt': {} };
    const ri = req_prim.ri;

    try {
        const db_res = await CNT.findByPk(ri);

        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': 'CNT resource not found' };
            return;
        }

        // provide int_cr if required by internal API call
        if (req_prim && req_prim.int_cr_req === true)
            cnt_obj['m2m:cnt'].int_cr = db_res.int_cr;

        // copy attributes that shall be stored in the db
        cnt_obj['m2m:cnt'].ty = db_res.ty;
        cnt_obj['m2m:cnt'].et = db_res.et;
        cnt_obj['m2m:cnt'].ct = db_res.ct;
        cnt_obj['m2m:cnt'].lt = db_res.lt;
        cnt_obj['m2m:cnt'].ri = db_res.ri;
        cnt_obj['m2m:cnt'].rn = db_res.rn;
        cnt_obj['m2m:cnt'].pi = db_res.pi;
        cnt_obj['m2m:cnt'].cni = db_res.cni;
        cnt_obj['m2m:cnt'].cbs = db_res.cbs;
        cnt_obj['m2m:cnt'].st = db_res.st;

        // copy optional attribute after checking
        if (db_res.acpi) cnt_obj['m2m:cnt'].acpi = db_res.acpi;
        if (db_res.lbl) cnt_obj['m2m:cnt'].lbl = db_res.lbl;
        if (db_res.cr) cnt_obj['m2m:cnt'].cr = db_res.cr;

        if (db_res.loc) cnt_obj['m2m:cnt'].loc = get_loc_attribute(db_res.loc);

        if (db_res.mni !== undefined) cnt_obj['m2m:cnt'].mni = db_res.mni;
        if (db_res.mbs !== undefined) cnt_obj['m2m:cnt'].mbs = db_res.mbs;
        if (db_res.mia !== undefined) cnt_obj['m2m:cnt'].mia = db_res.mia;

        resp_prim.pc = cnt_obj;
    } catch (err) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': 'CNT resource not found' };
        throw err;
    }

    return;
}

async function update_a_cnt(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:cnt'];
    const ri = req_prim.ri;

    // validation for primitive resource attribute
    const validated = cnt_update_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    try {
        const db_res = await CNT.findByPk(ri);

        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': 'CNT resource not found' };
            return;
        }

        db_res.lt = get_cur_time();
        db_res.st++;

        if (prim_res.et) db_res.et = prim_res.et;
        if (prim_res.acpi) db_res.acpi = prim_res.acpi;
        if (prim_res.lbl) db_res.lbl = prim_res.lbl;
        if (prim_res.loc) {
            await convert_loc_to_geoJson(prim_res, resp_prim);
            if (resp_prim.rsc) // from the prev function, error code is set
                return;
            db_res.loc = prim_res.loc;
        }

        // resource specific attributes
        if (prim_res.mni) db_res.mni = prim_res.mni;
        if (prim_res.mbs) db_res.mbs = prim_res.mbs;
        if (prim_res.mia) db_res.mia = prim_res.mia;
        if (prim_res.mni === null) db_res.mni = config.default.container.mni;
        if (prim_res.mbs === null) db_res.mbs = config.default.container.mbs;
        if (prim_res.mia === null) db_res.mia = config.default.container.mia;

        // delete optional attributes if they are null in the request
        // universal/common attributes
        if (prim_res.acpi === null) db_res.acpi = null;
        if (prim_res.lbl === null) db_res.lbl = null;
        if (prim_res.loc === null) db_res.loc = null;

        // resource specific attributes
        if (prim_res.mni === null) db_res.mni = config.default.container.mni;
        if (prim_res.mbs === null) db_res.mbs = config.default.container.mbs;
        if (prim_res.mia === null) db_res.mia = config.default.container.mia;

        await db_res.save();

        // update 'loc' in the lookup record if it is included in the request
        if (db_res.loc !== undefined) {
            await Lookup.update({ loc: db_res.loc }, { where: { ri } });
        }

        // get the updated resource and respond
        const tmp_req = { ri }, tmp_resp = {};
        await retrieve_a_cnt(tmp_req, tmp_resp);

        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        logger.error({ err }, 'update_a_cnt failed');
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': err.message };
    }

    return;
}

async function retrieve_ol(req_prim, resp_prim) {
    const oldest = await CIN.findOne({
        where: { pi: req_prim.parent_ri },
        order: [['st', 'ASC']],
        attributes: ['ri'],
    });
    if (!oldest) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': 'there is no <cin> resource' };
        return;
    }
    const tmp_req = { ri: oldest.ri }, tmp_resp = {};
    await cin.retrieve_a_cin(tmp_req, tmp_resp);
    resp_prim.rsc = enums.rsc_str["OK"];
    resp_prim.pc = tmp_resp.pc;
}

// if we want to apply 'attrl' filter here, then we can use "retrieve_a_res" function, rather than "retrieve_a_cin"
async function retrieve_la(req_prim, resp_prim) {
    const latest = await CIN.findOne({
        where: { pi: req_prim.parent_ri },
        order: [['st', 'DESC']],
        attributes: ['ri'],
    });
    if (!latest) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': 'there is no <cin> resource' };
        return;
    }
    const tmp_req = { ri: latest.ri }, tmp_resp = {};
    await cin.retrieve_a_cin(tmp_req, tmp_resp);
    resp_prim.rsc = enums.rsc_str["OK"];
    resp_prim.pc = tmp_resp.pc;
}

async function delete_la(req_prim, resp_prim) {
    const latest = await CIN.findOne({
        where: { pi: req_prim.parent_ri },
        order: [['st', 'DESC']],
        attributes: ['ri'],
    });
    if (!latest) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': 'there is no cin resource' };
        return;
    }

    // delete_a_res handles CNT cni/cbs update internally
    const tmp_req = { ri: latest.ri, to_ty: 4 }, tmp_resp = {};
    const { delete_a_res } = require('../hostingCSE');
    await delete_a_res(tmp_req, tmp_resp);

    resp_prim.rsc = enums.rsc_str["DELETED"];
    resp_prim.pc = tmp_resp.pc || undefined;
}

async function delete_ol(req_prim, resp_prim) {
    const oldest = await CIN.findOne({
        where: { pi: req_prim.parent_ri },
        order: [['st', 'ASC']],
        attributes: ['ri'],
    });
    if (!oldest) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': 'there is no cin resource' };
        return;
    }

    // delete_a_res handles CNT cni/cbs update internally
    const tmp_req = { ri: oldest.ri, to_ty: 4 }, tmp_resp = {};
    const { delete_a_res } = require('../hostingCSE');
    await delete_a_res(tmp_req, tmp_resp);

    resp_prim.rsc = enums.rsc_str["DELETED"];
    resp_prim.pc = tmp_resp.pc || undefined;
}


// to-do
async function aggregate_cin_res(req_prim, ri_list) {
    // it is guaranteed that the ri_list is not empty
    return Promise.all(ri_list.map(async (ri) => {
        let temp_req_prim = {
            fr: req_prim.fr,
            to: ri,
            pc: req_prim.pc // attrl may be contained in 'pc'
        };
        let temp_resp_prim = {};
        const { retrieve_a_res } = require('../hostingCSE');
        await retrieve_a_res(temp_req_prim, temp_resp_prim, ri);

        return temp_resp_prim.pc;
    }));
}

module.exports = {
    create_a_cnt,
    retrieve_a_cnt,
    update_a_cnt,
    retrieve_ol,
    retrieve_la,
    delete_la,
    delete_ol,
    aggregate_cin_res,
};