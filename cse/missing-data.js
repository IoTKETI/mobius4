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

// Index of the first element >= target in a numeric array sorted ascending (the standard
// lower-bound binary search). Used below to test window membership in O(log n) instead of
// scanning every present instance for every expected point — with a retention-sized present set
// and a per-sweep cap of thousands of expected points, that scan is a large number of comparisons
// for one resource in one tick, on the singleton sweeper (finding 5).
function lower_bound(sorted, target) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sorted[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
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
 * @param {string[]} a.present_dgts  dataGenerationTime of every <timeSeriesInstance> the caller
 *                                   could still usefully check against — the sweep restricts this
 *                                   to instances new enough to matter (see sweep_missing_data);
 *                                   it does not need to be every child that has ever existed
 * @param {string?}  a.oldest_surviving_dgt  dataGenerationTime of the oldest <timeSeriesInstance>
 *                                   currently under the parent, or null if none remain. Used to
 *                                   tell a genuine gap apart from an instance that arrived and was
 *                                   later evicted by retention (TS-0001:10.2.4.25) before this
 *                                   point was ever examined — see the loop below
 * @param {string}   a.now
 * @param {number?}  a.from_n        highest N already accounted for, or null
 * @param {number?}  a.max_points    upper bound on how many N this call examines; defaults to
 *                                   config.default.timeSeries.max_points_per_sweep. The remainder
 *                                   is left for the next call via the returned watermark
 * @returns {{ missing: string[], watermark: number }} missing newest-first
 */
/**
 * The missingDataDetectTimer actually in force for a <timeSeries>, which is not always the value
 * of its mdt attribute: mdt is 0..1 and TS-0001:9.6.36 gives no default, but TS-0001:10.2.4.29
 * defines the missing data detection time as "expected dataGenerationTime + missingDataDetectTimer"
 * -- a term that has to have a value for the detection time to exist at all.
 *
 * Exported because two callers need the same answer. detect_missing decides *which* points are
 * missing; report_missing_data timestamps *when* each was detected in order to run the
 * subscription's window timer. Those were separate expressions and they disagreed: an omitted mdt
 * meant the deployment default here and a flat 0 there. Nothing failed, because the window
 * arithmetic compares detection times only against other detection times and a constant offset
 * cancels -- but the two were one edit away from producing window boundaries that never happened.
 *
 * Both arguments and the result are in the attributes' own unit, milliseconds.
 *
 * @param {number|null|undefined} mdt   the resource's missingDataDetectTimer, if it has one
 * @param {number} delta                the effective periodicIntervalDelta
 */
function effective_mdt(mdt, delta) {
    return mdt ?? Math.max(config.default.timeSeries.mdt_default, delta + 1);
}

function detect_missing({ anchor, pei, peid, mdt, present_dgts, oldest_surviving_dgt, now, from_n, max_points }) {
    const delta_ms = peid ?? config.default.timeSeries.peid_default;

    // TS-0001:9.6.36: "If periodicIntervalDelta is present, the value of this attribute [mdt]
    // shall be greater than periodicIntervalDelta." cse/resources/ts.js enforces that only when
    // mdt is given explicitly — a client that omits mdt never asserted a value for it, so there
    // is nothing of theirs to validate. But the deployment default has to satisfy the same
    // relationship anyway, or an omitted mdt could silently violate it: pei:300/peid:150 is a
    // legal peid<=pei/2 configuration, yet the flat default of 60 is not greater than 150. Basing
    // the default on the effective peid keeps "mdt > peid" true whether or not the client ever
    // mentioned mdt, without rejecting a request that never supplied the attribute being
    // complained about (the alternative — validating the effective timer at CREATE/UPDATE and
    // refusing — would do exactly that for a conforming client).
    const timer_ms = effective_mdt(mdt, delta_ms);
    const max_n = max_points ?? config.default.timeSeries.max_points_per_sweep;

    // periodicInterval, periodicIntervalDelta and missingDataDetectTimer are MILLISECONDS. The
    // arithmetic below is in epoch seconds because m2m:timestamp's resolution is one second, so
    // the three are converted once here rather than at each use.
    //
    // TS-0001:9.6.36 gives all three as xs:positiveInteger and states no unit anywhere in the
    // prose or the XSD -- this is not read off the standard but off a conformance tester's own
    // arithmetic (SQ-009). TP/oneM2M/CSE/TS/001 was run against a <timeSeries> with pei 5000 and
    // mdt 1000 and the resource read back nine seconds later expecting exactly one missing point:
    // that is a five-second period detected one second late, and it is consistent with no other
    // reading.
    //
    // A pei that is not a whole number of seconds cannot be represented in missingDataList, whose
    // entries are m2m:timestamp values -- to_epoch_seconds does not accept the ",ffffff" fraction
    // the type allows either. Sub-second periods are therefore out of scope here rather than
    // silently rounded into duplicate entries (BACKLOG-131).
    const MS_PER_SECOND = 1000;
    const pei_s = pei / MS_PER_SECOND;
    const delta = delta_ms / MS_PER_SECOND;
    const timer = timer_ms / MS_PER_SECOND;

    const anchor_s = to_epoch_seconds(anchor);
    const now_s = to_epoch_seconds(now);
    const present = present_dgts.map(to_epoch_seconds).sort((x, y) => x - y);
    const oldest_s = (oldest_surviving_dgt == null) ? null : to_epoch_seconds(oldest_surviving_dgt);

    // The highest N whose detection time has passed:
    //   anchor + N*pei + timer <= now
    const last_n_wanted = Math.floor((now_s - anchor_s - timer) / pei_s);
    const first_n = (from_n === null || from_n === undefined) ? 1 : from_n + 1;

    // A historical backfill (anchor far in the past, small periodicInterval) can put last_n_wanted
    // in the hundreds of thousands or millions — unbounded, that range would be built into
    // `missing` synchronously in one call. max_n caps how many N a single call examines; the
    // watermark returned below reports only as far as this call actually got, so the next call
    // (from_n = that watermark) picks up where this one left off rather than re-examining or
    // skipping anything. Correctness is unaffected — every point is still examined eventually —
    // only the per-call cost is bounded.
    const last_n = Math.min(last_n_wanted, first_n + max_n - 1);

    const missing = [];
    for (let n = first_n; n <= last_n; n++) {
        const expected = anchor_s + n * pei_s;
        // present is sorted ascending, so the window [expected-delta, expected+delta] is a
        // contiguous slice: find where it would start and check whether that element still
        // falls at or before the upper edge. Both edges are inclusive, matching the "+/-
        // periodicIntervalDelta" boundary tests in test/missing-data.test.js.
        const idx = lower_bound(present, expected - delta);
        const hit = idx < present.length && present[idx] <= expected + delta;
        if (hit) continue;

        // Retention (TS-0001:10.2.4.25) evicts the oldest <timeSeriesInstance> first. If the
        // oldest instance still present arrived strictly after this point's whole window
        // (expected +/- delta) closed, then whatever might have satisfied this point — if it ever
        // arrived — is already gone. There is then no way to distinguish a genuine gap from an
        // instance that arrived and was evicted before any sweep examined it, so this point is
        // skipped rather than recorded as a false positive. The watermark still advances past it
        // (below), since "unknowable" is a final answer, not a reason to re-check later — the
        // evidence only gets older, not newer.
        if (oldest_s != null && expected + delta < oldest_s) continue;

        missing.push(from_epoch_seconds(expected));
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
 *
 * new_entries is now bounded by detect_missing's max_points (finding 1), so merging first and
 * slicing to mdn afterward is already bounded work regardless of mdn — not building past mdn in
 * the first place would save no more than the difference between mdn and max_points, and it
 * would cost this function a third parameter no other caller of the merge step needs. Left as a
 * slice rather than restructured into an accumulate-with-early-stop.
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
    let notified = 0;

    for (const row of candidates) {
        // The whole body is one try/catch, not just detect_missing: to_epoch_seconds calls below
        // (the anchor, and every present/oldest dgt parsed inside detect_missing) and row.save()
        // can all throw too, and a throw that escapes this loop aborts sweep_missing_data()
        // entirely — leaving every remaining candidate in this tick's array unprocessed, and
        // recurring on every subsequent tick because it happens before the anchor is persisted.
        // Catching per iteration is what makes "a single unparseable timestamp must not stop the
        // sweep for every other resource" true rather than aspirational.
        try {
            // A single indexed lookup (uq_tsi_pi_dgt in db/migrations/v4.16.0.sql) for the oldest
            // surviving child, used two ways below: to bootstrap the anchor on the first sweep
            // that sees this <ts>, and on every sweep to tell a genuine gap apart from an instance
            // that arrived and was later evicted by retention (TS-0001:10.2.4.25) before any
            // sweep got to look at it — see detect_missing's oldest_surviving_dgt. Replaces the
            // former "fetch every child" query for this purpose; that query still ran, unbounded,
            // every tick even though only the single oldest row was ever used for the anchor.
            const oldest = await TSI.findOne({
                where: { pi: row.ri },
                attributes: ['dgt'],
                order: [['dgt', 'ASC']],
            });

            // The anchor is "the dataGenerationTime of the first received <timeSeriesInstance>".
            // It is recorded on the first sweep that sees a child and then held, so that later
            // arrivals — or evictions of the earliest instance — cannot move the origin of the
            // expected-time series underneath the entries already recorded.
            let anchor = row.md_anchor_dgt;
            if (!anchor) {
                if (!oldest) continue; // nothing has arrived since detection started
                anchor = oldest.dgt;
                row.md_anchor_dgt = anchor;
            }

            const anchor_s = to_epoch_seconds(anchor);
            const delta = (row.peid ?? config.default.timeSeries.peid_default) / 1000;
            const watermark = row.md_watermark_n ?? 0;

            // Only fetch children new enough to still matter. TS-0001:10.2.4.29's window is
            // expected +/- periodicIntervalDelta, and the next unexamined point's expected time is
            // anchor + (watermark+1)*pei, so nothing older than anchor + watermark*pei - delta can
            // match it or any later N (one full periodicInterval of margin below the exact
            // window-lower-bound, kept simple rather than tight). Before this, the query above
            // fetched every child under the parent regardless of age — up to maxNrOfInstances rows
            // — on every tick.
            const boundary = from_epoch_seconds(anchor_s + watermark * (row.pei / 1000) - delta);
            const children = await TSI.findAll({
                where: { pi: row.ri, dgt: { [Op.gte]: boundary } },
                attributes: ['dgt'],
            });
            const dgts = children.map((c) => c.dgt);

            const result = detect_missing({
                anchor,
                pei: row.pei,
                peid: row.peid,
                mdt: row.mdt,
                present_dgts: dgts,
                oldest_surviving_dgt: oldest ? oldest.dgt : null,
                now,
                from_n: row.md_watermark_n,
                max_points: config.default.timeSeries.max_points_per_sweep,
            });

            const changed_anchor = row.changed('md_anchor_dgt');
            if (result.missing.length === 0 && result.watermark === row.md_watermark_n && !changed_anchor) continue;

            // TS-0001:9.6.36 leaves missingDataList uncapped when missingDataMaxNr is absent, and
            // apply_missing (above) stays faithful to that -- an explicit null always means
            // unbounded at the function level. But an uncapped list is a deployment liability, not
            // a spec question: mdlt is a VARCHAR(20)[] column, and a <timeSeries> with mdd:true, a
            // small periodicInterval and one backfilled old instance accrues entries every sweep
            // tick forever. Around 31 million entries the column exceeds PostgreSQL's 1 GB field
            // limit, row.save() below throws, and the catch around this loop iteration then
            // silently stalls detection for that resource on every later tick too (finding 6).
            // config.default.timeSeries.mdn_default applies here, at the sweep, rather than
            // changing what the client's own missingDataMaxNr means: a client-supplied value is
            // always honored as-is however large, and row.mdn itself is never written, so
            // retrieving the resource still reports no missingDataMaxNr, exactly as the client
            // left it -- only the accumulation this sweep performs is capped.
            const mdn = row.mdn ?? config.default.timeSeries.mdn_default;
            const folded = apply_missing(row.mdlt || [], row.mdc || 0, result.missing, mdn);
            row.mdlt = folded.mdlt;
            row.mdc = folded.mdc;
            row.md_watermark_n = result.watermark;
            await row.save();
            updated++;

            // The reporting half (TS-0001:10.2.4.29, TS-0004:7.5.1.2.9). Runs after the resource
            // state is persisted, so a subscription can never be told about a point the <ts> does
            // not yet carry. result.missing is what this tick newly detected -- deliberately not
            // the folded missingDataList, which is capped by missingDataMaxNr and shared by every
            // subscription, while the clause asks each subscription for what it has seen since its
            // own timer started.
            //
            // Required lazily: cse/noti.js pulls in the MQTT binding and the AE model, and this
            // module is also loaded by tests that only exercise the detection arithmetic.
            if (result.missing.length > 0) {
                const { report_missing_data } = require('./missing-data-subscription');
                const noti = require('./noti');
                notified += await report_missing_data({
                    ts_ri: row.ri,
                    missing: result.missing,
                    mdt: row.mdt,
                    peid: row.peid,
                    send_a_noti: noti.send_a_noti,
                    prefetch_ae_poa: noti.prefetch_ae_poa,
                });
            }
        } catch (err) {
            // A single unparseable timestamp must not stop the sweep for every other resource.
            logger.warn({ err, ri: row.ri }, 'missing-data sweep skipped one <ts>');
        }
    }

    return { scanned: candidates.length, updated, notified };
}

module.exports = { detect_missing, effective_mdt, apply_missing, sweep_missing_data, to_epoch_seconds, from_epoch_seconds };
