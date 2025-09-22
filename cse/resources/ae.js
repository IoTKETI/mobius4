const { ae_create_schema, ae_update_schema } = require('../validation/res_schema');
const config = require('config');
const randomstring = require('randomstring');

const { get_cur_time, get_default_et, convert_loc_to_geoJson, get_loc_attribute } = require('../utils');

const enums = require('../../config/enums');
const AE = require('../../models/ae-model');
const Lookup = require('../../models/lookup-model');

const ae_parent_res_types = ['cb'];

async function create_an_ae(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:ae'];

    // validation for primitive resource attribute
    const validated = ae_create_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    const ae_pi = req_prim.ri;
    const ae_sid = req_prim.sid + '/' + prim_res.rn;

    // parent resource type check
    const parent_ty = req_prim.to_ty;
    if (ae_parent_res_types.includes(enums.ty_str[parent_ty.toString()]) == false) {
        resp_prim.rsc = enums.rsc_str['INVALID_CHILD_RESOURCE_TYPE'];
        resp_prim.pc = { 'm2m:dbg': 'cannot register AE to this parent resource type' };
        return;
    }

    let aei;
    // to-do: no 'fr' is allowed in the spec only for AE registration
    if (!req_prim.fr) {
        // set empty string to assign an ID
        req_prim.fr = '';
    }
    switch (req_prim.fr) {
        // CSE relative ID for 'C' and null 'fr' parameter
        case '':
        case 'C':
            aei = 'C' + randomstring.generate(config.cse.aeid_length);
            break;
        case 'S':
            aei = 'S' + randomstring.generate(config.cse.aeid_length);
            break;
        // use the pre-assigned ID
        default:
            aei = req_prim.fr;
    }

    const now = get_cur_time();
    const et = get_default_et();

    // 'rr' is mandatory
    // to-do: mandatory attribute validation by Joi
    if (prim_res.rr === undefined || prim_res.rr === null) {
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': 'rr is missing' };
        return;
    }

    // 'api' shall start with 'N' or 'R'
    if (!prim_res.api || (prim_res.api.startsWith('N') === false && prim_res.api.startsWith('R') === false)) {
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': 'api shall start with N or R' };
        return;
    }

    // check if the AE-ID already exists
    const exists = await AE.findByPk(aei);
    if (exists) {
        resp_prim.rsc = enums.rsc_str['ORIGINATOR_HAS_ALREADY_REGISTERED'];
        resp_prim.pc = { 'm2m:dbg': `AE-ID (${aei}) already exists.` };
        return;
    }

    // process 'loc' attribute
    if (prim_res.loc) {
        await convert_loc_to_geoJson(prim_res, resp_prim);
        if (resp_prim.rsc) // from the prev function, error code is set
            return;
    }

    // mandatory attributes
    const ae_res = {
        // mandatory attributes
        ri: aei, // by the spec, 'ri' = 'aei'
        ty: 2,
        rn: prim_res.rn,
        pi: ae_pi,
        sid: ae_sid,
        int_cr: aei,
        ct: now,
        lt: now,
        // optional attributes
        et: prim_res.et || et,
        cr: (prim_res.cr === null) ? aei : null,
        acpi: prim_res.acpi || null,
        lbl: prim_res.lbl || null,
        loc: prim_res.loc || null,
        // resource specific attributes
        api: prim_res.api, // mandatory
        rr: prim_res.rr, // mandatory
        srv: prim_res.srv, // mandatory
        aei: aei, // mandatory
        csz: prim_res.csz || null,
        apn: prim_res.apn || null,
        poa: prim_res.poa || null,
    };

    try {
        await AE.create(ae_res);
        await Lookup.create({
            ri: ae_res.ri,
            ty: ae_res.ty,
            rn: ae_res.rn,
            sid: ae_res.sid,
            lvl: ae_res.sid.split("/").length,
            pi: ae_res.pi,
            cr: (ae_res.cr === null) ? aei : null,
            int_cr: ae_res.int_cr,
            et: prim_res.et || et,
            loc: prim_res.loc || null
        });
        const tmp_req = { ri: ae_res.ri }, tmp_resp = {};
        await retrieve_an_ae(tmp_req, tmp_resp);
        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        console.log(err);
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': err.message };
    }
    return;
}

