const { JSONPath } = require("jsonpath-plus");
const LRU = require("lru-cache");
const config = require("config");
const enums = require("../config/enums");
const logger = require("../logger").forFile(__filename);
const randomstring = require("randomstring");
const pool = require('../db/connection');
const moment = require('moment');

const metrics = require('../metrics');
const { Op, Sequelize } = require('sequelize');
const Lookup = require('../models/lookup-model');
// oneM2M standard resources
const ACP = require('../models/acp-model');
const AE = require('../models/ae-model');
const CIN = require('../models/cin-model');
const CNT = require('../models/cnt-model');
const CSR = require('../models/csr-model');
const FLX = require('../models/flx-model');
const GRP = require('../models/grp-model');
const SUB = require('../models/sub-model');

// non-standard resources yet
const MRP = require('../models/mrp-model');
const MMD = require('../models/mmd-model');
const MDP = require('../models/mdp-model');
const DPM = require('../models/dpm-model');
const DSP = require('../models/dsp-model');
const DTS = require('../models/dts-model');
const DSF = require('../models/dsf-model');


// oneM2M standard resources
const cb = require("./resources/cb");
const acp = require("./resources/acp");
const ae = require("./resources/ae");
const csr = require("./resources/csr");
const cnt = require("./resources/cnt");
const cin = require("./resources/cin");
const grp = require("./resources/grp");
const sub = require("./resources/sub");
// const smd = require("./resources/smd");
const flx = require("./resources/flx");
const noti = require("./noti");

// below are not specified in oneM2M yet
const mrp = require("./resources/mrp"); // <modelRepo>
const mmd = require("./resources/mmd"); // <mlModel>
const mdp = require("./resources/mdp"); // <modelDeploymentList>
const dpm = require("./resources/dpm"); // <modelDeployment>
const dsp = require("./resources/dsp"); // <datasetPolicy>
const dts = require("./resources/dts"); // <dataset>
const dsf = require("./resources/dsf"); // <datasetFragment>

// In SQL LIKE, '%' and '_' are wildcards. Underscores are common in resource names (e.g.
// '{modelId}_{version}_{instanceId}' from the Part 3 standard, or cb_default_acp for the default
// ACP), so without escaping they match sibling resources too — polluted results in discovery,
// and deletion of someone else's resource in delete. PostgreSQL LIKE uses backslash as its
// default escape character, so no separate ESCAPE clause is needed.
function escape_like(s) {
	return String(s).replace(/([\\%_])/g, '\\$1');
}

const virtual_res_names = ["fopt", "la", "ol"]; // fopt shall come first in the list

// [C6] LRU cache for Lookup table: key = 'to' path, value = { ri, sid, to_ty }
// TTL 5 minutes — invalidated on resource delete
const lookupCache = new LRU({ max: 5000, maxAge: 1000 * 60 * 5 });


// this is obsolete, replaced by the sequelize model in each resource create function
async function create_a_lookup_record(ty, rn, sid, ri, pi, cr, int_cr, loc) {
	try {
		const lvl = sid.split("/").length;

		await Lookup.create({
			ri,
			ty,
			rn,
			sid,
			lvl,
			pi,
			cr,
			int_cr,
			loc: loc || null, // geometry object or null
		});
	} catch (err) {
		logger.error({ err }, 'lookup insert failed');
	}
}


async function create_a_res(req_prim, resp_prim) {
	const ty = req_prim.ty;
	const obj_key = Object.keys(req_prim.pc)[0];
	const res_rep = req_prim.pc[obj_key];

	// request validity check

	// 'et' validation
	const et = res_rep.et || null;
	const timestamp_format = config.get('cse.timestamp_format');
	const now = moment().utc().format(timestamp_format);
	if (et && et <= now) {
		resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
		resp_prim.pc = { 'm2m:dbg': 'et cannot be in the current time or past' };
		return;
	}

	// get and check 'rn'

	if (!res_rep.rn) {
		res_rep.rn = get_a_new_rn(ty);
	}
	else if (virtual_res_names.includes(res_rep.rn)) {
		resp_prim.rsc = enums.rsc_str["OPERATION_NOT_ALLOWED"];
		resp_prim.pc = {
			"m2m:dbg": "cannot use the 'rn' since this is a virtual resource name",
		};
		return;
	}
	else if (await get_unstructuredID(req_prim.sid + "/" + res_rep.rn)) {
		resp_prim.rsc = enums.rsc_str["CONFLICT"];
		resp_prim.pc = { "m2m:dbg": "requested 'rn' is already used" };
		return;
	}


	switch (ty) {
		case 1:
			await acp.create_an_acp(req_prim, resp_prim);
			break;
		case 2:
			await ae.create_an_ae(req_prim, resp_prim);
			break;
		case 3:
			await cnt.create_a_cnt(req_prim, resp_prim);
			break;
		case 4:
			await cin.create_a_cin(req_prim, resp_prim);
			break;
		case 9:
			await grp.create_a_grp(req_prim, resp_prim);
			break;
		case 16:
			await csr.create_a_csr(req_prim, resp_prim);
			break;
		case 23:
			await sub.create_a_sub(req_prim, resp_prim);
			break;
		case 24:
			await smd.create_a_smd(req_prim, resp_prim);
			break;
		case 28:
			await flx.create_a_flx(req_prim, resp_prim);
			break;
		case 34:
			await dac.create_a_dac(req_prim, resp_prim);
			break;
		case 101:
			await mrp.create_an_mrp(req_prim, resp_prim);
			break;
		case 102:
			await mmd.create_an_mmd(req_prim, resp_prim);
			break;
		case 103:
			await mdp.create_an_mdp(req_prim, resp_prim);
			break;
		case 104:
			await dpm.create_a_dpm(req_prim, resp_prim);
			break;
		case 105:
			await dsp.create_a_dsp(req_prim, resp_prim);
			break;
		case 106: // this is not called by client, temporary for testing
			await dts.create_a_dts(req_prim, resp_prim);
			break;
		case 107: // this is not called by client, temporary for testing
			await dsf.create_a_dsf(req_prim, resp_prim);
			break;
		default:
			resp_prim.rsc = enums.rsc_str["OPERATION_NOT_ALLOWED"];
			resp_prim.pc = { "m2m:dbg": "not allowed API call" };
			return;
	}

	// if there was any error during the creation, 'resp_prim' will have an error code in 'rsc' property
	if (!resp_prim.rsc) {
		metrics.resourcesCreatedTotal.inc({ ty: String(ty) });
		resp_prim.rsc = enums.rsc_str["CREATED"];

		const resp_prim_copy = { ...resp_prim };
		if (req_prim.rcn == 0) {
			// rcn = 0: return nothing
			delete resp_prim.pc;
		}
		else if (req_prim.rcn == 2) {
			// rcn = 2: return hierarchical-address
			const obj_key = Object.keys(resp_prim.pc)[0];
			resp_prim.pc = {
				"m2m:uri": req_prim.to + "/" + resp_prim.pc[obj_key].rn,
			};
		}
		else if (req_prim.rcn == 3) {
			// rcn = 3: return attributes + hierarchical-address
			const obj_key = Object.keys(resp_prim.pc)[0];
			resp_prim.pc = {
				"uri": req_prim.to + "/" + resp_prim.pc[obj_key].rn,
				[obj_key]: resp_prim.pc[obj_key],
			};
		}
		// after creation, check and send notification(s) if needed
		// skip this for <sub> resource creation
		if (req_prim.ty !== 23) {
			noti.check_and_send_noti(req_prim, resp_prim_copy, "create")
				.catch(err => logger.error({ err }, 'check_and_send_noti failed'));
		}
	}

	return;
}

