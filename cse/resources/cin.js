const config = require('config');
const { cin_create_schema } = require('../validation/res_schema');
const enums = require('../../config/enums');

const { generate_ri, get_cur_time, get_default_et, convert_loc_to_geoJson, get_loc_attribute } = require('../utils');

const sequelize = require('../../db/sequelize');
const pool = require('../../db/connection');
const Lookup = require('../../models/lookup-model');
const CNT = require('../../models/cnt-model');
const CIN = require('../../models/cin-model');

const logger = require('../../logger').forFile(__filename);

const cin_parent_res_types = ['cnt'];

async function create_a_cin(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:cin'];

    // validation for primitive resource attribute
    const validated = cin_create_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    const cin_pi = req_prim.ri;
    const cin_sid = req_prim.sid + '/' + prim_res.rn;

    // parent resource type check
    const parent_ty = req_prim.to_ty;
    if (cin_parent_res_types.includes(enums.ty_str[parent_ty.toString()]) === false) {
        resp_prim.rsc = enums.rsc_str['INVALID_CHILD_RESOURCE_TYPE'];
        resp_prim.pc = { 'm2m:dbg': 'parent of <cin> resource shall be <cnt> resource' };
        return;
    }

    // compute content size
    const { get_mem_size } = require('../hostingCSE');
    const content_size = get_mem_size(prim_res.con);

    const ri = generate_ri();
    const now = get_cur_time();
    const et = get_default_et();

    // process 'loc' attribute
    if (prim_res.loc) {
        await convert_loc_to_geoJson(prim_res, resp_prim);
        if (resp_prim.rsc)
            return;
    }

    const cin_res = {
        ri,
        ty: 4,
        rn: prim_res.rn,
        pi: cin_pi,
        sid: cin_sid,
        et: prim_res.et || et,
        ct: now,
        lt: now,
        cr: prim_res.cr === null ? req_prim.fr : null,
        acpi: prim_res.acpi || null,
        lbl: prim_res.lbl || null,
        loc: prim_res.loc,
        cs: content_size,
        con: prim_res.con,
        cnf: prim_res.cnf || null,
    };

    try {
        const written = await write_a_cin(cin_res, req_prim.fr);

        // The parent has to exist and has to accept the size. Both are decided by the same
        // statement, so they are told apart by its result rather than by two earlier reads.
        if (!written.parent_found) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': 'parent <cnt> resource not found' };
            return;
        }
        if (!written.stored) {
            resp_prim.rsc = enums.rsc_str['NOT_ACCEPTABLE'];
            resp_prim.pc = { 'm2m:dbg': 'content size of a new <cin> is bigger than mbs of the parent container' };
            return;
        }

        // TS-0004:7.4.7.2.1 step 3 — the instance carries the parent's stateTag *after* the
        // increment, which is why it comes back from the statement that performed it.
        cin_res.st = written.st;

        // eviction after the write: delete oldest CIN(s) if mni or mbs exceeded
        await evict_if_needed(written, cin_pi);

        // [C1] build response directly from cin_res — no extra DB round trip
        resp_prim.pc = build_cin_response(cin_res);

    } catch (err) {
        logger.error({ err }, 'create_a_cin failed');
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': err.message };
    }
}

