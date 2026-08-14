const { Op } = require("sequelize");
const enums = require("../../config/enums");

const { generate_ri, get_cur_time, get_default_et, not_obsolete_where } = require('../utils');

const Lookup = require('../../models/lookup-model');
const MMD = require('../../models/mmd-model');
const MRP = require('../../models/mrp-model');
const DTS = require('../../models/dts-model');

const logger = require('../../logger').forFile(__filename);

const mmd_parent_res_types = ["mrp"];

// BACKLOG-087: mlModel is stored as the *decoded* bytes, not the base64 text a client sends
// (models/mmd-model.js's mmd column is BYTEA; db/migrations/v4.15.0.sql). What the CSE
// guarantees across CREATE/UPDATE -> RETRIEVE is the attribute's *value* -- the bytes -- not its
// *encoding*: a client that sends non-canonical base64 (missing padding, embedded line breaks)
// gets back the canonical base64 of the same bytes on RETRIEVE, not its own text verbatim. RFC
// 4648 base64 is otherwise a bytes<->text bijection, so this loses nothing a client could
// observably depend on beyond whitespace/padding it did not have to send in the first place.
//
// Input that is not valid base64 at all is rejected (BAD_REQUEST) rather than stored:
// Buffer.from(str, "base64") silently *drops* characters outside the base64 alphabet instead of
// throwing, so decoding first and trusting the result would let garbage through as whatever
// bytes happened to survive the drop.
//
// Returns the decoded Buffer, or null if `raw` is not valid base64 (after allowing embedded
// whitespace/newlines and omitted padding).
function decode_base64_mlmodel(raw) {
  if (typeof raw !== "string") return null;
  const stripped = raw.replace(/[\r\n\s]+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(stripped)) return null;
  const unpadded = stripped.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) return null; // no valid base64 grouping produces this length
  return Buffer.from(stripped, "base64");
}

// trainingDatasetID/inputDescriptor/outputDescriptor/preprocessingRef/modelSignatureRef below
// are NOT part of any oneM2M TS, and not part of TR-0071 itself -- this project's own proposal
// (docs/tr-0071-revision-proposal.md section F, mobius4-dev-tool repo) for a structured
// input/output schema on <mlModel>, built to measure whether a CSE-side compatibility check
// (cse/resources/dpm.js create_a_dpm) is possible and useful. Do not read these as standard.

// Resolves a resource ID (structured sid, e.g. "Mobius/dts-xxx", or unstructured ri) to its row
// in `Model`, or null if the ID does not resolve to any resource, or resolves to a resource that
// is not of `Model`'s type. Used to check that trainingDatasetID (tdi) names a real <dataset> --
// the CSE can check *that*, but never whether the model was actually trained on it (see the
// design doc's "trainingDatasetID는 WO다" section: that half is a self-reported claim).
async function resolve_resource_by_id(id, Model) {
  if (!id) return null;
  const { get_unstructuredID } = require('../hostingCSE');
  const ri = await get_unstructuredID(id);
  if (!ri) return null;
  return Model.findByPk(ri);
}

// inputDescriptor/outputDescriptor: a list of feature descriptions, e.g.
// [{ name: "temperature", dataType: "xs:float", unit: "Cel", optional: false }]. This only
// checks the minimal shape a comparison needs (each entry names a feature) -- it does not
// validate `dataType` against a vocabulary (revision proposal F-7 leaves that open) or `unit`.
function is_valid_descriptor(desc) {
  if (!Array.isArray(desc)) return false;
  return desc.every((f) => f && typeof f === 'object' && typeof f.name === 'string' && f.name.length > 0);
}