// unlike other operations, this returns a resource object, not a response primitive. so this can be used for other purposes e.g. rcn=4
async function retrieve_a_res(req_prim, resp_prim) {
	switch (req_prim.to_ty) {
		case 1:
			await acp.retrieve_an_acp(req_prim, resp_prim);
			break;
		case 2:
			await ae.retrieve_an_ae(req_prim, resp_prim);
			break;
		case 3:
			await cnt.retrieve_a_cnt(req_prim, resp_prim);
			break;
		case 4:
			await cin.retrieve_a_cin(req_prim, resp_prim);
			break;
		case 5:
			await cb.retrieve_a_cb(resp_prim);
			break;
		case 9:
			await grp.retrieve_a_grp(req_prim, resp_prim);
			break;
		case 16:
			await csr.retrieve_a_csr(req_prim, resp_prim);
			break;
		case 23:
			await sub.retrieve_a_sub(req_prim, resp_prim);
			break;
		case 24:
			await smd.retrieve_a_smd(req_prim, resp_prim);
			break;
		case 28:
			await flx.retrieve_a_flx(req_prim, resp_prim);
			break;
		case 101:
			await mrp.retrieve_an_mrp(req_prim, resp_prim);
			break;
		case 102:
			await mmd.retrieve_an_mmd(req_prim, resp_prim);
			break;
		case 103:
			await mdp.retrieve_an_mdp(req_prim, resp_prim);
			break;
		case 104:
			await dpm.retrieve_a_dpm(req_prim, resp_prim);
			break;
		case 105:
			await dsp.retrieve_a_dsp(req_prim, resp_prim);
			break;
		case 106:
			await dts.retrieve_a_dts(req_prim, resp_prim);
			break;
		case 107:
			await dsf.retrieve_a_dsf(req_prim, resp_prim);
			break;
	}

	// partial retrieval with a list of attributes in the request
	if (req_prim.op === 2 && req_prim.pc && req_prim.pc.atrl) {
		const obj_key = Object.keys(resp_prim.pc)[0]; // e.g. 'm2m:cnt'
		let partial_res = {};

		for (attr of req_prim.pc.atrl) {
			partial_res[attr] = resp_prim.pc[obj_key][attr];
		}
		logger.trace({ partial_res }, 'partial_res built');

		resp_prim.pc[obj_key] = partial_res;
	}

	if (resp_prim.rsc === enums.rsc_str['NOT_FOUND']) {
		return;
	}

	if (!resp_prim.rsc) {
		resp_prim.rsc = enums.rsc_str["OK"];
	}

	return;
}

async function rcn48_retrieve(req_prim, resp_prim) {
	const tmp_resp = {};

	await retrieve_a_res(req_prim, tmp_resp);
	const target_res = tmp_resp.pc;
	const res_key = Object.keys(target_res)[0]; // e.g. 'm2m:cnt'

	let aggr_res = {};

	if (4 == req_prim.rcn) aggr_res = target_res;

	if (8 == req_prim.rcn) aggr_res[res_key] = {};

	const { ids_list_per_ty: ids_list } = await discovery_core(req_prim);

	if (ids_list == []) {
		return [];
	} else {
		for (const ty_str in ids_list) {
			const ri_list = ids_list[ty_str].map((ids) => {
				return ids.ri;
			});
			// new resource type guide
			// add new resource type handling here
			let temp_reses = [];

			if ("acp" === ty_str) {
				temp_reses = await aggr_reses_per_ty(req_prim, ri_list, "acp");
				if (temp_reses.length)
					aggr_res[res_key]["m2m:acp"] = [...temp_reses];
			}
			if ("ae" === ty_str) {
				temp_reses = await aggr_reses_per_ty(req_prim, ri_list, "ae");
				if (temp_reses.length)
					aggr_res[res_key]["m2m:ae"] = [...temp_reses];
			}
			if ("cnt" === ty_str) {
				temp_reses = await aggr_reses_per_ty(req_prim, ri_list, "cnt");
				if (temp_reses.length)
					aggr_res[res_key]["m2m:cnt"] = [...temp_reses];
			}
			if ("cin" === ty_str) {
				temp_reses = await aggr_reses_per_ty(req_prim, ri_list, "cin");
				if (temp_reses.length)
					aggr_res[res_key]["m2m:cin"] = [...temp_reses];
			}
			if ("grp" === ty_str) {
				temp_reses = await aggr_reses_per_ty(req_prim, ri_list, "grp");
				if (temp_reses.length)
					aggr_res[res_key]["m2m:grp"] = [...temp_reses];
			}
			if ("sub" === ty_str) {
				temp_reses = await aggr_reses_per_ty(req_prim, ri_list, "sub");
				if (temp_reses.length)
					aggr_res[res_key]["m2m:sub"] = [...temp_reses];
			}
			// if ("smd" === ty_str) {
			//   temp_reses = await aggr_reses_per_ty(req_prim, ri_list, "smd");
			//   if (temp_reses.length)
			//     aggr_res[target_res_key]["m2m:smd"] = [...temp_reses];
			// }
			if ("flx" === ty_str) {
				temp_reses = await aggr_reses_per_ty(req_prim, ri_list, "flx");
				// Unlike the other types, each <flexContainer> specialization has its own
				// envelope key (TS-0004:7.4.37.1 permits a non-m2m: namespace prefix), so the
				// results are grouped by the key each resource actually carries rather than
				// collected under one fixed key.
				for (const flx_obj of temp_reses) {
					if (!flx_obj) continue;
					const obj_key = Object.keys(flx_obj)[0];
					if (aggr_res[res_key][obj_key] === undefined) {
						aggr_res[res_key][obj_key] = [];
					}
					aggr_res[res_key][obj_key].push(flx_obj[obj_key]);
				}
			}
			// if ("mrp" === ty_str) {
			//   temp_reses = await aggr_reses_per_ty(req_prim, ri_list, "mrp");
			//   if (temp_reses.length)
			//     aggr_res[target_res_key]["m2m:mrp"] = [...temp_reses];
			// }
			// if ("mmd" === ty_str) {
			//   temp_reses = await aggr_reses_per_ty(req_prim, ri_list, "mmd");
			//   if (temp_reses.length)
			//     aggr_res[target_res_key]["m2m:mmd"] = [...temp_reses];
			// }
			// if ("mdp" === ty_str) {
			//   temp_reses = await aggr_reses_per_ty(req_prim, ri_list, "mdp");
			//   if (temp_reses.length)
			//     aggr_res[target_res_key]["m2m:mdp"] = [...temp_reses];
			// }
			// if ("dpm" === ty_str) {
			//   temp_reses = await aggr_reses_per_ty(req_prim, ri_list, "dpm");
			//   if (temp_reses.length)
			//     aggr_res[target_res_key]["m2m:dpm"] = [...temp_reses];
			// }
		}
	}
	resp_prim.pc = aggr_res;

	return resp_prim;
};

