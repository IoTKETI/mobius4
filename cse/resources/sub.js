const { sub_create_schema, sub_update_schema } = require('../validation/res_schema');

const { generate_ri, get_cur_time, get_default_et } = require('../utils');

const enums = require("../../config/enums");

const SUB = require('../../models/sub-model');
const Lookup = require('../../models/lookup-model');  

const sub_parent_res_types = ["ae", "acp", "cb", "cnt", "csr", "grp", "flx", "mrp", "mmd", "mdp", "dpm"];


async function create_a_sub(req_prim, resp_prim) {
  const prim_res = req_prim.pc["m2m:sub"];

  const sub_pi = req_prim.ri;
  const sub_sid = req_prim.sid + '/' + prim_res.rn;

  // parent resource type check
  const parent_ty = req_prim.to_ty;
  if (sub_parent_res_types.includes(enums.ty_str[parent_ty.toString()]) === false) {
    resp_prim.rsc = enums.rsc_str["TARGET_NOT_SUBSCRIBABLE"];
    resp_prim.pc = { "m2m:dbg": "cannot subscribe to this parent resource type" };
    return resp_prim;
  }

  // validation for primitive resource attribute
  const validated = sub_create_schema.validate(prim_res);
  if (validated.error) {
    const { message, path } = validated.error.details[0];
    resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
    resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
    return;
  }

  if (prim_res.nu.length === 0) {
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": "nu cannot be empty" };
    return resp_prim;
  }

  const ri = generate_ri();
  const now = get_cur_time();
  const et = get_default_et();

  try {
    await SUB.create({
      // mandatory attributes
      ri,
      ty: 23,
      sid: sub_sid,
      int_cr: req_prim.fr,
      rn: prim_res.rn,
      pi: sub_pi,
      et: prim_res.et || et,
      ct: now,
      lt: now,
      // optional attributes
      acpi: prim_res.acpi || null,
      lbl: prim_res.lbl || null,
      enc: prim_res.enc || null, 
      exc: prim_res.exc,
      nu: prim_res.nu,
      nct: prim_res.nct || 1,
      cr: prim_res.cr === null ? req_prim.fr : null,
      su: prim_res.su || null,
    });

    // add lookup record
    await Lookup.create({
      ri,
      ty: 23,
      rn: prim_res.rn,
      sid: sub_sid,
      lvl: sub_sid.split("/").length,
      pi: sub_pi,
      cr: prim_res.cr === null ? req_prim.fr : null,
      int_cr: req_prim.fr,
      loc: null
    });

    // retrieve the created resource and respond
    const tmp_req = {ri}, tmp_resp = {};
    await retrieve_a_sub(tmp_req, tmp_resp);
    resp_prim.pc = tmp_resp.pc;
  } catch (err) {
    console.error(err);
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": err.message };
  }
  return;
}

async function retrieve_a_sub(req_prim, resp_prim) {
  const sub_obj = { "m2m:sub": {} };
  let db_res = {};
  const ri = req_prim.ri;

  try {
    db_res = await SUB.findByPk(ri);

    if (!db_res) {
      resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
      resp_prim.pc = { 'm2m:dbg': 'SUB resource not found' };
      return;
    }

    // int_cr is returned only when it is requested by internal API call (e.g. access decision)
    if (req_prim && req_prim.int_cr_req === true)
      sub_obj["m2m:sub"].int_cr = db_res.int_cr;

    // mandatory attributes
    sub_obj["m2m:sub"].ty = db_res.ty;
    sub_obj["m2m:sub"].et = db_res.et;
    sub_obj["m2m:sub"].ct = db_res.ct;
    sub_obj["m2m:sub"].lt = db_res.lt;
    sub_obj["m2m:sub"].ri = db_res.ri;
    sub_obj["m2m:sub"].rn = db_res.rn;
    sub_obj["m2m:sub"].pi = db_res.pi;

    // optional attributes
    if (db_res.cr) sub_obj["m2m:sub"].cr = db_res.cr;
    if (db_res.acpi && db_res.acpi.length) sub_obj["m2m:sub"].acpi = db_res.acpi;
    if (db_res.lbl && db_res.lbl.length) sub_obj["m2m:sub"].lbl = db_res.lbl;
    if (db_res.enc) sub_obj["m2m:sub"].enc = db_res.enc;
    if (db_res.exc != null) sub_obj["m2m:sub"].exc = db_res.exc;
    if (db_res.nu && db_res.nu.length) sub_obj["m2m:sub"].nu = db_res.nu;
    if (db_res.nct != null) sub_obj["m2m:sub"].nct = db_res.nct;
    if (db_res.su != null) sub_obj["m2m:sub"].su = db_res.su;

  } catch (err) {
    resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
    resp_prim.pc = { 'm2m:dbg': 'SUB resource not found' };
    throw err; 
  }

  resp_prim.pc = sub_obj;
  return;
}

async function update_a_sub(req_prim, resp_prim) {
  let db_res = {};
  const prim_res = req_prim.pc["m2m:sub"];
  const ri = req_prim.ri;

  // validation for primitive resource attribute
  const validated = sub_update_schema.validate(prim_res);
  if (validated.error) {
    const { message, path } = validated.error.details[0];
    resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
    resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
    return;
  }

  try {
    db_res = await SUB.findByPk(ri);

    db_res.lt = get_cur_time();

    // mandatory RW attributes cannot be deleted
    if (prim_res.nu === null) {
      resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
      resp_prim.pc = { 'm2m:dbg': 'nu cannot be deleted' };
      return;
    }
    
    if (prim_res.et) db_res.et = prim_res.et;
    
    if (prim_res.acpi != null && prim_res.acpi != undefined) {
      db_res.acpi = prim_res.acpi;
    }
    if (prim_res.lbl != null && prim_res.lbl != undefined) {
      db_res.lbl = prim_res.lbl;
    }
    // below are resource type specific attributes
    if (prim_res.enc != null && prim_res.enc != undefined) db_res.enc = prim_res.enc;
    if (prim_res.nu != null && prim_res.nu != undefined) db_res.nu = prim_res.nu;
    if (prim_res.nct != null && prim_res.nct != undefined) db_res.nct = prim_res.nct;

    // delete optional attributes if they are null in the request
    // universal/common attributes
    if (prim_res.acpi === null) db_res.acpi = null;
    if (prim_res.lbl === null) db_res.lbl = null;

    // resource specific attributes
    if (prim_res.enc === null) db_res.enc = null; 
    if (prim_res.exc === null) db_res.exc = null;
    if (prim_res.su === null) db_res.su = null;

    await db_res.save();

    const tmp_req = {ri}, tmp_resp = {};
    await retrieve_a_sub(tmp_req, tmp_resp);

    resp_prim.pc = tmp_resp.pc;
  } catch (err) {
    console.error(err);
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": err.message };
  }

  return resp_prim;
}

module.exports.create_a_sub = create_a_sub;
module.exports.retrieve_a_sub = retrieve_a_sub;
module.exports.update_a_sub = update_a_sub;