const config = require("config");
const axios = require('axios');
const { JSONPath } = require("jsonpath-plus");
const logger = require("../logger").forFile(__filename);

// Cache config values used in get_to_info on every request
const _SP_ID = config.cse.sp_id;
const _CSE_ID = config.cse.cse_id;
const _CSEBASE_RN = config.cse.csebase_rn;
const _SP_CSE_PREFIX = _SP_ID + _CSE_ID;

const enums = require("../config/enums");
const { req_prim_schema } = require("./validation/prim_schema");
const Lookup = require('../models/lookup-model');
const CSR = require('../models/csr-model');
const pendingCreates = require('./pending-creates');

const hostingCSE = require("./hostingCSE");
const cnt = require("./resources/cnt");
const ts = require("./resources/ts");
const grp = require("./resources/grp");
// const smd = require("./resources/smd");

// non-standard APIs yet
const mrp = require("./resources/mrp"); // <modelRepo>
const mdp = require("./resources/mdp"); // <modelDeployments>
const dts = require("./resources/dts"); // <dataset>


async function prim_handling(req_prim) {
  logger.info({ prim: req_prim }, 'request primitive received');

  // set default parameters for the request primitive
  set_default_req_params(req_prim);

  // initialize the response primitive
  const resp_prim = {};
  resp_prim.rqi = req_prim.rqi; // this is Request-ID parameter, not 'ri' (resourceID) attribute
  resp_prim.rvi = req_prim.rvi || config.cse.versions[0];

  // request primitive validation
  // BACKLOG-056: the schema requires To on every request. Whether AE registration may omit it
  // is a specification question that has not been settled here.
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

    // Early pendingCreates registration for CREATE ops with structured 'to' (e.g. "Mobius/MyAE").
    // Must happen before the first await so concurrent requests for child resources find the promise.
    if (req_prim.op === 1 && req_prim.pc && req_prim.to.includes('/')) {
      const pcValues = Object.values(req_prim.pc)[0];
      if (pcValues?.rn) {
        const new_sid = req_prim.to + '/' + pcValues.rn;
        hostingCSE.invalidateLookupCache(new_sid);
        let pendingResolve;
        pendingCreates.set(new_sid, new Promise(r => pendingResolve = r));
        req_prim._pendingCreate = { sid: new_sid, resolve: pendingResolve };
      }
    }
  }

  // continue to process the request as below since I'm the hosting CSE

  try {

  // check if the target resource as a normal resource exists or not
  // while the setting 'ri' and 'sid' in the req_prim, the target resource existence is checked for normal resource
  // if the target resource does not exist, 'ri' is set to null
  // also for the virtual resource, 'ri' is set to null 
  const { ri } = await hostingCSE.set_ri_sid(req_prim);

  // Fallback: unstructured 'to' (e.g. AE registration with to="Mobius") — sid only known after set_ri_sid
  if (req_prim.op === 1 && req_prim.pc && req_prim.sid && !req_prim._pendingCreate) {
    const pcValues = Object.values(req_prim.pc)[0];
    if (pcValues?.rn) {
      const new_sid = req_prim.sid + '/' + pcValues.rn;
      hostingCSE.invalidateLookupCache(new_sid);
      let pendingResolve;
      pendingCreates.set(new_sid, new Promise(r => pendingResolve = r));
      req_prim._pendingCreate = { sid: new_sid, resolve: pendingResolve };
    }
  }

  // check if the target is a virtual resource
  await set_virtual_res_info(req_prim);
  // in case it is a normal resource and does not exist, return the response immediately
  if (!req_prim.vr && !ri) {
    resp_prim.rsc = enums.rsc_str["NOT_FOUND"];
    resp_prim.pc = { "m2m:dbg": "target resource does not exist" };

    return resp_prim;
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
  // UPDATE and DELETE are judged on the type of the resource being addressed ('to_ty', resolved
  // by set_ri_sid above), not on 'ty'. 'ty' is the type of the resource to be created, so the
  // HTTP binding only ever fills it in for CREATE and these two guards never fired — the
  // request fell through to access control instead, and a registered AE got 4103 for a
  // <CSEBase> it merely lacked privileges on. TS-0004:7.4.3.2.3 and 7.4.3.2.4 reject at
  // Recv-1.0 "check the syntax of received message", before access control, so the answer is
  // 4005 no matter who asks (TP/oneM2M/CSE/REG/UPD/001, TP/oneM2M/CSE/REG/DEL/001).
  else if (req_prim.op === 3) {
    if (req_prim.to_ty === 5) {
      resp_prim.rsc = enums.rsc_str["OPERATION_NOT_ALLOWED"];
      resp_prim.pc = { "m2m:dbg": "<cb> resource update is not allowed" };
      return resp_prim;
    }
  }
  else if (req_prim.op === 4) {
    if (req_prim.to_ty === 5) {
      resp_prim.rsc = enums.rsc_str["OPERATION_NOT_ALLOWED"];
      resp_prim.pc = { "m2m:dbg": "<cb> resource deletion is not allowed" };
      return resp_prim;
    }
  }


  // A Subscription Verification request is judged here, ahead of the generic access decision,
  // because TS-0004:7.5.1.2.3 gives it status codes of its own for precisely the failure the
  // generic check reports as 4103: "if the creator does not have the privilege ...
  // SUBSCRIPTION_CREATOR_HAS_NO_PRIVILEGE ... if the Originator does not have the privilege ...
  // SUBSCRIPTION_HOST_HAS_NO_PRIVILEGE". Left after the generic check, the Originator case never
  // reached its own code -- measured as 4103, with 5205 unreachable.
  //
  // This is not a way around access control. handle_verification runs the same NOTIFY privilege
  // check against the same target, twice: once for the subscription's creator and once for the
  // Originator carrying the request. The generic check tests only the second of those, so a
  // verification request now passes a strictly stronger test than an ordinary NOTIFY, not a
  // weaker one. Anything that is not a verification request falls straight through.
  //
  // set_ri_sid has already run, so ri, sid and to_ty are on req_prim -- handle_verification needs
  // to_ty to ask access_decision about the target at all.
  if (req_prim.op === 5) {
    const { handle_verification } = require('./subscription-verification');
    if (await handle_verification(req_prim, resp_prim)) return resp_prim;
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
    // Only when the handler did not already answer. The unconditional assignment turned every
    // refusal fanout() could make into a 2000 — a group with no members has to answer 4109
    // NO_MEMBERS (TS-0004:7.4.14.2.4), and it was reaching the client as "OK, here is nothing".
    if (!resp_prim.rsc) resp_prim.rsc = enums.rsc_str["OK"];
  }
  // handling of retrievalPoint(rpt) virtual child resource of <dataset>
  else if ('rpt' === req_prim.vr) {
    await dst.retrieval(req_prim, resp_prim);
    if (!resp_prim.rsc) resp_prim.rsc = enums.rsc_str["OK"];
  }
  else if ('la' === req_prim.vr) {
    switch (req_prim.op) {
      case 2:
        if (req_prim.parent_ty == 3) {
          await cnt.retrieve_la(req_prim, resp_prim);
        } else if (req_prim.parent_ty == 29) {
          await ts.retrieve_la(req_prim, resp_prim);
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
        } else if (req_prim.parent_ty == 29) {
          await ts.delete_la(req_prim, resp_prim);
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
        } else if (req_prim.parent_ty == 29) {
          await ts.retrieve_ol(req_prim, resp_prim);
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
        } else if (req_prim.parent_ty == 29) {
          await ts.delete_ol(req_prim, resp_prim);
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
            // Swallowing the exception and only logging it leaves the client with an empty
            // list plus RSC 2000, which it misreads as "there are no results". Report a
            // failure as a failure — because of this flaw, a bad WHERE condition during the
            // lvl work surfaced as an empty result rather than an error and delayed diagnosis.
            logger.error({ err }, 'fu1 discovery failed');
            resp_prim.rsc = enums.rsc_str[err.rsc_hint || "INTERNAL_SERVER_ERROR"];
            // rsc_hint marks an error this code raised on purpose, with a message written for the
            // client ("unsupported geometry type"). Without it the throw came from somewhere
            // below and the message is an internal detail — see the catch at the end of
            // prim_handling for why that must not be forwarded.
            resp_prim.pc = { "m2m:dbg": err.rsc_hint ? err.message : "discovery failed" };
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
              await hostingCSE.rcn48_retrieve(req_prim, resp_prim);
            } else if (req_prim.rcn === 5 || req_prim.rcn === 6) {
              await hostingCSE.rcn56_retrieve(req_prim, resp_prim);
            } else {
              await hostingCSE.retrieve_a_res(req_prim, resp_prim);
            }
          } catch (err) {
            logger.error({ err }, 'retrieve failed');
          }
        }
        if (!resp_prim.rsc) {
          resp_prim.rsc = enums.rsc_str["OK"];
        }
        break;

      // UPDATE
      case 3:
        // additional access control for updating 'acpi' attribute
        // check if req_prim.pc has 'acpi' attribute using JSONPath
        const acpi = JSONPath("$..acpi", req_prim.pc);
        if (acpi && acpi.length > 0) {
          req_prim.acpi_update = true;
          const access_grant = await hostingCSE.access_decision(req_prim, resp_prim);
          if (false === access_grant) {
            resp_prim.rsc = enums.rsc_str["ORIGINATOR_HAS_NO_PRIVILEGE"];
            resp_prim.pc = { "m2m:dbg": "access denied" };
            return resp_prim;
          }
        }
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
        // rcn 4/5/6/8 are valid for Delete (TS-0001:8.1.2 Table 8.1.2-1) and would carry the
        // child representations; only rcn 0/1 are honoured here. Tracked as BACKLOG-050.
        if (!req_prim.rcn) resp_prim.pc = undefined;

        break;

      // NOTIFY
      // NOTIFY
      //
      // A verification request never gets here -- it is answered above, before the generic access
      // decision, so that TS-0004:7.5.1.2.3's own status codes are the ones a caller sees. What
      // remains is an ordinary notification, which this CSE accepts without inspecting.
      case 5:
        resp_prim.rsc = enums.rsc_str["OK"];
        break;
    }
  }

  return resp_prim;

  } catch (err) {
    logger.error({ err }, 'prim_handling uncaught error');
    resp_prim.rsc = enums.rsc_str["INTERNAL_SERVER_ERROR"];
    // A fixed string, not err.message. Anything reaching here is by definition unanticipated, so
    // the message is whatever the failing layer happened to say — reported from a deployment as
    // `{"m2m:dbg":"column \"or\" does not exist"}`, which is a schema detail travelling to an
    // unauthenticated client and tells that client nothing it can act on. The full error, with
    // its stack, is on the line above; the request identifier is in the same log entry, so an
    // operator can still tie a client's report to the cause.
    resp_prim.pc = { "m2m:dbg": "internal server error" };
    return resp_prim;
  } finally {
    logger.info({ rsc: resp_prim.rsc, rqi: resp_prim.rqi, ri: req_prim.ri, prim: resp_prim.pc }, 'response primitive');
    if (req_prim._pendingCreate) {
      req_prim._pendingCreate.resolve();
      pendingCreates.delete(req_prim._pendingCreate.sid);
    }
  }
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

  if (to.startsWith('//')) {
    // absolute ID format: //sp-id/cse-id[/path]
    if (to.startsWith(_SP_CSE_PREFIX + '/') || to === _SP_CSE_PREFIX) {
      // exact sp_id + cse_id match → for me
      shortest_to = to.slice(_SP_CSE_PREFIX.length + 1) || _CSEBASE_RN;
      is_for_me = true;
    } else {
      // extract the cse-id portion regardless of sp-id
      // format: //domain/cse-id[/path] → skip "//" then find first "/"
      const after_slashes = to.slice(2);
      const domain_end = after_slashes.indexOf('/');
      if (domain_end !== -1) {
        const cse_path = after_slashes.slice(domain_end); // "/cse-id[/path]"
        if (cse_path.startsWith(_CSE_ID + '/') || cse_path === _CSE_ID) {
          // different sp-id but our cse-id → still for me
          shortest_to = cse_path.slice(_CSE_ID.length + 1) || _CSEBASE_RN;
          is_for_me = true;
        } else if (to.startsWith(_SP_ID)) {
          // same sp domain, different cse → forward
          shortest_to = to.slice(_SP_ID.length);
        } else {
          // different sp domain → forward
          shortest_to = to;
        }
      } else {
        shortest_to = to;
      }
    }
  } else if (to.startsWith('/')) {
    // SP-relative ID format: /cse-id[/path]
    if (to.startsWith(_CSE_ID + '/') || to === _CSE_ID) {
      shortest_to = to.slice(_CSE_ID.length + 1) || _CSEBASE_RN;
      is_for_me = true;
    } else {
      shortest_to = to;
    }
  } else {
    // CSE-relative format → always for me
    shortest_to = to;
    is_for_me = true;
  }

  // '-' is the wildcard for the CSEBase rn per oneM2M spec
  if (shortest_to[0] === '-') {
    shortest_to = _CSEBASE_RN + shortest_to.slice(1);
  }

  return { shortest_to, is_for_me };
}