async function create_an_mmd(req_prim, resp_prim) {
  const prim_res = req_prim.pc["m2m:mmd"];

  const mmd_pi = req_prim.ri;
  const mmd_sid = req_prim.sid + '/' + prim_res.rn;

  // parent resource type check
  const parent_ty = req_prim.to_ty;
  if (mmd_parent_res_types.includes(enums.ty_str[parent_ty.toString()]) === false) {
    resp_prim.rsc = enums.rsc_str["INVALID_CHILD_RESOURCE_TYPE"];
    resp_prim.pc = { "m2m:dbg": "parent of <mmd> resource shall be <mrp> resource" };
    return;
  }

  // BACKLOG-060: hand-written validation instead of a Joi schema (non-standard resource).
  if (!prim_res.vr || !prim_res.plf || !prim_res.mlt) {
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": "vr, plf, and mlt are mandatory attributes" };
    return;
  }

  // BACKLOG-086: TR-0071:7.1.2.2 says of mlModel: "This cannot be present with mlModelURL." The
  // project's revision proposal (docs/tr-0071-revision-proposal.md item B-4) goes further --
  // exactly one of the two must be present, since a resource with neither is a model resource
  // that holds no model at all.
  if (prim_res.mmd && prim_res.mmu) {
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": "mmd and mmu are mutually exclusive" };
    return;
  }
  if (!prim_res.mmd && !prim_res.mmu) {
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": "exactly one of mmd or mmu is required" };
    return;
  }

  // inputDescriptor/outputDescriptor -- project proposal (F절), not TR-0071. A present value
  // must at least be a list of named features, or the compatibility check in
  // cse/resources/dpm.js (create_a_dpm) would be comparing against garbage.
  if (prim_res.ipd !== undefined && prim_res.ipd !== null && !is_valid_descriptor(prim_res.ipd)) {
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": "inputDescriptor must be a list of { name, ... } feature descriptions" };
    return;
  }
  if (prim_res.oud !== undefined && prim_res.oud !== null && !is_valid_descriptor(prim_res.oud)) {
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": "outputDescriptor must be a list of { name, ... } feature descriptions" };
    return;
  }

  const ri = generate_ri();
  const now = get_cur_time();
  const et = get_default_et();

  // mlModelSize (BACKLOG-087): the stored buffer's own length, not a byte-length-of-base64-text
  // calculation -- see decode_base64_mlmodel above.
  let decoded_mmd = null;
  if (prim_res.mmd) {
    decoded_mmd = decode_base64_mlmodel(prim_res.mmd);
    if (decoded_mmd === null) {
      resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
      resp_prim.pc = { "m2m:dbg": "mmd is not valid base64" };
      return;
    }
  }
  const mms = decoded_mmd ? decoded_mmd.length : 0;

  try {
    const mrp_res = await MRP.findByPk(mmd_pi);

    // maxByteOfModels is optional (TR-0071:7.1.2.1, multiplicity 0..1); mrp_res.mbmo is null
    // when the parent <modelRepo> was created without it (cse/resources/mrp.js), and an absent
    // limit means no limit here too. Without the null guard, `mms > null - cbmo` coerces the
    // null to 0 and rejects every non-empty model.
    //
    // Deleting the oldest mmd when mms is bigger than (mbmo - cbmo) is not defined in the
    // oneM2M TR yet, so this only refuses the create -- it does not evict (see BACKLOG-060 in
    // update_parent_mrp below for the same open question on the post-create side).
    if (mrp_res.mbmo != null && mms > mrp_res.mbmo - mrp_res.cbmo) {
      resp_prim.rsc = enums.rsc_str["NOT_ACCEPTABLE"];
      resp_prim.pc = { "m2m:dbg": "modelSize of a new <mmd> is bigger than (mbmo - cbmo)" };
      return;
    }

    // trainingDatasetID (tdi) -- project proposal, Write-Once. The CSE can only check that this
    // ID names a real <dataset> (ty=106); it cannot check that the model was actually trained
    // on it -- that half is self-reported (design doc "trainingDatasetID는 WO다" section).
    if (prim_res.tdi) {
      const dts_res = await resolve_resource_by_id(prim_res.tdi, DTS);
      if (!dts_res) {
        resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
        resp_prim.pc = { "m2m:dbg": "trainingDatasetID does not reference an existing <dataset>" };
        return;
      }
    }

    // create MMD resource
    await MMD.create({
      // mandatory attributes
      ri,
      ty: 102,
      rn: prim_res.rn,
      pi: mmd_pi,
      sid: mmd_sid,
      int_cr: req_prim.fr,
      et: prim_res.et || et,
      ct: now,
      lt: now,
      // common attributes
      cr: prim_res.cr === null ? req_prim.fr : prim_res.cr,
      acpi: prim_res.acpi || null,
      lbl: prim_res.lbl || null,
      // resource specific attributes
      vr: prim_res.vr,
      plf: prim_res.plf,
      mlt: prim_res.mlt,
      nm: prim_res.nm || null,
      dc: prim_res.dc || null,
      mms,
      ips: prim_res.ips || null,
      ous: prim_res.ous || null,
      mmd: decoded_mmd,
      mmu: prim_res.mmu || null,
      tdi: prim_res.tdi || null,
      ipd: prim_res.ipd || null,
      oud: prim_res.oud || null,
      ppr: prim_res.ppr || null,
      msr: prim_res.msr || null,
    });

    // update several meta info of its parent
    await update_parent_mrp(mrp_res, ri, mms);

    await Lookup.create({
      ri,
      ty: 102,
      rn: prim_res.rn,
      sid: mmd_sid,
      lvl: mmd_sid.split("/").length,
      pi: mmd_pi,
      cr: prim_res.cr === null ? req_prim.fr : prim_res.cr,
      int_cr: req_prim.fr,
      et: prim_res.et || et,
      loc: null
    });

    const tmp_req = { ri }, tmp_resp = {};
    await retrieve_an_mmd(tmp_req, tmp_resp);
    resp_prim.pc = tmp_resp.pc;
  } catch (err) {
    logger.error({ err }, 'create_an_mmd failed');
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": err.message };
  }

  return;
}

