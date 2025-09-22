const axios = require('axios');

const config = require('config');
const registree = config.cse;
const registrar = config.cse.registrar;

const hostingCSE = require('./hostingCSE');
const reqPrim = require('./reqPrim');


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
    const response = await axios.post(url, body, { headers });

    if (response.status === 201) {
        console.log("successfullly created <remoteCSE> resource to the registrar");
        console.log(response.data);
    }
    else {
        console.log("create <remoteCSE> resource request failed");
        console.log(response.data);
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