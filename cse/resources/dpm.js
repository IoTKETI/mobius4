const enums = require("../../config/enums");
const { generate_ri, get_cur_time, get_default_et } = require('../utils');

const Lookup = require('../../models/lookup-model');
const MDP = require('../../models/mdp-model');
const DPM = require('../../models/dpm-model');

const mmd_parent_res_types = ["mdp"];

async function create_a_dpm(req_prim, resp_prim) {
  const prim_res = req_prim.pc["m2m:dpm"];

  const dpm_pi = req_prim.ri;
  const dpm_sid = req_prim.sid + '/' + prim_res.rn;

  // parent resource type check
  const parent_ty = req_prim.to_ty;
  if (mmd_parent_res_types.includes(enums.ty_str[parent_ty.toString()]) === false) {
    resp_prim.rsc = enums.rsc_str["INVALID_CHILD_RESOURCE_TYPE"];
    resp_prim.pc = { "m2m:dbg": "parent of <dpm> shall be <mdp>" };
    return;
  }

  const ri = generate_ri();
  const now = get_cur_time();
  const et = get_default_et();

  try {
    const mdp_res = await MDP.findByPk(dpm_pi);

    // create DPM resource
    const db_res = await DPM.create({
      ri,
      ty: 104,
      rn: prim_res.rn,
      pi: dpm_pi,
      sid: dpm_sid,
      et: prim_res.et || et,
      ct: now,
      lt: now,
      cr: prim_res.cr === null ? req_prim.fr : null,
      acpi: prim_res.acpi || null,
      lbl: prim_res.lbl || null,
      moid: prim_res.moid || null,
      mcmd: prim_res.mcmd || 0, // 0: stop, 1: run
      mds: prim_res.mds || 0, // 0: deployed, 1: running, 2: stopped
      inr: prim_res.inr || null,
      our: prim_res.our || null,
    });

    // update meta info of its parent (last three arguments order: ndm, nrm, nsm)
    await update_parent_mdp({
      mdp_res,
      dpm_id: db_res.ri,
      ndm_delta: 1,
      nrm_delta: 0,
      nsm_delta: 0
    });

    await Lookup.create({
      ri,
      ty: 104,
      rn: prim_res.rn,
      sid: dpm_sid,
      lvl: dpm_sid.split("/").length,
      pi: dpm_pi,
      cr: prim_res.cr === null ? req_prim.fr : null,
      int_cr: req_prim.fr,
      et: prim_res.et || et
  });

    const tmp_req = { ri }, tmp_resp = {};
    await retrieve_a_dpm(tmp_req, tmp_resp);

    resp_prim.pc = tmp_resp.pc;
  } catch (err) {
    console.log(err);
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": err.message };
  }

  return;
}

async function update_parent_mdp({
  mdp_res,
  dpm_id,
  ndm_delta,
  nrm_delta,
  nsm_delta
}) {
  let { ri: mdp_ri, ndm, nrm, nsm, dpm_list } = mdp_res;

  // add this dpm_id into the dpm_list of the parent
  if (dpm_id) dpm_list.push(dpm_id);

  ndm += ndm_delta;
  nrm += nrm_delta;
  nsm += nsm_delta;

  // finally update the above parent attributes
  await MDP.update({
    dpm_list,
    ndm,
    nrm,
    nsm,
  }, {
    where: { ri: mdp_ri }
  });

  return;
}

