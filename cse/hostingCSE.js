const { JSONPath } = require("jsonpath-plus");
const config = require("config");
const enums = require("../config/enums");
const randomstring = require("randomstring");
const jose = require("jose");
const pool = require('../db/connection');
const moment = require('moment');

const { Op, Sequelize } = require('sequelize');
const Lookup = require('../models/lookup-model');
// oneM2M standard resources
const ACP = require('../models/acp-model');
const AE = require('../models/ae-model');
const CIN = require('../models/cin-model');
const CNT = require('../models/cnt-model');
const CSR = require('../models/csr-model');
// const FLX = require('../models/flx-model');
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
// const flx = require("./resources/flx");
const noti = require("./noti");

// below are not specified in oneM2M yet
const mrp = require("./resources/mrp"); // <modelRepo>
const mmd = require("./resources/mmd"); // <mlModel>
const mdp = require("./resources/mdp"); // <modelDeploymentList>
const dpm = require("./resources/dpm"); // <modelDeployment>
const dsp = require("./resources/dsp"); // <datasetPolicy>
const dts = require("./resources/dts"); // <dataset>
const dsf = require("./resources/dsf"); // <datasetFragment>

const virtual_res_names = ["fopt", "la", "ol"]; // fopt shall come first in the list


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
			loc: loc || null, // geometry 객체 또는 null
		});
	} catch (err) {
		console.error("Error inserting lookup record:", err);
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
		// case 28:
		//   await flx.create_a_flx(req_prim, resp_prim);
		//   break;
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
		noti.check_and_send_noti(req_prim, resp_prim_copy, "create");
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
		// case 28:
		//   await flx.retrieve_a_flx(req_prim, resp_prim);
		//   break;
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
		console.log("\n\npartial_res: ", partial_res);

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
			// if ("flx" === ty_str) {
			//   temp_reses = await aggr_reses_per_ty(req_prim, ri_list, "flx");
			//   // each <flx> specialization has different object key
			//   if (temp_reses.length) {
			//     for (flx_obj of temp_reses) {
			//       let obj_key = Object.keys(flx_obj);
			//       if (aggr_res[target_res_key][obj_key] == undefined) {
			//         aggr_res[target_res_key][obj_key] = [];
			//       }
			//       aggr_res[target_res_key][obj_key].push(flx_obj[obj_key]);
			//     }
			//   }
			// }
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
				// case "flx":
				//   await flx.retrieve_a_flx(tmp_req_prim, tmp_resp_prim);
				//   // object keys are different for flexContainer specializations
				//   return tmp_resp_prim.pc;

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
		// case 28:
		//   await flx.update_a_flx(req_prim, resp_prim);
		//   break;
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

		// after creation, check and send notification(s) if needed
		noti.check_and_send_noti(req_prim, resp_prim, "update");
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
	// wait for target resource deletion before returning the deleted resource
	const tmp_resp = {};
	await retrieve_a_res(req_prim, tmp_resp);
	if (tmp_resp.pc) {
		delete_resources([{ ri: req_prim.ri, ty: req_prim.to_ty }]);
	}
	resp_prim.pc = tmp_resp.pc;
	resp_prim.rsc = enums.rsc_str["DELETED"];

	// to-do
	// when delete a <cin> resource, update the parent <cnt> resource's 'cbs' attribute
	if (req_prim.to_ty === 4 && req_prim.int_cr_req !== true) {
		const parent_cnt_ri = tmp_resp.pc['m2m:cin'].pi;
		const cs = tmp_resp.pc['m2m:cin'].cs;

		const cnt_res = await CNT.findByPk(parent_cnt_ri);
		console.log("cnt_res: ", JSON.stringify(cnt_res, null, 2));
		cnt_res.cni--;
		cnt_res.cbs = cnt_res.cbs - cs;

		cnt_res.save();
	}

	//
	// delete child/decendant resources
	//

	// child_res_list is a list of resource where 'sid' in all records in 'lookup' table starts with 'sid' variable here
	const child_res_list = await Lookup.findAll({
		where: { sid: { [Op.like]: `${req_prim.sid}/%` } },
		attributes: ['ri', 'ty'],
	});

	// delete decendant resources asynchronously
	delete_resources(child_res_list);

	return;
};

