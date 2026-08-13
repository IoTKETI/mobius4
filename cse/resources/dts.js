const { generate_ri, get_cur_time, get_default_et } = require('../utils');

const enums = require("../../config/enums");
const { classify_create_error } = require("../create-error");
const dsf = require('./dsf');

const Lookup = require('../../models/lookup-model');
const DTS = require('../../models/dts-model');

const logger = require('../../logger').forFile(__filename);

const dts_parent_res_types = ["cb", "ae", "csr"];


async function create_a_dts(req_prim, resp_prim) {
    const prim_res = req_prim.pc["m2m:dts"];

    // no resource validation for internal API call

    // this function is called by internal API call, so 'rn' needs to be given here if needed
    const { get_a_new_rn } = require('../hostingCSE');
    if (!prim_res.rn) prim_res.rn = get_a_new_rn(106);

    const dts_pi = req_prim.ri;
    const dts_sid = req_prim.sid + '/' + prim_res.rn;

    const ri = generate_ri();
    const now = get_cur_time();
    const et = get_default_et();

    // parent resource type check
    const parent_ty = req_prim.to_ty;
    if (dts_parent_res_types.includes(enums.ty_str[parent_ty.toString()]) == false) {
        resp_prim.rsc = enums.rsc_str["INVALID_CHILD_RESOURCE_TYPE"];
        resp_prim.pc = { "m2m:dbg": "cannot create <dts> to this parent resource type" };
        return;
    }

    try {
        await DTS.create({
            // mandatory attributes
            ri,
            ty: 106,
            rn: prim_res.rn,
            pi: dts_pi,
            sid: dts_sid,
            int_cr: req_prim.fr,
            et: prim_res.et || et,
            ct: now,
            lt: now,
            // optional attributes
            cr: prim_res.cr === null ? req_prim.fr : null,
            acpi: prim_res.acpi || null,
            lbl: prim_res.lbl || null,

            // resource specific attributes
            dspi: prim_res.dspi,
            lof: prim_res.lof,
        });

        await Lookup.create({
            ri,
            ty: 106,
            rn: prim_res.rn,
            sid: dts_sid,
            lvl: dts_sid.split("/").length,
            pi: dts_pi,
            cr: prim_res.cr === null ? req_prim.fr : null,
            int_cr: req_prim.fr,
            et: prim_res.et || et
        });

        const tmp_req = { ri }, tmp_resp = {};
        await retrieve_a_dts(tmp_req, tmp_resp);

        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        logger.error({ err }, 'create_a_dts failed');
        // A name lost to a concurrent create is a conflict, not a bad request.
        const { rsc, dbg } = classify_create_error(err);
        resp_prim.rsc = rsc;
        resp_prim.pc = { "m2m:dbg": dbg };
    }

    return;
}

async function retrieve_a_dts(req_prim, resp_prim) {
    const dts_obj = { "m2m:dts": {} };
    const ri = req_prim.ri;

    try {
        const db_res = await DTS.findByPk(ri);

        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': 'DTS resource not found' };
            return;
        }

        // provide int_cr if required by internal API call
        if (req_prim && req_prim.int_cr_req === true)
            dts_obj["m2m:dts"].int_cr = db_res.int_cr;

        // copy mandatory attributes
        dts_obj["m2m:dts"].ty = db_res.ty;
        dts_obj["m2m:dts"].et = db_res.et;
        dts_obj["m2m:dts"].ct = db_res.ct;
        dts_obj["m2m:dts"].lt = db_res.lt;
        dts_obj["m2m:dts"].ri = db_res.ri;
        dts_obj["m2m:dts"].rn = db_res.rn;
        dts_obj["m2m:dts"].pi = db_res.pi;

        // copy optional attributes
        if (db_res.acpi) dts_obj["m2m:dts"].acpi = db_res.acpi;
        if (db_res.lbl) dts_obj["m2m:dts"].lbl = db_res.lbl;
        if (db_res.cr) dts_obj["m2m:dts"].cr = db_res.cr;

        // below are resource specific attributes
        // mcmd (modelCommand) is not returned
        if (db_res.dspi) dts_obj["m2m:dts"].dspi = db_res.dspi;
        if (db_res.lof) dts_obj["m2m:dts"].lof = db_res.lof;

        resp_prim.pc = dts_obj;
    } catch (err) {
        logger.error({ err }, 'retrieve_a_dts failed');
        resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    }

    return;
}

// <ol> ("oldest") resolves to the oldest non-obsolete <datasetFragment> under this <dataset>,
// found the same way <container>'s <ol> finds its oldest <contentInstance> (find_edge_cin in
// cse/resources/cnt.js) -- a query ordered by creationTime that excludes expired children,
// rather than array position in a list. See dsf.js's find_edge_dsf for why the ordering uses
// 'ct'+'ri' where <container> uses 'st'+'ct'+'ri' (<datasetFragment> has no stateTag).
async function retrieve_ol(req_prim, resp_prim) {
    const oldest = await dsf.find_edge_dsf(req_prim.parent_ri, 'ASC');
    if (!oldest) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': 'there is no dsf resource' };
        return;
    }

    const tmp_req = { ri: oldest.ri }, tmp_resp = {};
    await dsf.retrieve_a_dsf(tmp_req, tmp_resp);

    resp_prim.rsc = enums.rsc_str["OK"];
    resp_prim.pc = tmp_resp.pc;
    return;
}

async function retrieve_la(req_prim, resp_prim) {
    const latest = await dsf.find_edge_dsf(req_prim.parent_ri, 'DESC');
    if (!latest) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': 'there is no <dsf> resource' };
        return;
    }

    const tmp_req = { ri: latest.ri }, tmp_resp = {};
    await dsf.retrieve_a_dsf(tmp_req, tmp_resp);

    resp_prim.rsc = enums.rsc_str["OK"];
    resp_prim.pc = tmp_resp.pc;
    return;
}

module.exports = {
    create_a_dts,
    retrieve_a_dts,
    retrieve_ol,
    retrieve_la,
};