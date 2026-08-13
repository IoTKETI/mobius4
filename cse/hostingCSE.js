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
const { not_obsolete_where } = require('./utils');
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
		// A generated name still has to be free. A collision is unlikely but not impossible, and
		// the failure it produced was the confusing kind: the unique index on lookup.sid rejected
		// the insert and the client was told 4105 CONFLICT about a name it never chose and cannot
		// change. Retrying costs one indexed lookup on a path that is already doing several.
		res_rep.rn = await get_a_free_rn(ty, req_prim.sid);
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

// Resource types whose representations aggr_reses_per_ty knows how to fetch. Anything else
// discovery finds is skipped here rather than silently returned half-built.
const AGGREGATABLE_TYPES = ["acp", "ae", "cnt", "cin", "grp", "sub", "flx"];

/**
 * Fetches the representation of every discovered descendant and indexes it by ri, keeping the
 * envelope key each resource actually carries.
 *
 * The key is not always "m2m:<type>": a <flexContainer> specialization may use a namespace other
 * than m2m (TS-0004:7.4.37.1), so flx returns its whole pc and the key is read off it. Hardcoding
 * "m2m:" here would make every specialization disappear from the response.
 */
async function fetch_nodes_by_ri(req_prim, ids_list_per_ty) {
	const node_by_ri = new Map();

	for (const ty_str of Object.keys(ids_list_per_ty)) {
		if (!AGGREGATABLE_TYPES.includes(ty_str)) continue;
		const items = ids_list_per_ty[ty_str];
		const reses = await aggr_reses_per_ty(req_prim, items.map((i) => i.ri), ty_str);

		reses.forEach((res, idx) => {
			if (!res) return; // vanished between discovery and retrieval
			const item = items[idx];
			const is_flx = ty_str === "flx";
			const key = is_flx ? Object.keys(res)[0] : `m2m:${ty_str}`;
			const body = is_flx ? res[Object.keys(res)[0]] : res;
			node_by_ri.set(item.ri, { key, body, sid: item.sid, pi: item.pi });
		});
	}

	return node_by_ri;
}

/**
 * Nests the fetched descendants under their own parents and returns the direct children of the
 * target, in a stable order.
 *
 * TS-0004:8.4.3 EXAMPLE 3 is the shape being built:
 *     "m2m:cnt":[{"rn":"container1", ...},
 *                {"rn":"container2", ..., "m2m:sub":[{"rn":"sub1", ...}]}]
 * with the accompanying prose — "the subscription resource (sub1) appears nested inside its
 * parent (container2)". The XSD backs it: CDT-<resourceType>.xsd refers to child resources by
 * *global* element reference, so a child carries its own Child Resources block.
 *
 * A node whose pi is not among the fetched nodes is a direct child of the target (the target
 * itself is never in the discovery result). Ordering is by sid so that a resumed request sees
 * the same sequence — JSON member order itself is immaterial (TS-0004:8.4.2), but pagination
 * needs a deterministic sequence to offset into.
 */
function build_nested(node_by_ri) {
	const attach = (parent_body, child) => {
		if (!parent_body[child.key]) parent_body[child.key] = [];
		parent_body[child.key].push(child.body);
	};

	const direct_children = [];
	for (const node of node_by_ri.values()) {
		const parent = node_by_ri.get(node.pi);
		if (parent) attach(parent.body, node);
		else direct_children.push(node);
	}

	direct_children.sort((a, b) => (a.sid < b.sid ? -1 : a.sid > b.sid ? 1 : 0));
	return direct_children;
}

/** How many resources a subtree occupies, counting the direct child itself. */
function subtree_size(node) {
	let n = 1;
	for (const [k, v] of Object.entries(node.body)) {
		if (!k.includes(":") || !Array.isArray(v)) continue;
		for (const child of v) n += subtree_size({ body: child });
	}
	return n;
}