// check if the 'to' indicates virtual resource or not
// when 'to' includes postfix after virtual resource name, this function returns 'true'
// e.g. 'base/grp/fopt/path' and 'base/cnt/la/3'
async function set_virtual_res_info(req_prim) {
  // The name has to match a whole path segment, not a substring. Matching with
  // includes("/" + name) made the virtual resource of a container depend on the name of that
  // container: in 'Mobius/temp1/lamp/la' the first "/la" is inside "/lamp", so to_parent came
  // out as 'Mobius/temp1' and the remainder as 'mp/la', and the "'cnt/la' but not 'cnt/later'"
  // guard below then returned out of the whole function -- the request fell through to an
  // ordinary RETRIEVE and answered 4004. Every resource whose name merely starts with 'la',
  // 'ol' or 'fopt' lost its virtual children that way (measured 2026-08-24: lamp, later, label,
  // fopta -> 404; led, DATA, olive -> 200). BACKLOG-118.
  //
  // The list order still decides which name wins when a path carries more than one -- 'fopt'
  // comes first so that 'grp/fopt/la' is the group's fopt with vr_path 'la'.
  const segments = req_prim.to.split("/");
  for (const vir_res_name of hostingCSE.virtual_res_names) {
    // A virtual resource is always someone's child, so index 0 cannot be it. Resources cannot
    // be named after one either (hostingCSE.js rejects such an 'rn' with 4005), so the first
    // matching segment is the virtual resource and anything after it is its path.
    const idx = segments.indexOf(vir_res_name);
    if (idx >= 1) {
      const to_parent = segments.slice(0, idx).join("/");
      const vir_res_path = segments.slice(idx + 1).join("/");

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
        // The parent is gone, so this is not a virtual resource of anything. Returning without
        // setting req_prim.vr is what produces the right answer: vr is only assigned further down,
        // once the parent and its type check out, so the caller's "no vr and no ri" guard answers
        // 4004. Measured 2026-08-08: GET /Mobius/no-such-container/la -> 404 / RSC 4004.
        //
        // It reads like a missing error path and is not one, but it is fragile — moving the vr
        // assignment above this point would turn the 4004 into an empty 2000.
        return;
      }

      if (vir_res_name == "la" || vir_res_name == "ol") {
        // <flexContainerInstance> also carries <latest>/<oldest>, but that resource type does
        // not exist in mobius4 yet, so it is not in this list.
        if (
          enums.ty_str[parent_res.ty] !== "cnt" &&
          enums.ty_str[parent_res.ty] !== "ts" &&
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

  // The Originator is waiting on the Request Identifier it sent. It is multiplicity 1 in both the
  // request and the response primitive (TS-0004:6.4.1, 6.4.2), and TS-0001:10.2.5.19 states the
  // correlation outright -- "matching the Request Identifier parameter of the request ... and the
  // Request Identifier parameter of the response". Set here and never taken from the remote CSE's
  // answer, which carries whatever that CSE chose to echo.
  resp_prim.rqi = req_prim.rqi;

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

  logger.debug({ targetCseId: target_cse_id }, 'forwarding request');

  // The To parameter is forwarded as it stands. TS-0004:7.3.2.6 enumerates what a forwarding CSE
  // converts -- From into SP-relative or Absolute format, M2M Service User across SP domains, and
  // the removal of Release Version Indicator and Vendor Information for a Release 1 entity -- and
  // To is not among them.
  //
  // It used to be rewritten into CSE-relative form by cutting the target CSE-ID out of it, which
  // broke three ways. The next CSE routes a further hop by "the CSE-ID in the To parameter"
  // matching its own descendantCSEs (same clause), so a To with the CSE-ID removed cannot be
  // forwarded again. `To` of exactly the CSE-ID with no path produced the string "undefined". And
  // the cut was made on a string match, so a path that repeated the CSE-ID -- /cse/a/cse/b --
  // silently lost everything after the second occurrence.
  logger.debug({ forwardTo: shortest_to }, 'forwarding target resolved');


  // step2: find the nextCSE among <csr> resources

  const csr_res = await CSR.findOne({ where: { csi: target_cse_id } });
  if (!csr_res) {
    resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
    resp_prim.pc = { 'm2m:dbg': 'CSR resource not found' };
    return resp_prim;
  }

  // get 'poa' of the <remoteCSE> resource
  // send the request to the other CSE by the 'poa', which may be over HTTP or MQTT

  const poa_list = Array.isArray(csr_res.poa) ? csr_res.poa : [csr_res.poa];
  return await forward_to_poa(poa_list, req_prim, shortest_to, resp_prim, target_cse_id);
}


// The To parameter as the path component of a request line, TS-0009:6.2.2.1 table 6.2.2.1-1.
//
//   CSE-Relative   CSEBase/ae12/cont27   ->  /CSEBase/ae12/cont27
//   SP-Relative    /CSE178/CSEBase/ae12  ->  /~/CSE178/CSEBase/ae12
//   Absolute       //sp.org/CSE178/ae12  ->  /_/sp.org/CSE178/ae12
//
// This is the exact inverse of what bindings/http.js does on the way in, and it is why the To
// parameter can be forwarded unchanged: the "/~/" and "/_/" prefixes carry the scope that would
// otherwise have to be stripped out of the parameter itself.
function to_path_component(to) {
    if (to.startsWith('//')) return '/_/' + to.slice(2);
    if (to.startsWith('/')) return '/~' + to;
    return '/' + to;
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

/**
 * Tries each pointOfAccess in turn and fills resp_prim from the first that answers.
 *
 * Split out so it can be tested without a registered <remoteCSE>: what is worth pinning down is
 * which access point gets dialled and what comes back, and a real registration exercises neither.
 */
// A Response Status Code as the number it is defined to be. Anything unparseable is left alone
// rather than turned into NaN -- a wrong-looking value is easier to chase than a missing one.
function to_rsc(value) {
  if (value === undefined || value === null) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

async function forward_to_poa(poa_list, req_prim, forward_to, resp_prim, target_cse_id) {
  // pointOfAccess is a list because a CSE may be reachable more than one way. Trying only the
  // first made a <remoteCSE> unreachable as soon as that one stopped answering, however many
  // others it advertised, so each is tried in turn until one answers.
  //
  // A transport failure is the only reason to move on. An answer from the remote CSE — including
  // a 4xxx — is the answer to this request and is passed back as it stands: retrying it on
  // another access point would ask the same CSE the same question twice.
  let last_error = null;

  for (const poa of poa_list) {
  logger.debug({ poa }, 'forwarding via poa');

  // step3: forward the request to that CSE

  if (poa.startsWith('http')) {
    // HTTP - determine method based on operation type
    const http_method = get_http_method(req_prim.op);
    const http_req = {
      method: http_method,
      url: poa + to_path_component(forward_to),
      data: req_prim.pc,
      headers: {
        // The Originator's own Request Identifier, not a derived one. It used to be prefixed with
        // "forwarding_", and the remote CSE's echo of that was then handed back to the Originator
        // as its own -- so a client correlating a response to its request never found a match.
        'X-M2M-RI': req_prim.rqi,
        'X-M2M-Origin': req_prim.fr,
        'X-M2M-RVI': req_prim.rvi || '2a',
        'Content-Type': 'application/json'
      },
      // Without this the request was held until the operating system gave up on the socket --
      // tens of seconds to minutes -- and to the Originator that is indistinguishable from a lost
      // request. On expiry the poa loop moves to the next access point, and when none answers the
      // Originator gets 5103 TARGET_NOT_REACHABLE, which is the truth.
      timeout: config.cse.forwarding_timeout_seconds * 1000,
    };

    if (req_prim.op === 1) {
      http_req.headers['Content-Type'] = 'application/json' + ';ty=' + req_prim.ty;
    }

    // The one record of what actually went out. Incoming requests are logged as a primitive by
    // prim_handling; without the matching line here, a forwarded request could only be
    // reconstructed from three fragments (targetCseId, the resolved To, the poa) and its headers
    // and body were not recorded at all.
    logger.info({
      prim: { to: forward_to, fr: req_prim.fr, rqi: req_prim.rqi, rvi: req_prim.rvi,
              op: req_prim.op, ty: req_prim.ty, pc: req_prim.pc },
      method: http_method, url: http_req.url,
    }, 'request primitive forwarded');

    try {
      const http_resp = await axios(http_req);

      // convert http response to response primitive

      // resp_prim.rqi is the Originator's, set in request_forwarding, and is deliberately not
      // taken from the remote CSE's answer.
      // HTTP headers are strings; responseStatusCode is xs:integer (TS-0004
      // CDT-enumerationTypes.xsd). Passing the header through verbatim put a quoted "2000" into
      // the response primitive, which showed up in group fanout: a local member answered
      // rsc 2000 and a forwarded one answered "2000" in the same m2m:agr, so a client comparing
      // them had to accept both spellings.
      resp_prim.rsc = to_rsc(http_resp.headers['x-m2m-rsc']);
      resp_prim.rvi = http_resp.headers['x-m2m-rvi'];

      if (http_resp.data) {
        resp_prim.pc = http_resp.data;
      }

      // The remote CSE's status is the answer. This used to fall through to an unconditional
      // "OK" below, so a forwarded 4004 -- or any other status the other CSE returned -- reached
      // the Originator as 2000 with the error payload still attached.
      return resp_prim;
    } catch (error) {
      // axios rejects both on a transport failure and on a non-2xx status. Only the former means
      // this access point is unusable; a status came from the CSE and is its answer.
      if (error.response) {
        resp_prim.rsc = to_rsc(error.response.headers['x-m2m-rsc']);
        resp_prim.rvi = error.response.headers['x-m2m-rvi'];
        if (error.response.data) resp_prim.pc = error.response.data;
        if (resp_prim.rsc) return resp_prim;
      }

      last_error = error;
      logger.warn({ err: error, targetCseId: target_cse_id, poa }, 'forwarding failed, trying the next poa');
      continue;
    }
  } else if (poa.startsWith('mqtt')) {
    // The request goes out on the standard request topic of TS-0010:6.4.2 and the answer comes
    // back on the matching response topic, matched by rqi. A pointOfAccess names the broker only
    // (TS-0010:6.6.3), so the topic is built from the two identities rather than read from the URL.
    const mqtt_outbound = require('../bindings/mqtt-outbound');
    const forwarded = {
      ...req_prim,
      to: forward_to,
    };

    logger.info({
      prim: { to: forward_to, fr: req_prim.fr, rqi: req_prim.rqi, rvi: req_prim.rvi,
              op: req_prim.op, ty: req_prim.ty, pc: req_prim.pc },
      poa,
    }, 'request primitive forwarded');

    const remote_resp = await mqtt_outbound.request_over_mqtt(poa, forwarded, target_cse_id,
        config.cse.forwarding_timeout_seconds * 1000);
    if (remote_resp) {
      // The remote CSE's own rqi is its answer to the forwarded request; the Originator is waiting
      // on the one it sent, so the original is restored.
      resp_prim.rsc = remote_resp.rsc;
      resp_prim.rvi = remote_resp.rvi || resp_prim.rvi;
      if (remote_resp.pc !== undefined) resp_prim.pc = remote_resp.pc;
      return resp_prim;
    }

    logger.warn({ poa, targetCseId: target_cse_id }, 'mqtt forwarding got no answer');
    last_error = new Error('no response over MQTT');
    continue;
  } else {
    logger.warn({ poa, targetCseId: target_cse_id }, 'unsupported poa scheme');
    last_error = new Error(`unsupported poa scheme: ${poa}`);
    continue;
  }
  }

  // Every access point failed. 5103 TARGET_NOT_REACHABLE (TS-0004:6.6.3.6) says what happened --
  // the request was fine and the other CSE could not be reached.
  logger.error({ err: last_error, targetCseId: target_cse_id, tried: poa_list.length },
    'forwarding failed on every poa');
  resp_prim.rsc = enums.rsc_str['TARGET_NOT_REACHABLE'];
  resp_prim.pc = { 'm2m:dbg': `no pointOfAccess answered: ${last_error?.message ?? 'unknown'}` };

  return resp_prim;
}

module.exports = { prim_handling, get_to_info, forward_to_poa, to_path_component };
