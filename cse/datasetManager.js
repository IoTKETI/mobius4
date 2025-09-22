const dsp_default = require('../config/default').default.datasetPolicy;
const admin_id = require('../config/default').cse.admin;
const csebase_rn = require('../config/default').cse.csebase_rn;
const config = require('config');
const enums = require('../config/enums');
const moment = require('moment');

const cb = require('./resources/cb');
const dts = require('./resources/dts');
const dsf = require('./resources/dsf');

const CNT = require('../models/cnt-model');
const CIN = require('../models/cin-model');

const { JSONPath } = require('jsonpath-plus');

const IntervalManager = require('./intervalManager');
const interval_manager = new IntervalManager();

const batch_data = {};

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
        to_ty: 5, // cb resource type
        fr: admin_id
    };
    const tmp_resp_dts = {};

    await dts.create_a_dts(tmp_req, tmp_resp_dts);
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
    // use JSON Path to extract key names - 리프 노드만 추출

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
            const cnt_res = await CNT.findOne({
                where: {ri: ri},
                attributes: ['cin_list']
            });
            if (cnt_res && cnt_res.cin_list && cnt_res.cin_list.length > 0) {
                dsfs[id] = cnt_res.cin_list;
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
                console.log(`Skipping invalid CIN: ${cinId}`, error.message);
            }
        }
    }

    // sort by ct
    timeSortedData.sort((a, b) => a.ct.localeCompare(b.ct));

    // 2. merge data instances for each time correlation duration
    while (current_tcst < det) {
        const timestamp_format = config.get('cse.timestamp_format');
        const current_tcd_end = moment(current_tcst, timestamp_format).add(tcd, 'seconds').format(timestamp_format);
        
        // filter data instances for the current time window
        const timeWindowData = timeSortedData.filter(data => 
            data.ct >= current_tcst && data.ct < current_tcd_end
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
        const { get_structuredID, get_a_new_rn } = require('./hostingCSE');
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
            to_ty: 106, // dts resource type
            fr: admin_id
        };
        const tmp_resp = {};
        
        try {
            await dsf.create_a_dsf(tmp_req, tmp_resp);

            if (tmp_resp.rsc === enums.rsc_str["BAD_REQUEST"]) {
                console.error('Error creating DSF fragment:', tmp_resp.pc["m2m:dbg"]);
                return;
            } else {
                console.log('Created DSF fragment: ', tmp_req.sid + '/' + dsf_rn);
            }
        } catch (error) {
            console.error('Error creating DSF fragment:', error);
        }
    }
}

async function create_a_live_dataset(dsp_res, dst, det, lof) {
    // subscribe to the data sources (eventType = 'create')
    const sub_res = {
        rn: 'sub-live-dataset-' + dsp_res.ri,
        enc: {
        	net : [3],
            chty: [4]
        },
        nu : ['mqtt://localhost:1883/self/datasetManager/' + dsp_res.sid],
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
            console.error('Error creating a<sub> resource:', tmp_resp.pc["m2m:dbg"]);
            return;
        } else {
            console.log('Created a <sub> resource for live dataset: ', tmp_req.sid + '/' + sub_res.rn);
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
        console.error('Error creating a <dts> resource for live dataset:', tmp_resp.pc["m2m:dbg"]);
        return null;
    } else {
        console.log('Created a <dts> resource for live dataset: ', tmp_req.sid + '/' + dts_res.rn);
    }

    // create a <dsf> resource periodically

    // interval manager per <dsp> resource
    const interval_managers = {};

    const duration = (dsp_res.tcd) ? dsp_res.tcd : 10; // temporal default duration is 10 seconds

    interval_managers[dsp_res.ri] = interval_manager.createInterval(async (intervalId, dsp_ri, dts_ri, dts_sid, duration) => {
        // start creating <dsf> resources for live dataset
        await create_a_live_dsf(dsp_ri, dts_ri, dts_sid, duration);
    }, duration * 1000, { 
        id: `interval-${dsp_ri}`,
        params: [dsp_res.ri, dts_ri, dts_sid, duration] 
    });

    return ldi;
}

async function create_a_live_dsf(dsp_ri, dts_ri, dts_sid, duration) {
    // create <dsf> resources
    console.log('Creating <dsf> resources for live dataset: ', dsp_ri, duration);

    const end_time = moment.utc().format(config.get('cse.timestamp_format'));
    const start_time = moment.utc(end_time).subtract(duration, 'seconds').format(config.get('cse.timestamp_format'));

    const dsf_data = [];

    // check if batch_data[dsp_ri] is available and an object
    if (batch_data[dsp_ri] && typeof batch_data[dsp_ri] === 'object') {
        for (const [time, data] of Object.entries(batch_data[dsp_ri])) {
            if (time >= start_time && time <= end_time) {
                // add data to dsf_data
                dsf_data.push({ ...data });

                // remove data from batch_data
                delete batch_data[dsp_ri][time];
            }
        }
    } else {
        console.warn(`batch_data[${dsp_ri}] is not available or not an object. Initializing empty object.`);
        // safely initialize an empty object
        batch_data[dsp_ri] = {};
    }

    if (dsf_data.length === 0) {
        return;
    }

    console.log('dsf_data: ', dsf_data);
    // console.log('batch_data: ', batch_data);

    const { get_a_new_rn } = require('./hostingCSE');
    const dsf_rn = get_a_new_rn(107);
    const timestamps = Object.keys(dsf_data);
    
    // create a <dsf> resource
    const dsf_res = {
        rn: dsf_rn,
        dfst: timestamps[0],
        dfet: timestamps[timestamps.length - 1],
        nrf: timestamps.length,
        dsfr: dsf_data,
        dsfm: 0,
    };
    const tmp_req = {
        pc: { "m2m:dsf": dsf_res },
        ri: dts_ri,
        sid: dts_sid,
        to_ty: 106, // dts resource type
        fr: admin_id
    };
    const tmp_resp = {};
    await dsf.create_a_dsf(tmp_req, tmp_resp);
    if (tmp_resp.rsc === enums.rsc_str["BAD_REQUEST"]) {
        console.error('Error creating DSF resource for live dataset:', tmp_resp.pc["m2m:dbg"]);
        return;
    } else {
        console.log('Created DSF resource for live dataset: ', tmp_req.sid + '/' + dsf_res.rn);
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
    batch_data
}