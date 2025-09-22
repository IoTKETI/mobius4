const enums = require('../../config/enums');

const { generate_ri, get_cur_time, get_default_et } = require('../utils');

const Lookup = require('../../models/lookup-model');
const DTS = require('../../models/dts-model');
const DSF = require('../../models/dsf-model');

const dsf_parent_res_types = ['dts'];


async function create_a_dsf(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:dsf'];

    const dsf_pi = req_prim.ri;
    const dsf_sid = req_prim.sid + '/' + prim_res.rn;

    // parent resource type check
    const parent_ty = req_prim.to_ty;
    if (dsf_parent_res_types.includes(enums.ty_str[parent_ty.toString()]) === false) {
        resp_prim.rsc = enums.rsc_str['INVALID_CHILD_RESOURCE_TYPE'];
        resp_prim.pc = { 'm2m:dbg': 'parent of <dsf> resource shall be <dts> resource' };
        return;
    }

    // get parent resource info
    const dts_res = await DTS.findByPk(dsf_pi);
    if (!dts_res) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': 'parent <dts> resource not found' };
        return;
    }

    // currently no meta info (e.g. max size) for <dsf> resource

    const ri = generate_ri();
    const now = get_cur_time();
    const et = get_default_et();

    try {
        await DSF.create({
            // mandatory attributes
            ri,
            ty: 107,
            rn: prim_res.rn,
            pi: dsf_pi,
            sid: dsf_sid,
            et: prim_res.et || et,
            ct: now,
            lt: now,
            // common attributes
            cr: prim_res.cr === null ? req_prim.fr : prim_res.cr,
            acpi: prim_res.acpi || null,
            lbl: prim_res.lbl || null,
            // resource specific attributes
            dfst: prim_res.dfst,
            dfet: prim_res.dfet,
            nrf: prim_res.nrf,
            dsfr: prim_res.dsfr,
            dsfm: prim_res.dsfm,
        });

        let fragment_size = 0;
        if (typeof prim_res.dsfr == 'object') {
            fragment_size = JSON.stringify(prim_res.dsfr).length;
        } else if (typeof prim_res.dsfr == 'string') {
            fragment_size = prim_res.dsfr.length;
        }

        await update_parent_dts(dts_res, ri, fragment_size);

        await Lookup.create({
            ri,
            ty: 107,
            rn: prim_res.rn,
            sid: dsf_sid,
            lvl: dsf_sid.split("/").length,
            pi: dsf_pi,
            cr: prim_res.cr === null ? req_prim.fr : prim_res.cr,
        });

        const tmp_req = { ri }, tmp_resp = {};
        await retrieve_a_dsf(tmp_req, tmp_resp);
        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        console.log(err);
        resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
        resp_prim.pc = { "m2m:dbg": err.message };
    }

    return;
}

async function retrieve_a_dsf(req_prim, resp_prim) {
    const dsf_obj = { "m2m:dsf": {} };
    const ri = req_prim.ri;

    try {
        const db_res = await DSF.findByPk(ri);

        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': '<dsf> resource not found' };
            return;
        }

        // copy mandatory attributes
        dsf_obj["m2m:dsf"].ty = db_res.ty;
        dsf_obj["m2m:dsf"].et = db_res.et;
        dsf_obj["m2m:dsf"].ct = db_res.ct;
        dsf_obj["m2m:dsf"].lt = db_res.lt;
        dsf_obj["m2m:dsf"].ri = db_res.ri;
        dsf_obj["m2m:dsf"].rn = db_res.rn;
        dsf_obj["m2m:dsf"].pi = db_res.pi;

        // copy optional attribute after checking
        if (db_res.acpi) dsf_obj["m2m:dsf"].acpi = db_res.acpi;
        if (db_res.lbl) dsf_obj["m2m:dsf"].lbl = db_res.lbl;
        if (db_res.cr) dsf_obj["m2m:dsf"].cr = db_res.cr;

        // below are resource specific attributes
        if (db_res.dfst) dsf_obj["m2m:dsf"].dfst = db_res.dfst;
        if (db_res.dfet) dsf_obj["m2m:dsf"].dfet = db_res.dfet;
        if (db_res.nrf) dsf_obj["m2m:dsf"].nrf = db_res.nrf;
        if (db_res.dsfr) dsf_obj["m2m:dsf"].dsfr = db_res.dsfr;
        if (db_res.dsfm) dsf_obj["m2m:dsf"].dsfm = db_res.dsfm;

        resp_prim.pc = dsf_obj;
    } catch (err) {
        console.log(err);
        resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
        resp_prim.pc = { "m2m:dbg": err.message };
    }

    return;
}

async function update_parent_dts(dts_res, dsf_ri, fragment_size) {
    if (!dts_res.dsf_list) {
        dts_res.dsf_list = [];
    }   
    dts_res.dsf_list.push(dsf_ri);
    await DTS.update({ dsf_list: dts_res.dsf_list }, { where: { ri: dts_res.ri } });
}

module.exports = {
    create_a_dsf,
    retrieve_a_dsf,
};