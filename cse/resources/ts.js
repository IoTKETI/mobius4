const config = require('config');
const { ts_create_schema, ts_update_schema } = require('../validation/res_schema');

const { generate_ri, get_cur_time, get_default_et, convert_loc_to_geoJson, get_loc_attribute } = require('../utils');
const sequelize = require('../../db/sequelize');

const enums = require('../../config/enums');
const { classify_create_error } = require('../create-error');
const TS = require('../../models/ts-model');
const Lookup = require('../../models/lookup-model');
// NOTE: ./tsi is deliberately NOT required here. Task 3 adds it along with the <latest>/<oldest>
// handlers that need it. Requiring a module that does not exist yet would stop the server from
// booting, and every test in this task would fail with MODULE_NOT_FOUND rather than an assertion.

const logger = require('../../logger').forFile(__filename);

const ts_parent_res_types = ['ae', 'cnt', 'csr', 'cb', 'flx'];

// TS-0001:10.2.4.29 and 10.2.4.23 both say the detection state is cleared when one of these is
// updated. Both clauses qualify it with "while the data detection process is paused" and neither
// says what happens when it is running — see UP-004. DEC-116 resolves that gap by clearing
// regardless: expected dataGenerationTime is "the dataGenerationTime of the first received
// <timeSeriesInstance> plus (N * periodicInterval)", so once periodicInterval changes the N in
// that formula no longer means anything, and entries computed under the old period would sit in
// missingDataList next to entries computed under the new one with no way to tell them apart.
const DETECTION_PARAMS = ['pei', 'peid', 'mdt', 'mdn'];

function clear_detection_state(db_res) {
    db_res.mdlt = [];
    db_res.mdc = 0;
    db_res.md_anchor_dgt = null;
    db_res.md_watermark_n = null;
}

async function create_a_ts(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:ts'];

    const validated = ts_create_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    const ts_pi = req_prim.ri;
    const ts_sid = req_prim.sid + '/' + prim_res.rn;

    const parent_ty = req_prim.to_ty;
    if (ts_parent_res_types.includes(enums.ty_str[parent_ty.toString()]) === false) {
        resp_prim.rsc = enums.rsc_str['INVALID_CHILD_RESOURCE_TYPE'];
        resp_prim.pc = { 'm2m:dbg': 'cannot create <ts> to this parent resource type' };
        return;
    }

    // TS-0001:9.6.36 — "The value of this attribute shall be less than or equal to
    // (periodicInterval/2)."
    if (prim_res.peid != null && prim_res.pei != null && prim_res.peid > prim_res.pei / 2) {
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': 'peid must be less than or equal to pei/2' };
        return;
    }
    // TS-0001:9.6.36 — "If periodicIntervalDelta is present, the value of this attribute shall
    // be greater than periodicIntervalDelta."
    if (prim_res.mdt != null && prim_res.peid != null && prim_res.mdt <= prim_res.peid) {
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': 'mdt must be greater than peid' };
        return;
    }

    const ri = generate_ri();
    const now = get_cur_time();
    const et = get_default_et();

    if (prim_res.loc) {
        await convert_loc_to_geoJson(prim_res, resp_prim);
        if (resp_prim.rsc) return;
    }

    try {
        await sequelize.transaction(async (t) => {
            await TS.create({
                ri,
                rn: prim_res.rn,
                pi: ts_pi,
                sid: ts_sid,
                int_cr: req_prim.fr,
                et: prim_res.et || et,
                ct: now,
                lt: now,
                cr: prim_res.cr === null ? req_prim.fr : null,
                acpi: prim_res.acpi || null,
                lbl: prim_res.lbl || null,
                // ??, not ||: an explicitly requested 0 (Joi allows .min(0)) must survive, not
                // be silently replaced by the deployment default. Same reasoning as pei/peid/
                // mdn/mdt below.
                mni: prim_res.mni ?? config.default.timeSeries.mni,
                mbs: prim_res.mbs ?? config.default.timeSeries.mbs,
                mia: prim_res.mia ?? config.default.timeSeries.mia,
                pei: prim_res.pei ?? null,
                peid: prim_res.peid ?? null,
                // TS-0001:9.6.36 gives missingDataDetect multiplicity 1 with "The default value
                // is false", so it is stored even when the request omits it.
                mdd: prim_res.mdd ?? false,
                mdn: prim_res.mdn ?? null,
                mdt: prim_res.mdt ?? null,
                cnf: prim_res.cnf ?? null,
                or: prim_res.or ?? null,
                loc: prim_res.loc || null,
            }, { transaction: t });

            await Lookup.create({
                ri,
                ty: enums.ty_num.ts,
                rn: prim_res.rn,
                sid: ts_sid,
                lvl: ts_sid.split('/').length,
                pi: ts_pi,
                cr: prim_res.cr === null ? req_prim.fr : null,
                int_cr: req_prim.fr,
                et: prim_res.et || et,
                loc: prim_res.loc,
            }, { transaction: t });
        });

        logger.info({ ri, ts_sid }, 'ts created');

        const tmp_req = { ri }, tmp_resp = {};
        await retrieve_a_ts(tmp_req, tmp_resp);
        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        logger.error({ err }, 'create_a_ts failed');
        const { rsc, dbg } = classify_create_error(err);
        resp_prim.rsc = rsc;
        resp_prim.pc = { 'm2m:dbg': dbg };
    } finally {
        req_prim._pendingCreate?.resolve();
    }
}

