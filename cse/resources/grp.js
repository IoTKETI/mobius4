const { grp_create_schema, grp_update_schema } = require('../validation/res_schema');

const { generate_ri, get_cur_time, get_default_et } = require('../utils');
const sequelize = require('../../db/sequelize');
const enums = require('../../config/enums');
const GRP = require('../../models/grp-model');
const Lookup = require('../../models/lookup-model');

const logger = require('../../logger').forFile(__filename);

const grp_parent_res_types = ['ae', 'rce', 'cb'];

async function create_a_grp(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:grp'];

    // validation for primitive resource attribute
    const validated = grp_create_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    const grp_pi = req_prim.ri;
    const grp_sid = req_prim.sid + '/' + prim_res.rn;

    // parent resource type check
    const parent_ty = req_prim.to_ty;
    if (grp_parent_res_types.includes(enums.ty_str[parent_ty.toString()]) == false) {
        resp_prim.rsc = enums.rsc_str['INVALID_CHILD_RESOURCE_TYPE'];
        resp_prim.pc = { 'm2m:dbg': 'cannot create <grp> to this parent resource type' };
        return;
    }

    // validations for group creation
    prim_res.mid = remove_duplicate_memberIDs(prim_res.mid);
    if (false === await member_count_validation(prim_res.mnm, prim_res.mid, resp_prim)) {
        return;
    }

    if (prim_res.mt !== 0) {
        const validity = await memberType_validation(req_prim, resp_prim);
        if (false === validity) {
            return;
        } else {
            prim_res.mtv = true;
        }
    }

    // if (false === await memberType_validation(prim_res.csy, prim_res.mid, resp_prim)) {
    //     return;
    // }

    const ri = generate_ri();
    const now = get_cur_time();
    const et = get_default_et();

    try {
        await sequelize.transaction(async (t) => {
            await GRP.create({
                // mandatory attributes
                ri,
                ty: 9,
                sid: grp_sid,
                int_cr: req_prim.fr,
                rn: prim_res.rn,
                pi: grp_pi,
                et: prim_res.et || et,
                ct: now,
                lt: now,
                // optional attributes
                acpi: prim_res.acpi || null,
                lbl: prim_res.lbl || null,
                cr: prim_res.cr === null ? req_prim.fr : null,
                mt: prim_res.mt || 0,
                mtv: prim_res.mtv ? prim_res.mtv : null,
                cnm: prim_res.mid ? prim_res.mid.length : 0,
                mnm: prim_res.mnm,
                csy: prim_res.csy || 1,
                mid: prim_res.mid || [],
                macp: prim_res.macp || null,
                gn: prim_res.gn || null,
            }, { transaction: t });

            await Lookup.create({
                ri,
                ty: 9,
                rn: prim_res.rn,
                sid: grp_sid,
                lvl: grp_sid.split("/").length,
                pi: grp_pi,
                cr: prim_res.cr === null ? req_prim.fr : prim_res.cr,
                int_cr: req_prim.fr,
                et: prim_res.et || et,
                loc: null
            }, { transaction: t });
        });

        // retrieve the created resource and respond
        const tmp_req = { ri }, tmp_resp = {};
        await retrieve_a_grp(tmp_req, tmp_resp);
        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        logger.error({ err }, 'create_a_grp failed');
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': err.message };
    } finally {
        req_prim._pendingCreate?.resolve();
    }
    return;
}

async function retrieve_a_grp(req_prim, resp_prim) {
    const grp_obj = { 'm2m:grp': {} };
    const ri = req_prim.ri;

    try {
        const db_res = await GRP.findByPk(ri);

        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': 'GRP resource not found' };
            return;
        }

        if (req_prim && req_prim.int_cr_req === true)
            grp_obj['m2m:grp'].int_cr = db_res.int_cr;

        // mandatory attributes
        grp_obj['m2m:grp'].ty = db_res.ty;
        grp_obj['m2m:grp'].et = db_res.et;
        grp_obj['m2m:grp'].ct = db_res.ct;
        grp_obj['m2m:grp'].lt = db_res.lt;
        grp_obj['m2m:grp'].ri = db_res.ri;
        grp_obj['m2m:grp'].rn = db_res.rn;
        grp_obj['m2m:grp'].pi = db_res.pi;
        grp_obj['m2m:grp'].mt = db_res.mt;
        grp_obj['m2m:grp'].cnm = db_res.cnm;

        // common attributes
        if (db_res.acpi) grp_obj['m2m:grp'].acpi = db_res.acpi;
        if (db_res.lbl) grp_obj['m2m:grp'].lbl = db_res.lbl;
        if (db_res.cr) grp_obj['m2m:grp'].cr = db_res.cr;

        // resource specific attributes
        if (db_res.mt) grp_obj['m2m:grp'].mt = db_res.mt;
        if (db_res.mtv) grp_obj['m2m:grp'].mtv = db_res.mtv;
        if (db_res.mnm) grp_obj['m2m:grp'].mnm = db_res.mnm;
        if (db_res.csy) grp_obj['m2m:grp'].csy = db_res.csy;
        if (db_res.mid) grp_obj['m2m:grp'].mid = db_res.mid;
        if (db_res.macp) grp_obj['m2m:grp'].macp = db_res.macp;
        if (db_res.gn) grp_obj['m2m:grp'].gn = db_res.gn;

        resp_prim.pc = grp_obj;
    } catch (err) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': 'GRP resource not found' };
        throw err; 
    }
}

