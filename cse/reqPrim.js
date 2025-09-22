const config = require("config");
const axios = require('axios');

const enums = require("../config/enums");
const { req_prim_schema } = require("./validation/prim_schema");
const Lookup = require('../models/lookup-model');
const CSR = require('../models/csr-model');

const hostingCSE = require("./hostingCSE");
const cnt = require("./resources/cnt");
const grp = require("./resources/grp");
// const smd = require("./resources/smd");

// non-standard APIs yet
const mrp = require("./resources/mrp"); // <modelRepo>
const mdp = require("./resources/mdp"); // <modelDeployments>
const dts = require("./resources/dts"); // <dataset>


async function prim_handling(req_prim) {
  console.log("\nrequest primitive: \n", JSON.stringify(req_prim, null, 2));

  // set default parameters for the request primitive
  set_default_req_params(req_prim);

  // initialize the response primitive
  const resp_prim = {};
  resp_prim.rqi = req_prim.rqi; // this is Request-ID parameter, not 'ri' (resourceID) attribute
  resp_prim.rvi = req_prim.rvi || config.cse.versions[0];

  // request primitive validation
  // to-do: allow empty 'to' parameter for AE registration
  const validated = req_prim_schema.validate(req_prim);
  if (validated.error) {
    const { message, path } = validated.error.details[0];
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": path[0] + " => " + message.replace(/"/g, "") };

    return resp_prim;
  }

  // check if the request is for me or the other CSE
  const { shortest_to, is_for_me } = get_to_info(req_prim);
  // request forwarding
  if (!is_for_me) {
    // skip the below hosting CSE procedures and return the response from the other CSE

    // return response primitive which is received from a Registrar CSE
    return await request_forwarding(req_prim, shortest_to);
  }
  else {
    // to handle the request with 'to' as 'sid' or 'ri' in the Database, there shall be no SP-ID or CSE-ID
    req_prim.to = shortest_to;
  }

  // continue to process the request as below since I'm the hosting CSE

  // check if the target resource as a normal resource exists or not
  // while the setting 'ri' and 'sid' in the req_prim, the target resource existence is checked for normal resource
  // if the target resource does not exist, 'ri' is set to null
  // also for the virtual resource, 'ri' is set to null 
  const { ri } = await hostingCSE.set_ri_sid(req_prim);

  // check if the target is a virtual resource
  await set_virtual_res_info(req_prim); // to-do: should change the function name? a bit misleading for the following code
  // in case it is a normal resource and does not exist, return the response immediately
  if (!req_prim.vr && !ri) {
    resp_prim.rsc = enums.rsc_str["NOT_FOUND"];
    resp_prim.pc = { "m2m:dbg": "target resource does not exist" };

    return resp_prim;
  } else if (req_prim.vr && ri == null) {
    // to-do
  }

  //
  // reject not allowed operations
  //

  if (req_prim.op === 1) {
    if (req_prim.ty === 5) {
      resp_prim.rsc = enums.rsc_str["OPERATION_NOT_ALLOWED"];
      resp_prim.pc = { "m2m:dbg": "<cb> resource creation is not allowed" };
      return resp_prim;
    }
  }
  else if (req_prim.op === 3) {
    if (req_prim.ty === 5) {
      resp_prim.rsc = enums.rsc_str["OPERATION_NOT_ALLOWED"];
      resp_prim.pc = { "m2m:dbg": "<cb> resource update is not allowed" };
      return resp_prim;
    }
  }
  else if (req_prim.op === 4) {
    if (req_prim.ty === 5) {
      resp_prim.rsc = enums.rsc_str["OPERATION_NOT_ALLOWED"];
      resp_prim.pc = { "m2m:dbg": "<cb> resource deletion is not allowed" };
      return resp_prim;
    }
  }


  //
  // access decision before calling each API handler
  //

  if ((req_prim.op === 2 && req_prim.fc.fu === 1) === false) {
    // no access decision for discovery target since it is done for all discovered resources 
    // that can even be skipped when the 'allow_discovery_for_any' is true

    const access_grant = await hostingCSE.access_decision(req_prim, resp_prim);
    if (access_grant === false && resp_prim.rsc) {
      return resp_prim;
    }

    if (access_grant === false) {
      resp_prim.rsc = enums.rsc_str["ORIGINATOR_HAS_NO_PRIVILEGE"];
      resp_prim.pc = { "m2m:dbg": "access denied" };
      
      return resp_prim;
    }
  }


  // the followings are bound to more than one CRUD operations, so remains in this file

  //
  // Resource API handlers, virtual resouces first and then normal resources
  //

  // 'fopt' supports CRUD operations, so call it here before switch into C/R/U/D below
  if ('fopt' === req_prim.vr) {
    await grp.fanout(req_prim, resp_prim);
    resp_prim.rsc = enums.rsc_str["OK"];
  }
  // handling of retrievalPoint(rpt) virtual child resource of <dataset>
  else if ('rpt' === req_prim.vr) {
    await dst.retrieval(req_prim, resp_prim);
    resp_prim.rsc = enums.rsc_str["OK"];
  }
  else if ('la' === req_prim.vr) {
    switch (req_prim.op) {
      case 2:
        if (req_prim.parent_ty == 3) {
          await cnt.retrieve_la(req_prim, resp_prim);
        } else if (req_prim.parent_ty == 101) {
          await mrp.retrieve_la(req_prim, resp_prim);
        } else if (req_prim.parent_ty == 103) {
          await mdp.retrieve_la(req_prim, resp_prim);
        } else if (req_prim.parent_ty == 106) {
          await dts.retrieve_la(req_prim, resp_prim);
        }
        break;
      case 4:
        if (req_prim.parent_ty == 3) {
          await cnt.delete_la(req_prim, resp_prim);
        } else if (req_prim.parent_ty == 101) {
          await mrp.delete_la(req_prim, resp_prim);
        } else if (req_prim.parent_ty == 103) {
          await mdp.delete_la(req_prim, resp_prim);
        }
        break;
      default:
        resp_prim.rsc = enums.rsc_str["OPERATION_NOT_ALLOWED"];
        resp_prim.pc = { "m2m:dbg": "only Retrieve or Delete operation is allowed for <la> resource" };
    }
  }
  else if ('ol' === req_prim.vr) {
    switch (req_prim.op) {
      case 2:
        if (req_prim.parent_ty == 3) {
          await cnt.retrieve_ol(req_prim, resp_prim);
        } else if (req_prim.parent_ty == 101) {
          await mrp.retrieve_ol(req_prim, resp_prim);
        } else if (req_prim.parent_ty == 103) {
          await mdp.retrieve_ol(req_prim, resp_prim);
        } else if (req_prim.parent_ty == 106) {
          await dts.retrieve_ol(req_prim, resp_prim);
        }
        break;
      case 4:
        if (req_prim.parent_ty == 3) {
          await cnt.delete_ol(req_prim, resp_prim);
        } else if (req_prim.parent_ty == 101) {
          await mrp.delete_ol(req_prim, resp_prim);
        } else if (req_prim.parent_ty == 103) {
          await mdp.delete_ol(req_prim, resp_prim);
        } 
        break;
      default:
        resp_prim.rsc = enums.rsc_str["OPERATION_NOT_ALLOWED"];
        resp_prim.pc = { "m2m:dbg": "only Retrieve or Delete operation is allowed for <ol> resource" };
    }
  }
  // normal resource handling
  // 'to' parameter format is CSE-relative
  else {
    switch (req_prim.op) {
      // CREATE
      case 1:
        await hostingCSE.create_a_res(req_prim, resp_prim);
        if (!resp_prim.rsc) {
          resp_prim.rsc = enums.rsc_str["CREATED"];
        }
        break;

      // RETRIEVE
      case 2:
        if (req_prim.fc.fu === 1 && req_prim.fc.smf && req_prim.sqi === false) {
          // get list of target <smd> resource IDs
          req_prim.fc.ty = [24]; // 24: <smd>
          const { ids_list } = await hostingCSE.discovery_core(req_prim);
          const smd_list = ids_list.map((id) => {
            return id.sid;
          });
          // perform semantic discovery by calling semantic API on the triple store
          const discovery_result = await smd.semantic_discovery(
            req_prim.fc.smf,
            smd_list
          );
          if (discovery_result === false) {
            resp_prim.rsc = enums.rsc_str["INTERNAL_SERVER_ERROR"];
            resp_prim.rsc = { "m2m:dbg": "Semantic API server error" };
          } else if (discovery_result.length) {
            resp_prim.rsc = enums.rsc_str["OK"];
            resp_prim.pc = { "m2m:uril": discovery_result };
          }
        } else if (req_prim.fc.fu === 1) {
          try {
            await hostingCSE.fu1_discovery(req_prim, resp_prim);
          } catch (err) {
            console.error(err);
          }
        } else if (req_prim.fc.fu === 2) {
          // assumption: 'to' is in CSE-relative
          try {
            // if the target is a normal resource, but does not exist
            if (!req_prim.vr && ri === null) {
              resp_prim.rsc = enums.rsc_str["NOT_FOUND"];
              break;
            }
            if (req_prim.rcn === 4 || req_prim.rcn === 8) {
              // to-do: rcn8 implementation is different from the spec, the spec would be updated
              await hostingCSE.rcn48_retrieve(req_prim, resp_prim);
            } else {
              await hostingCSE.retrieve_a_res(req_prim, resp_prim);
            }
          } catch (err) {
            console.error(err);
          }
        }
        if (!resp_prim.rsc) {
          resp_prim.rsc = enums.rsc_str["OK"];
        }
        break;

      // UPDATE
      case 3:
        await hostingCSE.update_a_res(req_prim, resp_prim);
        if (!resp_prim.rsc) {
          resp_prim.rsc = enums.rsc_str["UPDATED"];
        }
        break;

      // DELETE
      case 4:
        await hostingCSE.delete_a_res(req_prim, resp_prim);
        if (!resp_prim.rsc) {
          resp_prim.rsc = enums.rsc_str["DELETED"];
        }
        // to-do: depending on 'rcn' options, 'pc' is set to empty or not
        if (!req_prim.rcn) resp_prim.pc = undefined;

        break;

      // NOTIFY
      case 5:
        resp_prim.rsc = enums.rsc_str["OK"];
        break;
    }
  }

  return resp_prim;
}

