"use strict";
// The reporting half of missing-data detection: TS-0001:10.2.4.29 and TS-0004:7.5.1.2.9.
//
// cse/missing-data.js detects missing data points and records them on the <timeSeries> resource.
// This module answers the other question the clause asks -- which subscriptions should hear about
// them, and when.
//
// The rule, in the clause's own terms (T1-T5 of figure 10.2.4.29-1):
//
//   T1  the first missing data point after the subscription exists starts a timer, counter = 1
//   T2  when the counter reaches the missingData `number`, a NOTIFY goes out
//   T3  every further point while the timer runs sends another NOTIFY
//   T4  when the timer expires the counter resets to 0; the timer is not restarted
//   T5  the next detected point starts a new timer, counter = 1
//
// THERE IS NO TIMER HERE. The clause says "timer", but nothing observable happens at the moment
// one expires -- the only effect is that the next detection counts from zero. So the window's end
// is stored and compared when the next point arrives. That buys three things: the state survives a
// restart (an in-memory timer would reset every subscriber's window on every deployment), there is
// no per-subscription object to hold, and the clause's "while the detection process is paused the
// timers associated with a subscription's window duration and counter continue to run" is true for
// free, because a stored end time keeps passing whether or not anything is watching it.
//
// Expiry is judged against the point's own **missing data detection time**, not against the wall
// clock when the sweep happens to run. The clause builds its whole timeline out of detection times
// (a point's detection time is its expected dataGenerationTime + missingDataDetectTimer), and a
// sweep that runs late must not move a window boundary. It also makes the outcome a function of
// the data alone, which is what lets the pure part below be tested without a clock.
const moment = require('moment');

const logger = require('../logger').forFile(__filename);
const SUB = require('../models/sub-model');
const { not_obsolete_where } = require('./utils');
const config = require('config');
const { to_epoch_seconds, from_epoch_seconds, effective_mdt } = require('./missing-data');

// The notificationEventType this module reports under: "Report on missing data points".
const NET_MISSING_DATA = 8;

// xs:duration in seconds. The window duration is m2m:missingData's `duration` element, typed
// xs:duration (CDT-commonTypes.xsd:1049), so "PT1M" and "P1DT2H" are both legal spellings.
//
// A non-positive duration is not refused. The XSD does not forbid one, and the literal consequence
// is well defined: the window closes at or before the point that opened it, so every subsequent
// point starts a window of its own and no counter ever reaches a threshold above 1. Refusing it
// would be inventing a rule the schema does not carry.
//
// moment resolves months as 30 days and years as 365. Both are unusual spellings for a reporting
// window and neither is exact, which is a property of xs:duration itself rather than of this code.
function duration_seconds(iso) {
    const seconds = moment.duration(iso).asSeconds();
    return Number.isFinite(seconds) ? seconds : 0;
}

// The pure core. Takes the stored window state and the points detected since, and answers with the
// new state plus the notifications that fall due, in order.
//
// `detections` must be ascending by detection time -- the sweep produces them in expected
// dataGenerationTime order, and detection time is that plus a constant.
//
// Each notification is a snapshot: the list as it stood when that point arrived, and its length.
// Snapshots rather than references, because T3 sends one NOTIFY per point and each has to carry
// the count at its own moment, not the count at the end of the batch.
function advance_window(state, detections, { num, dur_s }) {
    let window_end_s = state && state.window_end_s !== undefined ? state.window_end_s : null;
    let points = state && Array.isArray(state.points) ? state.points.slice() : [];
    const notifications = [];

    for (const d of detections) {
        // T4/T5 folded together: an expired window is indistinguishable from no window, because
        // the only thing either state does is make the next point start a fresh one.
        if (window_end_s === null || d.detection_s >= window_end_s) {
            points = [];
            window_end_s = d.detection_s + dur_s;
        }
        points.push(d.dgt);
        // T2 is `=== num` and T3 is every point after it, which is the same test as `>= num`.
        if (points.length >= num) {
            notifications.push({ mdlt: points.slice(), mdc: points.length });
        }
    }

    return { window_end_s, points, notifications };
}

