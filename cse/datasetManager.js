const config = require('config');
const dsp_default = config.get('default.datasetPolicy');
const admin_id = config.get('cse.admin');
const csebase_rn = config.get('cse.csebase_rn');
const logger = require('../logger').forFile(__filename);
const enums = require('../config/enums');
const moment = require('moment');

const cb = require('./resources/cb');
const dts = require('./resources/dts');

const CNT = require('../models/cnt-model');
const CIN = require('../models/cin-model');

const { JSONPath } = require('jsonpath-plus');

const IntervalManager = require('./intervalManager');
const interval_manager = new IntervalManager();

const batch_data = {};

// Per-mlDatasetPolicy state for the live path's nullValuePolicy forward-fill (BACKLOG-101).
// Keyed by dsp_ri, same as batch_data. In-memory only -- module state, not persisted to the DB --
// so a CSE restart clears both maps exactly the way it already clears batch_data (an unflushed
// live-dataset batch has always been lost on restart; this adds no new volatility, it just makes
// the existing volatility apply to forward-fill too). Concretely: after a restart, the live path
// resumes with no known features and no last-known values, so the first row of each
// previously-known feature reads as "never seen" (empty string, nvp=0 or nvp=1 alike) until that
// feature's source reports again post-restart.
const live_last_known_values = {}; // dsp_ri -> { feature: value } (nvp=1 fill-forward state)
const live_known_features = {};    // dsp_ri -> Set of feature paths observed so far for that policy

async function create_a_historical_dataset(dsp_res, dst, det, lof) {
    if (dst === null || det === null) {
        return null;
    }

    // resolve timeCorrelationStartTime (tcst) and timeCorrelationDuration (tcd)
    const tcst = (dsp_res.tcst) ? dsp_res.tcst : dst;
    const tcd = (dsp_res.tcd) ? dsp_res.tcd : dsp_default.tcd;

    // resolve nullValuePolicy (nvp)
    const nvp = (dsp_res.nvp) ? dsp_res.nvp : dsp_default.nvp; // 0: leave as null, 1: fill with last known value

    //resolve datasetFormat (dsfm)
    const dsfm = dsp_res.dsfm; // dsfm is mandatory attribute

    // resolve numberOfRowsForHistoricalDataset (nrhd)
    const nrhd = (dsp_res.nrhd) ? dsp_res.nrhd : dsp_default.nrhd;

    // create <dts> resource for historical data and resolve historicalDatasetId (hdi)
    const dts_res = {
        dspi: dsp_res.sid, dst, det, tcst, tcd, nvp, dsfm, nrhd, lof // includes other attributes for create_a_dts
    };
    const tmp_resp_cb = {};
    const cb_res = (await cb.retrieve_a_cb(tmp_resp_cb)).pc['m2m:cb'];
    const tmp_req = {
        pc: { "m2m:dts": dts_res },
        ri: cb_res.ri,
        sid: cb_res.rn,
        ty: 106,    // dts resource type -- selects hostingCSE.create_a_res's dispatch case
        to_ty: 5,   // cb resource type (the parent)
        fr: admin_id,
        // Marks this as a request the CSE raised itself. create_a_res refuses ty 106/107 without
        // it, because TR-0071:7.2.3.2 defines no client-facing Create for <dataset>.
        int_cr_req: true
    };
    const tmp_resp_dts = {};

    // Routed through create_a_res rather than calling dts.create_a_dts directly, for the same
    // reason <datasetFragment> is (see create_historical_dataset_fragments below): the
    // notification that follows create_a_res's dispatch switch is the only one there is, so a
    // <dataset> created this way was invisible to anyone subscribed to the <CSEBase>'s children.
    // <datasetFragment> was fixed this way earlier and <dataset> was left behind, which meant
    // "internal creates skip notification" held for one of the two and not the other, with
    // nothing saying which was intended. BACKLOG-097.
    const { create_a_res } = require('./hostingCSE');
    await create_a_res(tmp_req, tmp_resp_dts);
    const dts_res_created = tmp_resp_dts.pc["m2m:dts"];
    const hdi = cb_res.rn + '/' + dts_res_created.rn;

    await create_historical_dataset_fragments(dts_res_created.ri, dsp_res.sri, dst, det, tcst, tcd, nvp, dsfm, nrhd);

    return hdi;
}