// One statement for the whole write: the parent's counters, the <contentInstance> row, and
// its lookup row.
//
// It used to be four round trips — a SELECT for the parent's mbs and st, then BEGIN, three
// statements and COMMIT. Measured at roughly 1,000 creates per second and saturated at a
// concurrency of 8, because the ceiling was the round trips rather than the work. Folding it
// into one statement is what this function is for; a single statement is also atomic without
// an explicit transaction.
//
// Three things fall out of the shape rather than being arranged separately:
//
//   - The size check is the UPDATE's own WHERE. If the content does not fit, no row is
//     updated, so the two INSERTs — which select from that UPDATE — insert nothing. A refusal
//     cannot leave the counters advanced for a row that was never written.
//   - stateTag comes back from the UPDATE that incremented it, so the instance carries the
//     parent's post-increment value (TS-0004:7.4.7.2.1 step 3). The previous code read st
//     before opening its transaction, which let concurrent creates copy the same value into
//     several instances and left eviction — which orders by st — picking arbitrarily.
//   - "Parent missing" and "content too large" are distinguished by the parent CTE, since
//     both otherwise present as an empty UPDATE.
//
// The final SELECT uses scalar subqueries so that exactly one row comes back in every case,
// including the two failures.
const WRITE_CIN_SQL = `
WITH parent AS (
    SELECT ri FROM cnt WHERE ri = $1
), upd AS (
    UPDATE cnt
       SET cni = cni + 1, cbs = cbs + $2, st = st + 1
     WHERE ri = $1 AND (mbs IS NULL OR $2 <= mbs)
    RETURNING cni, cbs, mni, mbs, st
), new_cin AS (
    INSERT INTO cin (ri, ty, rn, pi, sid, et, ct, lt, cr, acpi, lbl, loc, st, cs, con, cnf)
    SELECT $3, 4, $4, $1, $5, $6, $7, $7, $8, $9, $10,
           CASE WHEN $11::text IS NULL THEN NULL
                ELSE ST_SetSRID(ST_GeomFromGeoJSON($11::text), 4326) END,
           upd.st, $2, $12::jsonb, $13
      FROM upd
    RETURNING ri
), new_lookup AS (
    INSERT INTO lookup (ri, ty, rn, sid, lvl, pi, cr, int_cr, et, loc)
    SELECT $3, 4, $4, $5, $14, $1, $8, $15, $6,
           CASE WHEN $11::text IS NULL THEN NULL
                ELSE ST_SetSRID(ST_GeomFromGeoJSON($11::text), 4326) END
      FROM upd
    RETURNING ri
)
SELECT (SELECT count(*) FROM parent)      AS parent_found,
       (SELECT count(*) FROM new_lookup)  AS stored,
       (SELECT cni FROM upd)              AS cni,
       (SELECT cbs FROM upd)              AS cbs,
       (SELECT mni FROM upd)              AS mni,
       (SELECT mbs FROM upd)              AS mbs,
       (SELECT st  FROM upd)              AS st
`;

async function write_a_cin(cin_res, originator) {
    const { rows } = await pool.query(WRITE_CIN_SQL, [
        cin_res.pi,                                        // $1
        cin_res.cs,                                        // $2
        cin_res.ri,                                        // $3
        cin_res.rn,                                        // $4
        cin_res.sid,                                       // $5
        cin_res.et,                                        // $6
        cin_res.ct,                                        // $7
        cin_res.cr,                                        // $8
        cin_res.acpi,                                      // $9
        cin_res.lbl,                                       // $10
        cin_res.loc ? JSON.stringify(cin_res.loc) : null,  // $11
        JSON.stringify(cin_res.con ?? null),               // $12
        cin_res.cnf,                                       // $13
        cin_res.sid.split('/').length,                     // $14
        originator,                                        // $15
    ]);

    const r = rows[0];
    return {
        parent_found: Number(r.parent_found) > 0,
        stored: Number(r.stored) > 0,
        cni: r.cni,
        cbs: r.cbs,
        mni: r.mni,
        mbs: r.mbs,
        st:  r.st,
    };
}

// [C1] build response object from in-memory cin_res (avoids re-reading from DB)
function build_cin_response(cin_res) {
    const cin_obj = { 'm2m:cin': {
        ty:  cin_res.ty,
        ri:  cin_res.ri,
        rn:  cin_res.rn,
        pi:  cin_res.pi,
        ct:  cin_res.ct,
        lt:  cin_res.lt,
        et:  cin_res.et,
        st:  cin_res.st,
        cs:  cin_res.cs,
        con: cin_res.con,
    }};

    if (cin_res.acpi && cin_res.acpi.length) cin_obj['m2m:cin'].acpi = cin_res.acpi;
    if (cin_res.lbl && cin_res.lbl.length)  cin_obj['m2m:cin'].lbl  = cin_res.lbl;
    if (cin_res.cr)                          cin_obj['m2m:cin'].cr   = cin_res.cr;
    if (cin_res.cnf)                         cin_obj['m2m:cin'].cnf  = cin_res.cnf;
    if (cin_res.loc)                         cin_obj['m2m:cin'].loc  = get_loc_attribute(cin_res.loc);

    return cin_obj;
}

