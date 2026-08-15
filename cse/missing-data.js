// Missing-data detection for <timeSeries>, per TS-0001:10.2.4.29.
//
// The calculation is deliberately separate from what triggers it. Everything below is a pure
// function of its arguments; the sweep that calls it is a later task, and the subscription layer
// (notificationEventType=8, a later cycle) is meant to call the same functions rather than
// restate the rules.
//
// Timestamps are the CSE's stored form, YYYYMMDDTHHMMSS, and all durations are whole seconds.

const config = require('config');
const { Op } = require('sequelize');

const logger = require('../logger').forFile(__filename);

// Parsing is local to this file so the arithmetic below has one representation to worry about.
// cse/utils.js has no converter for arbitrary YYYYMMDDTHHMMSS strings to/from epoch seconds —
// only get_cur_time()/get_default_et(), which produce the current time and don't parse. If
// cse/utils.js grows a shared converter, switch to it rather than keeping two.
function to_epoch_seconds(ts) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(ts);
    if (!m) throw new Error(`unparseable timestamp: ${ts}`);
    const [, y, mo, d, h, mi, s] = m;
    return Math.floor(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) / 1000);
}

function from_epoch_seconds(sec) {
    const d = new Date(sec * 1000);
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T` +
           `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/**
 * Which expected data points are missing as of `now`.
 *
 * @param {object}   a
 * @param {string}   a.anchor        dataGenerationTime of the first <timeSeriesInstance> received
 *                                   since detection last (re)started
 * @param {number}   a.pei           periodicInterval, seconds
 * @param {number?}  a.peid          periodicIntervalDelta, seconds. TS-0001:9.6.36 explicitly
 *                                   allows a local policy default when this is absent
 * @param {number?}  a.mdt           missingDataDetectTimer, seconds. TS-0001:9.6.36 grants no
 *                                   such local-policy allowance for this one — but without a
 *                                   value the detection time is undefined, so a deployment
 *                                   default is unavoidable regardless
 * @param {string[]} a.present_dgts  dataGenerationTime of every <timeSeriesInstance> under the parent
 * @param {string}   a.now
 * @param {number?}  a.from_n        highest N already accounted for, or null
 * @returns {{ missing: string[], watermark: number }} missing newest-first
 */
function detect_missing({ anchor, pei, peid, mdt, present_dgts, now, from_n }) {
    const delta = peid ?? config.default.timeSeries.peid_default;
    const timer = mdt ?? config.default.timeSeries.mdt_default;

    const anchor_s = to_epoch_seconds(anchor);
    const now_s = to_epoch_seconds(now);
    const present = present_dgts.map(to_epoch_seconds).sort((x, y) => x - y);

    // The highest N whose detection time has passed:
    //   anchor + N*pei + timer <= now
    const last_n = Math.floor((now_s - anchor_s - timer) / pei);
    const first_n = (from_n === null || from_n === undefined) ? 1 : from_n + 1;

    const missing = [];
    for (let n = first_n; n <= last_n; n++) {
        const expected = anchor_s + n * pei;
        const hit = present.some((p) => Math.abs(p - expected) <= delta);
        if (!hit) missing.push(from_epoch_seconds(expected));
    }

    // Newest first — TS-0001:9.6.36 describes missingDataList as being "in descending order by
    // time". The loop builds it oldest-first, so reverse rather than sort: the values are
    // already monotonic.
    missing.reverse();

    // The watermark is the highest N this call accounted for. When now is early enough that
    // last_n is negative (no detection time has passed yet), max() with from_n (0 when this is
    // the first call) keeps the watermark from going backwards — it never regresses below what
    // a previous call already established, and a first call with nothing yet due reports 0
    // rather than a negative number that would then lower first_n on the next call.
    return { missing, watermark: Math.max(last_n, from_n ?? 0) };
}

/**
 * Fold newly detected points into missingDataList / missingDataCurrentNr.
 *
 * TS-0001:10.2.4.29 caps the list at missingDataMaxNr by dropping the oldest, which is
 * TP/oneM2M/CSE/TS/002. missingDataCurrentNr is defined by TS-0001:9.6.36 as the count of
 * entries in the list, so it is derived here rather than tracked separately — the two cannot be
 * allowed to drift apart.
 *
 * @param {string[]} mdlt         current list, newest first
 * @param {number}   mdc          current count (unused except as a caller convenience; recomputed)
 * @param {string[]} new_entries  newly detected, newest first
 * @param {number?}  mdn          missingDataMaxNr, or null for unbounded
 */
function apply_missing(mdlt, mdc, new_entries, mdn) {
    const merged = [...new_entries, ...mdlt];
    const capped = (mdn == null) ? merged : merged.slice(0, mdn);
    return { mdlt: capped, mdc: capped.length };
}

/**
 * One pass over every <timeSeries> that is currently detecting.
 *
 * Time-driven rather than request-driven, because a gap is the absence of a request: nothing
 * arrives to trigger the check. This is the same shape as expired_resource_cleanup in
 * mobius4.js — a setInterval gated by cse/singleton-role.js so it runs in one process — and it
 * is deliberately a sweep rather than a timer per resource: timers would have to be rebuilt on
 * every restart, whereas the sweep reads its own resume point (md_watermark_n) out of the row.
 *
 * <timeSeries> DELETE needs no special handling for TS-0001:10.2.4.24's "shall terminate timers
 * related to the missing data detection process": there are no per-resource timers to terminate,
 * and a deleted row is simply not returned by the query below.
 *
 * @param {object} [opts]
 * @param {string} [opts.now]  override for tests; defaults to the current time
 */
async function sweep_missing_data(opts = {}) {
    const TS = require('../models/ts-model');
    const TSI = require('../models/tsi-model');
    const { get_cur_time } = require('./utils');

    const now = opts.now || get_cur_time();

    // TS-0001:10.2.4.21 — the procedure runs only when periodicInterval is set and
    // missingDataDetect is TRUE.
    const candidates = await TS.findAll({
        where: { mdd: true, pei: { [Op.ne]: null } },
        attributes: ['ri', 'pei', 'peid', 'mdt', 'mdn', 'mdlt', 'mdc', 'md_anchor_dgt', 'md_watermark_n'],
    });

    let updated = 0;

    for (const row of candidates) {
        // The whole body is one try/catch, not just detect_missing: anchor establishment
        // (to_epoch_seconds inside the reduce below) and row.save() can both throw too, and a
        // throw that escapes this loop aborts sweep_missing_data() entirely — leaving every
        // remaining candidate in this tick's array unprocessed, and recurring on every
        // subsequent tick because it happens before the anchor is persisted. Catching per
        // iteration is what makes "a single unparseable timestamp must not stop the sweep for
        // every other resource" true rather than aspirational.
        try {
            const children = await TSI.findAll({
                where: { pi: row.ri },
                attributes: ['dgt'],
            });
            if (children.length === 0) continue;

            const dgts = children.map((c) => c.dgt);

            // The anchor is "the dataGenerationTime of the first received <timeSeriesInstance>".
            // It is recorded on the first sweep that sees a child and then held, so that later
            // arrivals — or evictions of the earliest instance — cannot move the origin of the
            // expected-time series underneath the entries already recorded.
            let anchor = row.md_anchor_dgt;
            if (!anchor) {
                anchor = dgts.reduce((a, b) => (to_epoch_seconds(b) < to_epoch_seconds(a) ? b : a));
                row.md_anchor_dgt = anchor;
            }

            const result = detect_missing({
                anchor,
                pei: row.pei,
                peid: row.peid,
                mdt: row.mdt,
                present_dgts: dgts,
                now,
                from_n: row.md_watermark_n,
            });

            const changed_anchor = row.changed('md_anchor_dgt');
            if (result.missing.length === 0 && result.watermark === row.md_watermark_n && !changed_anchor) continue;

            const folded = apply_missing(row.mdlt || [], row.mdc || 0, result.missing, row.mdn);
            row.mdlt = folded.mdlt;
            row.mdc = folded.mdc;
            row.md_watermark_n = result.watermark;
            await row.save();
            updated++;
        } catch (err) {
            // A single unparseable timestamp must not stop the sweep for every other resource.
            logger.warn({ err, ri: row.ri }, 'missing-data sweep skipped one <ts>');
        }
    }

    return { scanned: candidates.length, updated };
}

module.exports = { detect_missing, apply_missing, sweep_missing_data, to_epoch_seconds, from_epoch_seconds };