async function retrieve_a_ts(req_prim, resp_prim) {
    const ts_obj = { 'm2m:ts': {} };
    const ri = req_prim.ri;

    try {
        const db_res = await TS.findByPk(ri);

        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': '<ts> resource not found' };
            return;
        }

        if (req_prim && req_prim.int_cr_req === true)
            ts_obj['m2m:ts'].int_cr = db_res.int_cr;

        // multiplicity 1 in TS-0001:9.6.36 — always present, never conditional
        ts_obj['m2m:ts'].ty = db_res.ty;
        ts_obj['m2m:ts'].et = db_res.et;
        ts_obj['m2m:ts'].ct = db_res.ct;
        ts_obj['m2m:ts'].lt = db_res.lt;
        ts_obj['m2m:ts'].ri = db_res.ri;
        ts_obj['m2m:ts'].rn = db_res.rn;
        ts_obj['m2m:ts'].pi = db_res.pi;
        ts_obj['m2m:ts'].cni = db_res.cni;
        ts_obj['m2m:ts'].cbs = db_res.cbs;
        ts_obj['m2m:ts'].mdd = db_res.mdd;
        ts_obj['m2m:ts'].mdc = db_res.mdc;

        // optional
        if (db_res.acpi) ts_obj['m2m:ts'].acpi = db_res.acpi;
        if (db_res.lbl) ts_obj['m2m:ts'].lbl = db_res.lbl;
        if (db_res.cr) ts_obj['m2m:ts'].cr = db_res.cr;
        if (db_res.loc) ts_obj['m2m:ts'].loc = get_loc_attribute(db_res.loc);
        if (db_res.mni !== undefined) ts_obj['m2m:ts'].mni = db_res.mni;
        if (db_res.mbs !== undefined) ts_obj['m2m:ts'].mbs = db_res.mbs;
        if (db_res.mia !== undefined) ts_obj['m2m:ts'].mia = db_res.mia;
        if (db_res.pei !== null) ts_obj['m2m:ts'].pei = db_res.pei;
        if (db_res.peid !== null) ts_obj['m2m:ts'].peid = db_res.peid;
        if (db_res.mdn !== null) ts_obj['m2m:ts'].mdn = db_res.mdn;
        if (db_res.mdt !== null) ts_obj['m2m:ts'].mdt = db_res.mdt;
        if (db_res.cnf) ts_obj['m2m:ts'].cnf = db_res.cnf;
        if (db_res.or) ts_obj['m2m:ts'].or = db_res.or;
        // 0..1 (L) — an empty list is "not set", not "set to empty"
        if (db_res.mdlt && db_res.mdlt.length) ts_obj['m2m:ts'].mdlt = db_res.mdlt;

        resp_prim.pc = ts_obj;
    } catch (err) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': '<ts> resource not found' };
        throw err;
    }
}