/**
 * Applies offset and limit to whole subtrees.
 *
 * TS-0001:8.1.2: "If a direct child resource and all its descendants cannot be included in the
 * returned content due to size limitations imposed by the hosting CSE then the direct child
 * resource shall not be included in the response." So a subtree goes in whole or not at all —
 * half a subtree is not a legal answer.
 *
 * Units (DEC-076, DEC-078): limit counts resources, offset counts *direct children*. The clause
 * texts disagree with each other here (see SQ-005); direct children is the only unit that can be
 * resumed, because restarting in the middle of a subtree would orphan nodes from a parent that
 * was already sent in the previous page.
 *
 * Returns the subtrees to include plus the resume point, or null when nothing is left over.
 */
// The offset filter condition is 1-based; every array index in this file is 0-based. These two
// functions are the only bridge between them, so the base cannot be applied twice or not at all.
//
// TS-0004:7.3.3.17.15 states it outright — "An **offset of 1** shall indicate the **first** direct
// child resource" — and TS-0001:8.1.2 agrees ("The offset shall start at 1"). Both clauses also
// describe offset as "the number of ... resources the Hosting CSE shall skip over", which reads
// one lower; that contradiction is SQ-005. It is settled in favour of the explicit statements,
// since a skip-count reading makes "shall start at 1" false and leaves the first child
// unreachable by any value (DEC-096, superseding the 0-based holding of DEC-078).
//
// An absent offset means "from the beginning", i.e. the same as 1.
function ofst_to_skip(fc_ofst) {
	return fc_ofst ? fc_ofst - 1 : 0;
}

// The value a client sends back as ofst to resume at 0-based index i. Content Offset (cnot) is the
// same filter condition travelling in the other direction (TS-0001:8.1.3), so it is emitted in the
// same base — a client that echoes cnot into ofst must land exactly where processing stopped.
function skip_to_ofst(i) {
	return i + 1;
}

function paginate_subtrees(direct_children, skip, lim) {
	const included = [];
	let used = 0;

	for (let i = skip; i < direct_children.length; i++) {
		const size = subtree_size(direct_children[i]);
		if (used + size > lim) {
			// Deliberately no "skip this one and try the next": the offset a client sends back
			// must mean "everything before this is done", which only holds if we stop here.
			return { included, next_ofst: i };
		}
		included.push(direct_children[i]);
		used += size;
	}

	return { included, next_ofst: null };
}

async function rcn48_retrieve(req_prim, resp_prim) {
	const tmp_resp = {};

	await retrieve_a_res(req_prim, tmp_resp);
	const target_res = tmp_resp.pc;
	const res_key = Object.keys(target_res)[0]; // e.g. 'm2m:cnt'

	let aggr_res = {};

	// rcn=8 keeps the envelope but drops the target's own attributes — TS-0001:8.1.2, "The
	// attributes of the parent resource are not returned, but all the attributes of the children
	// are returned". Table 7.5.2-2 still names m2m:<resourceType> as the element for R/8.
	if (4 == req_prim.rcn) aggr_res = target_res;
	if (8 == req_prim.rcn) aggr_res[res_key] = {};

	// Pagination is done here, on whole subtrees, so discovery must not pre-cut the flat list.
	const { ids_list_per_ty } = await discovery_core(req_prim, {
		paginate: false,
		exclude_obsolete_cin: true,
	});

	const node_by_ri = await fetch_nodes_by_ri(req_prim, ids_list_per_ty);
	const direct_children = build_nested(node_by_ri);

	const skip = ofst_to_skip(req_prim.fc.ofst);
	const lim = req_prim.fc.lim || config.cse.discovery_limit;
	const { included, next_ofst } = paginate_subtrees(direct_children, skip, lim);

	if (included.length === 0 && next_ofst !== null) {
		// The first subtree alone is bigger than lim, so nothing fits and raising ofst cannot
		// help — only a larger lim can. cnst below tells the client the result is partial, but
		// not why, and this is the one case an operator cannot diagnose from the response.
		logger.warn(
			{ to: req_prim.to, lim, subtree_size: subtree_size(direct_children[next_ofst]) },
			'rcn=4/8 returned no children: the first subtree is larger than lim'
		);
	}

	for (const child of included) {
		if (!aggr_res[res_key][child.key]) aggr_res[res_key][child.key] = [];
		aggr_res[res_key][child.key].push(child.body);
	}

	resp_prim.pc = aggr_res;
	if (next_ofst !== null) {
		resp_prim.cnst = 1;
		resp_prim.cnot = skip_to_ofst(next_ofst);
	}

	return resp_prim;
}