async function aggr_reses_per_ty(req_prim, ri_list, ty) {
	return await Promise.all(
		ri_list.map(async (ri) => {
			const tmp_req_prim = {
				fr: req_prim.fr,
				to: ri,
				fc: req_prim.fc,
				op: 2,
				ri,
			};
			const tmp_resp_prim = {};

			// new resource type guide
			// add new resource type handling here
			switch (ty) {
				case "acp":
					await acp.retrieve_an_acp(tmp_req_prim, tmp_resp_prim);
					return tmp_resp_prim.pc["m2m:acp"];
				case "ae":
					await ae.retrieve_an_ae(tmp_req_prim, tmp_resp_prim);
					return tmp_resp_prim.pc["m2m:ae"];
				case "cnt":
					await cnt.retrieve_a_cnt(tmp_req_prim, tmp_resp_prim);
					return tmp_resp_prim.pc["m2m:cnt"];
				case "cin":
					await cin.retrieve_a_cin(tmp_req_prim, tmp_resp_prim);
					return tmp_resp_prim.pc["m2m:cin"];
				case "grp":
					await grp.retrieve_a_grp(tmp_req_prim, tmp_resp_prim);
					return tmp_resp_prim.pc["m2m:grp"];
				case "sub":
					await sub.retrieve_a_sub(tmp_req_prim, tmp_resp_prim);
					return tmp_resp_prim.pc["m2m:sub"];
				case "smd":
					await sub.retrieve_a_smd(tmp_req_prim, tmp_resp_prim);
					return tmp_resp_prim.pc["m2m:smd"];
				case "flx":
					await flx.retrieve_a_flx(tmp_req_prim, tmp_resp_prim);
					// object keys are different for flexContainer specializations, so the whole
					// pc is returned and the caller groups by the key it finds
					return tmp_resp_prim.pc;

				// case "mrp":
				//   await mrp.retrieve_an_mrp(tmp_req_prim, tmp_resp_prim);
				//   return tmp_resp_prim.pc["m2m:mrp"];
				// case "mmd":
				//   await mmd.retrieve_an_mmd(tmp_req_prim, tmp_resp_prim);
				//   return tmp_resp_prim.pc["m2m:mmd"];
				// case "mdp":
				//   await mdp.retrieve_an_mdp(tmp_req_prim, tmp_resp_prim);
				//   return tmp_resp_prim.pc["m2m:mdp"];
				// case "dpm":
				//   await dpm.retrieve_a_dpm(tmp_req_prim, tmp_resp_prim);
				//   return tmp_resp_prim.pc["m2m:dpm"];
			}
		})
	);
}

async function update_a_res(req_prim, resp_prim) {
	// request validity check

	// 'et' validation
	const obj_key = Object.keys(req_prim.pc)[0];
	const et = req_prim.pc[obj_key].et || null;
	const timestamp_format = config.get('cse.timestamp_format');
	const now = moment().utc().format(timestamp_format);
	if (et && et <= now) {
		resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
		resp_prim.pc = { 'm2m:dbg': 'et cannot be in the current time or past' };
		return;
	}

	switch (req_prim.to_ty) {
		case 1:
			await acp.update_an_acp(req_prim, resp_prim);
			break;
		case 2:
			await ae.update_an_ae(req_prim, resp_prim);
			break;
		case 3:
			await cnt.update_a_cnt(req_prim, resp_prim);
			break;
		case 9:
			await grp.update_a_grp(req_prim, resp_prim);
			break;
		case 16:
			await csr.update_a_csr(req_prim, resp_prim);
			break;
		case 23:
			await sub.update_a_sub(req_prim, resp_prim);
			break;
		case 24:
			await smd.update_a_smd(req_prim, resp_prim);
			break;
		case 28:
			await flx.update_a_flx(req_prim, resp_prim);
			break;
		// case 34:
		//   await dac.update_a_dac(req_prim, resp_prim);
		//   break;
		case 101:
			await mrp.update_an_mrp(req_prim, resp_prim);
			break;
		case 102:
			await mmd.update_an_mmd(req_prim, resp_prim);
			break;
		case 103:
			await mdp.update_an_mdp(req_prim, resp_prim);
			break;
		case 104:
			await dpm.update_a_dpm(req_prim, resp_prim);
			break;
		case 105:
			await dsp.update_a_dsp(req_prim, resp_prim);
			break;
		default:
			resp_prim.rsc = enums.rsc_str["OPERATION_NOT_ALLOWED"];
			resp_prim.pc = { "m2m:dbg": "not allowed API call" };
			return;
	}

	if (!resp_prim.rsc) {
		resp_prim.rsc = enums.rsc_str["UPDATED"];

		// after update, check and send notification(s) if needed
		noti.check_and_send_noti(req_prim, resp_prim, "update")
			.catch(err => logger.error({ err }, 'check_and_send_noti failed'));
	}

	return;
}

async function delete_a_res(req_prim, resp_prim) {
	switch (req_prim.to_ty) {
		// cannot delete <CSEBase> resource
		case 5:
			resp_prim.rsc = enums.rsc_str["OPERATION_NOT_ALLOWED"];
			resp_prim.pc = { "m2m:dbg": "not allowed API call" };
			return;

		case 23:
			const { send_sub_del_noti } = require('./noti');
			const tmp_resp = {};
			const { retrieve_a_sub } = require('./resources/sub');
			await retrieve_a_sub(req_prim, tmp_resp);

			if (tmp_resp.pc) {
				await send_sub_del_noti(tmp_resp.pc['m2m:sub']);
			}
			break;

		// when deleting a <dsp> resource, delete the <sub> resource(s) if any
		case 105:
			const { delete_sub_for_live_dataset } = require('./datasetManager');
			await delete_sub_for_live_dataset(req_prim.ri);
			break;
	}

	const not_allowed_rcn = [2, 3, 7, 9, 10, 12];
	if (not_allowed_rcn.includes(req_prim.rcn)) {
		resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
		resp_prim.pc = { "m2m:dbg": "not allowed rcn value for DELETE" };
		return;
	}

	// delete a target resource
	// The await matters: without it the response says DELETED while the rows are still being
	// removed, so a client that deletes and then immediately retrieves can catch the resource
	// half-gone. That window is narrow but real — it produced an intermittent RSC 5000 in CI,
	// reproduced locally at roughly one request in 300 (see delete_a_res's own descendants
	// below, which are deliberately left asynchronous).
	const tmp_resp = {};
	await retrieve_a_res(req_prim, tmp_resp);
	if (tmp_resp.pc) {
		await delete_resources([{ ri: req_prim.ri, ty: req_prim.to_ty }]);
		// [C6] invalidate lookup cache for deleted resource
		if (req_prim.sid) lookupCache.del(req_prim.sid);
		if (req_prim.to)  lookupCache.del(req_prim.to);
	}
	resp_prim.pc = tmp_resp.pc;
	resp_prim.rsc = enums.rsc_str["DELETED"];

	// after deletion, check and send notification(s) if needed
	noti.check_and_send_noti(req_prim, tmp_resp, "delete")
		.catch(err => logger.error({ err }, 'check_and_send_noti failed'));

	// to-do
	// when delete a <cin> resource, update the parent <cnt> resource's 'cbs' attribute
	if (req_prim.to_ty === 4 && req_prim.int_cr_req !== true) {
		const parent_cnt_ri = tmp_resp.pc['m2m:cin'].pi;
		const cs = tmp_resp.pc['m2m:cin'].cs;

		const cnt_res = await CNT.findByPk(parent_cnt_ri);
		logger.trace({ cnt_res }, 'cnt_res');
		cnt_res.cni--;
		cnt_res.cbs = cnt_res.cbs - cs;

		await cnt_res.save();
	}

	//
	// delete child/decendant resources
	//

	// child_res_list is a list of resource where 'sid' in all records in 'lookup' table starts with 'sid' variable here
	const child_res_list = await Lookup.findAll({
		where: { sid: { [Op.like]: `${escape_like(req_prim.sid)}/%` } },
		attributes: ['ri', 'ty'],
	});

	// delete decendant resources asynchronously
	delete_resources(child_res_list);

	return;
};

// model registry for batch delete
const DELETE_MODEL = {
	1: ACP, 2: AE, 3: CNT, 4: CIN, 9: GRP, 16: CSR, 23: SUB, 28: FLX,
	101: MRP, 102: MMD, 103: MDP, 104: DPM, 105: DSP, 106: DTS, 107: DSF,
};