async function update_a_grp(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:grp'];
    const ri = req_prim.ri;

    // validation for primitive resource attribute
    const validated = grp_update_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    try {
        const db_res = await GRP.findByPk(ri);
        
        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': 'GRP resource not found' };
            return;
        }

        // validations for group update
        if (prim_res.mid) { 
            prim_res.mid = remove_duplicate_memberIDs(prim_res.mid);
            if (false === await member_count_validation(prim_res.mnm, prim_res.mid, resp_prim)) {
                return;
            }
        }

        db_res.lt = get_cur_time();

        if (prim_res.et) db_res.et = prim_res.et;
        if (prim_res.acpi) db_res.acpi = prim_res.acpi;
        if (prim_res.lbl) db_res.lbl = prim_res.lbl;
 
        // mandatory RW attributes cannot be deleted
        if (prim_res.mnm === null) {
            resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
            resp_prim.pc = { 'm2m:dbg': 'mnm cannot be deleted' };
            return;
        }
        // new mnm cannot be less than the number of current members
        logger.debug({ mnm: prim_res.mnm, cnm: db_res.cnm }, 'mnm/cnm check');
        if (prim_res.mnm < db_res.cnm) {
            resp_prim.rsc = enums.rsc_str['MAX_NUMBER_OF_MEMBER_EXCEEDED'];
            resp_prim.pc = { 'm2m:dbg': 'new mnm cannot be less than the number of current members' };
            return;
        }

        // below are resource specific attributes
        if (prim_res.mt) db_res.mt = prim_res.mt; 
        if (prim_res.cnm) db_res.cnm = prim_res.cnm; 
        if (prim_res.mnm) db_res.mnm = prim_res.mnm; 
        if (prim_res.csy) db_res.csy = prim_res.csy; 
        if (prim_res.mid) db_res.mid = prim_res.mid; 
        if (prim_res.macp) db_res.macp = prim_res.macp;
        if (prim_res.gn) db_res.gn = prim_res.gn;

        // delete optional attributes if they are null in the request
        // universal/common attributes
        if (prim_res.acpi === null) db_res.acpi = null;
        if (prim_res.lbl === null) db_res.lbl = null;
        if (prim_res.loc === null) db_res.loc = null;

        // resource specific attributes
        if (prim_res.macp === null) db_res.macp = null;
        if (prim_res.gn === null) db_res.gn = null;

        // members number validation
        // validations for group creation
        if (prim_res.mid) {
            db_res.mid = remove_duplicate_memberIDs(prim_res.mid);
        }
        if (false === await member_count_validation(db_res.mnm, db_res.mid, resp_prim)) {
            return;
        } else {
            db_res.cnm = db_res.mid.length;
        }

        // member type validation
        if (prim_res.mid && prim_res.mt !== 0) {
            // provide validation info from the existing resource attributes
            req_prim.pc['m2m:grp'].mt = db_res.mt;
            req_prim.pc['m2m:grp'].csy = db_res.csy;

            const validity = await memberType_validation(req_prim, resp_prim);
            if (false === validity) {
                return;
            } else {
                db_res.mtv = true;
                db_res.mt = req_prim.pc['m2m:grp'].mt;
                if (req_prim.pc['m2m:grp'].mid) {
                    db_res.mid = req_prim.pc['m2m:grp'].mid;
                }
            }
        }

        await db_res.save();

        const tmp_req = { ri }, tmp_resp = {};
        await retrieve_a_grp(tmp_req, tmp_resp);
        
        resp_prim.pc = tmp_resp.pc;
    } catch (err) {
        logger.error({ err }, 'update_a_grp failed');
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': err.message };
    }

    return;
}