async function retrieve_a_dpm(req_prim, resp_prim) {
  const dpm_obj = { "m2m:dpm": {} };
  const ri = req_prim.ri;

  try {
    const db_res = await DPM.findByPk(ri);

    if (!db_res) {
      resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
      resp_prim.pc = { 'm2m:dbg': 'DPM resource not found' };
      return;
    }

    // copy attributes that shall be stored in the db
    dpm_obj["m2m:dpm"].ty = db_res.ty;
    dpm_obj["m2m:dpm"].et = db_res.et;
    dpm_obj["m2m:dpm"].ct = db_res.ct;
    dpm_obj["m2m:dpm"].lt = db_res.lt;
    dpm_obj["m2m:dpm"].ri = db_res.ri;
    dpm_obj["m2m:dpm"].rn = db_res.rn;
    dpm_obj["m2m:dpm"].pi = db_res.pi;

    // copy optional attribute after checking
    if (db_res.acpi) dpm_obj["m2m:dpm"].acpi = db_res.acpi;
    if (db_res.lbl) dpm_obj["m2m:dpm"].lbl = db_res.lbl;
    if (db_res.cr) dpm_obj["m2m:dpm"].cr = db_res.cr;

    // below are resource specific attributes
    // mcmd (modelCommand) is not returned
    if (db_res.mds !== null) dpm_obj["m2m:dpm"].mds = db_res.mds; // mds is integer type
    if (db_res.moid) dpm_obj["m2m:dpm"].moid = db_res.moid;
    if (db_res.inr) dpm_obj["m2m:dpm"].inr = db_res.inr;
    if (db_res.our) dpm_obj["m2m:dpm"].our = db_res.our;
    
    resp_prim.pc = dpm_obj;
  } catch (err) {
    resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
    resp_prim.pc = { 'm2m:dbg': 'DPM resource not found' };
    throw err;
  }

  return;
}

async function update_a_dpm(req_prim, resp_prim) {
  const prim_res = req_prim.pc["m2m:dpm"];
  const ri = req_prim.ri;

  try {
    if (prim_res.moid || prim_res.mds)
      throw Error("moid and mds are immutable");

    const db_res = await DPM.findByPk(ri);
    if (!db_res) {
      resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
      resp_prim.pc = { 'm2m:dbg': 'DPM resource not found' };
      return;
    }

    const mdp_res = await MDP.findByPk(db_res.pi);

    db_res.lt = get_cur_time();

    if (prim_res.acpi) db_res.acpi = prim_res.acpi;
    if (prim_res.lbl) db_res.lbl = prim_res.lbl;

    // below are resource specific attributes
    if (prim_res.mcmd !== undefined) {
      // deployed status + run command -> running status
      if (db_res.mds === 0 && prim_res.mcmd === 1) { 
        await update_parent_mdp({
          mdp_res,
          dpm_id: null,
          ndm_delta: -1,
          nrm_delta: 1,
          nsm_delta: 0
        });
        db_res.mds = 1; // running
      }
      // running status + stop command -> stopped status
      if (db_res.mds === 1 && prim_res.mcmd === 0) { 
        await update_parent_mdp({
          mdp_res,
          dpm_id: null,
          ndm_delta: 0,
          nrm_delta: -1,
          nsm_delta: 1
        });
        db_res.mds = 2; // stopped
      }
      // stopped status + run command -> running status
      if (db_res.mds === 2 && prim_res.mcmd === 1) { 
        await update_parent_mdp({
          mdp_res,
          dpm_id: null,
          ndm_delta: 0,
          nrm_delta: 1,
          nsm_delta: -1
        });
        db_res.mds = 1; // running
      }
      db_res.mcmd = prim_res.mcmd;
    }

    if (prim_res.inr) db_res.inr = prim_res.inr;
    if (prim_res.our) db_res.our = prim_res.our;

    // delete optional attributes if they are null in the request
    if (prim_res.acpi === null) db_res.acpi = null;
    if (prim_res.lbl === null) db_res.lbl = null;

    await db_res.save();

    const temp_req = { ri }, temp_resp = {};
    await retrieve_a_dpm(temp_req, temp_resp);

    resp_prim.pc = temp_resp.pc;
  } catch (err) {
    console.error(err);
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": err.message };
  }

  return;
}

module.exports = {
  create_a_dpm,
  retrieve_a_dpm,
  update_a_dpm
};