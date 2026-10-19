const axios = require('axios');

const config = require('config');
const logger = require('../logger').forFile(__filename);
const registree = config.cse;
const registrar = config.cse.registrar;

const hostingCSE = require('./hostingCSE');
const reqPrim = require('./reqPrim');
const descendants = require('./descendants');


exports.registree = async function () {
    // step 1. send create <remoteCSE> resource request
    const url = `http://${registrar.ip}:${registrar.port}/${registrar.csebase_rn}`;
    const headers = {
        'X-M2M-RI': 'cse_creation_on_registrar',
        'X-M2M-Origin': config.cse.cse_id,
        'Content-Type': 'application/json; ty=16',
        'Accept': 'application/json'
    };
    const body = {
        "m2m:csr": {
            cst: registree.cse_type,
            poa: registree.poa,
            cb: registree.cse_id + '/' + registree.csebase_rn,
            csi: registree.cse_id,
            rr: true,
            // csz: registree.serializations,
            srv: registree.versions
        }
    };
    // CSEs that registered with us before a restart are still below us; TS-0001:9.6.4 has the
    // registree set descendantCSEs when it registers. Left out when there are none -- the list
    // type has minLength 1.
    // A failure to read them must not cost the registration itself; the next report sends the
    // list anyway.
    try {
        const dcse = await descendants.compute_descendants();
        if (dcse) body['m2m:csr'].dcse = dcse;
    } catch (err) {
        logger.warn({ err }, 'could not read local <remoteCSE> resources; registering without descendantCSEs');
    }
    // Registration is an outbound request like any other. Without a timeout an unreachable
    // registrar held this call open, and it runs at startup.
    const response = await axios.post(url, body, { headers,
        timeout: config.cse.forwarding_timeout_seconds * 1000 });

    if (response.status === 201) {
        logger.info({ registrarUrl: url }, 'remoteCSE resource created on registrar');
        // The registrar names our <remoteCSE> (no rn is sent), so its resource ID from the
        // response is the only address we have for the descendantCSEs updates that follow
        // (TS-0004:7.4.4.2.1 Recv-6.5). Sent as a CSE-relative unstructured ID, which the
        // registrar resolves on its own.
        const ri = response.data?.['m2m:csr']?.ri;
        if (ri) descendants.set_own_csr_ri(ri);
        else logger.warn({ registrarUrl: url }, 'registrar answered 201 without a resource ID; descendantCSEs will not be reported');
    }
    else {
        logger.warn({ registrarUrl: url, status: response.status }, 'remoteCSE creation on registrar failed');
    }

    // step 2. create <remoteCSE> resource, which represents the registrar CSE, locally
    const req_prim = {
        // standard params
        "fr": config.cse.admin,
        "to": config.cse.csebase_rn,
        "op": 1, // CREATE
        "ty": 16, // remoteCSE type
        "rqi": "csr_creation_locally",
        "pc": {
            "m2m:csr": {
                rn: hostingCSE.get_a_new_rn(16),
                cst: registrar.cse_type,
                poa: [`http://${registrar.ip}:${registrar.port}`],
                cb: registrar.cse_id + '/' + registrar.csebase_rn,
                csi: registrar.cse_id,
                rr: true,
                csz: registrar.serializations,
                srv: registrar.versions
            }
        },
        // additional params for 'create_a_csr' function
        // "ri": await hostingCSE.get_unstructuredID(config.cse.csebase_rn),
        // "sid": config.cse.csebase_rn,
        // "to_ty": 5 // CSEBase type
    };

    const resp_prim = await reqPrim.prim_handling(req_prim);
    // console.log('locally created <csr> resource: \n', resp_prim);
}