async function member_count_validation(maxNumber, memberIDs, resp_prim) {
    // check if the number of memberIDs exceeds the maximum number of members (mnm)
    if (memberIDs.length > maxNumber) {
        resp_prim.rsc = enums.rsc_str['MAX_NUMBER_OF_MEMBER_EXCEEDED'];
        resp_prim.pc = { 'm2m:dbg': 'number of memberIDs exceeds the maximum number of members (mnm)' };
        return false;
    }
    return true;
}

function remove_duplicate_memberIDs(memberIDs) {
    return memberIDs.filter((value, index, self) =>
        self.indexOf(value) === index
    );
}

// member type validation is called during creation and update of 'mid' attribute of <grp> resource
async function memberType_validation(req_prim, resp_prim) {
    // arguments: consistencyStrategy, memberType, memberIDs
    const prim_res = req_prim.pc['m2m:grp'];
    const consistencyStrategy = prim_res.csy;
    let memberType = prim_res.mt;
    const memberIDs = prim_res.mid;

    // get all resource types of the members
    // note that this works for local members only
    const member_types = await Promise.all(memberIDs.map(async (mid) => {
        const { get_unstructuredID, get_ty_from_unstructuredID } = require('../hostingCSE');
        const ri = await get_unstructuredID(mid);
        const ty = await get_ty_from_unstructuredID(ri);
        return { mid, ty };
    }));

    // check the member types from 'member_types' against 'memberType'
    // if all members are of the same type, return that type, otherwise, return 'MIXED'
    if (memberType && memberType !== 0) {
        const checked_ty = member_types.every(({ ty }) => ty === memberType) ? memberType : 'MIXED';
    
        logger.debug({ checked_ty }, 'memberType_validation result');
        if (memberType === checked_ty)
            return true;
        else
        // apply the consistency strategy (1: ABANDON_MEMBER, 2: ABANDON_GROUP, 3: SET_MIXED)
        {
            if (consistencyStrategy === 1) {
                // remove the members in member_types that do not conform to the memberType, and get the 'mid' list of the remaining members
                const remaining_members = member_types.filter(({ ty }) => ty === memberType).map(({ mid }) => mid);
                req_prim.pc['m2m:grp'].mid = remaining_members;
                
                return true;
            }
            if (consistencyStrategy === 2) {
                resp_prim.rsc = enums.rsc_str['GROUP_MEMBER_TYPE_INCONSISTENT'];
                resp_prim.pc = { 'm2m:dbg': 'member types are inconsistent with mt value provided' };
                
                return false;
            }
            if (consistencyStrategy === 3) {
                req_prim.pc['m2m:grp'].mt = 0; // 0: 'MIXED'
                
                return true; 
            }
            return false;
        }
    }
}

exports.fanout = async function (req_prim, resp_prim) {
    resp_prim.pc = { 'm2m:agr': { 'rsp': {} } };

    // send fanout requests concurrently and sum-up 
    const fanout_resp_prims = await aggregate_fanout_resp_prims(req_prim);

    resp_prim.pc['m2m:agr']['rsp'] = fanout_resp_prims;

    return;
}

async function aggregate_fanout_resp_prims(req_prim) {
    // 'to_parent' is given in check_vir_res() before
    const { get_unstructuredID } = require('../hostingCSE');
    const ri = await get_unstructuredID(req_prim.to_parent);
    const grp_res = await GRP.findByPk(ri, { attributes: ['mid'] });
    
    if (!grp_res || !grp_res.mid || grp_res.mid.length === 0) {
        return [];
    }
    
    const mid_list = grp_res.mid;

    return await Promise.all(mid_list.map(async (mid) => {
        // assume that all members are local resources
        // to-do: implement for remote member resources
        const fanout_req_prim = {
            fr: req_prim.fr,
            to: (req_prim.vr_path) ? mid + '/' + req_prim.vr_path : mid,
            fc: req_prim.fc,
            op: req_prim.op,
            rqi: req_prim.rqi,
            ty: req_prim.ty,
            pc: req_prim.pc
        };
        // console.log('fanout req_prim: ', JSON.stringify(fanout_req_prim, null, 2));
        const { prim_handling } = require('../reqPrim');
        const fanout_resp_prim = await prim_handling(fanout_req_prim);

        fanout_resp_prim.fr = mid;

        return fanout_resp_prim;
    }));
}

module.exports.create_a_grp = create_a_grp;
module.exports.retrieve_a_grp = retrieve_a_grp;
module.exports.update_a_grp = update_a_grp;