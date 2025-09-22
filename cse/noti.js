const axios = require("axios");
const config = require("config");

const mqtt = require("../bindings/mqtt");
const SUB = require('../models/sub-model');
const AE = require('../models/ae-model');


// eventTYpe = ['create', 'update']
async function check_and_send_noti(req_prim, resp_prim, event_type) {
    // get subscribed-to resource info
    const sub_res_pi = req_prim.ri;

    // get <sub> child resources
    const sub_res = (await SUB.findAll({ where: { pi: sub_res_pi } }))
        .map(sub => sub.toJSON());

    if (sub_res.length === 0) {
        return;
    }
    else {
        sub_res.forEach(async (sub_res) => {
            // by spec, when 'enc' is null, default criteria is 'updated attributes'
            if (!sub_res.enc) sub_res.enc = { net: [1] };

            if (sub_res.enc.net.includes(3) == true && "create" == event_type) {
                // net 3: create
                let this_ty = req_prim.ty;
                // console.log('\nsub_res for the creation target: ', sub_res);
                if (sub_res.enc.chty) {
                    if (sub_res.enc.chty.includes(this_ty)) {
                        send_a_noti(sub_res, resp_prim.pc, 3);
                    }
                } else {
                    send_a_noti(sub_res, resp_prim.pc, 3);
                }
            } else if (sub_res.enc.net.includes(1) == true && "update" == event_type) {
                // net 1: update
                if (2 == sub_res.nct) {
                    // notificationContentType 2: modified attributes
                    send_a_noti(sub_res, req_prim.pc, 1);
                } else if (1 == sub_res.nct) {
                    // notificationContentType 1: all attributes (default)
                    // console.log('noti obj: ', resp_prim.pc);
                    send_a_noti(sub_res, resp_prim.pc, 1);
                }
            }
        });

        // iterate calling 'send_noti' function to send one or more notifications
        send_a_noti(null, null);

        // to-do: do something for the notification reponse
    }

    return true; // for now, this is meaningless
}

async function send_a_noti(sub_res, event_obj, notificationEventType) {
    // to-do: figure out when this function get a null sub_res from forEach
    if (sub_res == null) {
        return;
    }

    const sgn = {
        "m2m:sgn": {
            nev: {
                rep: event_obj,
                sur: sub_res.sid,
                net: notificationEventType,
            },
        },
    }; // single notificaiton

    for (noti_target of sub_res.nu) {
        if (noti_target.indexOf("http") == 0) http_noti(noti_target, sgn);
        else if (noti_target.indexOf("mqtt") == 0) mqtt_noti(noti_target, sgn);
        else {
            // last case: nu represents the ID of an <AE> resource
            const { get_to_info } = require('./reqPrim');
            const { shortest_to: res_id } = get_to_info({ to: noti_target });

            // when res_id is null, ignore it and skip it
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
}
async function http_noti(noti_target, sgn) {
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
        })
        .then((resp) => {
            console.log("\nreceived message from notification target:");
            console.log(JSON.stringify(resp.data, null, 2));
        })
        .catch((err) => {
            if (err.response) {
                // server responded but 4xx/5xx error
                console.warn(`sur: ${sgn['m2m:sgn'].nev.sur}, target unreachable: ${noti_target} (status: ${err.response.status})`);
            } else if (err.request) {
                // request is sent but no response
                console.warn(`sur: ${sgn['m2m:sgn'].nev.sur}, target unreachable: ${noti_target} (no response)`);
            } else {
                // other error
                console.warn(`sur: ${sgn['m2m:sgn'].nev.sur}, target unreachable: ${noti_target} (error: ${err.message})`);
            }

            return false;
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
        console.warn(`MQTT notification failed: ${noti_target}`);
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
    console.log('\nself_noti_handler, topic: ', topic);

    const res = req_prim.pc['m2m:sgn'].nev.rep;
    const sub_rn = req_prim.pc['m2m:sgn'].nev.sur.split('/').pop();
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
                console.warn(`Feature "${feature}" not found in data`);
            }
        } catch (error) {
            console.error(`Error parsing feature "${feature}":`, error);
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
    console.log('\nbatch_data: ', JSON.stringify(batch_data, null, 2));
}

module.exports = { check_and_send_noti, self_noti_handler };