/**
 * rcn = 5 (attributes and child resource references) / 6 (child resource references).
 *
 * Both return *references* to the children rather than their representations, and the two forms
 * are mutually exclusive with the inline form by construction: CDT-<resourceType>.xsd wraps
 * "childResource" (m2m:childResourceRef) and the inlined child elements in the same xs:choice,
 * so a representation carries one or the other, never both.
 *
 * Serialization follows TS-0004:8.4.2 rule 10 — childResourceRef is a simple type carrying XML
 * attributes, so each entry becomes an object whose XML attributes appear under their short names
 * (nm, typ) and whose element value appears under the special name "val". TS-0004:8.4.3 EXAMPLE 2
 * shows exactly this shape for rcn = 5:
 *     "ch": [{"nm":"container1", "typ":3, "val":"mn-cse/appname/container1"}, ...]
 *
 * rcn = 6 drops the target's own attributes entirely (TS-0001:8.1.2 "without any representation of
 * the actual requested resource"), so the content is m2m:resourceRefList instead of the resource
 * element — Table 7.5.2-2 gives m2m:listOfChildResourceRef as its data type, whose repeated member
 * is "resourceRef" (rrf).
 */
async function rcn56_retrieve(req_prim, resp_prim) {
	const { ids_list, is_partial } = await discovery_core(req_prim);

	// drt selects the address format of the reference, the same choice discovery makes for
	// m2m:uril (TS-0004:7.5.2 note 2). Unset means structured, matching discovery's own default.
	const use_unstructured = req_prim.drt === 2;
	const refs = ids_list.map((item) => ({
		nm: item.sid.split('/').pop(),
		typ: item.ty,
		val: use_unstructured ? item.ri : item.sid,
	}));

	if (6 === req_prim.rcn) {
		resp_prim.pc = { 'm2m:rrl': { rrf: refs } };
	} else {
		const tmp_resp = {};
		await retrieve_a_res(req_prim, tmp_resp);
		if (!tmp_resp.pc) return resp_prim; // retrieve_a_res already set rsc (e.g. NOT_FOUND)
		const res_key = Object.keys(tmp_resp.pc)[0];
		// An empty ch would assert "this resource has no children", which is a different claim
		// from "the reference list is absent". The XSD makes the whole block optional, so leave
		// it out when there is nothing to reference.
		if (refs.length) tmp_resp.pc[res_key].ch = refs;
		resp_prim.pc = tmp_resp.pc;
	}

	set_partial_content(req_prim, resp_prim, is_partial);

	return resp_prim;
}

/**
 * TS-0001:8.1.2 requires child-resource results to carry an indication when the returned content
 * is partial, and 8.1.3 names the two response parameters that carry it: Content Status (cnst,
 * 1 = PARTIAL_CONTENT per TS-0004:6.3.4.2.44) and Content Offset (cnot), the point where a
 * subsequent request should resume via the offset filter condition.
 *
 * Without this a truncated result is indistinguishable from a complete one, and the client stops
 * early believing it saw everything.
 */