function set_default_req_params(req_prim) {
  // filter cri
  if (!req_prim.fc) {
    req_prim.fc = { fu: 2 };
  }
  if (req_prim.fc.fu === undefined && req_prim.op === 2) {
    // by the spec, default is conditional retrieval for RETRIEVE
    req_prim.fc.fu = 2;
  }
  if (req_prim.fc === 1 && !req_prim.fc.drt) {
    req_prim.fc.drt = 1; // structured ID format
  }

  // result content
  if (req_prim.rcn === undefined) {
    switch (req_prim.op) {
      case 1:
      case 2:
      case 3:
        req_prim.rcn = 1; // attributes for C/R/U
        break;
      case 4:
        req_prim.rcn = 0; // nothing for D
    }
  }
}

// check the To param value, to see if the request needs to be forwarded
// if the request targets me, get the CSE-relative To param value
function get_to_info(req_prim) {
  const to = req_prim.to;
  let shortest_to = null, is_for_me = false;

  // absolute ID format
  if (to.startsWith('//')) {
    // request for me
    if (to.startsWith(config.cse.sp_id + config.cse.cse_id)) {
      // remove the SP-ID and CSE-ID from the 'to' param, so it becomes CSE-relative ID format
      shortest_to = to.split(config.cse.sp_id + config.cse.cse_id + '/')[1];
      is_for_me = true;
    }
    // request for the other CSE in the same SP domain
    else if (to.startsWith(config.cse.sp_id)) {
      shortest_to = to.split(config.cse.sp_id)[1];
    }
    // request for the other CSE in the different SP domain
    else {
      shortest_to = to;
    }
  }
  // SP-relative ID format
  else if (to.startsWith('/')) {
    // request for me
    if (to.startsWith(config.cse.cse_id)) {
      // remove the CSE-ID from the 'to' param, so it becomes CSE-relative ID format
      shortest_to = to.split(config.cse.cse_id + '/')[1];
      is_for_me = true;
    }
    else {
      shortest_to = to;
    }
  }
  // CSE-relative ID format
  else {
    // consider all CSE-relative ID format 'to' param as request for me
    shortest_to = to;
    is_for_me = true;
  }

  // by the spec, '-' is the wildcard for the 'rn' of the <CSEBase> resource
  if (shortest_to[0] === '-') {
    shortest_to = shortest_to.replace('-', config.cse.csebase_rn);
  }

  return { shortest_to, is_for_me };
}

