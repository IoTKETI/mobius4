const { csr_create_schema, csr_update_schema } = require('../validation/res_schema');

const { generate_ri, get_cur_time, get_default_et, convert_loc_to_geoJson, get_loc_attribute } = require('../utils');
const enums = require('../../config/enums');
const CSR = require('../../models/csr-model');
const Lookup = require('../../models/lookup-model');

const csr_parent_res_types = ['cb'];

async function create_a_csr(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:csr'];
    const csr_pi = req_prim.ri;
    const csr_sid = req_prim.sid + '/' + prim_res.rn;

    // parent resource type check
    const parent_ty = req_prim.to_ty;
    if (!csr_parent_res_types.includes(enums.ty_str[parent_ty.toString()])) {
        resp_prim.rsc = enums.rsc_str['INVALID_CHILD_RESOURCE_TYPE'];
        resp_prim.pc = { 'm2m:dbg': 'cannot register CSE to this parent resource type' };
        return;
    }

    const ri = generate_ri();
    const now = get_cur_time();
    const et = get_default_et();

    // validation for primitive resource attribute (before loc conversion)
    console.log('prim_res object before validation:', JSON.stringify(prim_res, null, 2));
    const validated = csr_create_schema.validate(prim_res);
    if (validated.error) {
        console.log('Joi validation error details:', JSON.stringify(validated.error.details, null, 2));
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    // process 'loc' attribute (after validation)
    if (prim_res.loc) {
        await convert_loc_to_geoJson(prim_res, resp_prim);
        if (resp_prim.rsc) // from the prev function, error code is set
            return;
    }

    const csr_res = {
        // mandatory attributes
        ri,
        ty: 16,
        rn: prim_res.rn,
        pi: csr_pi,
        sid: csr_sid,
        int_cr: req_prim.fr,
        et: prim_res.et || et,
        ct: now,
        lt: now,
        // optional attributes
        cr: prim_res.cr === null ? req_prim.fr : null,
        acpi: prim_res.acpi || null,
        lbl: prim_res.lbl || null,
        loc: prim_res.loc || null,
        poa: prim_res.poa || null,
        // resource specific attributes
        cb: prim_res.cb, // mandatory
        rr: prim_res.rr, // mandatory
        srv: prim_res.srv, // mandatory
        csi: prim_res.csi || req_prim.fr, // optional
        cst: prim_res.cst || null,
        nl: prim_res.nl || null,
        csz: prim_res.csz || null,
    };

    try {
        await CSR.create(csr_res);
        await Lookup.create({
            ri: csr_res.ri,
            ty: csr_res.ty,
            rn: csr_res.rn,
            sid: csr_res.sid,
            lvl: csr_res.sid.split("/").length,
            pi: csr_res.pi,
            cr: csr_res.cr,
            int_cr: csr_res.int_cr,
            et: prim_res.et || et,
            loc: prim_res.loc || null,
        });

        const tmp_req = { ri }, tmp_resp = {};
        await retrieve_a_csr(tmp_req, tmp_resp);
        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        console.error(err);
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': err.message };
    }
    return;
}

async function retrieve_a_csr(req_prim, resp_prim) {
    const csr_obj = { 'm2m:csr': {} };
    const ri = req_prim.ri;
    try {
        const db_res = await CSR.findByPk(ri);
        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': 'CSR resource not found' };
            return;
        }

        // provide int_cr if required by internal API call
        if (req_prim && req_prim.int_cr_req === true)
            csr_obj['m2m:csr'].int_cr = db_res.int_cr;

        // mandatory attributes
        csr_obj['m2m:csr'].ty = db_res.ty;
        csr_obj['m2m:csr'].et = db_res.et;
        csr_obj['m2m:csr'].ct = db_res.ct;
        csr_obj['m2m:csr'].lt = db_res.lt;
        csr_obj['m2m:csr'].ri = db_res.ri;
        csr_obj['m2m:csr'].rn = db_res.rn;
        csr_obj['m2m:csr'].pi = db_res.pi;
        csr_obj['m2m:csr'].cb = db_res.cb;
        csr_obj['m2m:csr'].rr = db_res.rr;
        csr_obj['m2m:csr'].csi = db_res.csi;
        csr_obj['m2m:csr'].srv = db_res.srv;

        // optional attributes
        if (db_res.acpi) csr_obj['m2m:csr'].acpi = db_res.acpi;
        if (db_res.lbl) csr_obj['m2m:csr'].lbl = db_res.lbl;
        if (db_res.cr) csr_obj['m2m:csr'].cr = db_res.cr;
        if (db_res.cst) csr_obj['m2m:csr'].cst = db_res.cst;
        if (db_res.poa) csr_obj['m2m:csr'].poa = db_res.poa;
        if (db_res.nl) csr_obj['m2m:csr'].nl = db_res.nl;
        if (db_res.csz) csr_obj['m2m:csr'].csz = db_res.csz;
        if (db_res.loc) csr_obj['m2m:csr'].loc = get_loc_attribute(db_res.loc);
    } catch (err) {
        console.error(err);
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': err.message };
        return;
    }
    resp_prim.pc = csr_obj;
    return;
}

async function update_a_csr(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:csr'];
    const ri = req_prim.ri;

    // validation for primitive resource attribute
    const validated = csr_update_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    try {
        const db_res = await CSR.findByPk(ri);
        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': 'CSR resource not found' };
            return;
        }
        db_res.lt = get_cur_time();

        if (prim_res.et) db_res.et = prim_res.et;
        if (prim_res.acpi) db_res.acpi = prim_res.acpi;
        if (prim_res.lbl) db_res.lbl = prim_res.lbl;
        if (prim_res.loc) {
            await convert_loc_to_geoJson(prim_res, resp_prim);
            if (resp_prim.rsc) // from the prev function, error code is set
                return;
            db_res.loc = prim_res.loc;
        }
        if (prim_res.poa) db_res.poa = prim_res.poa;
        if (prim_res.nl) db_res.nl = prim_res.nl;
        if (prim_res.rr) db_res.rr = prim_res.rr;
        if (prim_res.csz) db_res.csz = prim_res.csz;
        if (prim_res.srv) db_res.srv = prim_res.srv;

        // delete optional attributes if they are null in the request
        // universal/common attributes
        if (prim_res.acpi === null) db_res.acpi = null;
        if (prim_res.lbl === null) db_res.lbl = null;
        if (prim_res.loc === null) db_res.loc = null;

        // resource specific attributes
        if (prim_res.poa === null) db_res.poa = null;
        if (prim_res.nl === null) db_res.nl = null;
        if (prim_res.csz === null) db_res.csz = null;
        if (prim_res.srv === null) db_res.srv = null;

        await db_res.save();

        // update 'loc' in the lookup record if it is included in the request
        if (db_res.loc !== undefined) {
            await Lookup.update({ loc: db_res.loc }, { where: { ri } });
        }
        
        const tmp_req = { ri }, tmp_resp = {};
        await retrieve_a_csr(tmp_req, tmp_resp);
        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': 'CSR resource not found' };
        throw err; 
    }
    return;
}

module.exports.create_a_csr = create_a_csr;
module.exports.retrieve_a_csr = retrieve_a_csr;
module.exports.update_a_csr = update_a_csr;