function set_partial_content(req_prim, resp_prim, is_partial) {
	if (!is_partial) return;
	const skip = ofst_to_skip(req_prim.fc.ofst);
	const lim = req_prim.fc.lim || config.cse.discovery_limit;
	resp_prim.cnst = 1;
	resp_prim.cnot = skip_to_ofst(skip + lim);
}

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

	// TS-0001:8.1.2 Table 8.1.2-1, Delete column: 0, 1, 4, 5, 6, 8 and 11 are valid; the rest are
	// n/a for this operation.
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

	// TS-0001:8.1.2 Table 8.1.2-1 marks rcn 4, 5, 6 and 8 valid for Delete as well as Retrieve:
	// the Originator asks to be shown what is about to disappear. The snapshot has to be taken
	// *before* delete_resources runs, because afterwards there is nothing left to describe.
	//
	// It is built separately from tmp_resp on purpose. tmp_resp is what the notification and the
	// parent's cbs bookkeeping below read, and both expect the plain single-resource shape --
	// handing them a nested tree or a reference list would break them quietly.
	let deleted_content = tmp_resp.pc;
	if (tmp_resp.pc) {
		const snapshot = {};
		if (req_prim.rcn === 4 || req_prim.rcn === 8) {
			await rcn48_retrieve(req_prim, snapshot);
			deleted_content = snapshot.pc;
		} else if (req_prim.rcn === 5 || req_prim.rcn === 6) {
			await rcn56_retrieve(req_prim, snapshot);
			deleted_content = snapshot.pc;
		}
		// cnst/cnot ride along when the snapshot was truncated by lim, the same as on a retrieve.
		if (snapshot.cnst !== undefined) resp_prim.cnst = snapshot.cnst;
		if (snapshot.cnot !== undefined) resp_prim.cnot = snapshot.cnot;
	}

	if (tmp_resp.pc) {
		await delete_resources([{ ri: req_prim.ri, ty: req_prim.to_ty }]);
		// [C6] invalidate lookup cache for deleted resource
		if (req_prim.sid) lookupCache.del(req_prim.sid);
		if (req_prim.to)  lookupCache.del(req_prim.to);
	}
	resp_prim.pc = deleted_content;
	resp_prim.rsc = enums.rsc_str["DELETED"];

	// after deletion, check and send notification(s) if needed
	noti.check_and_send_noti(req_prim, tmp_resp, "delete")
		.catch(err => logger.error({ err }, 'check_and_send_noti failed'));

	// Deleting a <cin> shrinks the parent <cnt>'s currentByteSize by that instance's contentSize.
	// (TS-0004:7.4.7.2.4 — the counters track the instances that are actually there.)
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

/**
 * @param opts.paginate  When false, the flat offset/limit slice at the end is skipped and the
 *   whole matching set is returned. rcn=4/8 needs this: it paginates over *subtrees*, and a list
 *   already cut in the middle of one cannot be regrouped (TS-0001:8.1.2 subtree atomicity).
 *   The per-type DB fetch cap (cse.discovery_limit) still applies either way.
 */
async function discovery_core(req_prim, opts = {}) {
	const paginate = opts.paginate !== false;
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
	const skip = ofst_to_skip(req_prim.fc.ofst);
	const ty_list = req_prim.fc.ty || Object.keys(enums.ty_str);

	// fetch enough per-type to cover offset + limit + 1 (for partial detection).
	// With paginate=false the caller slices by subtree instead, so the only bound left is the
	// protective cap — a subtree can hold more rows than ofst+lim would suggest.
	const fetch_lim = paginate
		? Math.min(skip + lim + 1, config.cse.discovery_limit)
		: config.cse.discovery_limit;

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
			let ty_where = where_per_ty[ty] ? { ...where, ...where_per_ty[ty] } : where;
			// rcn=4/8 asks for the children's representations, and TS-0001:10.2.4.4 says an
			// obsolete <contentInstance> is not among them. Wrapped in Op.and rather than merged
			// in: `where` already carries an Op.and array of its own (lvl, and the attribute
			// conditions), and spreading a second one over it would drop those silently.
			//
			// Only ty=4 and only for this caller — fu=1 discovery keeps returning obsolete
			// resources until the sweep removes them, which no clause forbids and which the
			// reporting client relies on to find its own leftovers (DEC-095).
			if (ty === 4 && opts.exclude_obsolete_cin) {
				ty_where = { [Op.and]: [ty_where, not_obsolete_where()] };
			}
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
	const paged = paginate ? ids_list.slice(skip) : ids_list;
	const is_partial = paginate ? paged.length > lim : false;
	const final_list = paginate ? paged.slice(0, lim) : paged;

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
		const skip = ofst_to_skip(req_prim.fc.ofst);
		const lim = req_prim.fc.lim || config.cse.discovery_limit;
		resp_prim.cnst = 1;                           // partial
		resp_prim.cnot = skip_to_ofst(skip + lim);    // offset for next request
	}

	return;
}