async function update_a_ts(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:ts'];
    const ri = req_prim.ri;

    const validated = ts_update_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    try {
        const db_res = await TS.findByPk(ri);

        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': '<ts> resource not found' };
            return;
        }

        db_res.lt = get_cur_time();

        if (prim_res.et) db_res.et = prim_res.et;
        if (prim_res.acpi) db_res.acpi = prim_res.acpi;
        if (prim_res.lbl) db_res.lbl = prim_res.lbl;
        if (prim_res.loc) {
            await convert_loc_to_geoJson(prim_res, resp_prim);
            if (resp_prim.rsc) return;
            db_res.loc = prim_res.loc;
        }

        // !== undefined, not truthy: an explicitly requested 0 must be applied, not skipped.
        if (prim_res.mni !== undefined) db_res.mni = prim_res.mni;
        if (prim_res.mbs !== undefined) db_res.mbs = prim_res.mbs;
        if (prim_res.mia !== undefined) db_res.mia = prim_res.mia;

        const was_detecting = db_res.mdd;
        for (const k of DETECTION_PARAMS) {
            if (prim_res[k] !== undefined) db_res[k] = prim_res[k];
        }
        // No cnf handling here: TS-0001:9.6.36 marks contentInfo WO, and ts_update_schema
        // rejects it outright, so it never reaches this point.
        if (prim_res.or !== undefined) db_res.or = prim_res.or;

        // clear on null (universal/common)
        if (prim_res.acpi === null) db_res.acpi = null;
        if (prim_res.lbl === null) db_res.lbl = null;
        if (prim_res.loc === null) db_res.loc = null;
        if (prim_res.mni === null) db_res.mni = config.default.timeSeries.mni;
        if (prim_res.mbs === null) db_res.mbs = config.default.timeSeries.mbs;
        if (prim_res.mia === null) db_res.mia = config.default.timeSeries.mia;

        // TS-0001:10.2.4.23 + DEC-116 — order matters. A request that both flips mdd and edits a
        // detection parameter must end up cleared either way, so the parameter check runs first
        // and the mdd transition can only add a clear, never cancel one.
        const params_touched = DETECTION_PARAMS.some((k) => prim_res[k] !== undefined);
        if (params_touched) clear_detection_state(db_res);

        if (prim_res.mdd !== undefined && prim_res.mdd !== was_detecting) {
            db_res.mdd = prim_res.mdd;
            // "When the missingDataDetect is updated from false to true the Hosting CSE will
            // clear the missingDataList and missingDataCurrentNr." The other direction pauses
            // and explicitly keeps them.
            if (prim_res.mdd === true) clear_detection_state(db_res);
        }

        // TS-0001:9.6.36 constraints, re-checked against the merged resource rather than the
        // request: a request may change only one of the pair and still break the relation.
        if (db_res.peid != null && db_res.pei != null && db_res.peid > db_res.pei / 2) {
            resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
            resp_prim.pc = { 'm2m:dbg': 'peid must be less than or equal to pei/2' };
            return;
        }
        if (db_res.mdt != null && db_res.peid != null && db_res.mdt <= db_res.peid) {
            resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
            resp_prim.pc = { 'm2m:dbg': 'mdt must be greater than peid' };
            return;
        }

        await db_res.save();

        if (db_res.loc !== undefined) {
            await Lookup.update({ loc: db_res.loc }, { where: { ri } });
        }

        const tmp_req = { ri }, tmp_resp = {};
        await retrieve_a_ts(tmp_req, tmp_resp);
        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        logger.error({ err }, 'update_a_ts failed');
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': err.message };
    }
}

module.exports = {
    create_a_ts,
    retrieve_a_ts,
    update_a_ts,
    clear_detection_state,
    DETECTION_PARAMS,
};