// [C4] evict oldest CIN(s) when mni or mbs is exceeded — runs after transaction commits
async function evict_if_needed(cnt, cin_pi) {
    const { delete_a_res } = require('../hostingCSE');

    let { cni, cbs, mni, mbs } = cnt.dataValues || cnt;

    const excess_mni = Math.max(0, cni - mni);
    if (excess_mni === 0 && cbs <= mbs) return;

    // fetch enough oldest CINs to cover both mni and mbs eviction
    const fetch_limit = Math.max(excess_mni + 10, 50);
    const candidates = await CIN.findAll({
        where: { pi: cin_pi },
        order: [['st', 'ASC']],
        limit: fetch_limit,
        attributes: ['ri', 'cs'],
    });

    const to_delete = [];

    // mni: remove oldest until within limit
    let i = 0;
    while (cni > mni && i < candidates.length) {
        to_delete.push(candidates[i]);
        cni--;
        cbs -= candidates[i].cs;
        i++;
    }

    // mbs: continue removing oldest until within size limit
    while (cbs > mbs && i < candidates.length) {
        to_delete.push(candidates[i]);
        cbs -= candidates[i].cs;
        i++;
    }

    if (to_delete.length === 0) return;

    // delete each evicted CIN (int_cr_req=true skips the per-CIN CNT update in delete_a_res)
    let cbs_reduction = 0;
    for (const old_cin of to_delete) {
        const tmp_resp = {};
        await delete_a_res(
            { fr: config.cse.admin, to: old_cin.ri, ri: old_cin.ri, rqi: 'evict_cin', to_ty: 4, int_cr_req: true },
            tmp_resp
        );
        cbs_reduction += old_cin.cs;
    }

    // update CNT to reflect evicted CINs
    await CNT.update(
        {
            cni: sequelize.literal(`cni - ${to_delete.length}`),
            cbs: sequelize.literal(`cbs - ${cbs_reduction}`),
        },
        { where: { ri: cin_pi } }
    );
}

async function retrieve_a_cin(req_prim, resp_prim) {
    const cin_obj = { 'm2m:cin': {} };
    const ri = req_prim.ri;

    try {
        const db_res = await CIN.findByPk(ri);
        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': '<cin> resource not found' };
            return;
        }

        // provide int_cr if required by internal API call
        if (req_prim && req_prim.int_cr_req === true)
            cin_obj['m2m:cin'].int_cr = db_res.int_cr;

        // copy mandatory attributes
        cin_obj['m2m:cin'].ty = db_res.ty;
        cin_obj['m2m:cin'].et = db_res.et;
        cin_obj['m2m:cin'].ct = db_res.ct;
        cin_obj['m2m:cin'].lt = db_res.lt;
        cin_obj['m2m:cin'].ri = db_res.ri;
        cin_obj['m2m:cin'].rn = db_res.rn;
        cin_obj['m2m:cin'].pi = db_res.pi;
        cin_obj['m2m:cin'].st = db_res.st;

        // optional attributes
        if (db_res.acpi && db_res.acpi.length) cin_obj['m2m:cin'].acpi = db_res.acpi;
        if (db_res.lbl && db_res.lbl.length) cin_obj['m2m:cin'].lbl = db_res.lbl;
        if (db_res.cr) cin_obj['m2m:cin'].cr = db_res.cr;
        if (db_res.cnf) cin_obj['m2m:cin'].cnf = db_res.cnf;
        if (db_res.cs !== undefined) cin_obj['m2m:cin'].cs = db_res.cs;
        if (db_res.con !== undefined) cin_obj['m2m:cin'].con = db_res.con;
        if (db_res.loc) cin_obj['m2m:cin'].loc = get_loc_attribute(db_res.loc);
    } catch (err) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': '<cin> resource not found' };
        throw err;
    }

    resp_prim.pc = cin_obj;
    return;
}

module.exports.create_a_cin = create_a_cin;
module.exports.retrieve_a_cin = retrieve_a_cin;
