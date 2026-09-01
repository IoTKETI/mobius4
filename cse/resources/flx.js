const { flx_create_schema, flx_update_schema } = require('../validation/res_schema');

const { generate_ri, get_cur_time, get_default_et, convert_loc_to_geoJson, get_loc_attribute } = require('../utils');
const sequelize = require('../../db/sequelize');

const enums = require('../../config/enums');
const { classify_create_error } = require('../create-error');
const specialization = require('../specialization');
const FLX = require('../../models/flx-model');
const Lookup = require('../../models/lookup-model');

const logger = require('../../logger').forFile(__filename);

// TS-0004:7.4.37.1 names <CSEBase>, <AE>, <remoteCSE> and <container>; TS-0001 table 9.6.35-1
// additionally allows a <flexContainer> to hold its own specializations as children.
const flx_parent_res_types = ['cb', 'ae', 'csr', 'cnt', 'flx'];

// <flexContainerInstance> is out of scope for now, so the retention attributes that would
// drive it are rejected rather than silently stored. TS-0004:7.4.37.2.1 step 3 and
// 7.4.37.2.3 step 3 make a non-zero mni/mbs/mia the trigger for creating instances; accepting
// the attribute without creating them would report success for a policy that does not run.
function reject_unsupported_retention(prim_res, resp_prim) {
    for (const attr of ['mni', 'mbs', 'mia']) {
        if (prim_res[attr]) {
            resp_prim.rsc = enums.rsc_str['NOT_IMPLEMENTED'];
            resp_prim.pc = {
                'm2m:dbg': `${attr} with a non-zero value requires <flexContainerInstance> support, which is not implemented`,
            };
            return true;
        }
    }
    return false;
}

// Resolves the specialization for a cnd and checks the payload's envelope key against it.
// Returns null after setting resp_prim when either step fails.
function resolve_specialization(cnd, envelope_key, resp_prim) {
    const entry = specialization.lookup(cnd);
    if (!entry) {
        resp_prim.rsc = enums.rsc_str['SPECIALIZATION_SCHEMA_NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': `no schema registered for containerDefinition ${cnd}` };
        return null;
    }

    const expected = specialization.expected_envelope_key(entry);
    if (envelope_key !== expected) {
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': `envelope key must be ${expected} for containerDefinition ${cnd}` };
        return null;
    }

    return entry;
}

async function create_a_flx(req_prim, resp_prim) {
    try {
        await do_create_a_flx(req_prim, resp_prim);
    } finally {
        // Released here rather than inside do_create_a_flx so that the rejection paths
        // (4000/4108/4125/5001) release it too. set_ri_sid awaits this promise with no
        // timeout, so an entry left pending makes every later request for the same sid — for
        // instance the client's corrected retry under the same resourceName — hang forever.
        req_prim._pendingCreate?.resolve();
    }
}

async function do_create_a_flx(req_prim, resp_prim) {
    // The envelope key is read generically: a specialization may use a namespace prefix other
    // than m2m: (TS-0004:7.4.37.1), so it cannot be hardcoded the way the other handlers do.
    const envelope_key = Object.keys(req_prim.pc)[0];
    const prim_res = req_prim.pc[envelope_key];

    // validation for primitive resource attribute
    const validated = flx_create_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    const entry = resolve_specialization(prim_res.cnd, envelope_key, resp_prim);
    if (!entry) return;

    const flx_pi = req_prim.ri;
    const flx_sid = req_prim.sid + '/' + prim_res.rn;

    // parent resource type check
    const parent_ty = req_prim.to_ty;
    if (flx_parent_res_types.includes(enums.ty_str[parent_ty.toString()]) == false) {
        resp_prim.rsc = enums.rsc_str['INVALID_CHILD_RESOURCE_TYPE'];
        resp_prim.pc = { 'm2m:dbg': 'cannot create <flexContainer> to this parent resource type' };
        return;
    }

    if (reject_unsupported_retention(prim_res, resp_prim)) return;

    const { custom } = specialization.split_attributes(prim_res);
    // creating: a CREATE carries the whole resource, so mandatory attributes must be present.
    const custom_check = specialization.validate_custom(entry, custom, { creating: true });
    if (!custom_check.ok) {
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': custom_check.message };
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

    const { get_mem_size } = require('../hostingCSE');

    try {
        await sequelize.transaction(async (t) => {
            await FLX.create({
                // mandatory attributes
                ri,
                rn: prim_res.rn,
                pi: flx_pi,
                sid: flx_sid,
                int_cr: req_prim.fr,
                et: prim_res.et || et,
                ct: now,
                lt: now,
                cnd: prim_res.cnd,
                ek: envelope_key,
                // TS-0001:9.6.35 — "Sum of the size in bytes of all of the custom attributes".
                // get_mem_size is the same sizer <contentInstance> uses; the standard does not
                // define how bytes are counted, so consistency is preferred over a second
                // interpretation living in the same repo.
                cs: get_mem_size(custom),
                custom,
                // optional attributes
                cr: prim_res.cr === null ? req_prim.fr : null,
                acpi: prim_res.acpi || null,
                lbl: prim_res.lbl || null,
                or: prim_res.or || null,
                nl: prim_res.nl || null,
                loc: prim_res.loc || null,
            }, { transaction: t });

            await Lookup.create({
                ri,
                ty: 28,
                rn: prim_res.rn,
                sid: flx_sid,
                lvl: flx_sid.split("/").length,
                pi: flx_pi,
                cr: prim_res.cr === null ? req_prim.fr : null,
                int_cr: req_prim.fr,
                et: prim_res.et || et,
                loc: prim_res.loc,
            }, { transaction: t });
        });

        logger.info({ ri, flx_sid, cnd: prim_res.cnd }, 'flx created');

        // retrieve the created resource and respond
        const tmp_req = { ri }, tmp_resp = {};
        await retrieve_a_flx(tmp_req, tmp_resp);
        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        logger.error({ err }, 'create_a_flx failed');
        // A name lost to a concurrent create is a conflict, not a bad request.
        const { rsc, dbg } = classify_create_error(err);
        resp_prim.rsc = rsc;
        resp_prim.pc = { 'm2m:dbg': dbg };
    }

    return;
}

async function retrieve_a_flx(req_prim, resp_prim) {
    const ri = req_prim.ri;

    try {
        const db_res = await FLX.findByPk(ri);

        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': 'FLX resource not found' };
            return;
        }

        // Replay the envelope key the resource was created with, e.g. 'sc:parkingBlock'.
        const flx_obj = { [db_res.ek]: {} };
        const res = flx_obj[db_res.ek];

        // provide int_cr if required by internal API call
        if (req_prim && req_prim.int_cr_req === true)
            res.int_cr = db_res.int_cr;

        // copy attributes that shall be stored in the db
        res.ty = db_res.ty;
        res.et = db_res.et;
        res.ct = db_res.ct;
        res.lt = db_res.lt;
        res.ri = db_res.ri;
        res.rn = db_res.rn;
        res.pi = db_res.pi;
        res.st = db_res.st;
        res.cnd = db_res.cnd;
        res.cs = db_res.cs;

        // copy optional attribute after checking
        if (db_res.acpi) res.acpi = db_res.acpi;
        if (db_res.lbl) res.lbl = db_res.lbl;
        if (db_res.cr) res.cr = db_res.cr;
        if (db_res.or) res.or = db_res.or;
        if (db_res.nl) res.nl = db_res.nl;

        if (db_res.loc) res.loc = get_loc_attribute(db_res.loc);

        // [customAttribute] values sit alongside the reserved attributes in the representation
        if (db_res.custom) Object.assign(res, db_res.custom);

        resp_prim.pc = flx_obj;
    } catch (err) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': 'FLX resource not found' };
        throw err;
    }

    return;
}