// sri (sourceResourceIDs) refers to <cnt> reseources
async function get_dataset_info(sri) {
    const { get_unstructuredID } = require('./hostingCSE');
    const { retrieve_la, retrieve_ol } = require('./resources/cnt');
    let dst = null, det = null;
    const lof = []; // list of dataset features

    for (const id of sri) {
        const ri = await get_unstructuredID(id);
        if (ri === null) {
            return { dst: null, det: null, lof: [] };
        }
        const tmp_req = { parent_ri: ri }, tmp_resp_la = {}, tmp_resp_ol = {};

        // container type specific handling

        await retrieve_la(tmp_req, tmp_resp_la);
        const la_ct = (tmp_resp_la.pc) ? tmp_resp_la.pc["m2m:cin"].ct : null;
        const cin_lof = (tmp_resp_la.pc) ? get_feature_list(tmp_resp_la.pc["m2m:cin"].con) : null;
        if (cin_lof) lof.push(...cin_lof);

        if (det === null) det = la_ct;
        else if (la_ct && det < la_ct) det = la_ct;

        await retrieve_ol(tmp_req, tmp_resp_ol);
        const ol_ct = (tmp_resp_ol.pc) ? tmp_resp_ol.pc["m2m:cin"].ct : null;

        if (dst === null) dst = ol_ct;
        else if (ol_ct && ol_ct < dst) dst = ol_ct;
    }
    if (dst === null && det === null) {
        // error handling
        return null;
    }

    return { dst, det, lof };
}

