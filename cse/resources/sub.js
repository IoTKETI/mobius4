const { sub_create_schema, sub_update_schema } = require('../validation/res_schema');
const { unimplemented_net } = require('../notification-event-types');

const { generate_ri, get_cur_time, get_default_et } = require('../utils');
const sequelize = require('../../db/sequelize');

const enums = require("../../config/enums");
const { classify_create_error } = require("../create-error");

const SUB = require('../../models/sub-model');
const Lookup = require('../../models/lookup-model');

const logger = require('../../logger').forFile(__filename);

// BACKLOG-094: TR-0071's per-type child-resource tables list <subscription> at multiplicity
// 0..n for every AI/ML resource type except <datasetFragment> ("dsf", ty 107) -- confirmed by
// reading TR-0071:7.1.2.1 (mrp), 7.1.2.2 (mmd), 7.1.2.3 (mdp), 7.1.2.4 (dpm), 7.2.2.1 (dsp) and
// 7.2.2.2 (dts). "dsp" and "dts" were missing here even though mrp/mmd/mdp/dpm were already
// present, which blocked subscribing to a <dataset> for its live-collection notifications
// (TR-0071:7.2.2.1: "Newly created inference input data can be retrieved or notified with
// subscription..."). <datasetFragment> (7.2.2.3) has no child-resource table at all -- no
// <subscription> child is defined for it, consistent with it being immutable -- so "dsf" is
// deliberately left out, not an oversight.
const sub_parent_res_types = ["ae", "acp", "cb", "cnt", "csr", "grp", "flx", "ts", "mrp", "mmd", "mdp", "dpm", "dsp", "dts"];


// TS-0004:7.4.8.2.1 (Recv-6.5, step 2): "If the notificationURI is not the Originator, the Hosting
// CSE shall set the Originator's ID as the <subscription> resource's creator attribute."
//
// Only the explicit form was implemented — a request carrying "cr": null got the Originator, and
// a request that simply omitted cr got nothing. So the attribute was present exactly when a
// client already knew to ask for it, and absent in the ordinary case the clause is about. A
// notification consumer then had no standard way to tell whose subscription it was answering.
//
// "notificationURI is not the Originator" is read literally: if every nu entry names the
// Originator itself, the clause does not apply and cr stays unset. Anything else — a URL, another
// entity's ID, a mix — sets it.
// Returns the value to store in cr, or throws a 4000 when the request tries to name someone else.
//
// creator is defined as "The AE-ID or CSE-ID of the entity which created the resource"
// (TS-0001:9.6.1.3.2) — it is a statement about who acted, not a field a requester fills in with
// a value of its choosing. Storing a supplied value verbatim would be a privilege escalation
// here, not just an inaccuracy: on a resource that defines accessControlPolicyIDs but has none
// set, the creator is the identity that gets full control (TS-0001:9.6.1.3.2 default access
// policy). A client could hand that control to a third party by writing its ID into cr.
//
// So: an empty value means "fill it in for me", the Originator's own ID is accepted as the
// no-op it is, and anything else is refused.
function creator_for(prim_res, originator) {
  if (prim_res.cr !== undefined && prim_res.cr !== null) {
    if (prim_res.cr !== originator) {
      const err = new Error("'cr' cannot be set to another entity's identity");
      err.rsc_hint = 'BAD_REQUEST';
      throw err;
    }
    return originator;
  }
  if (prim_res.cr === null) return originator;

  // TS-0004:7.4.8.2.1 (Recv-6.5, step 2): "If the notificationURI is not the Originator, the
  // Hosting CSE shall set the Originator's ID as the <subscription> resource's creator
  // attribute." Read literally — when every nu names the Originator itself the clause does not
  // apply, and cr stays unset rather than being invented.
  const targets = Array.isArray(prim_res.nu) ? prim_res.nu : [prim_res.nu];
  return targets.every((t) => t === originator) ? null : originator;
}

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

  // A net value oneM2M defines but this CSE does not act on. The schema above already refused
  // anything outside the enumeration as BAD_REQUEST; this is the other half -- a valid request for
  // a capability that is absent, which is NOT_IMPLEMENTED. Left unchecked the <subscription> was
  // created, answered 2001, and then never fired.
  const unimpl_net = unimplemented_net(prim_res.enc);
  if (unimpl_net.length > 0) {
    resp_prim.rsc = enums.rsc_str['NOT_IMPLEMENTED'];
    resp_prim.pc = { 'm2m:dbg': 'notificationEventType ' + unimpl_net.join(', ') + ' is not implemented' };
    return resp_prim;
  }

  if (prim_res.nu.length === 0) {
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": "nu cannot be empty" };
    return resp_prim;
  }

  // check if the Originator has RETRIEVE privilege for the parent resource
  const temp_req = {ri: req_prim.ri, op: 2, fr: req_prim.fr, to_ty: parent_ty};
  const temp_resp = {};
  
  const {access_decision} = require('../hostingCSE');
  const access_grant = await access_decision(temp_req, temp_resp);
  if (false === access_grant) {
    resp_prim.rsc = enums.rsc_str['ORIGINATOR_HAS_NO_PRIVILEGE'];
    resp_prim.pc = { 'm2m:dbg': 'Originator has no retrieve privilege for the parent resource' };
    return resp_prim;
  }

  // Resolved before the transaction so a refused cr comes back as 4000 rather than reaching
  // prim_handling's catch, which would report it as 5000.
  let creator;
  try {
    creator = creator_for(prim_res, req_prim.fr);
  } catch (err) {
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": err.message };
    return resp_prim;
  }

  const ri = generate_ri();
  const now = get_cur_time();
  const et = get_default_et();

  try {
    await sequelize.transaction(async (t) => {
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
        cr: creator,
        su: prim_res.su || null,
      }, { transaction: t });

      await Lookup.create({
        ri,
        ty: 23,
        rn: prim_res.rn,
        sid: sub_sid,
        lvl: sub_sid.split("/").length,
        pi: sub_pi,
        cr: creator,
        int_cr: req_prim.fr,
        loc: null
      }, { transaction: t });
    });

    // retrieve the created resource and respond
    const tmp_req = {ri}, tmp_resp = {};
    await retrieve_a_sub(tmp_req, tmp_resp);
    resp_prim.pc = tmp_resp.pc;
  } catch (err) {
    logger.error({ err }, 'create_a_sub failed');
    // A name lost to a concurrent create is a conflict, not a bad request.
    const { rsc, dbg } = classify_create_error(err);
    resp_prim.rsc = rsc;
    resp_prim.pc = { "m2m:dbg": dbg };
  } finally {
    req_prim._pendingCreate?.resolve();
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

  // A net value oneM2M defines but this CSE does not act on. The schema above already refused
  // anything outside the enumeration as BAD_REQUEST; this is the other half -- a valid request for
  // a capability that is absent, which is NOT_IMPLEMENTED. Left unchecked the <subscription> was
  // created, answered 2001, and then never fired.
  const unimpl_net = unimplemented_net(prim_res.enc);
  if (unimpl_net.length > 0) {
    resp_prim.rsc = enums.rsc_str['NOT_IMPLEMENTED'];
    resp_prim.pc = { 'm2m:dbg': 'notificationEventType ' + unimpl_net.join(', ') + ' is not implemented' };
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
    logger.error({ err }, 'update_a_sub failed');
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": err.message };
  }

  return resp_prim;
}

module.exports.create_a_sub = create_a_sub;
module.exports.retrieve_a_sub = retrieve_a_sub;
module.exports.update_a_sub = update_a_sub;