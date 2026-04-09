const axios = require("axios");
const config = require("config");
const { Op } = require('sequelize');

const logger = require("../logger").child({ module: "noti" });
const mqtt = require("../bindings/mqtt");
const SUB = require('../models/sub-model');
const AE = require('../models/ae-model');
const Lookup = require('../models/lookup-model');


// supported notificationEventType (net) = {
//     1: Update of Resource
//     2: Delete of Resource
//     3: Create of Direct Child Resource
//     4: Delete of Direct Child Resource
// }

async function check_and_send_noti(req_prim, resp_prim, event_type) {
    const sub_res_pi = req_prim.ri;

    const sub_res = (await SUB.findAll({ where: { pi: sub_res_pi } }))
        .map(sub => sub.toJSON());

    if (sub_res.length === 0) return;

    // pre-fetch all AE poa values in one batch to avoid N+1 queries
    const ae_poa_map = await prefetch_ae_poa(sub_res);

    await Promise.all(sub_res.map(async (sub) => {
        if (!sub.enc) sub.enc = { net: [1] };

        if (sub.enc.net.includes(3) && event_type === 'create') {
            const this_ty = req_prim.ty;
            if (!sub.enc.chty || sub.enc.chty.includes(this_ty)) {
                await send_a_noti(sub, resp_prim.pc, 3, ae_poa_map);
            }
        } else if (sub.enc.net.includes(1) && event_type === 'update') {
            const pc = sub.nct === 2 ? req_prim.pc : resp_prim.pc;
            await send_a_noti(sub, pc, 1, ae_poa_map);
        } else if (sub.enc.net.includes(2) && event_type === 'delete') {
            await send_a_noti(sub, resp_prim.pc, 2, ae_poa_map);
        }
    }));

    return true;
}

// batch-load AE poa for all non-URL nu targets across all subscriptions
async function prefetch_ae_poa(sub_list) {
    const { get_to_info } = require('./reqPrim');

    // collect unique AE resource IDs (nu that are not http/mqtt URLs)
    const res_id_set = new Set();
    for (const sub of sub_list) {
        for (const nu of (sub.nu || [])) {
            if (!nu.startsWith('http') && !nu.startsWith('mqtt')) {
                const { shortest_to } = get_to_info({ to: nu });
                if (shortest_to) res_id_set.add(shortest_to);
            }
        }
    }

    if (res_id_set.size === 0) return {};

    const res_ids = [...res_id_set];

    // batch-resolve structured IDs to ri
    const structured = res_ids.filter(id => id.includes('/'));
    const unstructured = res_ids.filter(id => !id.includes('/'));

    const lookups = structured.length > 0
        ? await Lookup.findAll({ where: { sid: structured }, attributes: ['ri', 'sid'] })
        : [];

    const sid_to_ri = Object.fromEntries(lookups.map(l => [l.sid, l.ri]));
    const all_ri = [
        ...lookups.map(l => l.ri),
        ...unstructured,
    ];

    if (all_ri.length === 0) return {};

    // batch-fetch AE poa in a single query
    const ae_list = await AE.findAll({
        where: { ri: { [Op.in]: all_ri } },
        attributes: ['ri', 'poa'],
    });
    const ri_to_poa = Object.fromEntries(ae_list.map(ae => [ae.ri, ae.poa]));

    // build map: res_id → poa[]
    const poa_map = {};
    for (const res_id of res_ids) {
        const ri = sid_to_ri[res_id] || res_id;
        poa_map[res_id] = ri_to_poa[ri] || [];
    }
    return poa_map;
}

async function send_a_noti(sub_res, event_obj, notificationEventType, ae_poa_map = {}) {
    if (sub_res == null) return;

    const sgn = {
        "m2m:sgn": {
            nev: { rep: event_obj, net: notificationEventType },
            sur: sub_res.sid,
        },
    };

    for (const noti_target of sub_res.nu) {
        if (noti_target.startsWith('http'))  { http_noti(noti_target, sgn); continue; }
        if (noti_target.startsWith('mqtt'))  { mqtt_noti(noti_target, sgn); continue; }

        // AE resource ID — use pre-fetched poa map, fall back to DB query if not found
        const { get_to_info } = require('./reqPrim');
        const { shortest_to: res_id } = get_to_info({ to: noti_target });
        if (!res_id) continue;

        const urls = ae_poa_map[res_id] ?? await get_urls_from_poa(res_id);
        for (const url of urls) {
            let result = null;
            if (url.startsWith('http'))  result = await http_noti(url, sgn);
            else if (url.startsWith('mqtt')) result = await mqtt_noti(url, sgn);
            if (result === true) break;
        }
    }
}

