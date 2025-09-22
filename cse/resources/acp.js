const { acp_create_schema, acp_update_schema } = require('../validation/res_schema');

const ACP = require('../../models/acp-model');
const Lookup = require('../../models/lookup-model');

const { generate_ri, get_cur_time, get_default_et } = require('../utils');
const enums = require('../../config/enums');

const acp_parent_res_types = ['cb', 'ae'];

async function create_an_acp(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:acp'];

    // validation for primitive resource attribute
    const validated = acp_create_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    const acp_pi = req_prim.ri;
    const acp_sid = req_prim.sid + '/' + prim_res.rn;

    // parent resource type check
    const parent_ty = req_prim.to_ty;
    if (acp_parent_res_types.includes(enums.ty_str[parent_ty.toString()]) == false) {
        resp_prim.rsc = enums.rsc_str['INVALID_CHILD_RESOURCE_TYPE'];
        resp_prim.pc = { 'm2m:dbg': 'cannot create ACP to this parent resource type' };
        return;
    }

    const ri = generate_ri();
    const now = get_cur_time();
    const et = get_default_et();

    // validity check
    if (!prim_res.pvs.acr || prim_res.pvs.acr.length === 0) {
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': 'pvs shall have at last one acr' };
        return;
    }

    try {
        await ACP.create({
            // mandatory attributes
            ri,
            ty: 1,
            sid: acp_sid,
            int_cr: req_prim.fr,
            rn: prim_res.rn,
            pi: acp_pi,
            et: prim_res.et || et,
            ct: now,
            lt: now,
            // common attributes
            acpi: prim_res.acpi || null,
            lbl: prim_res.lbl || null,
            cr: prim_res.cr === null ? req_prim.fr : null, 
            // resource specific attributes
            pv: prim_res.pv, // mandatory
            pvs: prim_res.pvs // mandatory and array shall not be empty
        });

        await Lookup.create({
            ri,
            ty: 1,
            rn: prim_res.rn,
            sid: acp_sid,
            lvl: acp_sid.split("/").length,
            pi: acp_pi,
            cr: prim_res.cr === null ? req_prim.fr : null,
            et: prim_res.et || et,
            int_cr: req_prim.fr
        });

        const tmp_req = {ri}, tmp_resp = {};
        await retrieve_an_acp(tmp_req, tmp_resp);

        resp_prim.pc = tmp_resp.pc;
    } catch (err) {        
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': err.message };
    } 
}

async function retrieve_an_acp(req_prim, resp_prim) {
    const acp_obj = { 'm2m:acp': {} };
    const ri = req_prim.ri;

    try {
        const db_res = await ACP.findByPk(ri);

        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': 'ACP resource not found' };
            return;
        }

        // provide int_cr if required by internal API call
        if (req_prim && req_prim.int_cr_req === true)
            acp_obj['m2m:acp'].int_cr = db_res.int_cr;

        // copy attributes that shall be stored in the db
        acp_obj['m2m:acp'].ty = db_res.ty;
        acp_obj['m2m:acp'].et = db_res.et;
        acp_obj['m2m:acp'].ct = db_res.ct;
        acp_obj['m2m:acp'].lt = db_res.lt;
        acp_obj['m2m:acp'].ri = db_res.ri;
        acp_obj['m2m:acp'].rn = db_res.rn;
        acp_obj['m2m:acp'].pi = db_res.pi;

        // copy optional attribute after checking
        if (db_res.acpi && db_res.acpi.length !== 0) { 
            acp_obj['m2m:acp'].acpi = db_res.acpi; 
        }
        if (db_res.lbl && db_res.lbl.length !== 0) { 
            acp_obj['m2m:acp'].lbl = db_res.lbl; 
        }
        if (db_res.cr) { 
            acp_obj['m2m:acp'].cr = db_res.cr; 
        }

        // below are resource specific attributes
        if (db_res.pv) { 
            acp_obj['m2m:acp'].pv = db_res.pv; 
        }
        if (db_res.pvs) { 
            acp_obj['m2m:acp'].pvs = db_res.pvs; 
        }
    } catch (err) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': 'ACP resource not found' };
        throw err; 
    } 

    resp_prim.pc = acp_obj;
    return;
}

async function update_an_acp(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:acp'];
    const ri = req_prim.ri;

    // validation for primitive resource attribute
    const validated = acp_update_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    try {
        const db_res = await ACP.findByPk(ri);
        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': 'ACP resource not found' };
            return;
        }

        // mandatory RW attributes cannot be deleted
        if (prim_res.pvs === null) {
            resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
            resp_prim.pc = { 'm2m:dbg': 'pvs cannot be deleted' };
            return;
        }

        db_res.lt = get_cur_time();

        if (prim_res.et) db_res.et = prim_res.et;
        if (prim_res.acpi) db_res.acpi = prim_res.acpi;
        if (prim_res.lbl) db_res.lbl = prim_res.lbl;
        if (prim_res.pv) db_res.pv = prim_res.pv;
        if (prim_res.pvs) db_res.pvs = prim_res.pvs;

        // delete optional attributes if they are null in the request
        // universal/common attributes
        if (prim_res.acpi === null) db_res.acpi = null;
        if (prim_res.lbl === null) db_res.lbl = null;

        // special handling for 'pv'
        if (prim_res.pv === null) db_res.pv = [];
        
        await db_res.save();

        const tmp_req = {ri}, tmp_resp = {};
        await retrieve_an_acp(tmp_req, tmp_resp);
        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        console.error(err);
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': err.message };
    }
}

module.exports.create_an_acp = create_an_acp;
module.exports.retrieve_an_acp = retrieve_an_acp;
module.exports.update_an_acp = update_an_acp;