async function delete_resources(res_list) {
	if (!res_list || res_list.length === 0) return;

	try {
		// group ri's by type for batch DELETE instead of one-by-one
		const by_type = {};
		const all_ri = [];
		for (const res of res_list) {
			if (!by_type[res.ty]) by_type[res.ty] = [];
			by_type[res.ty].push(res.ri);
			all_ri.push(res.ri);
		}

		// batch delete lookup records and each resource table in parallel
		await Promise.all([
			Lookup.destroy({ where: { ri: { [Op.in]: all_ri } } }),
			...Object.entries(by_type).map(([ty, ri_list]) => {
				const model = DELETE_MODEL[parseInt(ty)];
				if (!model) return Promise.resolve();
				return model.destroy({ where: { ri: { [Op.in]: ri_list } } });
			}),
		]);
	} catch (error) {
		logger.error({ err: error }, 'resource deletion failed');
	}
}

// The operation discovery evaluates each of its results under. access_decision switches on this
// number; the matching accessControlOperations bit is 32 = DISCOVERY (TS-0004:6.3.4.2.29).
const DISCOVERY_OP = 6;

// Separates the components of a decision-memo key. A control character, so it cannot occur in an
// originator (an AE-ID or CSE-ID) or in a resourceID, and two different tuples cannot collide.
const MEMO_KEY_SEP = String.fromCharCode(0);

// Keeps only the entries that still have a lookup row, in one query. Used by discovery_core
// after the access filter -- see the comment there for why the check is needed at all.
async function drop_vanished(items) {
	const ris = items.map(i => i.ri);

	// Raw query rather than Lookup.findAll: building a model instance per row costs more than
	// the query does, and nothing here needs a model. The count comes back first because the
	// answer is almost always "all of them" -- one integer instead of a row per survivor -- and
	// only a short count makes it worth asking which ones. ri is the primary key, so both are
	// index lookups and neither can return duplicates.
	const counted = await pool.query(
		'SELECT count(*)::int AS n FROM lookup WHERE ri = ANY($1::text[])', [ris]);
	if (counted.rows[0].n === ris.length) return items;

	const alive = await pool.query(
		'SELECT ri FROM lookup WHERE ri = ANY($1::text[])', [ris]);
	const alive_ri = new Set(alive.rows.map(r => r.ri));
	return items.filter(i => alive_ri.has(i.ri));
}

async function discovery_core(req_prim) {
	let ids_list = []; // this is for discovery response
	let ids_list_per_ty = {}; // this is for rcn = 4 or rcn = 8 response

	const { where, where_per_ty, has_geo_query, unsupported_geo } = set_where_clause(req_prim);
	if (unsupported_geo) {
		// A geometry type that is valid per the spec but not implemented here — following
		// TS-0004:7.3.2.1 ("reject what is not supported"), it must not be silently ignored.
		const err = new Error('unsupported geometry type');
		err.rsc_hint = 'NOT_IMPLEMENTED';
		throw err;
	}

	const lim = req_prim.fc.lim || config.cse.discovery_limit;
	const ofst = req_prim.fc.ofst || 0;
	const ty_list = req_prim.fc.ty || Object.keys(enums.ty_str);

	// fetch enough per-type to cover offset + limit + 1 (for partial detection)
	const fetch_lim = Math.min(ofst + lim + 1, config.cse.discovery_limit);

	// model registry: type code → { model, no_geo }
	const TYPE_MODEL = {
		1:   { model: ACP, no_geo: true  },
		2:   { model: AE,  no_geo: false },
		3:   { model: CNT, no_geo: false },
		4:   { model: CIN, no_geo: false },
		9:   { model: GRP, no_geo: true  },
		16:  { model: CSR, no_geo: false },
		23:  { model: SUB, no_geo: true  },
		28:  { model: FLX, no_geo: false },
		101: { model: MRP, no_geo: true  },
		102: { model: MMD, no_geo: true  },
		103: { model: MDP, no_geo: true  },
		104: { model: DPM, no_geo: true  },
		105: { model: DSP, no_geo: true  },
		106: { model: DTS, no_geo: true  },
		107: { model: DSF, no_geo: true  },
	};

	// A filter that names a column only some tables have restricts the query to those tables.
	// Types without the column cannot satisfy the filter, and including them would send the
	// condition to a table that does not have it — the failure mode documented for lvl above.
	const has_per_ty_filter = Object.keys(where_per_ty).length > 0;

	// run all type queries in parallel instead of sequentially
	const query_tasks = ty_list
		.map(ty_str => parseInt(ty_str))
		.filter(ty => {
			const entry = TYPE_MODEL[ty];
			if (!entry) return false;
			if (entry.no_geo && has_geo_query) return false;
			if (has_per_ty_filter && !where_per_ty[ty]) return false;
			return true;
		})
		.map(ty => {
			const { model } = TYPE_MODEL[ty];
			const ty_where = where_per_ty[ty] ? { ...where, ...where_per_ty[ty] } : where;
			// 'pi' is only needed to key the access-decision memo below, but every one of these
			// tables is being read anyway, so the extra column is free.
			return model.findAll({ where: ty_where, attributes: ['sid', 'ri', 'ty', 'pi'], limit: fetch_lim })
				.then(rows => ({ ty, rows }));
		});

	const results = await Promise.all(query_tasks);

	for (const { ty, rows } of results) {
		const mapped = rows.map(row => ({ sid: row.sid, ri: row.ri, ty: row.ty, pi: row.pi }));
		ids_list = ids_list.concat(mapped);
		ids_list_per_ty[enums.ty_str[ty.toString()]] = mapped;
	}

	if (config.cse.allow_discovery_for_any === false) {
		// console.log("discovery result without access control: ", ids_list);

		// filter out discovered resource IDs when the originator has 'discovery' privilege
		//
		// Most of this loop is the same question asked again. A <contentInstance> has no
		// accessControlPolicyIDs of its own, so access_decision resolves its parent and decides
		// about the parent instead (Case B) -- meaning 150 CINs under one <container> produce 150
		// identical parent decisions, each of them a handful of DB round trips. The container
		// itself, when it is in the same result set, asks that very same question a 151st time.
		//
		// So the decision is memoized on what actually decides it: the parent's ri for a
		// parent-governed type, the resource's own ri otherwise. Those two keyspaces are the same
		// keyspace -- resourceIDs are unique across the CSE (TS-0001:9.6.1.3.1) -- which is why
		// the container and its children collapse onto one entry rather than two.
		//
		// An access decision is a function of three things: who is asking, which operation, and what
		// is being asked about. The key names all three. Only the third varies in this loop -- the
		// originator and DISCOVERY are fixed for the whole request -- but naming them costs a string
		// concat and stops the key from being correct only by accident. Someone reusing this loop for
		// more than one originator would otherwise get silently wrong answers.
		//
		// The third component is not the resource itself: it is whatever decides for it, which is the
		// parent's ri for a parent-governed type and the resource's own ri otherwise. Those are one
		// keyspace, since resourceIDs are unique across the CSE (TS-0001:9.6.1.3.1), so a container
		// and its content instances collapse onto a single entry rather than two.
		//
		// The Map lives and dies with one discovery request, and that is what makes it sound. It is
		// deliberately not a cache with a lifetime: promoting it to a TTL or to process scope would
		// mean an <accessControlPolicy> whose privileges changed keeps granting the old answer, with
		// no way to notice short of watching every <acp> and every acpi referencing one -- and the
		// full tuple in the key would not save it, because the privileges themselves are not part of
		// the tuple. Within a single request there is no such exposure, and consistency in fact
		// improves: the loop used to read policy state at 150 different instants and could put two
		// different policy states into one response.
		const decision_memo = new Map();
		const filtered_ids_list = [];
		for (const item of ids_list) {
			const ty_str = enums.ty_str[item.ty.toString()];
			const decided_by = NORM_RES_WITHOUT_ACPI.includes(ty_str) && item.pi ? item.pi : item.ri;
			const memo_key = `${req_prim.fr}${MEMO_KEY_SEP}${DISCOVERY_OP}${MEMO_KEY_SEP}${decided_by}`;

			let access_grant = decision_memo.get(memo_key);
			if (access_grant === undefined) {
				const tmp_req = { fr: req_prim.fr, ri: item.ri, to_ty: item.ty, op: DISCOVERY_OP };
				const tmp_resp = {};
				access_grant = await access_decision(tmp_req, tmp_resp);
				decision_memo.set(memo_key, access_grant);
			}

			if (access_grant) {
				filtered_ids_list.push(item);
			}
		}

		// Reusing a decision also skips the read that produced it, and that read was doing a
		// second job: access_decision answers false for a resource that is no longer there
		// (its NOT_FOUND guard), so the old loop confirmed every single resource still existed.
		// With decisions shared, only the first resource behind each key is confirmed, and one
		// deleted between the type queries above and this point could stay in the URI list.
		//
		// That race is not new -- a resource deleted just after its check was always going to be
		// listed, and a discovery result is a snapshot either way -- but the window went from
		// per-resource to per-request, so the existence check is put back explicitly. One indexed
		// query over the survivors replaces the N reads it stands in for.
		//
		// Existence is asked of the lookup table rather than of each type table, because that is
		// what the answer is about: discovery returns addresses (m2m:uril), and a row with no
		// lookup entry has no address to return. It also costs one query instead of up to 15.
		ids_list = filtered_ids_list.length > 0
			? await drop_vanished(filtered_ids_list)
			: filtered_ids_list;
	}

	// apply offset and limit to aggregated result
	const paged = ids_list.slice(ofst);
	const is_partial = paged.length > lim;
	const final_list = paged.slice(0, lim);

	// reconstruct ids_list_per_ty from final paginated list
	const final_per_ty = {};
	for (const item of final_list) {
		const ty_name = enums.ty_str[item.ty.toString()];
		if (!final_per_ty[ty_name]) final_per_ty[ty_name] = [];
		final_per_ty[ty_name].push(item);
	}

	return { ids_list: final_list, ids_list_per_ty: final_per_ty, is_partial };
}

