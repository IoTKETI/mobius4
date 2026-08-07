const config = require('config');
const { cin_create_schema } = require('../validation/res_schema');
const enums = require('../../config/enums');
const { classify_create_error } = require('../create-error');

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
            resp_prim.pc = { 'm2m:dbg': 'content size of a new <cin> is bigger than mbs or mbis of the parent container' };
            return;
        }

        // TS-0004:7.4.7.2.1 step 3 — the instance carries the parent's stateTag *after* the
        // increment, which is why it comes back from the statement that performed it.
        cin_res.st = written.st;
        // TS-0004:7.4.7.2.1 step 2 e) — et may have been capped to the parent's mia; the
        // statement is authoritative, not the value cin_res was built with.
        cin_res.et = written.et;

        // eviction after the write: delete oldest CIN(s) if mni or mbs exceeded
        await evict_if_needed(written, cin_pi);

        // [C1] build response directly from cin_res — no extra DB round trip
        resp_prim.pc = build_cin_response(cin_res);

    } catch (err) {
        logger.error({ err }, 'create_a_cin failed');
        // A name lost to a concurrent create is a conflict, not a bad request.
        const { rsc, dbg } = classify_create_error(err);
        resp_prim.rsc = rsc;
        resp_prim.pc = { 'm2m:dbg': dbg };
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
// Four things fall out of the shape rather than being arranged separately:
//
//   - The size check is the UPDATE's own WHERE. If the content does not fit, no row is
//     updated, so the two INSERTs — which select from that UPDATE — insert nothing. A refusal
//     cannot leave the counters advanced for a row that was never written. It checks mbs and
//     mbis (maxByteSizePerInstance) both, per TS-0004:7.4.7.2.1 step 1 — the parent's total
//     budget and its cap on any one instance are two independent reasons to refuse.
//   - stateTag comes back from the UPDATE that incremented it, so the instance carries the
//     parent's post-increment value (TS-0004:7.4.7.2.1 step 3). The previous code read st
//     before opening its transaction, which let concurrent creates copy the same value into
//     several instances and left eviction — which orders by st — picking arbitrarily.
//   - "Parent missing" and "content too large" are distinguished by the parent CTE, since
//     both otherwise present as an empty UPDATE.
//   - et is capped to the parent's maxInstanceAge, computed in the same statement (step 2 e):
//     et_calc reads mia off the row the UPDATE already touched, so no extra read is needed to
//     learn it before deciding what to insert. The cap is a ceiling over whatever et was
//     requested (client-supplied or the deployment default), never a floor — a client asking
//     for something shorter than mia keeps what it asked for. config.default.container.mia
//     (365 days) is chosen to track the deployment's default et (12 months, moment-calendar),
//     so a <container> left at its defaults behaves the same as before mia was enforced, to
//     within the day or so that "365 days" and "12 calendar months" can differ.
//
// The final SELECT uses scalar subqueries so that exactly one row comes back in every case,
// including the two failures.
const WRITE_CIN_SQL = `
WITH parent AS (
    SELECT ri FROM cnt WHERE ri = $1
), upd AS (
    UPDATE cnt
       SET cni = cni + 1, cbs = cbs + $2, st = st + 1
     WHERE ri = $1 AND (mbs IS NULL OR $2 <= mbs) AND (mbis IS NULL OR $2 <= mbis)
    RETURNING cni, cbs, mni, mbs, mbis, mia, st
), et_calc AS (
    SELECT CASE WHEN mia IS NULL THEN $6 ELSE
             to_char(
               LEAST(
                 to_timestamp($6, 'YYYYMMDD"T"HH24MISS'),
                 to_timestamp($7, 'YYYYMMDD"T"HH24MISS') + mia * INTERVAL '1 second'
               ),
               'YYYYMMDD"T"HH24MISS'
             )
           END AS et
      FROM upd
), new_cin AS (
    INSERT INTO cin (ri, ty, rn, pi, sid, et, ct, lt, cr, acpi, lbl, loc, st, cs, con, cnf)
    SELECT $3, 4, $4, $1, $5, et_calc.et, $7, $7, $8, $9, $10,
           CASE WHEN $11::text IS NULL THEN NULL
                ELSE ST_SetSRID(ST_GeomFromGeoJSON($11::text), 4326) END,
           upd.st, $2, $12::jsonb, $13
      FROM upd, et_calc
    RETURNING ri, et
), new_lookup AS (
    INSERT INTO lookup (ri, ty, rn, sid, lvl, pi, cr, int_cr, et, loc)
    SELECT $3, 4, $4, $5, $14, $1, $8, $15, (SELECT et FROM new_cin),
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
       (SELECT st  FROM upd)              AS st,
       (SELECT et  FROM new_cin)          AS et
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
        et:  r.et,
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

// Eviction, also in one statement — TS-0004:7.4.7.2.1 step 2 a) and b).
//
// The clause is "remove the oldest ... until the conditions are met", so what survives is a
// contiguous run of the newest instances: the newest maxNrOfInstances of them whose sizes
// still add up to no more than maxByteSize. That is expressible directly. Ranking newest
// first, an instance is kept while its position is within mni and the running total of sizes
// up to and including it is within mbs; everything past either boundary is evicted, in one
// pass, without deciding anything in JavaScript.
//
// Why not go through delete_a_res as before: it retrieves the resource, deletes it, queries
// for descendants and deletes those, and offers the deletion to the notification path — for
// a <contentInstance>, which is always a leaf (no resource type accepts one as a parent) and
// whose eviction must not notify anyway (step 2 d). That is several round trips per evicted
// instance, and eviction runs on the hot write path.
//
// The one thing delete_a_res did that still has to happen here is invalidating the lookup
// cache, so the evicted sids come back from the statement.
//
// The leading SELECT ... FOR UPDATE on the parent is not incidental. Without it this statement
// takes its locks in the opposite order from the write above — cin rows, then lookup rows,
// then the container — while the write takes the container first. Two requests interleaving on
// one container then deadlock, and PostgreSQL fails one of them: measured at a third of writes
// returning 4000 under sustained load against a container held at its limit. Locking the
// container first puts both statements in the same order, and has the side effect of
// serialising evictions per container, so two of them can no longer choose overlapping victims.
// The write already serialises on that same row, so this adds no contention that was not
// there.
//
// Two details in the SQL are load-bearing and easy to undo by accident:
//
//   - `WHERE pi = $1` takes the parameter directly. Writing it as `pi = (SELECT ri FROM
//     locked)` reads better and costs a sequential scan of the whole cin table — the planner
//     cannot use idx_cin_pi against a value it only learns from a CTE. Measured on a table of
//     16,000 rows holding an 11-row container: 14.5 ms against 0.58 ms, and the gap grows with
//     the table rather than with the container.
//   - The two DELETEs join `victims` with USING rather than `ri IN (SELECT ...)`. The IN form
//     plans as a hash semi-join and sequentially scans cin and lookup in full; USING drives the
//     primary key.
//
// The lock is instead tied in through victims, which cannot be evaluated until it is held.
const EVICT_SQL = `
WITH locked AS (
    SELECT ri FROM cnt WHERE ri = $1 FOR UPDATE
), ranked AS (
    SELECT ri, cs, sid,
           row_number() OVER (ORDER BY st DESC, ct DESC, ri DESC) AS pos,
           sum(cs)      OVER (ORDER BY st DESC, ct DESC, ri DESC
                              ROWS UNBOUNDED PRECEDING)           AS running_bytes
      FROM cin
     WHERE pi = $1
), victims AS (
    SELECT ri, cs, sid FROM ranked
     WHERE (($2::int IS NOT NULL AND pos > $2)
         OR ($3::int IS NOT NULL AND running_bytes > $3))
       AND (SELECT count(*) FROM locked) = 1
), del_cin AS (
    DELETE FROM cin c    USING victims v WHERE c.ri = v.ri RETURNING c.cs
), del_lookup AS (
    DELETE FROM lookup l USING victims v WHERE l.ri = v.ri RETURNING l.ri
), adj AS (
    UPDATE cnt
       SET cni = cni - (SELECT count(*) FROM del_cin),
           cbs = cbs - COALESCE((SELECT sum(cs) FROM del_cin), 0)
     WHERE ri = $1
    RETURNING cni, cbs
)
SELECT COALESCE((SELECT array_agg(sid) FROM victims), ARRAY[]::varchar[]) AS sids,
       (SELECT count(*) FROM del_lookup)                                 AS evicted,
       a.cni, a.cbs
  FROM adj a
`;

async function evict_if_needed(cnt, cin_pi) {
    const { cni, cbs, mni, mbs } = cnt.dataValues || cnt;

    // Nothing to do in the common case, and this keeps the statement off the hot path
    // entirely for containers that are not at their limit.
    if ((mni == null || cni <= mni) && (mbs == null || cbs <= mbs)) return;

    const { rows } = await pool.query(EVICT_SQL, [cin_pi, mni ?? null, mbs ?? null]);
    const evicted = rows[0];
    if (!evicted || Number(evicted.evicted) === 0) return;

    // delete_a_res used to do this. A stale entry would resolve an evicted instance's path to
    // a resourceID whose row is gone; the answer would still be 4004, but by a route that
    // depends on the cache rather than on the store.
    const { invalidateLookupCache } = require('../hostingCSE');
    for (const sid of evicted.sids || []) invalidateLookupCache(sid);

    logger.debug({ pi: cin_pi, evicted: Number(evicted.evicted), cni: evicted.cni, cbs: evicted.cbs },
        'evicted oldest <cin>(s)');
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