function get_feature_list(data) {
    // extract hierarchical key names from data (e.g. observation.air.humi from 'data' object)
    // key names are separated by '.'
    // use JSON Path to extract key names - extract leaf nodes only

    const leafPaths = [];

    // use JSONPath to extract all paths and values
    const results = JSONPath({
        path: '$..*',
        json: data,
        resultType: 'all'  // extract all paths and values
    });

    // filter out leaf nodes only and extract paths
    results.forEach(result => {
        // only process leaf nodes (values are not objects)
        if (typeof result.value !== 'object' || result.value === null) {
            // extract path part only from JSONPath result
            const pathString = result.path
                .replace(/\$\[/g, '')  // remove $[
                .replace(/\]/g, '')    // remove ]
                .replace(/'/g, '')     // remove '
                .replace(/\[/g, '.')   // replace [ with .
                .replace(/^\./, '');   // remove starting .

            // remove duplicates and add only leaf node paths
            if (pathString && !leafPaths.includes(pathString)) {
                leafPaths.push(pathString);
            }
        }
    });

    return leafPaths;
}

async function create_historical_dataset_fragments(dts_ri, sri, dst, det, tcst, tcd, nvp, dsfm, nrhd) {
    const dsfs = {};

    // get innstsance resource list for each data sources
    for (const id of sri) {
        const { get_unstructuredID, get_ty_from_unstructuredID } = require('./hostingCSE');
        const ri = await get_unstructuredID(id);
        const ty = await get_ty_from_unstructuredID(ri);
        if (ty === 3) {
            const cin_rows = await CIN.findAll({
                where: { pi: ri },
                order: [['ct', 'ASC']],
                attributes: ['ri'],
            });
            if (cin_rows.length > 0) {
                dsfs[id] = cin_rows.map(c => c.ri);
            }
        }
        // other resource types can be supported later
    }

    // merge data instances for each time correlation duration
    // console.log(JSON.stringify(dsfs));

    // merge data instances for each time correlation duration
    let current_tcst = tcst;
    const allFeatures = new Set(); // all features extracted from all data sources
    const timeSortedData = []; // all data sorted by time
    let lastKnownValues = {}; // last known values for nvp=1

    // 1. retrieve all data instances and sort by time
    for (const [sourceId, cinIds] of Object.entries(dsfs)) {
        for (const cinId of cinIds) {
            try {
                const cin = await CIN.findByPk(cinId);
                if (cin && cin.con) {
                    const features = get_feature_list(cin.con);
                    features.forEach(feature => allFeatures.add(feature));
                    
                    timeSortedData.push({
                        sourceId,
                        cinId,
                        ct: cin.ct,
                        con: cin.con,
                        features: features
                    });
                }
            } catch (error) {
                logger.warn({ cinId, err: error }, 'skipping invalid CIN');
            }
        }
    }

    // sort by ct
    timeSortedData.sort((a, b) => a.ct.localeCompare(b.ct));

    // 2. merge data instances for each time correlation duration
    while (current_tcst < det) {
        const timestamp_format = config.get('cse.timestamp_format');
        const current_tcd_end = moment(current_tcst, timestamp_format).add(tcd, 'seconds').format(timestamp_format);

        // filter data instances for the current time window. `data.ct <= det` is BACKLOG-093's
        // upper bound: without it, a window whose tcd-sized end extends past det (the common
        // case -- tcd defaults to 60s, but a source's own instances are usually much closer
        // together) would include instances after the caller's requested end time, decided by
        // window size rather than by det itself. Both bounds are inclusive -- TR-0071:7.2.2.1
        // calls dst/det "the timestamp filter as the start/end time", without stating open vs.
        // closed, and a source instance timestamped exactly at dst or det reads more naturally as
        // being "at" the filtered range than excluded from it. mobius4's `ct` has only
        // second-granularity precision (config/default.json "timestamp_format"), so this decision
        // is the difference between a source instance created in the same second as dst/det being
        // in or out.
        const timeWindowData = timeSortedData.filter(data =>
            data.ct >= current_tcst && data.ct < current_tcd_end && data.ct <= det
        );

        if (timeWindowData.length > 0) {
            // merge data instances for the current time window (pass lastKnownValues for the entire period)
            const mergedRows = merge_data_for_timewindow(timeWindowData, allFeatures, nvp, lastKnownValues);
            
            // create fragments by nrhd
            await create_dataset_fragments(mergedRows, nrhd, dsfm, dts_ri);
        }

        current_tcst = current_tcd_end;
    }
}

// merge data instances for the current time window (pass lastKnownValues for the entire period)
function merge_data_for_timewindow(timeWindowData, allFeatures, nvp, lastKnownValues) {
    const rows = [];
    
    for (const data of timeWindowData) {
        const row = {
            time: data.ct,
            values: {}
        };
        
        // set value for all features
        for (const feature of allFeatures) {
            const value = get_nested_value(data.con, feature);
            
            if (value !== undefined && value !== null) {
                row.values[feature] = value;
                lastKnownValues[feature] = value; // save for nvp=1
            } else if (nvp === 1 && lastKnownValues[feature] !== undefined) {
                // nvp=1 and previous value exists, copy the value
                row.values[feature] = lastKnownValues[feature];
            } else {
                // nvp=0 or previous value does not exist, set empty value
                row.values[feature] = '';
            }
        }
        
        rows.push(row);
    }
    
    return rows;
}

// get value from nested object by dot separated path
function get_nested_value(obj, path) {
    // The live path (create_a_live_dsf below) feeds this function flat_data objects built by
    // cse/noti.js's get_flat_data, which key themselves by the *whole* dotted feature path (e.g.
    // "room1.temperature" as one literal key) rather than nesting -- unlike a historical
    // <contentInstance>.con, which is genuinely nested JSON. Trying a literal-key lookup first
    // makes this function work for both shapes, which is what lets create_a_live_dsf reuse
    // merge_data_for_timewindow instead of a second nullValuePolicy implementation (BACKLOG-101).
    // This is a pure superset for the historical path: nested JSON from real sensor payloads does
    // not normally carry a top-level property whose name is itself a dotted path.
    if (obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, path)) {
        return obj[path];
    }

    const keys = path.split('.');
    let current = obj;

    for (const key of keys) {
        if (current && typeof current === 'object' && key in current) {
            current = current[key];
        } else {
            return undefined;
        }
    }

    return current;
}

async function create_dataset_fragments(rows, nrhd, dsfm, dts_ri) {    
    // create fragments by nrhd
    for (let i = 0; i < rows.length; i += nrhd) {
        const fragmentRows = rows.slice(i, i + nrhd);
        const allFeatures = new Set();
        
        // collect all features in the current fragment
        fragmentRows.forEach(row => {
            Object.keys(row.values).forEach(feature => allFeatures.add(feature));
        });
        
        // formatting fragment data
        let formatted_fragment = null;
        if (dsfm === 0 )
            formatted_fragment = convert_to_CSV(fragmentRows, allFeatures);
        else if (dsfm === 1)
            formatted_fragment = convert_to_JSON(fragmentRows);
              
        // create <dsf> resources
        const { get_structuredID, get_a_new_rn, create_a_res } = require('./hostingCSE');
        const dts_sid = await get_structuredID(dts_ri);
        const dsf_rn = await get_a_new_rn(107);

        const dsf_res = {
            rn: dsf_rn,
            dsfr: formatted_fragment,
            dsfm: dsfm, // dataset format
            nrf: fragmentRows.length, // numberOfRowsInFragment
            dfst: fragmentRows[0].time, // datasetFragmentStartTime
            dfet: fragmentRows[fragmentRows.length - 1].time // datasetFragmentEndTime
        };

        const tmp_req = {
            pc: { "m2m:dsf": dsf_res },
            ri: dts_ri,
            sid: dts_sid,
            ty: 107, // dsf resource type -- selects hostingCSE.create_a_res's dispatch case.
                     // Distinct from 'to_ty' below (the *parent's* type, which dsf.create_a_dsf
                     // still reads for its own parent-type check).
            to_ty: 106, // dts resource type
            fr: admin_id,
            // See the <dataset> create above: create_a_res refuses ty 106/107 without this.
            int_cr_req: true
        };
        const tmp_resp = {};

        try {
            // Routed through create_a_res rather than calling dsf.create_a_dsf directly, so this
            // CSE-initiated create fires the same noti.check_and_send_noti(..., "create") a
            // client-issued CREATE gets (hostingCSE.js, right after its dispatch switch).
            // TR-0071:7.2.2.1 requires newly created inference input data to be notifiable to
            // subscribers on <dataset>, and TS-0018/DEC-history aside, dsf.create_a_dsf itself has
            // no notification call of its own -- create_a_res's post-dispatch block is the only
            // place that fires one. hostingCSE.js's own `case 107` comment ("not called by
            // client, temporary for testing") already marks this as the intended entry point.
            // create_a_res's other additions are no-ops here: 'rn' is already generated and
            // unique (the duplicate-name recheck it does is an extra but harmless query), no 'et'
            // is set, and 'rcn' is left undefined so the full representation still comes back
            // unchanged. Unlike a client CREATE this never goes through reqPrim.js, so
            // access_decision (which lives outside create_a_res) never runs for it -- correctly:
            // there is no external originator to check privileges for, the CSE is creating this
            // on its own authority.
            await create_a_res(tmp_req, tmp_resp);

            if (tmp_resp.rsc === enums.rsc_str["BAD_REQUEST"]) {
                logger.error({ sid: tmp_req.sid, dbg: tmp_resp.pc?.["m2m:dbg"] }, 'dsf fragment creation failed');
                return;
            } else {
                logger.info({ sid: `${tmp_req.sid}/${dsf_rn}` }, 'dsf fragment created');
            }
        } catch (error) {
            logger.error({ err: error }, 'dsf fragment creation error');
        }
    }
}

async function create_a_live_dataset(dsp_res, dst, det, lof) {
    // resolve nullValuePolicy (nvp) -- same resolution as create_a_historical_dataset above, so
    // both paths treat an absent nvp identically (BACKLOG-101: this used to be resolved only on
    // the historical path; the live path never read it at all).
    const nvp = (dsp_res.nvp) ? dsp_res.nvp : dsp_default.nvp; // 0: leave as null, 1: fill with last known value

    // subscribe to the data sources (eventType = 'create')
    const sub_res = {
        rn: 'sub-live-dataset-' + dsp_res.ri,
        enc: {
        	net : [3],
            chty: [4]
        },
        // Read from config.mqtt rather than hard-coded, so this matches whatever broker the
        // running CSE is actually connected to. Under config/default.json both are
        // ("localhost", 1883) so this was invisible in normal operation, but the test harness
        // (test/helpers/broker.js) starts a private broker on a random free port per DEC-037 --
        // against the old hard-coded URL, bindings/mqtt-outbound.js's is_own_broker() check never
        // matched, the "self" delivery shortcut never fired, and batch_data (this module's
        // per-policy row buffer) never got populated for the live-dataset path.
        nu : [`mqtt://${config.mqtt.ip}:${config.mqtt.port}/self/datasetManager/${dsp_res.sid}`],
        nct: 1
    };

    for (const id of dsp_res.sri) {
        const { get_unstructuredID, get_structuredID, get_ty_from_unstructuredID } = require('./hostingCSE');
        const ri = await get_unstructuredID(id);
        const sid = await get_structuredID(id);
        const to_ty = await get_ty_from_unstructuredID(ri);

        const tmp_req = {
            pc: { "m2m:sub": sub_res },
            ri: ri,
            sid: sid,
            to_ty: to_ty,
            fr: admin_id
        };
        const tmp_resp = {};

        const sub = require('./resources/sub');
        await sub.create_a_sub(tmp_req, tmp_resp);

        if (tmp_resp.rsc === enums.rsc_str["BAD_REQUEST"]) {
            logger.error({ sid: tmp_req.sid, dbg: tmp_resp.pc?.["m2m:dbg"] }, 'sub resource creation for live dataset failed');
            return;
        } else {
            logger.info({ sid: `${tmp_req.sid}/${sub_res.rn}` }, 'sub resource created for live dataset');
        }
    }

    // create a <dts> resource for live dataset
    const dts_res = {
        dspi: dsp_res.sid,
        lof: lof
    };
    const tmp_resp_cb = {};
    const cb_res = (await cb.retrieve_a_cb(tmp_resp_cb)).pc['m2m:cb'];
    const tmp_req = {
        pc: { "m2m:dts": dts_res },
        ri: cb_res.ri,
        sid: cb_res.rn,
        to_ty: 5, // cb resource type
        fr: admin_id
    };
    const tmp_resp = {};
    await dts.create_a_dts(tmp_req, tmp_resp);
    const dts_res_created = tmp_resp.pc["m2m:dts"];
    const ldi = cb_res.rn + '/' + dts_res_created.rn;

    const dts_ri = dts_res_created.ri;
    const dts_sid = ldi

    if (tmp_resp.rsc === enums.rsc_str["BAD_REQUEST"]) {
        logger.error({ sid: tmp_req.sid, dbg: tmp_resp.pc?.["m2m:dbg"] }, 'dts resource creation for live dataset failed');
        return null;
    } else {
        logger.info({ sid: `${tmp_req.sid}/${dts_res.rn}` }, 'dts resource created for live dataset');
    }

    // create a <dsf> resource periodically

    // interval manager per <dsp> resource
    const interval_managers = {};

    const duration = (dsp_res.tcd) ? dsp_res.tcd : 10; // temporal default duration is 10 seconds

    interval_managers[dsp_res.ri] = interval_manager.createInterval(async (intervalId, dsp_ri, dts_ri, dts_sid, duration, nvp) => {
        // start creating <dsf> resources for live dataset
        await create_a_live_dsf(dsp_ri, dts_ri, dts_sid, duration, nvp);
    }, duration * 1000, {
        // BACKLOG-092: `dsp_ri` is a callback parameter (bound at call time via `params` below),
        // not a binding in this enclosing scope. The id must use the same value the enclosing
        // scope already has: `dsp_res.ri`.
        id: `interval-${dsp_res.ri}`,
        params: [dsp_res.ri, dts_ri, dts_sid, duration, nvp]
    });

    return ldi;
}

async function create_a_live_dsf(dsp_ri, dts_ri, dts_sid, duration, nvp) {
    logger.debug({ dsp_ri, durationSec: duration }, 'creating live dsf resources');

    const end_time = moment.utc().format(config.get('cse.timestamp_format'));
    const start_time = moment.utc(end_time).subtract(duration, 'seconds').format(config.get('cse.timestamp_format'));

    // Pull this window's notifications out of batch_data, time-sorted -- same source data as
    // before, just kept in the { time, con } shape merge_data_for_timewindow expects instead of
    // being pushed straight into dsf_data. Sorting matters here (it did not before): nvp=1's
    // forward-fill in merge_data_for_timewindow depends on walking rows in chronological order.
    const windowEntries = [];
    if (batch_data[dsp_ri] && typeof batch_data[dsp_ri] === 'object') {
        const times = Object.keys(batch_data[dsp_ri])
            .filter(time => time >= start_time && time <= end_time)
            .sort();
        for (const time of times) {
            windowEntries.push({ time, con: batch_data[dsp_ri][time] });
            // remove data from batch_data
            delete batch_data[dsp_ri][time];
        }
    } else {
        logger.warn({ dsp_ri }, 'batch_data not available, initializing empty object');
        batch_data[dsp_ri] = {};
    }

    if (windowEntries.length === 0) {
        return;
    }

    // BACKLOG-101: reuse the historical path's forward-fill (merge_data_for_timewindow) instead
    // of a second nullValuePolicy implementation. Each batch_data entry is one notification --
    // i.e. one source (cse/noti.js's get_flat_data/batch_noti_data) -- so without this merge every
    // row would carry only the feature(s) of whichever single source produced it, exactly the
    // defect BACKLOG-101 describes. allFeatures/lastKnownValues are kept per dsp_ri at module
    // scope (live_known_features/live_last_known_values, declared near batch_data above) so
    // forward-fill carries across separate create_a_live_dsf invocations, the live path's
    // equivalent of the historical path's per-call lastKnownValues/allFeatures -- historical has a
    // single call over a closed [dst,det] range so it can compute allFeatures upfront (with
    // look-ahead over the whole range); the live path is incremental and unbounded, so its
    // allFeatures can only grow from what has actually been observed up to now, never from the
    // future. A feature not yet observed anywhere is simply not a known feature yet, matching the
    // historical path's answer for the same question: not a row key at all until first observed,
    // and '' (not nvp=1-filled) on the first row that introduces it, since there is no prior value
    // to fill with (see merge_data_for_timewindow's else-branch).
    const timeWindowData = windowEntries.map(entry => ({
        ct: entry.time,
        con: entry.con,
        features: Object.keys(entry.con).filter(key => key !== 'time'),
    }));

    if (!live_known_features[dsp_ri]) live_known_features[dsp_ri] = new Set();
    if (!live_last_known_values[dsp_ri]) live_last_known_values[dsp_ri] = {};
    const allFeatures = live_known_features[dsp_ri];
    for (const data of timeWindowData) {
        for (const feature of data.features) allFeatures.add(feature);
    }

    const mergedRows = merge_data_for_timewindow(timeWindowData, allFeatures, nvp, live_last_known_values[dsp_ri]);
    // Flatten { time, values: {...} } back to { time, ...values } -- the wire shape this path has
    // always produced (dsfm=0's dsfr here is the flat row array itself, not CSV/JSON via
    // convert_to_CSV/convert_to_JSON as create_dataset_fragments uses for the historical path).
    const dsf_data = mergedRows.map(row => ({ time: row.time, ...row.values }));

    logger.debug({ dsp_ri, rowCount: dsf_data.length }, 'dsf_data ready');
    // console.log('batch_data: ', batch_data);

    const { get_a_new_rn, create_a_res } = require('./hostingCSE');
    const dsf_rn = get_a_new_rn(107);

    // create a <dsf> resource
    //
    // dfst/dfet used to be read off `Object.keys(dsf_data)` -- but dsf_data was (and still is) an
    // array, so Object.keys returned index strings ("0", "1", ...), not timestamps. Found and
    // fixed incidentally while rewriting this block for BACKLOG-101 (mergedRows is already
    // time-sorted, same ordering guarantee the historical path relies on in
    // create_dataset_fragments' `fragmentRows[0].time` / `fragmentRows[...].time`), not something
    // this BACKLOG set out to fix -- called out here and in the report rather than left silent.
    const dsf_res = {
        rn: dsf_rn,
        dfst: dsf_data[0].time,
        dfet: dsf_data[dsf_data.length - 1].time,
        nrf: dsf_data.length,
        dsfr: dsf_data,
        dsfm: 0,
    };
    const tmp_req = {
        pc: { "m2m:dsf": dsf_res },
        ri: dts_ri,
        sid: dts_sid,
        ty: 107, // dsf resource type -- see create_dataset_fragments() above for why this goes
                 // through create_a_res (notification) rather than dsf.create_a_dsf directly.
        to_ty: 106, // dts resource type
        fr: admin_id,
        // The live path's fragment create. Same marker as the other two internal creates in this
        // file: create_a_res refuses ty 106/107 without it (BACKLOG-090).
        int_cr_req: true
    };
    const tmp_resp = {};
    await create_a_res(tmp_req, tmp_resp);
    if (tmp_resp.rsc === enums.rsc_str["BAD_REQUEST"]) {
        logger.error({ sid: tmp_req.sid, dbg: tmp_resp.pc?.["m2m:dbg"] }, 'live dsf resource creation failed');
        return;
    } else {
        logger.info({ sid: `${tmp_req.sid}/${dsf_res.rn}` }, 'live dsf resource created');
    }

    return;
}

function convert_to_CSV(rows, allFeatures) {
    const features = Array.from(allFeatures).sort();
    const header = ['time', ...features].join(', ');
    
    const csvRows = rows.map(row => {
        const values = features.map(feature => 
            row.values[feature] !== undefined ? row.values[feature] : ''
        );
        return [row.time, ...values].join(', ');
    });
    
    return [header, ...csvRows].join('\n');
}

function convert_to_JSON(rows) {
    return rows.map(row => ({
        time: row.time,
        ...row.values
    }));
}

async function delete_sub_for_live_dataset(dsp_ri) {
    const discovery_req = {
        fr: admin_id,
        sid: csebase_rn,
        fc: {
            ty: [23], // sub resource type
            rn: 'sub-live-dataset-' + dsp_ri
        }
    };
    const { discovery_core, delete_resources } = require('./hostingCSE');
    const { ids_list } = await discovery_core(discovery_req);
    
    await delete_resources(ids_list);
    
    return;
}

module.exports = {
    create_a_historical_dataset,
    create_a_live_dataset,
    get_dataset_info,
    get_feature_list,
    delete_sub_for_live_dataset,
    batch_data,
    shutdown: () => interval_manager.stopAllIntervals(),
}