// check if the 'to' indicates virtual resource or not
// when 'to' includes postfix after virtual resource name, this function returns 'true'
// e.g. 'base/grp/fopt/path' and 'base/cnt/la/3'
async function set_virtual_res_info(req_prim) {
  for (const vir_res_name of hostingCSE.virtual_res_names) {
    // const vir_res_name = item; // this assginement is needed indeed, to prevent async handling error
    if (req_prim.to.includes("/" + vir_res_name) === true) {
      const to_parent = req_prim.to.split("/" + vir_res_name)[0];
      // req_prim.sid = to_parent;

      // 'cnt/la' is virtual resource, but 'cnt/later' is not
      const remainder = req_prim.to.split("/" + vir_res_name)[1];
      if (remainder && remainder[0] != "/") {
        return;
      }

      const vir_res_path = req_prim.to.split(vir_res_name + "/")[1];

      // by now, the parent_res_id is in structured ID format
      // get parent resource and cross-check with child virtual resource
      let parent_res;
      const where_clause = (to_parent.includes("/")) ? { sid: to_parent } : { ri: to_parent };
      const result = await Lookup.findOne({
        where: where_clause,
        attributes: ['ty', 'ri']
      });
      if (result) {
        parent_res = result.toJSON();
        // in case of "target = virtual resource", parent resource type (enum) is included in the primitive for further use
        req_prim.parent_ty = parent_res.ty;
        req_prim.parent_ri = parent_res.ri;
      } else {
        // to-do: return error info
        return;
      }

      if (vir_res_name == "la" || vir_res_name == "ol") {
        // confirm that the parent is 'cnt' type => could be timeSeries, flexContainerInstance as well (to-do)
        if (
          enums.ty_str[parent_res.ty] !== "cnt" &&
          enums.ty_str[parent_res.ty] !== "mrp" &&
          enums.ty_str[parent_res.ty] !== "mdp" &&
          enums.ty_str[parent_res.ty] !== "dts"
        ) {
          return;
        }
      } else if (vir_res_name == "fopt") {
        // confirm that the parent is 'grp' type
        if (enums.ty_str[parent_res.ty] !== "grp") {
          return;
        }
      }

      // otherwise, set info and return
      req_prim.to_parent = to_parent;
      req_prim.vr = vir_res_name;
      req_prim.vr_path = vir_res_path;

      return;
    }
  }

  return;
}