async function update_a_flx(req_prim, resp_prim) {
    const envelope_key = Object.keys(req_prim.pc)[0];
    const prim_res = req_prim.pc[envelope_key];
    const ri = req_prim.ri;

    // validation for primitive resource attribute
    const validated = flx_update_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    if (reject_unsupported_retention(prim_res, resp_prim)) return;

    const { get_mem_size } = require('../hostingCSE');

    try {
        const db_res = await FLX.findByPk(ri);

        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': 'FLX resource not found' };
            return;
        }

        // cnd is write-once, so the stored value decides which specialization applies.
        // TS-0004:7.4.37.2.3 re-validates the representation against it on every UPDATE.
        const entry = resolve_specialization(db_res.cnd, envelope_key, resp_prim);
        if (!entry) return;

        const { custom } = specialization.split_attributes(prim_res);
        const custom_check = specialization.validate_custom(entry, custom);
        if (!custom_check.ok) {
            resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
            resp_prim.pc = { 'm2m:dbg': custom_check.message };
            return;
        }

        db_res.lt = get_cur_time();

        if (prim_res.et) db_res.et = prim_res.et;
        if (prim_res.acpi) db_res.acpi = prim_res.acpi;
        if (prim_res.lbl) db_res.lbl = prim_res.lbl;
        if (prim_res.or) db_res.or = prim_res.or;
        if (prim_res.nl) db_res.nl = prim_res.nl;
        if (prim_res.loc) {
            await convert_loc_to_geoJson(prim_res, resp_prim);
            if (resp_prim.rsc) // from the prev function, error code is set
                return;
            db_res.loc = prim_res.loc;
        }

        // delete optional attributes if they are null in the request
        if (prim_res.acpi === null) db_res.acpi = null;
        if (prim_res.lbl === null) db_res.lbl = null;
        if (prim_res.or === null) db_res.or = null;
        if (prim_res.nl === null) db_res.nl = null;
        if (prim_res.loc === null) db_res.loc = null;

        // [customAttribute] handling. TS-0001:9.6.35 scopes the stateTag increment to custom
        // attribute modification — unlike <container>, where every UPDATE bumps it — and
        // TS-0004:7.4.37.2.3 step 2b recomputes contentSize on the same trigger. Presence of a
        // custom attribute in the request is taken as the modification, matching step 3's
        // "contains ... at least one custom attribute".
        const custom_keys = Object.keys(custom);
        if (custom_keys.length > 0) {
            const merged = { ...(db_res.custom || {}) };
            for (const [key, value] of Object.entries(custom)) {
                if (value === null) delete merged[key];
                else merged[key] = value;
            }
            db_res.custom = merged;
            db_res.cs = get_mem_size(merged);
            db_res.st++;
        }

        await db_res.save();

        // update 'loc' in the lookup record if it is included in the request
        if (db_res.loc !== undefined) {
            await Lookup.update({ loc: db_res.loc }, { where: { ri } });
        }

        // get the updated resource and respond
        const tmp_req = { ri }, tmp_resp = {};
        await retrieve_a_flx(tmp_req, tmp_resp);

        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        logger.error({ err }, 'update_a_flx failed');
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': err.message };
    }

    return;
}

module.exports = {
    create_a_flx,
    retrieve_a_flx,
    update_a_flx,
};