function set_where_clause(req_prim) {
	// 
	// get filter conditions from request primitive
	//

	// singleton filter conditions
	const cra = req_prim.fc.cra; // created after
	const crb = req_prim.fc.crb; // created before
	const ms = req_prim.fc.ms; // modified since
	const us = req_prim.fc.us; // umodified since
	const exb = req_prim.fc.exb; // expire before
	const exa = req_prim.fc.exa; // expire after
	const stb = req_prim.fc.stb; // stateTag bigger
	const sts = req_prim.fc.sts; // stateTag smaller
	const lbl = req_prim.fc.lbl; // labels
	const lvl = req_prim.fc.lvl; // level
	const sza = req_prim.fc.sza; // size above
	const szb = req_prim.fc.szb; // size below
	const ofst = req_prim.fc.ofst; // offset (to-do: implement)

	// array filter condition
	const cty_list = req_prim.fc.cty; // contentType
	const cnd_list = req_prim.fc.cnd; // container definition of <flx>
	const or_list = req_prim.fc.or; // ontology reference of <smd>

	// generic 'attribute' condition
	const cr = req_prim.fc.cr;
	const rn = req_prim.fc.rn;
	const aei = req_prim.fc.aei;

	// geo-query conditions
	const geometry_type = req_prim.fc.gmty;
	const geo_function = req_prim.fc.gsf;
	const coordinates = req_prim.fc.geom;

	//
	// set SQL WHERE clause
	//

	const where = {};

	// Conditions on columns that only some type tables have. `where` is applied to every type
	// table, so putting a column-specific condition there makes the other tables' queries fail
	// with "column does not exist" — the same trap documented for lvl below. discovery_core
	// merges these into the matching type's query and skips the types without the column.
	const where_per_ty = {};

	// basically, target resources are all children of the discovery target
	where.sid = { [Op.like]: `${escape_like(req_prim.sid)}/%` };

	// cnd (containerDefinition) exists only on <flexContainer> (ty=28)
	if (cnd_list) {
		where_per_ty[28] = { cnd: { [Op.in]: Array.isArray(cnd_list) ? cnd_list : [cnd_list] } };
	}

	// lvl (level) is an upper bound on the depth *relative to the target* (TS-0001:8.1.2 — the
	// target itself is 0, its direct children are 1). The absolute depth that can be counted with
	// sid.split("/").length, on the other hand, starts at 1 for Mobius. So the target's absolute
	// depth (target_lvl) is added to convert lvl into an absolute bound — leave that conversion
	// out and it only happens to be right at the top of the tree and is wrong for nodes below.
	//
	// The lookup table is pre-populated with this absolute depth in its lvl column (Mobius=1), but
	// discovery does not query lookup: it queries each per-type table (cnt/cin/acp/...) separately
	// and those tables have no lvl column (measured 2026-07-26: `SELECT ... FROM cnt WHERE
	// lvl <= 3` → "column lvl does not exist"; using where.lvl as-is kills every per-type query
	// with an error and discovery returns an empty result). So the depth (slash count + 1) is
	// computed in SQL directly from the sid column, which all type tables have in common.
	//
	// Why this goes into the WHERE clause instead of being filtered afterwards in the application
	// (DEC-040): discovery truncates results at lim (200 by default), so filtering later lets deep
	// nodes fill the quota first and cuts off the shallow results that were actually wanted.
	if (lvl !== undefined) {
		const target_lvl = req_prim.sid.split("/").length;
		const sid_depth = Sequelize.fn(
			'array_length',
			Sequelize.fn('string_to_array', Sequelize.col('sid'), '/'),
			1
		);
		// Type coercion of lvl differs per binding — HTTP puts it through parseInt, but MQTT passes
		// the JSON.parse'd fc straight through and Joi does not write its coerced value back
		// either. With a string, target_lvl + lvl becomes concatenation instead of arithmetic
		// (e.g. 2 + "2" → "22"), making the bound effectively unlimited, so it is coerced to a
		// number explicitly here.
		const lvl_condition = Sequelize.where(sid_depth, { [Op.lte]: target_lvl + Number(lvl) });
		if (where[Op.and] && Array.isArray(where[Op.and])) {
			where[Op.and].push(lvl_condition);
		} else {
			where[Op.and] = [lvl_condition];
		}
	}

	// bigger than or smaller than
	if (cra || crb) {
		where.ct = {};
		if (cra) where.ct[Op.gt] = cra;
		if (crb) where.ct[Op.lt] = crb;
	}

	if (ms || us) {
		where.lt = {};
		if (us) where.lt[Op.gt] = us;
		if (ms) where.lt[Op.lt] = ms;
	}

	if (exa || exb) {
		where.et = {};
		if (exa) where.et[Op.gt] = exa;
		if (exb) where.et[Op.lt] = exb;
	}

	if (stb || sts) {
		where.st = {};
		if (stb) where.st[Op.gt] = stb;
		if (sts) where.st[Op.lt] = sts;
	}

	if (sza || szb) {
		where.sz = {};
		if (sza) where.sz[Op.gt] = sza;
		if (szb) where.sz[Op.lt] = szb;
	}

	// text match (full or partial)
	if (rn) {
		if (rn[0] === '*' && rn[rn.length - 1] === '*') {
			where.rn = { [Op.like]: `%${rn.slice(1, -1)}%` };
		} else if (rn[0] === '*') {
			where.rn = { [Op.like]: `%${rn.slice(1)}` };
		} else if (rn[rn.length - 1] === '*') {
			where.rn = { [Op.like]: `${rn.slice(0, -1)}%` };
		} else {
			where.rn = rn;
		}
	}
	if (cr) {
		where.rn = rn;
	}

	// in the list

	if (lbl) {
		where.lbl = { [Op.overlap]: [lbl] };
	}

	// geo-query 
	let has_geo_query = false;
	if (geometry_type && geo_function && coordinates) {
		try {
			// determine PostGIS geometry type based on geometry_type
			let postgis_geometry_type;
			switch (geometry_type) {
				case 1: // Point
					postgis_geometry_type = 'Point';
					break;
				case 2: // LineString  
					postgis_geometry_type = 'LineString';
					break;
				case 3: // Polygon
					postgis_geometry_type = 'Polygon';
					break;
				default:
					// The schema only lets 1..6 through, so a value arriving here is valid
					// per the spec but a type mobius4 does not implement (4..6). Silently
					// ignoring it repeats the failure seen with lvl — flag it so the caller
					// can respond with 5001.
					logger.warn({ geometry_type }, 'unsupported geometry type');
					return { where, where_per_ty, has_geo_query, unsupported_geo: true };
			}

			// create geometry object in GeoJSON format
			const geojson = {
				type: postgis_geometry_type,
				coordinates: coordinates
			};

			// select PostGIS function based on geo_function
			let postgis_function;
			switch (geo_function) {
				case 1: // Within
					postgis_function = 'ST_Within';
					break;
				case 2: // Contains
					postgis_function = 'ST_Contains';
					break;
				case 3: // Intersects
					postgis_function = 'ST_Intersects';
					break;
				default:
					// The contract of this function is { where, has_geo_query }. Returning
					// where alone leaves where undefined in the caller's destructuring, and
					// findAll({ where: undefined }) returns the entire table with no
					// conditions — the sid condition that narrows the query to the target
					// subtree disappears along with it. gsf is capped at 1..3 by the schema
					// so this is unreachable, but the contract is kept consistent with the
					// geometry_type branch.
					logger.warn({ geo_function }, 'unsupported geo function');
					return { where, where_per_ty, has_geo_query, unsupported_geo: true };
			}

			// add PostGIS spatial query condition (parameterized to prevent SQL injection)
			const spatialCondition = Sequelize.where(
				Sequelize.fn(postgis_function,
					Sequelize.col('loc'),
					Sequelize.fn('ST_GeomFromGeoJSON', JSON.stringify(geojson))
				),
				true
			);

			// add spatial query condition to WHERE object
			const andConditions = [];

			// add loc IS NOT NULL condition
			andConditions.push({ loc: { [Op.ne]: null } });

			// add spatial query condition
			andConditions.push(spatialCondition);

			// merge existing Op.and conditions if any
			if (where[Op.and] && Array.isArray(where[Op.and])) {
				// filter out invalid conditions
				const validExistingConditions = where[Op.and].filter(condition =>
					condition !== null && condition !== undefined &&
					(typeof condition === 'object' ? Object.keys(condition).length > 0 : true)
				);
				where[Op.and] = [...validExistingConditions, ...andConditions];
			} else {
				where[Op.and] = andConditions;
			}

			has_geo_query = true;
		} catch (error) {
			logger.error({ err: error, geometry_type, geo_function }, 'geo-query failed');
		}
	}

	return { where, where_per_ty, has_geo_query };
}

