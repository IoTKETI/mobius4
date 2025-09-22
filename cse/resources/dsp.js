const { dsp_create_schema, dsp_update_schema } = require('../validation/res_schema');

const { generate_ri, get_cur_time, get_default_et } = require('../utils');
const dataset_manager = require('../datasetManager');

const enums = require('../../config/enums');

const Lookup = require('../../models/lookup-model');
const DSP = require('../../models/dsp-model');

const dsp_parent_res_types = ["cb", "ae", "csr"];


async function create_a_dsp(req_prim, resp_prim) {
    const prim_res = req_prim.pc["m2m:dsp"];

    // validation for primitive resource attribute
    const validated = dsp_create_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    const dsp_pi = req_prim.ri;
    const dsp_sid = req_prim.sid + '/' + prim_res.rn;

    const ri = generate_ri();
    const now = get_cur_time();
    const et = get_default_et();

    // parent resource type check
    const parent_ty = req_prim.to_ty;
    if (dsp_parent_res_types.includes(enums.ty_str[parent_ty.toString()]) == false) {
        resp_prim.rsc = enums.rsc_str["INVALID_CHILD_RESOURCE_TYPE"];
        resp_prim.pc = { "m2m:dbg": "cannot create <dsp> to this parent resource type" };
        return;
    }

    const dsp_res = req_prim.pc["m2m:dsp"];

    try {
        dsp_res.sid = dsp_sid;
        dsp_res.ri = ri;

        // get dataset info first
        const { dst, det, lof } = await dataset_manager.get_dataset_info(dsp_res.sri);

        // create <dataset> resource for historical data and resolve hdi (historicalDatasetId
        // for dataset creation, set 'cr' as From param of the 'dsp' resource
        let hdi = null;
        if (prim_res.nrhd) {
            hdi = await dataset_manager.create_a_historical_dataset(dsp_res, dst, det, lof);
            if (hdi === null) {
                resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
                resp_prim.pc = { "m2m:dbg": "check sourceResourceIDs (sri)" };
                return;
            }
        }

        // if, nrld (numberOfRowsForLiveDataset) exists in a request, create <dataset> resource for live data and resolve ldi (liveDatasetId)
        let ldi = null; 
        if (prim_res.nrld) {
            ldi = await dataset_manager.create_a_live_dataset(dsp_res, dst, det, lof);
            if (ldi === null) {
                resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
                resp_prim.pc = { "m2m:dbg": "check sourceResourceIDs (sri)" };
                return;
            }
        }

        await DSP.create({
            // mandatory attributes
            ri,
            ty: 105,
            rn: prim_res.rn,
            pi: dsp_pi,
            sid: dsp_sid,
            int_cr: req_prim.fr,
            et: prim_res.et || et,
            ct: now,
            lt: now,
            // optional attributes
            cr: prim_res.cr === null ? req_prim.fr : null,
            acpi: prim_res.acpi || null,
            lbl: prim_res.lbl || null,
            // resource specific attributes
            sri: prim_res.sri, // sourceResourceIDs is not null
            dst: prim_res.dst || null,
            det: prim_res.det || null,
            tcst: prim_res.tcst || prim_res.dst, // if not given, use the datasetStartTime
            tcd: prim_res.tcd || 60, // default duration is 60 seconds
            nvp: prim_res.nvp || 0, // 0: leave as null, 1: fill with last known value
            dsfm: prim_res.dsfm, // datasetFormat is not null (0: CSV, 1: JSON)
            hdi: hdi,
            ldi: ldi,
            nrhd: prim_res.nrhd || null, // default is 'all', but represent as 'null' in DB
            nrld: prim_res.nrld || 1,
        });

        await Lookup.create({
            ri,
            ty: 105,
            rn: prim_res.rn,
            sid: dsp_sid,
            lvl: dsp_sid.split("/").length,
            pi: dsp_pi,
            cr: prim_res.cr === null ? req_prim.fr : null,
            int_cr: req_prim.fr,
            et: prim_res.et || et
        });

        const tmp_req = { ri }, tmp_resp = {};
        await retrieve_a_dsp(tmp_req, tmp_resp);

        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        console.log(err);
        resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
        resp_prim.pc = { "m2m:dbg": err.message };
    }

    return;
}