// The newest ('DESC') or oldest ('ASC') <mlModel> under a <modelRepo> that is not obsolete.
// Mirrors find_edge_cin in cse/resources/cnt.js -- <mlModel> has no stateTag, so creationTime
// is the ordering basis, with 'ri' as a deterministic tiebreaker (this codebase's 'ct' has only
// second granularity, so two models created in the same second would otherwise tie).
//
// exclude_ri lets the eviction check below guarantee the model just created can never be its
// own victim, even if it and its oldest sibling land in the same second and would otherwise
// tie on the sort above.
async function find_edge_mmd(parent_ri, order, exclude_ri) {
  const where = { pi: parent_ri, ...not_obsolete_where() };
  if (exclude_ri) where.ri = { [Op.ne]: exclude_ri };
  return MMD.findOne({
    where,
    order: [['ct', order], ['ri', order]],
    attributes: ['ri'],
  });
}

async function update_parent_mrp(mrp_db_res, mmd_id, model_size) {
  let { ri: mrp_id, cnmo, cbmo, mnmo, mbmo } = mrp_db_res;

  cnmo++;

  // maxNumberOfModels is optional (TR-0071:7.1.2.1, multiplicity 0..1), and
  // cse/resources/mrp.js stores an unset mnmo as null -- an absent limit means no limit, the
  // same as <container>'s maxNrOfInstances when unset. Without the null guard, `cnmo > mnmo`
  // compared against a falsy default and evicted on the very first <mlModel> insert, and the
  // only sibling in a just-populated <modelRepo> was the model just created.
  if (mnmo != null && cnmo > mnmo) {
    // Evict the oldest sibling by the same query <latest>/<oldest> use (find_edge_mmd), not by
    // array position. mmd_id is excluded so the model just created can never be its own victim.
    const oldest = await find_edge_mmd(mrp_id, 'ASC', mmd_id);
    if (oldest) {
      const { delete_a_res } = require('../hostingCSE');
      const tmp_resp = {};
      await delete_a_res({ ri: oldest.ri, to_ty: 102 }, tmp_resp);
      const deleted_mms = tmp_resp.pc?.['m2m:mmd']?.mms || 0;
      cbmo -= deleted_mms;
      cnmo--;
    }
  }

  // update 'cbmo' of the parent
  cbmo += model_size;
  if (mbmo != null && cbmo > mbmo) {
    // BACKLOG-060: maxByteOfModels is not enforced for this resource family. Unlike mnmo above,
    // TR-0071 says nothing about what should happen here, and evicting by byte budget on top of
    // the count-based eviction above would need its own answer for which limit wins when both
    // are set and disagree on the victim -- left as an observation, not an eviction, until that
    // is decided (see the same note on the create-time check above).
  }

  // finally update the above parent attributes
  await MRP.update({ cnmo, cbmo }, { where: { ri: mrp_id } });

  return;
}