async function delete_resources(res_list) {
	try {
		for (const res of res_list) {
			// delete lookup record
			await Lookup.destroy({ where: { ri: res.ri } });

			// delete resource in each table
			switch (res.ty) {
				case 1:
					await ACP.destroy({ where: { ri: res.ri } });
					break;
				case 2:
					await AE.destroy({ where: { ri: res.ri } });
					break;
				case 3:
					await CNT.destroy({ where: { ri: res.ri } });
					break;
				case 4:
					await CIN.destroy({ where: { ri: res.ri } });
					break;
				case 9:
					await GRP.destroy({ where: { ri: res.ri } });
					break;
				case 16:
					await CSR.destroy({ where: { ri: res.ri } });
					break;
				case 23:
					await SUB.destroy({ where: { ri: res.ri } });
					break;
				// case 24:
				//   await SMD.destroy({ where: { ri: child_res.ri } });
				//   break;
				// case 28:
				//   await FLX.destroy({ where: { ri: child_res.ri } });
				//   break;
				case 101:
					await MRP.destroy({ where: { ri: res.ri } });
					break;
				case 102:
					await MMD.destroy({ where: { ri: res.ri } });
					break;
				case 103:
					await MDP.destroy({ where: { ri: res.ri } });
					break;
				case 104:
					await DPM.destroy({ where: { ri: res.ri } });
					break;
				case 105:
					await DSP.destroy({ where: { ri: res.ri } });
					break;
				case 106:
					await DTS.destroy({ where: { ri: res.ri } });
					break;
				case 107:
					await DSF.destroy({ where: { ri: res.ri } });
					break;
			}
		}
	} catch (error) {
		console.error('Error during resource deletion:', error);
		// Additional error handling can be added here if needed
	}
}

