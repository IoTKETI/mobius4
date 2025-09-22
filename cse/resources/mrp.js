const { generate_ri, get_cur_time, get_default_et } = require('../utils');

const Lookup = require("../../models/lookup-model");
const enums = require("../../config/enums");
const mmd = require("./mmd");
const MRP = require("../../models/mrp-model");

const mrp_parent_res_types = ["cb", "ae", "csr"];

async function create_an_mrp(req_prim, resp_prim) {
  const prim_res = req_prim.pc["m2m:mrp"];

  const mrp_pi = req_prim.ri;
  const mrp_sid = req_prim.sid + '/' + prim_res.rn;

  const ri = generate_ri();
  const now = get_cur_time();
  const et = get_default_et();

  // parent resource type check
  const parent_ty = req_prim.to_ty;
  if (mrp_parent_res_types.includes(enums.ty_str[parent_ty.toString()]) == false) {
    resp_prim.rsc = enums.rsc_str["INVALID_CHILD_RESOURCE_TYPE"];
    resp_prim.pc = { "m2m:dbg": "cannot create <mrp> to this parent resource type" };
    return;
  }

  try {
    await MRP.create({
      // mandatory attributes
      ri,
      ty: 101,
      rn: prim_res.rn,
      pi: mrp_pi,
      sid: mrp_sid,
      int_cr: req_prim.fr,
      et: prim_res.et || et,
      ct: now,
      lt: now,
      // optional attributes
      cr: prim_res.cr === null ? req_prim.fr : null,
      acpi: prim_res.acpi || null,
      lbl: prim_res.lbl || null,
      // resource specific attributes
      mnmo: prim_res.mnmo || 0,
      mbmo: prim_res.mbmo || 0,
    });

    await Lookup.create({
      ri,
      ty: 101,
      rn: prim_res.rn,
      sid: mrp_sid,
      lvl: mrp_sid.split("/").length,
      pi: mrp_pi,
      cr: prim_res.cr === '' ? req_prim.fr : null,
      int_cr: req_prim.fr,
      et: prim_res.et || et,
      loc: null
    });
    // retrieve the created resource and respond
    const tmp_req = { ri }, tmp_resp = {};
    await retrieve_an_mrp(tmp_req, tmp_resp);
    resp_prim.pc = tmp_resp.pc;
  } catch (err) {
    console.error(err);
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": err.message };
    return;
  }

  return;
}

async function retrieve_an_mrp(req_prim, resp_prim) {
  const mrp_obj = { "m2m:mrp": {} };
  const ri = req_prim.ri;

  try {
    const db_res = await MRP.findByPk(ri);

    if (!db_res) {
      resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
      resp_prim.pc = { 'm2m:dbg': 'MRP resource not found' };
      return;
    }

    // provide int_cr if required by internal API call
    if (req_prim && req_prim.int_cr_req == true)
      mrp_obj["m2m:mrp"].int_cr = db_res.int_cr;

    // copy attributes that shall be stored in the db
    mrp_obj["m2m:mrp"].ty = db_res.ty;
    mrp_obj["m2m:mrp"].et = db_res.et;
    mrp_obj["m2m:mrp"].ct = db_res.ct;
    mrp_obj["m2m:mrp"].lt = db_res.lt;
    mrp_obj["m2m:mrp"].ri = db_res.ri;
    mrp_obj["m2m:mrp"].rn = db_res.rn;
    mrp_obj["m2m:mrp"].pi = db_res.pi;
    mrp_obj["m2m:mrp"].cnmo = db_res.cnmo;
    mrp_obj["m2m:mrp"].cbmo = db_res.cbmo;

    // copy optional attribute after checking
    if (db_res.acpi) mrp_obj['m2m:mrp'].acpi = db_res.acpi;
    if (db_res.lbl) mrp_obj['m2m:mrp'].lbl = db_res.lbl;
    if (db_res.cr) mrp_obj['m2m:mrp'].cr = db_res.cr;

    // below are resource specific attributes
    if (db_res.mnmo) mrp_obj["m2m:mrp"].mnmo = db_res.mnmo;
    if (db_res.mbmo) mrp_obj["m2m:mrp"].mbmo = db_res.mbmo;

    resp_prim.pc = mrp_obj;
  } catch (err) {
    resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
    resp_prim.pc = { 'm2m:dbg': 'MRP resource not found' };
    throw err;
  }

  return;
}