async function retrieve_an_mmd(req_prim, resp_prim) {
  const mmd_obj = { "m2m:mmd": {} };
  const ri = req_prim.ri;

  try {
    const db_res = await MMD.findByPk(ri);

    if (!db_res) {
      resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
      resp_prim.pc = { 'm2m:dbg': 'MMD resource not found' };
      return;
    }

    // provide int_cr if required by internal API call
    if (req_prim && req_prim.int_cr_req === true)
      mmd_obj["m2m:mmd"].int_cr = db_res.int_cr;

    // copy mandatory attributes
    mmd_obj["m2m:mmd"].ty = db_res.ty;
    mmd_obj["m2m:mmd"].et = db_res.et;
    mmd_obj["m2m:mmd"].ct = db_res.ct;
    mmd_obj["m2m:mmd"].lt = db_res.lt;
    mmd_obj["m2m:mmd"].ri = db_res.ri;
    mmd_obj["m2m:mmd"].rn = db_res.rn;
    mmd_obj["m2m:mmd"].pi = db_res.pi;

    // copy optional attribute after checking
    if (db_res.acpi) mmd_obj["m2m:mmd"].acpi = db_res.acpi;
    if (db_res.lbl) mmd_obj["m2m:mmd"].lbl = db_res.lbl;
    if (db_res.cr) mmd_obj["m2m:mmd"].cr = db_res.cr;

    // below are resource specific attributes
    if (db_res.nm) mmd_obj["m2m:mmd"].nm = db_res.nm;
    if (db_res.vr) mmd_obj["m2m:mmd"].vr = db_res.vr;
    if (db_res.plf) mmd_obj["m2m:mmd"].plf = db_res.plf;
    if (db_res.mlt) mmd_obj["m2m:mmd"].mlt = db_res.mlt;
    if (db_res.dc) mmd_obj["m2m:mmd"].dc = db_res.dc;
    if (db_res.ips) mmd_obj["m2m:mmd"].ips = db_res.ips;
    if (db_res.ous) mmd_obj["m2m:mmd"].ous = db_res.ous;
    // BACKLOG-087: db_res.mmd is the decoded Buffer (BYTEA column); re-encode to base64 for the
    // wire, since that is the representation TR-0071:7.1.2.2 describes ("base64 encoded binary
    // model").
    if (db_res.mmd) {
      mmd_obj["m2m:mmd"].mmd = Buffer.isBuffer(db_res.mmd) ? db_res.mmd.toString("base64") : db_res.mmd;
    }
    if (db_res.mms) mmd_obj["m2m:mmd"].mms = db_res.mms;
    if (db_res.mmu) mmd_obj["m2m:mmd"].mmu = db_res.mmu;
    // Project proposal attributes (F절) -- not TR-0071, see the note at decode_base64_mlmodel.
    if (db_res.tdi) mmd_obj["m2m:mmd"].tdi = db_res.tdi;
    if (db_res.ipd) mmd_obj["m2m:mmd"].ipd = db_res.ipd;
    if (db_res.oud) mmd_obj["m2m:mmd"].oud = db_res.oud;
    if (db_res.ppr) mmd_obj["m2m:mmd"].ppr = db_res.ppr;
    if (db_res.msr) mmd_obj["m2m:mmd"].msr = db_res.msr;

  } catch (err) {
    resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
    resp_prim.pc = { 'm2m:dbg': 'MMD resource not found' };
    throw err;
  }

  resp_prim.pc = mmd_obj;
  return;
}