async function fu1_discovery(req_prim, resp_prim) {
	const { ids_list, is_partial } = await discovery_core(req_prim);
	let uril = [];
	if (!req_prim.drt) {
		req_prim.drt = 1;
	}

	if (req_prim.drt === 1) {
		uril = ids_list.map((item) => item.sid);
	} else if (req_prim.drt === 2) {
		uril = ids_list.map((item) => item.ri);
	} else {
		resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
		resp_prim.pc = { "m2m:dbg": "unsupported drt" };
		return resp_prim;
	}

	resp_prim.pc = { "m2m:uril": uril };

	// set pagination response parameters when result is partial
	if (is_partial) {
		const ofst = req_prim.fc.ofst || 0;
		const lim = req_prim.fc.lim || config.cse.discovery_limit;
		resp_prim.cnst = 1;          // partial
		resp_prim.cnot = ofst + lim; // offset for next request
	}

	return;
}

async function get_ty_from_unstructuredID(ri) {
	try {
		const result = await pool.query('SELECT ty FROM lookup WHERE ri = $1', [ri]);

		if (result.rows.length === 0) {
			return 0;
		} else {
			return result.rows[0].ty;
		}
	} catch (err) {
		logger.error({ err }, 'get_ty_from_unstructuredID failed');
		return 0;
	}
}

async function get_structuredID(to) {
	// if 'to' is already a structuredID, then return it immediately
	if (true == to.includes("/")) {
		return to;
	}

	// if 'to' is the csebase_rn, then return it immediately
	if (false == to.includes("/") && config.cse.csebase_rn == to) {
		return to;
	}

	// in other cases, 'to' is 'ri'
	try {
		result = await Lookup.findOne({ where: { ri: to } });
		return result.sid;
	} catch (err) {
		logger.error({ err }, 'get_structuredID failed');
		return null;
	}

}

async function get_unstructuredID(to) {
	// if 'to' is the csebase_rn or a structuredID, then return the 'ri' from the lookup table
	if (config.cse.csebase_rn == to || to.includes("/")) {
		try {
			const result = await Lookup.findOne({ where: { sid: to } });

			if (!result) {
				return null;
			} else {
				return result.ri;
			}
		} catch (err) {
			logger.error({ err }, 'get_unstructuredID failed');
			return null;
		}
	}
	// if 'to' is not a structuredID, then return it
	return to;
}

async function set_ri_sid(req_prim) {
	// [C6] serve from cache for repeated requests to the same resource path
	const cached = lookupCache.get(req_prim.to);
	if (cached) {
		req_prim.ri     = cached.ri;
		req_prim.sid    = cached.sid;
		req_prim.to_ty  = cached.to_ty;
		return { ri: cached.ri, sid: cached.sid, to_ty: cached.to_ty };
	}

	req_prim.ri = await get_unstructuredID(req_prim.to);

	if (!req_prim.ri) {
		// A concurrent CREATE may have registered a pending promise before its transaction commits.
		// Awaiting it avoids the 50ms blind sleep while still handling the READ COMMITTED race.
		const pendingCreates = require('./pending-creates');
		const pending = pendingCreates.get(req_prim.to);
		if (pending) {
			await pending;
			req_prim.ri = await get_unstructuredID(req_prim.to);
		}
		if (!req_prim.ri) {
			logger.warn({ sid: req_prim.to }, 'set_ri_sid: resource not found');
		}
	}

	req_prim.sid   = await get_structuredID(req_prim.to);
	req_prim.to_ty = await get_ty_from_unstructuredID(req_prim.ri);

	// The two lookups above are separate queries, so a concurrent DELETE can commit between
	// them: the first still sees the row and yields an ri, the second no longer does and yields
	// 0. An ri with no type is a resource that has just ceased to exist, and passing it on is
	// worse than reporting it gone — retrieve_a_res has no case for type 0, so it would answer
	// OK with no content and callers that read that content would throw.
	if (req_prim.ri && !req_prim.to_ty) {
		logger.warn({ sid: req_prim.to, ri: req_prim.ri },
			'set_ri_sid: resource disappeared between the id and type lookups');
		req_prim.ri = null;
	}

	if (req_prim.ri) {
		lookupCache.set(req_prim.to, { ri: req_prim.ri, sid: req_prim.sid, to_ty: req_prim.to_ty });
	}

	return { ri: req_prim.ri, sid: req_prim.sid, to_ty: req_prim.to_ty };
}


