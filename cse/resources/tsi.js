const { tsi_create_schema } = require('../validation/res_schema');
const enums = require('../../config/enums');
const { classify_create_error } = require('../create-error');

const { generate_ri, get_cur_time, get_default_et, convert_loc_to_geoJson, get_loc_attribute, not_obsolete_where } = require('../utils');

const pool = require('../../db/connection');
const TSI = require('../../models/tsi-model');

const logger = require('../../logger').forFile(__filename);

const tsi_parent_res_types = ['ts'];

// One statement for the whole write, for the same reasons WRITE_CIN_SQL in cse/resources/cin.js
// is one statement — see the commentary there. The differences from that statement:
//
//   - no mbis: TS-0001:9.6.36 gives <timeSeries> no maxByteSizePerInstance, so the size check
//     is against mbs alone.
//   - dgt and snr are inserted; dgt is what the (pi, dgt) unique index enforces, and a
//     violation surfaces as the same unique-violation error classify_create_error already maps
//     to CONFLICT for duplicate resource names.
const WRITE_TSI_SQL = `
WITH parent AS (
    -- mdd and md_anchor_dgt come back so the caller can tell whether this instance is the one
    -- that gives a detecting <timeSeries> its anchor. Until the anchor exists there is no
    -- expected point, so the missing-data sweep has nothing to compute a wake-up from.
    SELECT ri, mdd, md_anchor_dgt FROM ts WHERE ri = $1
), upd AS (
    UPDATE ts
       SET cni = cni + 1, cbs = cbs + $2
     WHERE ri = $1 AND (mbs IS NULL OR $2 <= mbs)
    RETURNING cni, cbs, mni, mbs, mia
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
), new_tsi AS (
    INSERT INTO tsi (ri, ty, rn, pi, sid, et, ct, lt, cr, int_cr, lbl, loc, cs, con, dgt, snr)
    SELECT $3, 30, $4, $1, $5, et_calc.et, $7, $7, $8, $15, $9,
           CASE WHEN $10::text IS NULL THEN NULL
                ELSE ST_SetSRID(ST_GeomFromGeoJSON($10::text), 4326) END,
           $2, $11::jsonb, $12, $13
      FROM upd, et_calc
    RETURNING ri, et
), new_lookup AS (
    INSERT INTO lookup (ri, ty, rn, sid, lvl, pi, cr, int_cr, et, loc)
    SELECT $3, 30, $4, $5, $14, $1, $8, $15, (SELECT et FROM new_tsi),
           CASE WHEN $10::text IS NULL THEN NULL
                ELSE ST_SetSRID(ST_GeomFromGeoJSON($10::text), 4326) END
      FROM upd
    RETURNING ri
)
SELECT (SELECT count(*) FROM parent)      AS parent_found,
       (SELECT mdd FROM parent)           AS parent_mdd,
       (SELECT md_anchor_dgt FROM parent) AS parent_anchor,
       (SELECT count(*) FROM new_lookup)  AS stored,
       (SELECT cni FROM upd)              AS cni,
       (SELECT cbs FROM upd)              AS cbs,
       (SELECT mni FROM upd)              AS mni,
       (SELECT mbs FROM upd)              AS mbs,
       (SELECT et  FROM new_tsi)          AS et
`;

async function write_a_tsi(tsi_res, originator) {
    const { rows } = await pool.query(WRITE_TSI_SQL, [
        tsi_res.pi,                                        // $1
        tsi_res.cs,                                        // $2
        tsi_res.ri,                                        // $3
        tsi_res.rn,                                        // $4
        tsi_res.sid,                                       // $5
        tsi_res.et,                                        // $6
        tsi_res.ct,                                        // $7
        tsi_res.cr,                                        // $8
        tsi_res.lbl,                                       // $9
        tsi_res.loc ? JSON.stringify(tsi_res.loc) : null,  // $10
        JSON.stringify(tsi_res.con ?? null),               // $11
        tsi_res.dgt,                                       // $12
        tsi_res.snr ?? null,                               // $13
        tsi_res.sid.split('/').length,                     // $14
        originator,                                        // $15
    ]);

    const r = rows[0];
    return {
        parent_found: Number(r.parent_found) > 0,
        parent_detecting: r.parent_mdd === true,
        parent_anchored: r.parent_anchor != null,
        stored: Number(r.stored) > 0,
        cni: r.cni,
        cbs: r.cbs,
        mni: r.mni,
        mbs: r.mbs,
        et:  r.et,
    };
}