async function get_ty_from_unstructuredID(ri) {
	// A failed query is NOT the same answer as "no such row", and must not be turned into one.
	// This used to return 0 on error, which set_ri_sid reads as "the resource disappeared" and
	// reqPrim answers 4004 — so an unreachable database told every client that every resource
	// had ceased to exist. TS-0004:6.6.3.6 puts a receiver-side failure at 5000
	// INTERNAL_SERVER_ERROR; prim_handling already maps a thrown error to that, so the error is
	// left to propagate.
	const result = await pool.query('SELECT ty FROM lookup WHERE ri = $1', [ri]);
	return result.rows.length === 0 ? 0 : result.rows[0].ty;
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
	// Errors propagate on purpose — see get_ty_from_unstructuredID. The old catch also hid a
	// second case: a missing row made `result` null and `result.sid` threw a TypeError, which was
	// then reported as if the lookup itself had failed. A row that is not there is not an error,
	// so it is answered with null and only real failures are thrown.
	const result = await Lookup.findOne({ where: { ri: to } });
	return result ? result.sid : null;
}

async function get_unstructuredID(to) {
	// if 'to' is the csebase_rn or a structuredID, then return the 'ri' from the lookup table
	if (config.cse.csebase_rn == to || to.includes("/")) {
		// Errors propagate on purpose — see get_ty_from_unstructuredID. Returning null here made a
		// database outage indistinguishable from "no such resource", and 4004 is a claim about the
		// resource tree that the CSE is in no position to make when it cannot read it.
		const result = await Lookup.findOne({ where: { sid: to } });
		return result ? result.ri : null;
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
	return enums.ty_str[ty.toString()] + '-' + randomstring.generate(config.length.rn_random);
}

// How many names to try before giving up. Each attempt is independent, so exhausting this many in
// a namespace that is not nearly full does not happen by chance -- if it does, the cause is
// something other than luck (a truncated rn_random, say) and looping harder would only hide it.
const RN_GENERATION_ATTEMPTS = 5;

/**
 * A generated resourceName that is not already taken under `parent_sid`.
 *
 * TS-0001:9.6.1.3.1 leaves the name to the Hosting CSE when the Originator does not provide one,
 * and requires names to be unique among the children of a parent. Nothing here can make that
 * atomic -- a concurrent create can take the name between this check and the insert -- so the
 * unique index stays the real guard. This removes the ordinary collision, not the race.
 */
async function get_a_free_rn(ty, parent_sid) {
	let rn = get_a_new_rn(ty);

	for (let attempt = 1; attempt <= RN_GENERATION_ATTEMPTS; attempt++) {
		if (!(await get_unstructuredID(`${parent_sid}/${rn}`))) return rn;
		logger.warn({ rn, parent_sid, attempt }, 'generated resourceName was taken, retrying');
		rn = get_a_new_rn(ty);
	}

	// Handing back the last candidate rather than throwing: the unique index will refuse it if it
	// is genuinely taken, which is the same answer this function would have to give anyway.
	logger.error({ parent_sid, attempts: RN_GENERATION_ATTEMPTS },
		'could not generate a free resourceName; check config.length.rn_random');
	return rn;
}

/**
 * The value of a `contentSize`-style attribute: the size **in bytes** of a content value.
 *
 * `TS-0001:9.6.7` Table 9.6.7-2 defines `contentSize` as "Size in bytes of the content
 * attribute", and `TS-0004:7.4.37.2.1` uses the same wording for `<flexContainer>`.
 *
 * This used to report the JavaScript in-memory footprint instead — `string.length * 2` (UTF-16
 * code units), 8 per number, 4 per boolean. That is not a byte count of anything on the wire, and
 * it broke a real deployment: a `<container>` with `maxByteSizePerInstance` of 10 refused a
 * 10-byte ASCII payload with 5207 NOT_ACCEPTABLE, because 10 characters were counted as 20. It
 * also ran the other way for non-Latin text — "한글" is 6 bytes in UTF-8 and was counted as 4.
 *
 * A string is measured as its own UTF-8 bytes, not as its JSON encoding: the attribute being
 * sized is the content value, and the surrounding quotes belong to the serialization rather than
 * to the value. Structured content has no size until it is serialized, so it is measured as its
 * JSON form — which is what mobius4 stores and returns.
 *
 * **This does not settle what the standard means.** "Size in bytes" is undefined as to *which*
 * serialization, and the same resource has different sizes in JSON, XML and CBOR while
 * `contentSize` is a single value (tracked as SQ-003 in mobius4-dev-tool). What is settled is
 * that the previous figure was not a byte count under any reading.
 */
function get_mem_size(obj) {
	if (obj === null || obj === undefined) return 0;
	if (typeof obj === "string") return Buffer.byteLength(obj, "utf8");
	return Buffer.byteLength(JSON.stringify(obj), "utf8");
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

	// int_cr_req marks a request the CSE raised on its own behalf (eviction, cascade delete), which
	// makes retrieve_a_res hand back the internal creator that access control needs. It is cleared
	// here, once that decision has been made, so the flag cannot leak into the procedures that
	// follow and put int_cr into a response.
	req_prim.int_cr_req = false;

	// Cheat-key for system admin.
	//
	// oneM2M has no such concept — privileges are expressed as <accessControlPolicy> resources —
	// and v4.6.0 removed this check for that reason, leaving the administrator to reach a
	// resource only through a policy naming it or through the creator fallback in Case D. That
	// turned out to be the wrong trade for this deployment: a resource created by an AE with no
	// acpi (the common shape — see Case D below) became unreachable by the administrator, and
	// there was no way back, because the acpi_update path in reqPrim.js reads privileges off the
	// acpi the resource does not have. An operator locked out of a resource had no request that
	// could fix it.
	//
	// So the short-circuit is back, deliberately and non-conformantly. The admin policy
	// (config.cb.admin_acp, created by db/init.js) is still created and still evaluated for
	// everyone else; it is simply no longer the only way the administrator gets in.
	//
	// The config.cse.admin guard is not decoration. fr is undefined on a request that carries no
	// X-M2M-Origin, so an unset admin identity would match every anonymous request and hand out
	// the cheat-key. config/validate.js refuses to start without cse.admin, which makes this
	// unreachable in a running CSE — it is here because the cost of being wrong is total.
	if (config.cse.admin && req_prim.fr === config.cse.admin) {
		logger.debug({ fr: req_prim.fr }, 'access granted as admin');
		return true;
	}

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
	rcn56_retrieve,
	update_a_res,
	delete_a_res,
	delete_resources,
	fu1_discovery,
	discovery_core,
	get_a_new_rn,
	get_a_free_rn,
	get_ty_from_unstructuredID,
	get_structuredID,
	get_unstructuredID,
	get_mem_size,
	access_decision,
	expired_resource_cleanup,
	virtual_res_names,
	invalidateLookupCache,
}