async function retrieve_an_ae(req_prim, resp_prim) {
    const ae_obj = { 'm2m:ae': {} };
    const ri = req_prim.ri;

    try {
        const db_res = await AE.findByPk(ri);
        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': 'AE resource not found' };
            return;
        }
        if (req_prim && req_prim.int_cr_req == true) {
            ae_obj['m2m:ae'].int_cr = db_res.int_cr;
        }
        
        // mandatory attributes
        ae_obj['m2m:ae'].ty = db_res.ty;
        ae_obj['m2m:ae'].et = db_res.et;
        ae_obj['m2m:ae'].ct = db_res.ct;
        ae_obj['m2m:ae'].lt = db_res.lt;
        ae_obj['m2m:ae'].ri = db_res.ri;
        ae_obj['m2m:ae'].rn = db_res.rn;
        ae_obj['m2m:ae'].pi = db_res.pi;
        ae_obj['m2m:ae'].rr = db_res.rr;

        // optional attributes
        // if null, do not include in the response
        if (db_res.acpi) ae_obj['m2m:ae'].acpi = db_res.acpi;
        if (db_res.lbl) ae_obj['m2m:ae'].lbl = db_res.lbl;
        if (db_res.srv) ae_obj['m2m:ae'].srv = db_res.srv;
        if (db_res.csz) ae_obj['m2m:ae'].csz = db_res.csz;
        if (db_res.cr) ae_obj['m2m:ae'].cr = db_res.cr;
        if (db_res.api) ae_obj['m2m:ae'].api = db_res.api;
        if (db_res.apn) ae_obj['m2m:ae'].apn = db_res.apn;
        if (db_res.aei) ae_obj['m2m:ae'].aei = db_res.aei;
        if (db_res.poa) ae_obj['m2m:ae'].poa = db_res.poa;
        if (db_res.loc) ae_obj['m2m:ae'].loc = get_loc_attribute(db_res.loc);

    } catch (err) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': 'AE resource not found' };
        throw err; 
    }
    resp_prim.pc = ae_obj;
    return;
}

async function update_an_ae(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:ae'];
    const ri = req_prim.ri;

    // validation for primitive resource attribute
    const validated = ae_update_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    try {
        const db_res = await AE.findByPk(ri);
        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': 'AE resource not found' };
            return;
        }
        db_res.lt = get_cur_time();

        if (prim_res.et) db_res.et = prim_res.et;
        if (prim_res.acpi) db_res.acpi = prim_res.acpi;
        if (prim_res.lbl) db_res.lbl = prim_res.lbl;
        if (prim_res.srv) db_res.srv = prim_res.srv;
        if (prim_res.apn) db_res.apn = prim_res.apn;
        if (prim_res.poa) db_res.poa = prim_res.poa;
        if (prim_res.rr) db_res.rr = prim_res.rr;
        if (prim_res.loc) {
            await convert_loc_to_geoJson(prim_res, resp_prim);
            if (resp_prim.rsc) // from the prev function, error code is set
                return;
            db_res.loc = prim_res.loc;
        }
        if (prim_res.api || prim_res.aei) {
            resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
            resp_prim.pc = { 'm2m:dbg': 'api and aei are not allowed to be updated' };
            return;
        }

        // delete optional attributes if they are null in the request
        // universal/common attributes
        if (prim_res.acpi === null) db_res.acpi = null;
        if (prim_res.lbl === null) db_res.lbl = null;
        if (prim_res.loc === null) db_res.loc = null;

        // resource specific attributes
        if (prim_res.srv === null) db_res.srv = null;
        if (prim_res.apn === null) db_res.apn = null;
        if (prim_res.poa === null) db_res.poa = null;
        if (prim_res.csz === null) db_res.csz = null;

        await db_res.save();

        // update 'loc' in the lookup record if it is included in the request
        if (db_res.loc !== undefined) {
            await Lookup.update({ loc: db_res.loc }, { where: { ri } });
        }

        const tmp_req = { ri }, tmp_resp = {};
        await retrieve_an_ae(tmp_req, tmp_resp);
        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        console.error(err);
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': err.message };
    }
    return;
}

module.exports.create_an_ae = create_an_ae;
module.exports.retrieve_an_ae = retrieve_an_ae;
module.exports.update_an_ae = update_an_ae;