async function send_sub_del_noti(sub_res) {
    // this works only when the sub resource has a 'su' attribute
    const subscriberURI = sub_res.su;
    if (!subscriberURI) 
        return;

    const { get_structuredID } = require('./hostingCSE');
    
    const sgn = {
        "m2m:sgn": {
            sud: true,
            sur: await get_structuredID(sub_res.ri),
        }
    };

    
    if (subscriberURI.indexOf("http") == 0) http_noti(subscriberURI, sgn);
    else if (subscriberURI.indexOf("mqtt") == 0) mqtt_noti(subscriberURI, sgn);
    else {
        // last case: subscriberURI represents the ID of an <AE> resource, not a HTTP/MQTT URL
        const { get_to_info } = require('./reqPrim');
        const { shortest_to: res_id } = get_to_info({ to: subscriberURI });

        if (res_id) {
            const urls = await get_urls_from_poa(res_id);

            for (const url of urls) {
                let result = null;
                if (url.indexOf("http") == 0) result = await http_noti(url, sgn);
                else if (url.indexOf("mqtt") == 0) result = await mqtt_noti(url, sgn);

                // if the notification is sent successfully, stop the loop
                if (result === true) break;
            }
        }
    }
    
}

async function http_noti(noti_target, sgn) {
    logger.debug({ target: noti_target, sur: sgn['m2m:sgn']?.sur }, 'sending http notification');
    const { generate_ri } = require('./utils');

    // axios handles HTTP and HTTPs automatically
    axios
        .request({
            url: noti_target,
            method: "post",
            headers: {
                "X-M2M-Origin": config.cse.cse_id,
                "X-M2M-RI": 'http-noti-' + generate_ri(),
                "Content-Type": "application/json",
            },
            data: JSON.stringify(sgn),
            timeout: 3000,
        })
        .then((resp) => {
            logger.debug({ target: noti_target, status: resp.status }, 'http notification acknowledged');
        })
        .catch((err) => {
            const sur = sgn['m2m:sgn'].sur;
            if (err.response) {
                logger.warn({ sur, target: noti_target, status: err.response.status, data: err.response.data }, 'http notification rejected by target');
            } else {
                logger.warn({ sur, target: noti_target, code: err.code, err }, 'http notification delivery failed');
            }
        });

    return true;
}

async function mqtt_noti(noti_target, sgn) {
    // oneM2M defined MQTT URL convention: mqtt://<IP>:<PORT>/<topic>
    const url_without_protocol = noti_target.split("//")[1];
    const topic_index = url_without_protocol.indexOf("/");

    // when nu is URL, use nu as the MQTT topic
    let topic = url_without_protocol.substring(topic_index + 1);

    // remove trailing option for serialization (e.g. '?ct=json)
    if (topic.includes("?")) {
        topic = topic.split("?")[0] + '/json';
    } else {
        topic = topic + '/json';
    }

    const { generate_ri } = require('./utils');
    const req_prim = {
        fr: config.cse.cse_id,
        ri: 'mqtt-noti-' + generate_ri(),
        op: 5, // 5: notify
        pc: sgn,
    };

    // to-do: MQTT notify response handling
    // to-do: support connection to different MQTT brokers other than the local one
    const result = await mqtt.mqtt_transmitter(topic, req_prim);
    if (result === false) {
        logger.warn({ target: noti_target, topic }, 'mqtt notification delivery failed');
        return false;
    }
    return true;
}

async function get_urls_from_poa(res_id) {
    const { get_unstructuredID } = require('./hostingCSE');
    const ri = await get_unstructuredID(res_id);
    const ae_res = await AE.findByPk(ri);
    if (!ae_res) {
        return [];
    }
    return ae_res.poa;
}

function self_noti_handler(topic, req_prim) {
    logger.debug({ topic }, 'self notification received');

    const res = req_prim.pc['m2m:sgn'].nev.rep;
    const sub_rn = req_prim.pc['m2m:sgn'].sur.split('/').pop();
    const dsp_ri = sub_rn.split('sub-live-dataset-')[1];

    // self notification to create live dataset
    if (topic.startsWith('self/datasetManager/')) {
        if (res['m2m:cin']) {
            const time = res['m2m:cin'].ct;
            const data = res['m2m:cin'].con;

            const flat_data = get_flat_data(time, data);
            batch_noti_data(dsp_ri, flat_data);
        }
    }
    
    return;
}

function get_flat_data(time, data) {
    const { get_feature_list } = require('./datasetManager');
    const JSONPath = require('jsonpath-plus');

    const features = get_feature_list(data);
    const flat_data = {};

    for (const feature of features) {
        try {
            // extract the value of the feature using JSONPath
            // if the feature is "room1.temperature", convert it to "$.room1.temperature"
            const jsonPath = '$.' + feature;
            const result = JSONPath.JSONPath({ path: jsonPath, json: data });

            // if the result exists and the first element exists, use the value
            if (result && result.length > 0) {
                flat_data[feature] = result[0];
            } else {
                // if the feature is not found, set null
                flat_data[feature] = null;
                logger.warn({ feature }, 'feature not found in data');
            }
        } catch (error) {
            logger.error({ err: error, feature }, 'feature parsing error');
            flat_data[feature] = null;
        }
    }
    // also add time (e.g. ct)
    flat_data.time = time;
    
    return flat_data;
}

function batch_noti_data(dsp_ri,data) {
    const { batch_data } = require('./datasetManager');
    // batch_data[data.time] = data;
    if (!batch_data[dsp_ri]) {
        batch_data[dsp_ri] = {};
    }
    batch_data[dsp_ri][data.time] = data;
    logger.trace({ dsp_ri, batchSize: Object.keys(batch_data[dsp_ri]).length }, 'batch data updated');
}

module.exports = { 
    check_and_send_noti, 
    send_sub_del_noti,
    self_noti_handler 
};