async function request_forwarding(req_prim, shortest_to) {
  const resp_prim = {};

  // step1: change the originator ID into SP-relative or Absolute format, if needed
  // check 'to' param scope, if it is SP-relative or Absolute format
  if (shortest_to.startsWith('//')) {
    // Absolute format
    if (req_prim.fr.startsWith('C')) {
      req_prim.fr = config.cse.sp_id + config.cse.cse_id + '/' + req_prim.fr;
    } else if (req_prim.fr.startsWith('S')) {
      req_prim.fr = config.cse.sp_id + '/' + req_prim.fr;
    }
  }
  else if (shortest_to.startsWith('/')) {
    // SP-relative format
    if (req_prim.fr.startsWith('C')) {
      req_prim.fr = config.cse.cse_id + '/' + req_prim.fr;
    }
  }

  // resolve target CSE-ID

  let target_cse_id = '';

  if (shortest_to.startsWith('//')) {
    target_cse_id = '/' + shortest_to.split('//')[1].split('/')[1];
  }
  else if (shortest_to.startsWith('/')) {
    target_cse_id = '/' + shortest_to.split('/')[1];
  }

  console.log('request forwarding to ', target_cse_id);

  // resolve CSE-relative 'to' param for the target CSE

  const cse_rel_to = shortest_to.split(target_cse_id + '/')[1];
  console.log('cse_rel_to: ', cse_rel_to);


  // step2: find the nextCSE among <csr> resources

  const csr_res = await CSR.findOne({ where: { csi: target_cse_id } });
  if (!csr_res) {
    resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
    resp_prim.pc = { 'm2m:dbg': 'CSR resource not found' };
    return;
  }

  // get 'poa' of the <remoteCSE> resource
  // send the request to the other CSE by the 'poa', which may be over HTTP or MQTT

  // to-do
  // check whether we need to try other poa items if one of them is not working
  const poa = csr_res.poa[0];
  console.log('poa: ', poa);

  // step3: forward the request to that CSE

  if (poa.startsWith('http')) {
    // HTTP - determine method based on operation type
    const http_method = get_http_method(req_prim.op);
    const http_req = {
      method: http_method,
      url: poa + '/' + cse_rel_to,
      data: req_prim.pc,
      headers: {
        'X-M2M-RI': 'forwarding_' + req_prim.rqi,
        'X-M2M-Origin': req_prim.fr,
        'X-M2M-RVI': req_prim.rvi || '2a',
        'Content-Type': 'application/json'
      }
    };

    if (req_prim.op === 1) {
      http_req.headers['Content-Type'] = 'application/json' + ';ty=' + req_prim.ty;
    }

    try {
      const http_resp = await axios(http_req);
      // console.log('http_resp: ', http_resp);

      // convert http response to response primitive

      resp_prim.rqi = http_resp.headers['x-m2m-ri'];
      resp_prim.rsc = http_resp.headers['x-m2m-rsc'];
      resp_prim.rvi = http_resp.headers['x-m2m-rvi'];

      if (http_resp.data) {
        // console.log('http response payload: ', http_resp.data);
        resp_prim.pc = http_resp.data;
      }
    } catch (error) {
      console.error('HTTP forwarding error:', error.message);
      resp_prim.rsc = enums.rsc_str['INTERNAL_SERVER_ERROR'];
      resp_prim.pc = { 'm2m:dbg': `HTTP forwarding failed: ${error.message}` };
      return resp_prim;
    }
  } else if (poa.startsWith('mqtt')) {
    // MQTT
    // to-do: implement MQTT forwarding
  }

  // step4: handle the response back from the other CSEs and send it back to the Originator
  resp_prim.rsc = enums.rsc_str['OK'];

  return resp_prim;
}


function get_http_method(op) {
  switch (op) {
    case 1: // CREATE
      return 'POST';
    case 2: // RETRIEVE
      return 'GET';
    case 3: // UPDATE
      return 'PUT';
    case 4: // DELETE
      return 'DELETE';
    case 5: // NOTIFY
      return 'POST';
  }
}

module.exports = { prim_handling, get_to_info };