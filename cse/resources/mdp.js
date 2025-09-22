const { generate_ri, get_cur_time, get_default_et } = require('../utils');

const Lookup = require('../../models/lookup-model');
const MDP = require('../../models/mdp-model');
const enums = require("../../config/enums");
const dpm = require("./dpm");

const mdp_parent_res_types = ["cb", "ae", "csr"];

async function create_an_mdp(req_prim, resp_prim) {
  const prim_res = req_prim.pc["m2m:mdp"];

  const mdp_pi = req_prim.ri;
  const mdp_sid = req_prim.sid + '/' + prim_res.rn;

  const ri = generate_ri();
  const now = get_cur_time();
  const et = get_default_et();

  // parent resource type check
  const parent_ty = req_prim.to_ty;
  if (mdp_parent_res_types.includes(enums.ty_str[parent_ty.toString()]) === false) {
    resp_prim.rsc = enums.rsc_str["INVALID_CHILD_RESOURCE_TYPE"];
    resp_prim.pc = { "m2m:dbg": "cannot create <mdp> to this parent resource type" };
    return;
  }

  try {
    // create MDP resource
    await MDP.create({
      ri,
      ty: 103,
      rn: prim_res.rn,
      pi: mdp_pi,
      sid: mdp_sid,
      int_cr: req_prim.fr,
      et: prim_res.et || et,
      ct: now,
      lt: now,
      cr: prim_res.cr === null ? req_prim.fr : null,
      acpi: prim_res.acpi || null,
      lbl: prim_res.lbl || null,
      // resource specific attributes
      ndm: 0, // number of deployed models
      nrm: 0, // number of running models
      nsm: 0 // number of stopped models
    });

    await Lookup.create({
      ri,
      ty: 103,
      rn: prim_res.rn,
      sid: mdp_sid,
      lvl: mdp_sid.split("/").length,
      pi: mdp_pi,
      cr: prim_res.cr === '' ? req_prim.fr : prim_res.cr,
      int_cr: req_prim.fr,
      et: prim_res.et || et
    });

    const tmp_req = { ri }, tmp_resp = {};
    await retrieve_an_mdp(tmp_req, tmp_resp);

    resp_prim.pc = tmp_resp.pc;
  } catch (err) {
    console.log(err);
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": err.message };
  }

  return;
}

async function retrieve_an_mdp(req_prim, resp_prim) {
  const mdp_obj = { "m2m:mdp": {} };
  const ri = req_prim.ri;

  try {
    const db_res = await MDP.findByPk(ri);

    if (!db_res) {
      resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
      resp_prim.pc = { 'm2m:dbg': 'MDP resource not found' };
      return;
    }

    // provide int_cr if required by internal API call
    if (req_prim && req_prim.int_cr_req === true)
      mdp_obj["m2m:mdp"].int_cr = db_res.int_cr;

    // copy attributes that shall be stored in the db
    mdp_obj["m2m:mdp"].ty = db_res.ty;
    mdp_obj["m2m:mdp"].et = db_res.et;
    mdp_obj["m2m:mdp"].ct = db_res.ct;
    mdp_obj["m2m:mdp"].lt = db_res.lt;
    mdp_obj["m2m:mdp"].ri = db_res.ri;
    mdp_obj["m2m:mdp"].rn = db_res.rn;
    mdp_obj["m2m:mdp"].pi = db_res.pi;

    // resource specific mandatory attributes
    mdp_obj["m2m:mdp"].ndm = db_res.ndm;
    mdp_obj["m2m:mdp"].nrm = db_res.nrm;
    mdp_obj["m2m:mdp"].nsm = db_res.nsm;

    // copy optional attribute after checking
    if (db_res.acpi) mdp_obj["m2m:mdp"].acpi = db_res.acpi;
    if (db_res.lbl) mdp_obj["m2m:mdp"].lbl = db_res.lbl;
    if (db_res.cr) mdp_obj["m2m:mdp"].cr = db_res.cr;
    
    resp_prim.pc = mdp_obj;
  } catch (err) {
    resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
    resp_prim.pc = { 'm2m:dbg': 'MDP resource not found' };
    throw err;
  }

  return;
}

