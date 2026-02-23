const { pch_create_schema, pch_update_schema } = require('../validation/res_schema');

const { generate_ri, get_cur_time, get_default_et } = require('../utils');
const enums = require('../../config/enums');
const PCH = require('../../models/pch-model');
const Lookup = require('../../models/lookup-model');

const pch_parent_res_types = ['ae', 'csr'];

async function create_a_pch(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:pch'];

    // validation for primitive resource attribute
    const validated = pch_create_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    const pch_pi = req_prim.ri;
    const pch_sid = req_prim.sid + '/' + prim_res.rn;

    // parent resource type check
    const parent_ty = req_prim.to_ty;
    if (pch_parent_res_types.includes(enums.ty_str[parent_ty.toString()]) == false) {
        resp_prim.rsc = enums.rsc_str['INVALID_CHILD_RESOURCE_TYPE'];
        resp_prim.pc = { 'm2m:dbg': 'cannot create <pch> to this parent resource type' };
        return;
    }

    // check if there is already a pch under the same <AE> or <remoteCSE> resource
    // <AE> or <remoteCSE> resource having the same 'pi' attribute => already exists
    const pch_res = await PCH.findOne({
        where: { pi: pch_pi },
    });
    if (pch_res) {
        resp_prim.rsc = enums.rsc_str['CONFLICT'];
        resp_prim.pc = { 'm2m:dbg': 'there is already a <pch> under the same <AE> or <remoteCSE> resource' };
        return;
    }

    const ri = generate_ri();
    const now = get_cur_time();
    const et = get_default_et();

    try {
        await PCH.create({
            // mandatory attributes
            ri,
            ty: 15,
            sid: pch_sid,
            int_cr: req_prim.fr,
            rn: prim_res.rn,
            pi: pch_pi,
            et: prim_res.et || et,
            ct: now,
            lt: now,
            // optional attributes
            lbl: prim_res.lbl || null,
            rqag: prim_res.rqag || false,
        });

        await Lookup.create({
            ri,
            ty: 15,
            rn: prim_res.rn,
            sid: pch_sid,
            lvl: pch_sid.split("/").length,
            pi: pch_pi,
            cr: null, // cr is not defined for pch
            int_cr: req_prim.fr,
            et: prim_res.et || et,
        });

        const tmp_req = { ri }, tmp_resp = {};
        await retrieve_a_pch(tmp_req, tmp_resp);
        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        console.error(err);
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': err.message };
    }
    return;
}

async function retrieve_a_pch(req_prim, resp_prim) {
    const pch_obj = { 'm2m:pch': {} };
    const ri = req_prim.ri;

    try {
        const db_res = await PCH.findByPk(ri);

        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': '<pch> resource not found' };
            return;
        }

        // copy mandatory attributes
        pch_obj['m2m:pch'].ty = db_res.ty;
        pch_obj['m2m:pch'].et = db_res.et;
        pch_obj['m2m:pch'].ct = db_res.ct;
        pch_obj['m2m:pch'].lt = db_res.lt;
        pch_obj['m2m:pch'].ri = db_res.ri;
        pch_obj['m2m:pch'].rn = db_res.rn;
        pch_obj['m2m:pch'].pi = db_res.pi;

        // copy optional attribute after checking
        if (db_res.lbl) pch_obj['m2m:pch'].lbl = db_res.lbl;
        if (db_res.rqag) pch_obj['m2m:pch'].rqag = db_res.rqag;

        resp_prim.pc = pch_obj;
    } catch (err) {
        console.error(err);
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': err.message };
    }
    return;
}

async function update_a_pch(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:pch'];
    const ri = req_prim.ri;

    // validation for primitive resource attribute
    const validated = pch_update_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    try {
        const db_res = await PCH.findByPk(ri);
        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': '<pch> resource not found' };
            return;
        }

        db_res.lt = get_cur_time();

        if (prim_res.et) db_res.et = prim_res.et;
        if (prim_res.lbl) db_res.lbl = prim_res.lbl;

        // resource specific attribute
        if (prim_res.rqag) db_res.rqag = prim_res.rqag;

        await db_res.save();

        const tmp_req = {ri}, tmp_resp = {};
        await retrieve_a_pch(tmp_req, tmp_resp);
        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        console.error(err);
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': err.message };
    }
    return;
}

async function retrieve_pcu(req_prim, resp_prim) {
    console.log("retrieve_pcu: ", JSON.stringify(req_prim, null, 2));
    resp_prim.rsc = enums.rsc_str["OK"];
    return;
}

async function notify_pcu(req_prim, resp_prim) {
    console.log("notify_pcu: ", JSON.stringify(req_prim, null, 2));
    resp_prim.rsc = enums.rsc_str["OK"];
    return;
}

module.exports = {
    create_a_pch,
    retrieve_a_pch,
    update_a_pch,
    retrieve_pcu,
    notify_pcu
};