// Is this <subscription> one that asked to hear about missing data?
//
// Both halves are required. TS-0001:9.6.8 table 9.6.8-3 says the missingData condition "is ignored
// unless notificationEventType has a value of 'Report on missing data points'", so md without
// net=8 is not an error -- it simply never fires, and is filtered out here rather than refused at
// creation.
function subscribes_to_missing_data(sub) {
    const enc = sub && sub.enc;
    if (!enc || !Array.isArray(enc.net) || !enc.net.includes(NET_MISSING_DATA)) return false;
    const md = enc.md;
    return !!(md && typeof md === 'object' && Number.isInteger(md.num) && typeof md.dur === 'string');
}

// The notification representation. TS-0004:7.5.1.2.9 requires a timeSeriesNotification in the
// notificationEvent/representation element, and TS-0004:6.3.5.62 table 6.3.5.62-1 makes that the
// representation for notificationContentType 5. Its two members are missingDataList and
// missingDataCurrentNr (CDT-timeSeriesNotification.xsd:32); the root element's short name is tsn
// (TS-0004:8.2.7).
//
// mdc is **this subscription's window counter**, not the <timeSeries> resource's
// missingDataCurrentNr attribute, even though the two share a name. TS-0001:10.2.4.29 asks for
// "the number of missing data points that have been detected since the start of the subscription's
// timer". Recorded because the standard is not of one mind here: TP/oneM2M/CSE/TS/005's expected
// behaviour describes the payload as a <timeSeries> resource carrying missingDataList and
// "currentMissingDataNr", which is neither the element nor the name the XSD defines. Tracked as
// SQ-008.
function notification_body({ mdlt, mdc }) {
    return { 'm2m:tsn': { mdlt, mdc } };
}

// Evaluates every missing-data subscription on one <timeSeries> against the points a sweep has
// just recorded, persists the new window state, and sends what falls due.
//
// Returns the number of notifications sent, for the sweep's log line. Failures are contained per
// subscription: one bad notificationURI must not stop the others, and must not stop the sweep.
async function report_missing_data({ ts_ri, missing, mdt, peid, send_a_noti, prefetch_ae_poa }) {
    if (!Array.isArray(missing) || missing.length === 0) return 0;

    const subs = (await SUB.findAll({ where: { pi: ts_ri, ...not_obsolete_where() } }));
    const targets = subs.filter((sub) => subscribes_to_missing_data(sub.toJSON()));
    if (targets.length === 0) return 0;

    // A point's detection time is its expected dataGenerationTime plus missingDataDetectTimer
    // (TS-0001:10.2.4.29). mdt is optional, and an omitted one used to be read as 0 here while
    // the sweep that produced these points read it as the deployment default -- the same absent
    // attribute meaning two different instants. effective_mdt is now the single answer.
    // effective_mdt answers in the attribute's unit, milliseconds; detection_s below is in epoch
    // seconds.
    const detect_delay = effective_mdt(mdt, peid ?? config.default.timeSeries.peid_default) / 1000;
    const detections = missing
        .map((dgt) => ({ dgt, detection_s: to_epoch_seconds(dgt) + detect_delay }))
        .sort((a, b) => a.detection_s - b.detection_s);

    const ae_poa_map = await prefetch_ae_poa(targets.map((s) => s.toJSON()));
    let sent = 0;

    for (const sub of targets) {
        try {
            const enc = sub.enc;
            const dur_s = duration_seconds(enc.md.dur);
            const state = {
                window_end_s: sub.md_window_end ? to_epoch_seconds(sub.md_window_end) : null,
                points: sub.md_points || [],
            };

            const next = advance_window(state, detections, { num: enc.md.num, dur_s });

            // Persist before sending. A notification that goes out twice because the process died
            // between the send and the save is worse than one that is lost: the subscriber cannot
            // tell a duplicate from a genuine second point, and the counter it carries would
            // repeat. Saving first makes the failure mode "missed", which the next detection
            // corrects.
            sub.md_window_end = next.window_end_s === null ? null : from_epoch_seconds(next.window_end_s);
            sub.md_points = next.points;
            await sub.save();

            for (const snapshot of next.notifications) {
                await send_a_noti(sub.toJSON(), notification_body(snapshot), NET_MISSING_DATA, ae_poa_map);
                sent++;
            }
        } catch (err) {
            logger.warn({ err, sub_ri: sub.ri, ts_ri }, 'missing-data notification skipped one <subscription>');
        }
    }

    return sent;
}

module.exports = {
    NET_MISSING_DATA,
    duration_seconds,
    advance_window,
    subscribes_to_missing_data,
    notification_body,
    report_missing_data,
};
