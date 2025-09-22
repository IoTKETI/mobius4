const config = require('config');
const { cin_create_schema } = require('../validation/res_schema');
const enums = require('../../config/enums');

const { generate_ri, get_cur_time, get_default_et, convert_loc_to_geoJson, get_loc_attribute } = require('../utils');

const Lookup = require('../../models/lookup-model');
const CNT = require('../../models/cnt-model');
const CIN = require('../../models/cin-model');

const cin_parent_res_types = ['cnt'];

async function create_a_cin(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:cin'];

    // validation for primitive resource attribute
    const validated = cin_create_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    const cin_pi = req_prim.ri;
    const cin_sid = req_prim.sid + '/' + prim_res.rn;

    // parent resource type check
    const parent_ty = req_prim.to_ty;
    if (cin_parent_res_types.includes(enums.ty_str[parent_ty.toString()]) === false) {
        resp_prim.rsc = enums.rsc_str['INVALID_CHILD_RESOURCE_TYPE'];
        resp_prim.pc = { 'm2m:dbg': 'parent of <cin> resource shall be <cnt> resource' };
        return;
    }

    // get parent container info
    const cnt_res = await CNT.findByPk(cin_pi);
    if (!cnt_res) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': 'parent <cnt> resource not found' };
        return;
    }
    // getting 'st' of the parent container to be used for 'st' of the new <cin>
    const parent_st = cnt_res.st;

    // content size 계산
    const { get_mem_size } = require('../hostingCSE');
    const content_size = get_mem_size(prim_res.con);
    // to-do: the above is not equal to the size of the DB (this topic is being discussed in oneM2M)

    // when mbs < cs, it is not acceptable
    if (content_size > cnt_res.mbs) {
        resp_prim.rsc = enums.rsc_str['NOT_ACCEPTABLE'];
        resp_prim.pc = { 'm2m:dbg': 'content size of a new <cin> is bigger than mbs of the parent container' };
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

    // create cin resource
    const cin_res = {
        ri,
        ty: 4,
        rn: prim_res.rn,
        pi: cin_pi,
        sid: cin_sid,
        et: prim_res.et || et,
        ct: now,
        lt: now,
        // common attributes
        cr: prim_res.cr === null ? req_prim.fr : null,
        acpi: prim_res.acpi || null,
        lbl: prim_res.lbl || null,
        loc: prim_res.loc,
        st: parent_st + 1, // check if this is correct logic, to-do
        // resource specific attributes
        cs: content_size,
        con: prim_res.con, // mandatory
        cnf: prim_res.cnf || null,
    };

    // set optional attributes
    if (prim_res.cr === null) cin_res.cr = req_prim.fr;
    if (prim_res.acpi) cin_res.acpi = prim_res.acpi;
    if (prim_res.lbl) cin_res.lbl = prim_res.lbl;
    if (prim_res.cnf) cin_res.cnf = prim_res.cnf;

    try {
        await CIN.create(cin_res);

        // update parent container meta info and get stateTag
        const this_st = await update_parent_container(cnt_res, ri, content_size);

        // create lookup record
        // await CSE.create_a_lookup_record(db_res.ty, db_res.rn, db_res.sid, db_res.ri, db_res.pi, db_res.cr || null, req_prim.fr, null);
        await Lookup.create({
            ri,
            ty: 4,
            rn: prim_res.rn,
            sid: cin_sid,
            lvl: cin_sid.split("/").length,
            pi: cin_pi,
            cr: prim_res.cr === null ? req_prim.fr : null,
            int_cr: req_prim.fr,
            et: prim_res.et || et,
            loc: prim_res.loc
        });

        // retrieve the created resource and respond
        const tmp_req = { ri };
        await retrieve_a_cin(tmp_req, resp_prim);
    } catch (err) {
        console.log(err);
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': err.message };
    }
    return;
}

async function update_parent_container(cnt_res, cin_ri, content_size) {
    const { delete_a_res } = require('../hostingCSE');

    let cni = cnt_res.cni;
    let cbs = cnt_res.cbs;
    let mni = cnt_res.mni;
    let mbs = cnt_res.mbs;
    let st = cnt_res.st + 1;
    let cin_list = (cnt_res.cin_list) ? cnt_res.cin_list : [];

    // add this cin_ri into the cin_list of the parent container
    cin_list.push(cin_ri);
    cni++;

    // mni handling
    if (cni > mni) {
        const deleted_ri = cin_list.shift();

        // delete the corresponding cin 
        const tmp_resp = {};

        await delete_a_res({ fr: config.cse.admin, to: deleted_ri, ri: deleted_ri, rqi: 'delete_a_cin', to_ty: 4, int_cr_req: true }, tmp_resp);
        if (tmp_resp.pc && tmp_resp.pc['m2m:cin'] && tmp_resp.pc['m2m:cin'].cs) {
            cbs = cbs - tmp_resp.pc['m2m:cin'].cs;
        }
        cni--;
    }

    // mbc handling
    cbs += content_size;
    while (cbs > mbs) {
        const deleted_ri = cin_list.shift();
        const tmp_resp = {};
        await delete_a_res({ fr: config.cse.admin, to: deleted_ri, ri: deleted_ri, rqi: 'delete_a_cin', to_ty: 4, int_cr_req: true }, tmp_resp);
        if (tmp_resp.pc && tmp_resp.pc['m2m:cin'] && tmp_resp.pc['m2m:cin'].cs) {
            cbs = cbs - tmp_resp.pc['m2m:cin'].cs;
        }
        cni--;
    }

    // parent container resource update
    await CNT.update({ cni, cbs, st, cin_list }, { where: { ri: cnt_res.ri } });

    return st;
}

async function retrieve_a_cin(req_prim, resp_prim) {
    const cin_obj = { 'm2m:cin': {} };
    const ri = req_prim.ri;

    try {
        const db_res = await CIN.findByPk(ri);
        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': '<cin> resource not found' };
            return;
        }

        // provide int_cr if required by internal API call
        if (req_prim && req_prim.int_cr_req === true)
            cin_obj['m2m:cin'].int_cr = db_res.int_cr;

        // copy mandatory attributes
        cin_obj['m2m:cin'].ty = db_res.ty;
        cin_obj['m2m:cin'].et = db_res.et;
        cin_obj['m2m:cin'].ct = db_res.ct;
        cin_obj['m2m:cin'].lt = db_res.lt;
        cin_obj['m2m:cin'].ri = db_res.ri;
        cin_obj['m2m:cin'].rn = db_res.rn;
        cin_obj['m2m:cin'].pi = db_res.pi;
        cin_obj['m2m:cin'].st = db_res.st;

        // optional attributes
        if (db_res.acpi && db_res.acpi.length) cin_obj['m2m:cin'].acpi = db_res.acpi;
        if (db_res.lbl && db_res.lbl.length) cin_obj['m2m:cin'].lbl = db_res.lbl;
        if (db_res.cr) cin_obj['m2m:cin'].cr = db_res.cr;
        if (db_res.cnf) cin_obj['m2m:cin'].cnf = db_res.cnf;
        if (db_res.cs !== undefined) cin_obj['m2m:cin'].cs = db_res.cs;
        if (db_res.con !== undefined) cin_obj['m2m:cin'].con = db_res.con;
        if (db_res.loc) cin_obj['m2m:cin'].loc = get_loc_attribute(db_res.loc);
    } catch (err) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': '<cin> resource not found' };
        throw err;
    }

    resp_prim.pc = cin_obj;
    return;
}

module.exports.create_a_cin = create_a_cin;
module.exports.retrieve_a_cin = retrieve_a_cin;