// Eviction in one statement, mirroring EVICT_SQL in cse/resources/cin.js — including the leading
// SELECT ... FOR UPDATE on the parent, which is what keeps this statement's lock order the same
// as the write's. Taking the child rows first here and the parent first there is what produced a
// measured deadlock on <container>; the same shape would produce the same deadlock on <timeSeries>.
const EVICT_TSI_SQL = `
WITH locked AS (
    SELECT ri FROM ts WHERE ri = $1 FOR UPDATE
), ranked AS (
    SELECT ri, cs, sid,
           row_number() OVER (ORDER BY dgt DESC, ri DESC) AS pos,
           sum(cs)      OVER (ORDER BY dgt DESC, ri DESC
                              ROWS UNBOUNDED PRECEDING)   AS running_bytes
      FROM tsi
     WHERE pi = $1
), victims AS (
    SELECT ri, cs, sid FROM ranked
     WHERE (($2::int IS NOT NULL AND pos > $2)
         OR ($3::int IS NOT NULL AND running_bytes > $3))
       AND (SELECT count(*) FROM locked) = 1
), del_tsi AS (
    DELETE FROM tsi c    USING victims v WHERE c.ri = v.ri RETURNING c.cs
), del_lookup AS (
    DELETE FROM lookup l USING victims v WHERE l.ri = v.ri RETURNING l.ri
), adj AS (
    UPDATE ts
       SET cni = cni - (SELECT count(*) FROM del_tsi),
           cbs = cbs - COALESCE((SELECT sum(cs) FROM del_tsi), 0)
     WHERE ri = $1
    RETURNING cni, cbs
)
SELECT COALESCE((SELECT array_agg(sid) FROM victims), ARRAY[]::varchar[]) AS sids,
       (SELECT count(*) FROM del_lookup)                                 AS evicted,
       a.cni, a.cbs
  FROM adj a
`;

async function evict_if_needed(parent, tsi_pi) {
    const { cni, cbs, mni, mbs } = parent.dataValues || parent;

    if ((mni == null || cni <= mni) && (mbs == null || cbs <= mbs)) return;

    const { rows } = await pool.query(EVICT_TSI_SQL, [tsi_pi, mni ?? null, mbs ?? null]);
    const evicted = rows[0];
    if (!evicted || Number(evicted.evicted) === 0) return;

    const { invalidateLookupCache } = require('../hostingCSE');
    for (const sid of evicted.sids || []) invalidateLookupCache(sid);

    logger.debug({ pi: tsi_pi, evicted: Number(evicted.evicted), cni: evicted.cni, cbs: evicted.cbs },
        'evicted oldest <tsi>(s)');
}

// Tolerance, not zero: clocks drift by seconds between honest machines and a warning on every
// instance would be noise. Two minutes is far below the smallest offset a timezone mistake can
// produce (thirty minutes) and far above ordinary drift.
const DGT_AHEAD_TOLERANCE_SECONDS = 120;

function warn_if_dgt_is_ahead(dgt, now, sid) {
    if (!dgt) return;
    let ahead;
    try {
        const { to_epoch_seconds } = require('../missing-data');
        ahead = to_epoch_seconds(dgt) - to_epoch_seconds(now);
    } catch {
        return;   // an unparseable dgt is the schema's problem, not this warning's
    }
    if (ahead <= DGT_AHEAD_TOLERANCE_SECONDS) return;
    logger.warn({ sid, dgt, cse_time: now, ahead_seconds: ahead },
        'dataGenerationTime is ahead of this CSE clock; missing-data detection measures from it, ' +
        'so expected points are in the future and missingDataList will stay empty');
}