async function discovery_core(req_prim) {
	let ids_list = []; // this is for discovery response
	let ids_list_per_ty = {}; // this is for rcn = 4 or rcn = 8 response

	const { where, has_geo_query } = set_where_clause(req_prim);

	const lim = req_prim.fc.lim || config.cse.discovery_limit;
	const ty_list = req_prim.fc.ty || Object.keys(enums.ty_str);


	for (const ty_str of ty_list) {
		const ty = parseInt(ty_str);
		let temp_list = [];

		// new resource type guide
		// add new resource type handling here
		if (1 === ty && !has_geo_query) {
			temp_list = await ACP.findAll({
				where: where,
				attributes: ['sid', 'ri', 'ty'],
				limit: lim,
			});
			ids_list = ids_list.concat(temp_list.map(row => ({ sid: row.sid, ri: row.ri, ty: row.ty })));
			ids_list_per_ty[enums.ty_str[ty.toString()]] = temp_list;
			continue;
		}
		if (2 === ty) {
			temp_list = await AE.findAll({
				where: where,
				attributes: ['sid', 'ri', 'ty'],
				limit: lim,
			});
			ids_list = ids_list.concat(temp_list.map(row => ({ sid: row.sid, ri: row.ri, ty: row.ty })));
			ids_list_per_ty[enums.ty_str[ty.toString()]] = ids_list;
			continue;
		}
		if (3 === ty) {
			temp_list = await CNT.findAll({
				where: where,
				attributes: ['sid', 'ri', 'ty'],
				limit: lim,
			});
			ids_list = ids_list.concat(temp_list.map(row => ({ sid: row.sid, ri: row.ri, ty: row.ty })));
			ids_list_per_ty[enums.ty_str[ty.toString()]] = ids_list;
			continue;
		}
		if (4 === ty) {
			temp_list = await CIN.findAll({
				where: where,
				attributes: ['sid', 'ri', 'ty'],
				limit: lim,
			});
			ids_list = ids_list.concat(temp_list.map(row => ({ sid: row.sid, ri: row.ri, ty: row.ty })));
			ids_list_per_ty[enums.ty_str[ty.toString()]] = ids_list;
			continue;
		}
		if (9 === ty && !has_geo_query) {
			temp_list = await GRP.findAll({
				where: where,
				attributes: ['sid', 'ri', 'ty'],
				limit: lim,
			});
			ids_list = ids_list.concat(temp_list.map(row => ({ sid: row.sid, ri: row.ri, ty: row.ty })));
			ids_list_per_ty[enums.ty_str[ty.toString()]] = ids_list;
			continue;
		}
		if (16 === ty) {
			temp_list = await CSR.findAll({
				where: where,
				attributes: ['sid', 'ri', 'ty'],
				limit: lim,
			});
			ids_list = ids_list.concat(temp_list.map(row => ({ sid: row.sid, ri: row.ri, ty: row.ty })));
			ids_list_per_ty[enums.ty_str[ty.toString()]] = ids_list;
			continue;
		}
		if (23 === ty && !has_geo_query) {
			temp_list = await SUB.findAll({
				where: where,
				attributes: ['sid', 'ri', 'ty'],
				limit: lim,
			});
			ids_list = ids_list.concat(temp_list.map(row => ({ sid: row.sid, ri: row.ri, ty: row.ty })));
			ids_list_per_ty[enums.ty_str[ty.toString()]] = ids_list;
			continue;
		}
		// if (24 === ty) {
		//   temp_list = await SMD.findAll({
		//     where: where,
		//     attributes: ['sid', 'ri'],
		//     limit: lim,
		//   });
		//   ids_list = ids_list.concat(temp_list.map(row => ({ sid: row.sid, ri: row.ri })));
		//   ids_list_per_ty[enums.ty_str[ty.toString()]] = ids_list;
		//   continue;
		// }
		// if (28 === ty) {
		//   temp_list = await FLX.findAll({
		//     where: where,
		//     attributes: ['sid', 'ri'],
		//     limit: lim,
		//   });
		//   ids_list = ids_list.concat(temp_list.map(row => ({ sid: row.sid, ri: row.ri })));
		//   ids_list_per_ty[enums.ty_str[ty.toString()]] = ids_list;
		//   continue;
		// }
		if (101 === ty && !has_geo_query) {
			temp_list = await MRP.findAll({
				where: where,
				attributes: ['sid', 'ri', 'ty'],
				limit: lim,
			});
			ids_list = ids_list.concat(temp_list.map(row => ({ sid: row.sid, ri: row.ri, ty: row.ty })));
			ids_list_per_ty[enums.ty_str[ty.toString()]] = ids_list;
			continue;
		}
		if (102 === ty && !has_geo_query) {
			temp_list = await MMD.findAll({
				where: where,
				attributes: ['sid', 'ri', 'ty'],
				limit: lim,
			});
			ids_list = ids_list.concat(temp_list.map(row => ({ sid: row.sid, ri: row.ri, ty: row.ty })));
			ids_list_per_ty[enums.ty_str[ty.toString()]] = ids_list;
			continue;
		}
		if (103 === ty && !has_geo_query) {
			temp_list = await MDP.findAll({
				where: where,
				attributes: ['sid', 'ri', 'ty'],
				limit: lim,
			});
			ids_list = ids_list.concat(temp_list.map(row => ({ sid: row.sid, ri: row.ri, ty: row.ty })));
			ids_list_per_ty[enums.ty_str[ty.toString()]] = ids_list;
			continue;
		}
		if (104 === ty && !has_geo_query) {
			temp_list = await DPM.findAll({
				where: where,
				attributes: ['sid', 'ri', 'ty'],
				limit: lim,
			});
			ids_list = ids_list.concat(temp_list.map(row => ({ sid: row.sid, ri: row.ri, ty: row.ty })));
			ids_list_per_ty[enums.ty_str[ty.toString()]] = ids_list;
			continue;
		}
		if (105 === ty && !has_geo_query) {
			temp_list = await DSP.findAll({
				where: where,
				attributes: ['sid', 'ri', 'ty'],
				limit: lim,
			});
			ids_list = ids_list.concat(temp_list.map(row => ({ sid: row.sid, ri: row.ri, ty: row.ty })));
			ids_list_per_ty[enums.ty_str[ty.toString()]] = ids_list;
			continue;
		}
		if (106 === ty && !has_geo_query) {
			temp_list = await DTS.findAll({
				where: where,
				attributes: ['sid', 'ri', 'ty'],
				limit: lim,
			});
			ids_list = ids_list.concat(temp_list.map(row => ({ sid: row.sid, ri: row.ri, ty: row.ty })));
			ids_list_per_ty[enums.ty_str[ty.toString()]] = ids_list;
			continue;
		}
		if (107 === ty && !has_geo_query) {
			temp_list = await DSF.findAll({
				where: where,
				attributes: ['sid', 'ri', 'ty'],
				limit: lim,
			});
			ids_list = ids_list.concat(temp_list.map(row => ({ sid: row.sid, ri: row.ri, ty: row.ty })));
			ids_list_per_ty[enums.ty_str[ty.toString()]] = ids_list;
			continue;
		}
	}

	if (config.cse.allow_discovery_for_any === false) {
		// console.log("discovery result without access control: ", ids_list);

		// filter out discovered resource IDs when the originator has 'discovery' privilege
		const filtered_ids_list = [];
		for (const item of ids_list) {
			const tmp_req = { fr: req_prim.fr, ri: item.ri, to_ty: item.ty, op: 6 };
			const tmp_resp = {};
			const access_grant = await access_decision(tmp_req, tmp_resp);

			if (access_grant) {
				filtered_ids_list.push(item);
			}
		}
		ids_list = filtered_ids_list;
	}

	return { ids_list, ids_list_per_ty };
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
	// const cnd_list = req_prim.fc.cnd; // container definition of <flx>
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

	// basically, target resources are all children of the discovery target
	where.sid = { [Op.like]: `${req_prim.sid}/%` };

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
					console.warn(`Unsupported geometry type: ${geometry_type}`);
					return where;
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
					console.warn(`Unsupported geo function: ${geo_function}`);
					return where;
			}

			// add PostGIS spatial query condition
			const spatialCondition = Sequelize.literal(`${postgis_function}(loc, ST_GeomFromGeoJSON('${JSON.stringify(geojson)}'))`); // loc is the geometry column

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
			console.error('Geo-query error:', error);
			console.error('Geometry data:', { geometry_type, geo_function, coordinates });
		}
	}

	return { where, has_geo_query };
}