async function update_an_mrp(req_prim, resp_prim) {
  const prim_res = req_prim.pc["m2m:mrp"];
  const ri = req_prim.ri;

  try {
    const db_res = await MRP.findByPk(ri);

    if (!db_res) {
      resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
      resp_prim.pc = { 'm2m:dbg': 'MRP resource not found' };
      return;
    }

    db_res.lt = get_cur_time();

    if (prim_res.acpi) db_res.acpi = prim_res.acpi;
    if (prim_res.lbl) db_res.lbl = prim_res.lbl;

    // below are resource specific attributes
    if (prim_res.mnmo) db_res.mnmo = prim_res.mnmo;
    if (prim_res.mbmo) db_res.mbmo = prim_res.mbmo;

    // delete optional attributes if they are null in the request
    // universal/common attributes
    if (prim_res.acpi === null) db_res.acpi = null;
    if (prim_res.lbl === null) db_res.lbl = null;

    // resource specific attributes
    if (prim_res.mnmo === null) db_res.mnmo = null;
    if (prim_res.mbmo === null) db_res.mbmo = null;

    await db_res.save();

    const tmp_req = { ri }, tmp_resp = {};
    await retrieve_an_mrp(tmp_req, tmp_resp);

    resp_prim.pc = tmp_resp.pc;
  } catch (err) {
    console.error(err);
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": err.message };
  }

  return;
}

// to-do: check the logic (all the functions below)
async function retrieve_ol(req_prim, resp_prim) {
  const mrp_res = await MRP.findOne({
    where: { ri: req_prim.parent_ri },
    attributes: ['mmd_list']
  });
  if (!mrp_res) {
    resp_prim.rsc = enums.rsc_str["NOT_FOUND"];
    resp_prim.pc = { "m2m:dbg": "<mrp> resource which is the parent of <ol> not found" };
    return;
  }

  const mmd_list = mrp_res.mmd_list;
  if (mmd_list.length > 0) {
    const mmd_ri = mmd_list[0];
    const tmp_req = { ri: mmd_ri }, tmp_resp = {};
    await mmd.retrieve_an_mmd(tmp_req, tmp_resp);

    // set successful RCS in case of virtual resource
    resp_prim.rsc = enums.rsc_str["OK"];
    resp_prim.pc = tmp_resp.pc;
  } else {
    resp_prim.rsc = enums.rsc_str["NOT_FOUND"];
    resp_prim.pc = { "m2m:dbg": "there is no <mmd> resource" };
  }

  return;
};

// if we want to apply 'attrl' filter here, then we can use "retrieve_a_res" function, rather than "retrieve_a_cin"
async function retrieve_la(req_prim, resp_prim) {
  const mrp_res = await MRP.findOne({
    where: { ri: req_prim.parent_ri },
    attributes: ['mmd_list']
  });
  if (!mrp_res) {
    resp_prim.rsc = enums.rsc_str["NOT_FOUND"];
    resp_prim.pc = { "m2m:dbg": "there is no <mmd> resource" };
    return;
  }

  const mmd_list = mrp_res.mmd_list;
  if (mmd_list.length > 0) {
    const mmd_ri = mmd_list[mmd_list.length - 1];

    const tmp_req = { ri: mmd_ri }, tmp_resp = {};
    await mmd.retrieve_an_mmd(tmp_req, tmp_resp);

    // set successful RCS in case of virtual resource
    resp_prim.rsc = enums.rsc_str["OK"];
    resp_prim.pc = tmp_resp.pc;
  } else {
    resp_prim.rsc = enums.rsc_str["NOT_FOUND"];
    resp_prim.pc = { "m2m:dbg": "there is no <mmd> resource" };
  }

  return;
};

async function delete_la(req_prim, resp_prim) {

  return;
}

async function delete_ol(req_prim, resp_prim) {

  return;
}

async function aggregate_mmd_res(req_prim, ri_list) {
  // it is guaranteed that the ri_list is not empty
  return Promise.all(
    ri_list.map(async (ri) => {
      let temp_req_prim = {
        fr: req_prim.fr,
        to: ri,
        pc: req_prim.pc, // attrl may be contained in 'pc'
      };
      let temp_resp_prim = {};
      const { retrieve_a_res } = require('../hostingCSE');
      await retrieve_a_res(temp_req_prim, temp_resp_prim, ri);

      return temp_resp_prim.pc;
    })
  );
}

module.exports = {
  create_an_mrp,
  retrieve_an_mrp,
  update_an_mrp,
  retrieve_ol,
  retrieve_la,
  delete_la,
  delete_ol,
  aggregate_mmd_res,
};