function get_a_new_rn(ty) {
	const rn = enums.ty_str[ty.toString()] + '-' + randomstring.generate(config.length.rn_random);

	// To-Do: check if the random one already exists, for safety

	return rn;
}

function get_mem_size(obj) {
	let bytes = 0;

	function sizeOf(obj) {
		if (obj !== null && obj !== undefined) {
			switch (typeof obj) {
				case "number":
					bytes += 8;
					break;
				case "string":
					bytes += obj.length * 2;
					break;
				case "boolean":
					bytes += 4;
					break;
				case "object":
					var objClass = Object.prototype.toString.call(obj).slice(8, -1);
					if (objClass === "Object" || objClass === "Array") {
						for (var key in obj) {
							if (!obj.hasOwnProperty(key)) continue;
							sizeOf(obj[key]);
						}
					} else bytes += obj.toString().length * 2;
					break;
			}
		}
		return bytes;
	}

	return sizeOf(obj);
}

// Resource types whose access decision is their parent's. TS-0001:9.6.1.3.2 draws the line at
// whether the *type* defines accessControlPolicyIDs at all: a type with no such definition is
// "governed in a different way, for example, the accessControlPolicy associated with the parent
// may apply". <contentInstance> is the explicit case (TS-0001:9.6.7: "inherits the same access
// control policies of the parent <container> resource, and does not have its own
// accessControlPolicyIDs attribute").
//
// <schedule> does not belong here: TS-0001:9.6.9 gives it accessControlPolicyIDs 0..1 RW, and a
// type that has the definition but no value takes the default access policy (custodian, else the
// creator) rather than the parent's. Left in place for now because moving it narrows access for
// existing <schedule> resources and mobius4 has no custodian attribute to implement the rest of
// the rule -- tracked separately rather than changed in passing.
//
// <acp> is deliberately absent: it answers from its own pvs (G-2).
//
// discovery_core memoizes its per-resource decisions by this list, so a type added here also
// changes which discovered resources share a decision. Both readers must see the same list.
const NORM_RES_WITHOUT_ACPI = ["cin", "sch"];

async function access_decision(req_prim, resp_prim) {
	let access_grant = false;
	const temp_resp = {};

	// for AE and CSE registration, it is always granted since Mobius does not support Service Subscription Profile
	if (req_prim.op === 1) {
		if (req_prim.ty === 2 || req_prim.ty === 16) {
			return true;
		}
	}

	// set int_cr request indicator as true for Case D.
	req_prim.int_cr_req = true;
	// deep copy of req_prim to temp_req (_pendingCreate contains a function, exclude it)
	const { _pendingCreate, ...cloneable } = req_prim;
	const temp_req = structuredClone(cloneable);

	// for virtual resources, access decision is different per resource type
	if (temp_req.vr) {
		if (temp_req.vr === 'la' || temp_req.vr === 'ol' || temp_req.vr === 'fopt') {
			temp_req.to = temp_req.to_parent;
			temp_req.to_ty = temp_req.parent_ty;
			temp_req.ri = temp_req.parent_ri;
		}
	}

	await retrieve_a_res(temp_req, temp_resp);
	// An empty pc is treated the same as an explicit NOT_FOUND. retrieve_a_res leaves pc unset
	// for a target whose type it has no case for, and then labels the answer OK, so the absence
	// of content is the only signal there is. Reading obj_key off it would throw and surface as
	// RSC 5000 — a server fault reported for a resource that is simply not there.
	if (temp_resp.rsc === enums.rsc_str['NOT_FOUND'] || !temp_resp.pc) {
		resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
		resp_prim.pc = temp_resp.pc || { 'm2m:dbg': 'target resource does not exist' };
		return false;
	}

	const obj_key = Object.keys(temp_resp.pc)[0];
	const ty = temp_resp.pc[obj_key].ty;
	const ty_str = enums.ty_str[ty];
	const acpi = JSONPath("$..acpi", temp_resp)[0];

	// to-do: what is this?
	// disable this so it is not applied for subsequent procedures, hence not exposed in responses
	req_prim.int_cr_req = false;

	// The administrator used to be granted every operation here, before any policy was read.
	// oneM2M has no such concept — privileges are expressed as <accessControlPolicy> resources —
	// so the grant now comes from the admin policy (config.cb.admin_acp, created by db/init.js)
	// like any other originator's, and this function no longer special-cases an identity.
	//
	// One consequence is worth knowing when reading the branches below: the administrator now
	// reaches a resource only through an <accessControlPolicy> that names it, or through the
	// creator fallback in Case D when the resource carries no acpi at all.

	// Case A.
	// special handling for <ACP> resource as a target 
	if (ty_str == "acp") {
		const pvs = temp_resp.pc["m2m:acp"].pvs;
		access_grant = await access_decision_privileges(req_prim.fr, req_prim.op, pvs);
		return access_grant;
	}

	// special handling for updating 'acpi' attribute of any resources
	if (req_prim.acpi_update === true) {
		// using req_prim, get the 'acpi' attribute from the target resource
		const acpi = JSONPath("$..acpi", temp_resp)[0];
		// using acpi, retrieve the ACP resource and get the 'pvs' attribute from the target resource
		for (const acp_id of acpi) {
			const ACP = require('../models/acp-model');
			const acp_ri = await get_unstructuredID(acp_id);
			const acp_model = await ACP.findByPk(acp_ri, { attributes: ['pvs'] });
			const pvs = acp_model ? acp_model.pvs : null;
			
			if (!pvs) continue;
			
			access_grant = await access_decision_privileges(req_prim.fr, req_prim.op, pvs);
			if (access_grant === true) {
				// console.log("access granted for updating 'acpi' attribute of ", acpi_id);
				return true;
			}
		}
		return false;
	}

	// Case B.
	// special handling for normal resources types that do not define 'acpi' attribute (e.g. cin)
	// use acpi from the parent of the target resource
	if (NORM_RES_WITHOUT_ACPI.includes(ty_str)) {
		const pi = JSONPath("$..pi", temp_resp)[0];
		const parent_ret_req = {};

		try {
			// prepare the temp_req for the parent resource retrieval
			// get the 'ty' of the parent resource by Lookup table
			const result = await Lookup.findOne({
				where: { ri: pi },
				attributes: ['ty']
			});
			if (result) {
				parent_res = result.toJSON();
				parent_ret_req.to_ty = parent_res.ty;
			}

			parent_ret_req.ri = pi;

			// retireve the parent of the target resource
			await retrieve_a_res(parent_ret_req, temp_resp);
		} catch (err) {
			resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
			resp_prim.pc = { 'm2m:dbg': 'target resource does not exist' };
			return false;
		}
		// access decision for the parent of the target resource
		//
		// 'op' is load-bearing. access_decision_acpi and access_decision_privileges both switch
		// on the operation to pick the acop bit, so an undefined op matches no case and every
		// rule evaluates to false. Until 2026-08-06 this object carried to_ty, ri and fr only,
		// which meant a <contentInstance> under a container carrying any acpi was refused to
		// everyone -- the administrator included -- and dropped from every discovery result,
		// contradicting TS-0001:9.6.7 ("inherits the same access control policies of the parent
		// <container>"). It went unnoticed because a container created without an acpi falls
		// through to the creator comparison instead, and fr was carried, so the ordinary shape
		// of an AE reading back its own writes kept working.
		// Pinned by test/access-control.test.js "the operation is carried into the parent's
		// decision, not assumed".
		const parent_access_req = {
			to_ty: parent_ret_req.to_ty,
			ri: parent_ret_req.ri,
			op: req_prim.op,
			fr: req_prim.fr
		}
		const parent_access = await access_decision(parent_access_req, temp_resp);

		return parent_access;
	}

	// Case C. target is virtual resource type => use parent's access privileges
	//         in this case, 'ri' input param is already set as parent's ri when this function is called

	if (req_prim.vr === "fopt") {
		await grp.retrieve_a_grp(temp_req, temp_resp);
		
		const grp_res = temp_resp.pc["m2m:grp"];
		if (grp_res.macp) {
			access_grant = await access_decision_acpi(req_prim.fr, req_prim.op, grp_res.macp);
			logger.debug({ access_grant }, 'access_grant for fopt');
			return access_grant;
		}
		// if 'macp is empty, then move on to apply the 'acpi' of the parent group
	}

	if (req_prim.vr == "rpt") {
		access_grant = await dst.retrievalPoint_access_control(req_prim);
		if (false == access_grant) {
			resp_prim.rsc = enums.rsc_str["ACCESS_DENIED"];
			resp_prim.pc = {
				"m2m:dbg":
					"there is no <pur> resource to use the target <dst> resource",
			};
		}
		return access_grant;
	}

	// Case D. target is normal resource type that DOES define 'acpi' attribute (e.g. cnt)
	//         use acpi from the target resource itself
	// Therefore, case C and D share the same code

	// 1. try access decision by <ACP> resouces
	// const acpi = JSONPath("$..acpi", temp_resp)[0];

	// use <ACP> resources when 'acpi' is not empty
	if (acpi != null && acpi.length != 0) {
		access_grant = await access_decision_acpi(req_prim.fr, req_prim.op, acpi);
	}
	// use internally kept 'creator' info when 'acpi' is empty
	else {
		const int_cr = JSONPath("$..int_cr", temp_resp)[0];

		logger.debug({ int_cr, fr: req_prim.fr }, 'comparing creator and originator');

		if (req_prim.fr == int_cr) {
			access_grant = true;
		}
	}

	return access_grant;
}