async function fu1_discovery(req_prim, resp_prim) {
	const { ids_list } = await discovery_core(req_prim);
	let uril = [];
	if (!req_prim.drt) {
		req_prim.drt = 1;
	}

	if (req_prim.drt === 1) {
		uril = ids_list.map((item) => {
			// console.log("item", item);
			return item.sid;
		});
	} else if (req_prim.drt === 2) {
		uril = ids_list.map((item) => {
			return item.ri;
		});
	} else {
		resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
		resp_prim.pc = { "m2m:dbg": "unsupported drt" };
		return resp_prim;
	}

	if (req_prim.lim) {
		uril = uril.slice(0, req_prim.lim);
	}

	resp_prim.pc = { "m2m:uril": uril };

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
		console.error('Error in get_ty_from_unstructuredID:', err);
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
		console.error(err);
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
			console.error('Error in get_unstructuredID:', err);
			return null;
		}
	}
	// if 'to' is not a structuredID, then return it
	return to;
}

async function set_ri_sid(req_prim) {
	req_prim.ri = await get_unstructuredID(req_prim.to);
	req_prim.sid = await get_structuredID(req_prim.to);
	req_prim.to_ty = await get_ty_from_unstructuredID(req_prim.ri);

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

async function access_decision(req_prim, resp_prim) {
	// resource types in this array will use parent's aceess privileges, so this does not include 'acp'
	const norm_res_without_acpi = ["cin", "sch"];
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
	// deep copy of req_prim to temp_req
	const temp_req = JSON.parse(JSON.stringify(req_prim));

	// for virtual resources, access decision is different per resource type
	if (temp_req.vr) {
		if (temp_req.vr === 'la' || temp_req.vr === 'ol' || temp_req.vr === 'fopt') {
			temp_req.to = temp_req.to_parent;
			temp_req.to_ty = temp_req.parent_ty;
			temp_req.ri = temp_req.parent_ri;
		}
	}

	await retrieve_a_res(temp_req, temp_resp);
	if (temp_resp.rsc === enums.rsc_str['NOT_FOUND']) {
		resp_prim.rsc = temp_resp.rsc;
		resp_prim.pc = temp_resp.pc;
		return false;
	}

	const obj_key = Object.keys(temp_resp.pc)[0];
	const ty = temp_resp.pc[obj_key].ty;
	const ty_str = enums.ty_str[ty];

	// to-do: what is this?
	// disable this so it is not applied for subsequent procedures, hence not exposed in responses
	req_prim.int_cr_req = false;

	// Cheat-key for system admin
	if (req_prim.fr === config.cse.admin) {
		console.log("access granted as the system admin\n");
		return true;
	}

	// Case A.
	// special handling for <ACP> resource as a target
	if (ty_str == "acp") {
		const pvs = temp_resp.pc["m2m:acp"].pvs;
		access_grant = await access_decision_acp_pvs(req_prim.fr, req_prim.op, pvs);
		return access_grant;
	}

	// Case B.
	// special handling for normal resources types that do not define 'acpi' attribute (e.g. cin)
	// use acpi from the parent of the target resource
	if (norm_res_without_acpi.includes(ty_str)) {
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
		const parent_access_req = {
			to_ty: parent_ret_req.to_ty,
			ri: parent_ret_req.ri,
			fr: req_prim.fr
		}
		const parent_access = await access_decision(parent_access_req, temp_resp);

		return parent_access;
	}

	// Case C. target is virtual resource type => use parent's access privileges
	//         in this case, 'ri' input param is already set as parent's ri when this function is called

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
	const acpi = JSONPath("$..acpi", temp_resp)[0];

	// use <ACP> resources when 'acpi' is not empty
	if (acpi != null && acpi.length != 0) {
		access_grant = await access_decision_acp_pv(req_prim.fr, req_prim.op, acpi);
	}
	// use internally kept 'creator' info when 'acpi' is empty
	else {
		const int_cr = JSONPath("$..int_cr", temp_resp)[0];

		console.log(
			`comparing internally kept creator (${int_cr}) and originator (${req_prim.fr})`
		);

		if (req_prim.fr == int_cr) {
			access_grant = true;
		}
	}

	return access_grant;
}

let request = require("sync-request");

async function parse_dynamic_auth_resp(dap, req_seci) {
	let resp = request("POST", dap, {
		headers: {
			Accept: "application/json",
			"X-M2M-RI": 12345,
			"X-M2M-Origin": config.cse.cse_id,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(req_seci),
	});

	console.log(JSON.stringify(JSON.parse(resp.getBody()), null, 2));
	const seci = JSON.parse(resp.getBody())["m2m:seci"];

	let dai = null,
		tokens = null;
	if (seci) {
		if (seci.dres.dai) {
			dai = seci.dres.dai;
			console.log(
				"\n\ndynamicACPInfo from DAS: ",
				JSON.stringify(dai, null, 2)
			);
		}
		if (seci.dres.tkns) {
			tokens = seci.dres.tkns;
			// for now, supports JWE only
			tokens = tokens.map((token) => {
				return JSON.parse(
					jose.JWE.decrypt(token, config.das.private_key, {
						complete: true,
					}).cleartext.toString()
				);
			});
			console.log(
				"\n\ndecrypted first token from DAS: ",
				JSON.stringify(tokens, null, 2)
			);
		}
	}

	return { dai, tokens };
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

async function access_decision_acp_pv(originator, operation, acp_id_list) {
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

async function access_decision_acp_pvs(originator, operation, pvs) {
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

	// ri와 ty 속성을 가지는 객체 배열로 변환
	const expired_res_list = result.map(resource => ({
		ri: resource.ri,
		ty: resource.ty,
		sid: resource.sid
	}));

	console.log("expired_res_list", expired_res_list);
	expired_res_list.forEach(async (res) => {
		// 'res' include 'ri', 'ty', 'sid'
		console.log("deleting expired resource: ", res.sid);
		await delete_resources([res]);

		// get decendant resources of the expired resource
		const child_res_list = await Lookup.findAll({
			where: { sid: { [Op.like]: `${res.sid}/%` } },
			attributes: ['ri', 'ty', 'sid'],
		});

		child_res_list.forEach(async (child_res) => {
			console.log("deleting decendant resource of expired resource: ", child_res.sid);
			await delete_resources([child_res]);
		});
	});

	return expired_res_list;
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
}