async function update_an_mmd(req_prim, resp_prim) {
  const prim_res = req_prim.pc["m2m:mmd"];
  const ri = req_prim.ri;

  // BACKLOG-060: hand-written validation instead of a Joi schema (non-standard resource).
  if (prim_res.mmd === null && prim_res.mmu) {
    resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
    resp_prim.pc = { 'm2m:dbg': 'either mmd or mmu shall be included' };
    return;
  }
  if ((prim_res.vr === null) || (prim_res.plf === null) || (prim_res.mlt === null)) {
    resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
    resp_prim.pc = { 'm2m:dbg': 'vr, plf, and mlt are mandatory attributes' };
    return;
  }

  // trainingDatasetID (tdi) is Write-Once (design doc "trainingDatasetID는 WO다" section) --
  // the CSE has no way to verify a *changed* claim any more than the original one, and letting
  // lineage be edited after the fact would defeat the point of recording it. Any attempt to
  // touch it via Update (set or clear) is rejected outright, unlike the RW descriptor fields
  // below.
  if (prim_res.tdi !== undefined) {
    resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
    resp_prim.pc = { 'm2m:dbg': 'trainingDatasetID is write-once and cannot be changed by Update' };
    return;
  }
  if (prim_res.ipd !== undefined && prim_res.ipd !== null && !is_valid_descriptor(prim_res.ipd)) {
    resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
    resp_prim.pc = { 'm2m:dbg': 'inputDescriptor must be a list of { name, ... } feature descriptions' };
    return;
  }
  if (prim_res.oud !== undefined && prim_res.oud !== null && !is_valid_descriptor(prim_res.oud)) {
    resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
    resp_prim.pc = { 'm2m:dbg': 'outputDescriptor must be a list of { name, ... } feature descriptions' };
    return;
  }

  try {
    if (prim_res.mms) {
      resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
      resp_prim.pc = { 'm2m:dbg': 'mms is immutable' };
      return;
    }

    const db_res = await MMD.findByPk(ri);

    if (!db_res) {
      resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
      resp_prim.pc = { 'm2m:dbg': 'MMD resource not found' };
      return;
    }

    db_res.lt = get_cur_time();

    if (prim_res.et) db_res.et = prim_res.et;
    if (prim_res.acpi) db_res.acpi = prim_res.acpi;
    if (prim_res.lbl) db_res.lbl = prim_res.lbl;

    // resource specific attributes
    if (prim_res.nm) db_res.nm = prim_res.nm;
    if (prim_res.vr) db_res.vr = prim_res.vr;
    if (prim_res.plf) db_res.plf = prim_res.plf;
    if (prim_res.mlt) db_res.mlt = prim_res.mlt;
    if (prim_res.dc) db_res.dc = prim_res.dc;
    if (prim_res.ips) db_res.ips = prim_res.ips;
    if (prim_res.ous) db_res.ous = prim_res.ous;
    if (prim_res.mmd) {
      const decoded = decode_base64_mlmodel(prim_res.mmd);
      if (decoded === null) {
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': 'mmd is not valid base64' };
        return;
      }
      db_res.mmd = decoded;
      db_res.mms = decoded.length;
    }
    if (prim_res.mmu) db_res.mmu = prim_res.mmu;
    // ipd/oud/ppr/msr are RW (unlike tdi above, rejected before reaching this point if present).
    if (prim_res.ipd) db_res.ipd = prim_res.ipd;
    if (prim_res.oud) db_res.oud = prim_res.oud;
    if (prim_res.ppr) db_res.ppr = prim_res.ppr;
    if (prim_res.msr) db_res.msr = prim_res.msr;

    // delete optional attributes if they are null in the request
    // universal/common attributes
    if (prim_res.acpi === null) db_res.acpi = null;
    if (prim_res.lbl === null) db_res.lbl = null;

    // resource specific attributes
    if (prim_res.nm === null) db_res.nm = null;
    if (prim_res.dc === null) db_res.dc = null;
    if (prim_res.ous === null) db_res.ous = null;
    if (prim_res.ips === null) db_res.ips = null;
    if (prim_res.mmd === null) {
      db_res.mmd = null;
      db_res.mms = 0;
    }
    if (prim_res.mmu === null) db_res.mmu = null;
    if (prim_res.ipd === null) db_res.ipd = null;
    if (prim_res.oud === null) db_res.oud = null;
    if (prim_res.ppr === null) db_res.ppr = null;
    if (prim_res.msr === null) db_res.msr = null;

    await db_res.save();

    const temp_req = { ri }, temp_resp = {};
    await retrieve_an_mmd(temp_req, temp_resp);

    resp_prim.pc = temp_resp.pc;
  } catch (err) {
    logger.error({ err }, 'update_an_mmd failed');
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": err.message };
  }

  return;
}

module.exports = {
  create_an_mmd,
  retrieve_an_mmd,
  update_an_mmd,
  find_edge_mmd,
};