async function update_an_mdp(req_prim, resp_prim) {
  const prim_res = req_prim.pc["m2m:mdp"];
  const ri = req_prim.ri;
  
  try {
    const db_res = await MDP.findByPk(ri);

    if (!db_res) {
      resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
      resp_prim.pc = { 'm2m:dbg': 'MDP resource not found' };
      return;
    }

    db_res.lt = get_cur_time();

    if (prim_res.acpi) db_res.acpi = prim_res.acpi;
    if (prim_res.lbl) db_res.lbl = prim_res.lbl;

    // delete optional attributes if they are null in the request
    if (prim_res.acpi === null) db_res.acpi = null;
    if (prim_res.lbl === null) db_res.lbl = null;

    await db_res.save();

    const temp_req = { ri }, temp_resp = {};
    await retrieve_an_mdp(temp_req, temp_resp);

    resp_prim.pc = temp_resp.pc;
  } catch (err) {
    console.error(err);
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": err.message };
  }

  return;
}

async function retrieve_ol (req_prim, resp_prim) {
  const mdp_res = await MDP.findOne({
    where: { ri: req_prim.parent_ri },
    attributes: ['dpm_list']
  });
  
  if (!mdp_res) {
    resp_prim.rsc = enums.rsc_str["NOT_FOUND"];
    resp_prim.pc = { "m2m:dbg": "<mdp> resource which is the parent of <ol> not found" };
    return;
  }

  const dpm_list = mdp_res.dpm_list || [];
  if (dpm_list.length > 0) {
    const dpm_ri = dpm_list[0];
    const tmp_resp = {};
    await dpm.retrieve_an_dpm(dpm_ri, req_prim, tmp_resp);
    resp_prim.pc = tmp_resp.pc;
  } else {
    resp_prim.rsc = enums.rsc_str["NOT_FOUND"];
    resp_prim.pc = { "m2m:dbg": "there is no <deployment> resource" };
  }
  return;
};

// if we want to apply 'attrl' filter here, then we can use "retrieve_a_res" function, rather than "retrieve_a_cin"
async function retrieve_la (req_prim, resp_prim) {
  const mdp_res = await MDP.findOne({
    where: { ri: req_prim.parent_ri },
    attributes: ['dpm_list']
  });
  
  if (!mdp_res) {
    resp_prim.rsc = enums.rsc_str["NOT_FOUND"];
    resp_prim.pc = { "m2m:dbg": "<mdp> resource which is the parent of <la> not found" };
    return;
  }

  const dpm_list = mdp_res.dpm_list || [];

  if (dpm_list.length > 0) {
    const dpm_ri = dpm_list[dpm_list.length - 1];

    const tmp_resp = {};
    await dpm.retrieve_a_dpm(dpm_ri, req_prim, tmp_resp);
    resp_prim.pc = tmp_resp.pc;
  } else {
    resp_prim.rsc = enums.rsc_str["NOT_FOUND"];
    resp_prim.pc = { "m2m:dbg": "there is no <deployment> resource" };
  }
  return;
};

async function delete_la (req_prim, resp_prim) {

  return;
} 

async function delete_ol (req_prim, resp_prim) {

  return;
}


async function aggregate_dpm_res(req_prim, ri_list) {
  // it is guaranteed that the ri_list is not empty
  return Promise.all(
    ri_list.map(async (ri) => {
      const temp_req_prim = {
        fr: req_prim.fr,
        to: ri,
        pc: req_prim.pc, // attrl may be contained in 'pc'
      };
      const temp_resp_prim = {};
      const { retrieve_a_res } = require("../hostingCSE");
      await retrieve_a_res(temp_req_prim, temp_resp_prim, ri);

      return temp_resp_prim.pc;
    })
  );
}

module.exports = {
  create_an_mdp,
  retrieve_an_mdp,
  update_an_mdp,
  retrieve_ol,
  retrieve_la,
  delete_la,
  delete_ol,
  aggregate_dpm_res
};