function access_decision_acr_list(acr_list, originator, operation) {
	for (const acr of acr_list) {
		if (
			acr["acor"].includes(originator) ||
			acr["acor"].includes("all") ||
			acr["acor"].includes("*")
		) {
			const acop_binary = parseInt(acr["acop"]).toString(2).padStart(6, "0");

			// acop_binary example: '000111' that has CREATE, RETRIEVE, UPDATE rights
			switch (operation) {
				// CREATE
				case 1:
					if ("1" === acop_binary[6 - 1]) {
						return true;
					}
					break;
				// RETRIEVE
				case 2:
					if ("1" === acop_binary[6 - 2]) {
						return true;
					}
					break;
				// UPDATE
				case 3:
					if ("1" === acop_binary[6 - 3]) {
						return true;
					}
					break;
				// DELETE
				case 4:
					if ("1" === acop_binary[6 - 4]) {
						return true;
					}
					break;
				// NOTIFY
				case 5:
					if ("1" === acop_binary[6 - 5]) {
						return true;
					}
					break;
				// DISCOVERY
				case 6:
					if ("1" === acop_binary[6 - 6]) {
						return true;
					}
					break;
			}
		}
	}

	return false;
}

async function access_decision_acpi(originator, operation, acp_id_list) {
	if (acp_id_list) {
		for (const acp_id of acp_id_list) {
			const acp_ri = await get_unstructuredID(acp_id); // make sure that this is structured ID
			const acp_model = await ACP.findOne({
				where: { ri: acp_ri },
				attributes: ['pv']
			});
			if (!acp_model) {
				return false;
			}

			const pv = acp_model.pv;
			const acr_list = JSONPath("$..acr", pv)[0];
			for (const acr of acr_list) {
				if (
					acr["acor"].includes(originator) ||
					acr["acor"].includes("all") ||
					acr["acor"].includes("*")
				) {
					const acop_binary = parseInt(acr["acop"]).toString(2).padStart(6, "0");

					// acop_binary example: '000111' that has CREATE, RETRIEVE, UPDATE rights
					switch (operation) {
						// CREATE
						case 1:
							if ("1" === acop_binary[6 - 1]) {
								return true;
							}
							break;
						// RETRIEVE
						case 2:
							if ("1" === acop_binary[6 - 2]) {
								return true;
							}
							break;
						// UPDATE
						case 3:
							if ("1" === acop_binary[6 - 3]) {
								return true;
							}
							break;
						// DELETE
						case 4:
							if ("1" === acop_binary[6 - 4]) {
								return true;
							}
							break;
						// NOTIFY
						case 5:
							if ("1" === acop_binary[6 - 5]) {
								return true;
							}
							break;
						// DISCOVERY
						case 6:
							if ("1" === acop_binary[6 - 6]) {
								return true;
							}
							break;
					}
				}
			}
		}
	}

	// otherwise, access rejected
	return false;
}

async function access_decision_privileges(originator, operation, pvs) {
	const acr_list = pvs["acr"];
	for (const acr of acr_list) {
		if (
			acr["acor"].includes(originator) ||
			acr["acor"].includes("all") ||
			acr["acor"].includes("*")
		) {
			const acop_binary = parseInt(acr["acop"]).toString(2).padStart(6, "0");

			// acop_binary example: '000111' that has CREATE, RETRIEVE, UPDATE rights
			switch (operation) {
				// CREATE
				case 1:
					if ("1" == acop_binary[6 - 1]) {
						return true;
					}
					break;
				// RETRIEVE
				case 2:
					if ("1" == acop_binary[6 - 2]) {
						return true;
					}
					break;
				// UPDATE
				case 3:
					if ("1" == acop_binary[6 - 3]) {
						return true;
					}
					break;
				// DELETE
				case 4:
					if ("1" == acop_binary[6 - 4]) {
						return true;
					}
					break;
				// NOTIFY
				case 5:
					if ("1" == acop_binary[6 - 5]) {
						return true;
					}
					break;
				// DISCOVERY
				case 6:
					if ("1" == acop_binary[6 - 6]) {
						return true;
					}
					break;
			}
		}
	}

	// otherwise, access rejected
	return false;
}

async function expired_resource_cleanup() {
	// get all resources that are expired
	const timestamp_format = config.get('cse.timestamp_format');
	const currentTime = moment.utc().format(timestamp_format);

	const result = await Lookup.findAll({
		where: {
			et: {
				[Op.lt]: currentTime
			}
		},
		attributes: ['ri', 'ty', 'sid']
	});

	// convert into an array of objects carrying the ri and ty attributes
	const expired_res_list = result.map(resource => ({
		ri: resource.ri,
		ty: resource.ty,
		sid: resource.sid
	}));

	logger.info({ count: expired_res_list.length }, 'expired resource cleanup started');
	await Promise.all(expired_res_list.map(async (res) => {
		// 'res' include 'ri', 'ty', 'sid'
		logger.info({ sid: res.sid }, 'deleting expired resource');
		await delete_resources([res]);

		// get descendant resources of the expired resource
		const child_res_list = await Lookup.findAll({
			where: { sid: { [Op.like]: `${res.sid}/%` } },
			attributes: ['ri', 'ty', 'sid'],
		});

		await Promise.all(child_res_list.map(async (child_res) => {
			logger.debug({ sid: child_res.sid }, 'deleting descendant of expired resource');
			await delete_resources([child_res]);
		}));
	}));

	return expired_res_list;
}

function invalidateLookupCache(key) {
	lookupCache.del(key);
}

module.exports = {
	set_ri_sid,
	create_a_lookup_record,
	create_a_res,
	retrieve_a_res,
	rcn48_retrieve,
	update_a_res,
	delete_a_res,
	delete_resources,
	fu1_discovery,
	discovery_core,
	get_a_new_rn,
	get_ty_from_unstructuredID,
	get_structuredID,
	get_unstructuredID,
	get_mem_size,
	access_decision,
	expired_resource_cleanup,
	virtual_res_names,
	invalidateLookupCache,
}