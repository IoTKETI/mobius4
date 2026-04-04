const pool = require('../../db/connection');
const logger = require('../../logger').child({ module: 'cb' });

async function retrieve_a_cb(resp_prim) {
    const cb_obj = { "m2m:cb": {} };
    
    try {
        // get <cb> resource from PostgreSQL
        const result = await pool.query('SELECT * FROM cb WHERE ty = 5');
        
        if (result.rows.length > 0) {
            const db_res = result.rows[0];
            
            // set mandatory attributes
            cb_obj["m2m:cb"].ri = db_res.ri;
            cb_obj["m2m:cb"].ty = db_res.ty;
            cb_obj["m2m:cb"].rn = db_res.rn;
            cb_obj["m2m:cb"].pi = db_res.pi;
            cb_obj["m2m:cb"].ct = db_res.ct;
            cb_obj["m2m:cb"].lt = db_res.lt;
            cb_obj["m2m:cb"].cst = db_res.cst;
            cb_obj["m2m:cb"].csi = db_res.csi;
            cb_obj["m2m:cb"].srt = db_res.srt;
            cb_obj["m2m:cb"].srv = db_res.srv;
            cb_obj["m2m:cb"].poa = db_res.poa;
            
            // set optional attributes
            if (db_res.nl) cb_obj["m2m:cb"].nl = db_res.nl;
            // cb_obj["m2m:cb"].csz = db_res.csz; // apply this to the new branch 'conformance'
            if (db_res.acpi && db_res.acpi.length > 0) {
                cb_obj["m2m:cb"].acpi = db_res.acpi;
            }
            if (db_res.lbl && db_res.lbl.length > 0) {
                cb_obj["m2m:cb"].lbl = db_res.lbl;
            }
        }
    } catch (err) {
        logger.error({ err }, 'retrieve_a_cb failed');
    }

    resp_prim.pc = cb_obj;
    return resp_prim;
}

module.exports = {
    retrieve_a_cb
};