async function retrieve_a_dsp(req_prim, resp_prim) {
    const dsp_obj = { "m2m:dsp": {} };
    const ri = req_prim.ri;

    try {
        const db_res = await DSP.findByPk(ri);

        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': 'DSP resource not found' };
            return;
        }

        // copy mandatory attributes
        dsp_obj["m2m:dsp"].ty = db_res.ty;
        dsp_obj["m2m:dsp"].et = db_res.et;
        dsp_obj["m2m:dsp"].ct = db_res.ct;
        dsp_obj["m2m:dsp"].lt = db_res.lt;
        dsp_obj["m2m:dsp"].ri = db_res.ri;
        dsp_obj["m2m:dsp"].rn = db_res.rn;
        dsp_obj["m2m:dsp"].pi = db_res.pi;

        // copy optional attributes
        if (db_res.acpi) dsp_obj["m2m:dsp"].acpi = db_res.acpi;
        if (db_res.lbl) dsp_obj["m2m:dsp"].lbl = db_res.lbl;
        if (db_res.cr) dsp_obj["m2m:dsp"].cr = db_res.cr;

        // below are resource specific attributes
        // mcmd (modelCommand) is not returned
        if (db_res.sri) dsp_obj["m2m:dsp"].sri = db_res.sri;
        if (db_res.dst) dsp_obj["m2m:dsp"].dst = db_res.dst;
        if (db_res.det) dsp_obj["m2m:dsp"].det = db_res.det;
        if (db_res.tcst) dsp_obj["m2m:dsp"].tcst = db_res.tcst;
        if (db_res.tcd !== null) dsp_obj["m2m:dsp"].tcd = db_res.tcd; // tcd is integer type
        if (db_res.nvp !== null) dsp_obj["m2m:dsp"].nvp = db_res.nvp; // nvp is integer type
        if (db_res.dsfm !== null) dsp_obj["m2m:dsp"].dsfm = db_res.dsfm; // dsf is integer type
        if (db_res.hdi) dsp_obj["m2m:dsp"].hdi = db_res.hdi;
        if (db_res.ldi) dsp_obj["m2m:dsp"].ldi = db_res.ldi;
        if (db_res.nrhd !== null) dsp_obj["m2m:dsp"].nrhd = db_res.nrhd; // nrhd is integer type
        if (db_res.nrld !== null) dsp_obj["m2m:dsp"].nrld = db_res.nrld; // nrld is integer type

        resp_prim.pc = dsp_obj;
    } catch (err) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': 'DSP resource not found' };
        throw err;
    }

    return;
}

async function update_a_dsp(req_prim, resp_prim) {
    const prim_res = req_prim.pc["m2m:dsp"];
    const ri = req_prim.ri;

    // validation for primitive resource attribute
    const validated = dsp_update_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    try {
        const db_res = await DSP.findByPk(ri);

        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': 'DSP resource not found' };
            return;
        }

        db_res.lt = get_cur_time();

        if (prim_res.acpi) db_res.acpi = prim_res.acpi;
        if (prim_res.lbl) db_res.lbl = prim_res.lbl;

        // resource specific attributes of <dataset> are WO or RO, so immu

        // delete optional attributes if they are null in the request
        // universal/common attributes
        if (prim_res.acpi === null) db_res.acpi = null;
        if (prim_res.lbl === null) db_res.lbl = null;

        await db_res.save();

        const tmp_req = { ri }, tmp_resp = {};
        await retrieve_a_dsp(tmp_req, tmp_resp);

        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        console.log(err);
        resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
        resp_prim.pc = { "m2m:dbg": err.message };
    }

    return;
}

module.exports = {
    create_a_dsp,
    retrieve_a_dsp,
    update_a_dsp,
};