async function create_a_tsi(req_prim, resp_prim) {
    const prim_res = req_prim.pc['m2m:tsi'];

    const validated = tsi_create_schema.validate(prim_res);
    if (validated.error) {
        const { message, path } = validated.error.details[0];
        resp_prim.rsc = enums.rsc_str['BAD_REQUEST'];
        resp_prim.pc = { 'm2m:dbg': path[0] + ' => ' + message.replace(/"/g, '') };
        return;
    }

    const tsi_pi = req_prim.ri;
    const tsi_sid = req_prim.sid + '/' + prim_res.rn;

    const parent_ty = req_prim.to_ty;
    if (tsi_parent_res_types.includes(enums.ty_str[parent_ty.toString()]) === false) {
        resp_prim.rsc = enums.rsc_str['INVALID_CHILD_RESOURCE_TYPE'];
        resp_prim.pc = { 'm2m:dbg': 'parent of <tsi> resource shall be <ts> resource' };
        return;
    }

    const { get_mem_size } = require('../hostingCSE');
    const content_size = get_mem_size(prim_res.con);

    const ri = generate_ri();
    const now = get_cur_time();
    const et = get_default_et();

    if (prim_res.loc) {
        await convert_loc_to_geoJson(prim_res, resp_prim);
        if (resp_prim.rsc) return;
    }

    const tsi_res = {
        ri,
        ty: enums.ty_num.tsi,
        rn: prim_res.rn,
        pi: tsi_pi,
        sid: tsi_sid,
        et: prim_res.et || et,
        ct: now,
        lt: now,
        cr: prim_res.cr === null ? req_prim.fr : null,
        lbl: prim_res.lbl || null,
        loc: prim_res.loc,
        cs: content_size,
        con: prim_res.con,
        dgt: prim_res.dgt,
        snr: prim_res.snr ?? null,
    };

    // A dataGenerationTime ahead of this CSE's clock is legal and is stored as sent, but it is
    // worth saying out loud. Missing-data detection measures expected points from the first
    // instance's dgt (TS-0001:10.2.4.29), so an anchor in the future puts every expected point in
    // the future too and nothing is ever overdue -- missingDataList stays empty forever and the
    // resource looks like detection is broken.
    //
    // m2m:timestamp carries no timezone (CDT-commonTypes.xsd: YYYYMMDDThhmmss and nothing more),
    // so a sender writing local time where the receiver reads another zone produces exactly this,
    // silently. Observed against a conformance tester whose dgt ran two hours ahead of the ct this
    // CSE assigned in the same second. Warned rather than refused: the standard permits a future
    // dgt and a client may legitimately be backfilling a schedule.
    warn_if_dgt_is_ahead(tsi_res.dgt, now, tsi_sid);

    try {
        const written = await write_a_tsi(tsi_res, req_prim.fr);

        // The instance that gives a detecting <timeSeries> its anchor is the one that turns
        // "nothing is due" into "something is due". Before it there is no expected point for the
        // sweep to have computed a wake-up from, so it is asleep on the ceiling. Only this one:
        // once the anchor exists the sweep paces itself correctly, and waking on every instance
        // would force a pass per instance on a busy time series.
        if (written.parent_found && written.parent_detecting && !written.parent_anchored) {
            require('../missing-data-scheduler').wake();
        }

        if (!written.parent_found) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': 'parent <ts> resource not found' };
            return;
        }
        if (!written.stored) {
            resp_prim.rsc = enums.rsc_str['NOT_ACCEPTABLE'];
            resp_prim.pc = { 'm2m:dbg': 'content size of a new <tsi> is bigger than mbs of the parent <ts>' };
            return;
        }

        tsi_res.et = written.et;

        await evict_if_needed(written, tsi_pi);

        resp_prim.pc = build_tsi_response(tsi_res);
    } catch (err) {
        logger.error({ err }, 'create_a_tsi failed');
        // A duplicate dataGenerationTime trips uq_tsi_pi_dgt and arrives as the same
        // unique-violation this helper already maps to CONFLICT (TS-0001:9.6.37 requires dgt to
        // be unique among siblings).
        const { rsc, dbg } = classify_create_error(err);
        resp_prim.rsc = rsc;
        resp_prim.pc = { 'm2m:dbg': dbg };
    }
}

function build_tsi_response(tsi_res) {
    const tsi_obj = { 'm2m:tsi': {
        ty:  tsi_res.ty,
        ri:  tsi_res.ri,
        rn:  tsi_res.rn,
        pi:  tsi_res.pi,
        ct:  tsi_res.ct,
        lt:  tsi_res.lt,
        et:  tsi_res.et,
        cs:  tsi_res.cs,
        con: tsi_res.con,
        dgt: tsi_res.dgt,
    }};

    if (tsi_res.lbl && tsi_res.lbl.length)   tsi_obj['m2m:tsi'].lbl  = tsi_res.lbl;
    if (tsi_res.cr)                          tsi_obj['m2m:tsi'].cr   = tsi_res.cr;
    if (tsi_res.snr !== null && tsi_res.snr !== undefined) tsi_obj['m2m:tsi'].snr = tsi_res.snr;
    if (tsi_res.loc)                         tsi_obj['m2m:tsi'].loc  = get_loc_attribute(tsi_res.loc);

    return tsi_obj;
}

async function retrieve_a_tsi(req_prim, resp_prim) {
    const tsi_obj = { 'm2m:tsi': {} };
    const ri = req_prim.ri;

    try {
        const db_res = await TSI.findByPk(ri);
        if (!db_res) {
            resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
            resp_prim.pc = { 'm2m:dbg': '<tsi> resource not found' };
            return;
        }

        if (req_prim && req_prim.int_cr_req === true)
            tsi_obj['m2m:tsi'].int_cr = db_res.int_cr;

        tsi_obj['m2m:tsi'].ty = db_res.ty;
        tsi_obj['m2m:tsi'].et = db_res.et;
        tsi_obj['m2m:tsi'].ct = db_res.ct;
        tsi_obj['m2m:tsi'].lt = db_res.lt;
        tsi_obj['m2m:tsi'].ri = db_res.ri;
        tsi_obj['m2m:tsi'].rn = db_res.rn;
        tsi_obj['m2m:tsi'].pi = db_res.pi;
        // multiplicity 1 in TS-0001:9.6.37
        tsi_obj['m2m:tsi'].dgt = db_res.dgt;
        tsi_obj['m2m:tsi'].cs = db_res.cs;
        tsi_obj['m2m:tsi'].con = db_res.con;

        if (db_res.lbl && db_res.lbl.length) tsi_obj['m2m:tsi'].lbl = db_res.lbl;
        if (db_res.cr) tsi_obj['m2m:tsi'].cr = db_res.cr;
        if (db_res.snr !== null && db_res.snr !== undefined) tsi_obj['m2m:tsi'].snr = db_res.snr;
        if (db_res.loc) tsi_obj['m2m:tsi'].loc = get_loc_attribute(db_res.loc);
    } catch (err) {
        resp_prim.rsc = enums.rsc_str['NOT_FOUND'];
        resp_prim.pc = { 'm2m:dbg': '<tsi> resource not found' };
        throw err;
    }

    resp_prim.pc = tsi_obj;
}

// The newest ('DESC') or oldest ('ASC') non-obsolete <timeSeriesInstance> under a <timeSeries>.
// Shared by <latest>/<oldest> and their DELETE forms so the four cannot disagree about which
// instances count — the reasoning is the same as find_edge_cin in cse/resources/cnt.js (DEC-095).
async function find_edge_tsi(parent_ri, order) {
    return TSI.findOne({
        where: { pi: parent_ri, ...not_obsolete_where() },
        order: [['dgt', order], ['ri', order]],
        attributes: ['ri'],
    });
}

module.exports = {
    create_a_tsi,
    retrieve_a_tsi,
    evict_if_needed,
    find_edge_tsi,
};
