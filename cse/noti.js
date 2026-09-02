const axios = require("axios");
const config = require("config");
const { Op } = require('sequelize');

const logger = require("../logger").forFile(__filename);
const mqtt = require("../bindings/mqtt");
const SUB = require('../models/sub-model');
const AE = require('../models/ae-model');
const Lookup = require('../models/lookup-model');
const { not_obsolete_where } = require('./utils');
const { comparison_conditions_match, resource_of } = require('./enc-conditions');


// supported notificationEventType (net) = {
//     1: Update of Resource
//     2: Delete of Resource
//     3: Create of Direct Child Resource
//     4: Delete of Direct Child Resource
// }

// The attribute names an UPDATE request actually carries. req_prim.pc holds the update
// representation inside its envelope ({"m2m:cnt": {lbl: [...]}}), so the inner keys are exactly
// the attributes the Originator asked to change. This is the same source nct=2 ("modified
// attributes") already sends as notification content, which is why no separate diff is needed.
function updated_attribute_names(req_prim) {
    const pc = req_prim.pc;
    if (!pc || typeof pc !== 'object') return [];
    const envelope_key = Object.keys(pc)[0];
    const body = envelope_key === undefined ? null : pc[envelope_key];
    if (!body || typeof body !== 'object') return [];
    return Object.keys(body);
}

// The "attribute" condition of eventNotificationCriteria (TS-0001:9.6.8 table 9.6.8-3): when the
// list is present it names the subset of the subscribed-to resource's attributes whose update
// generates a notification -- "If an attribute that is not specified in this list is updated, then
// a notification shall not be generated". When absent, the default is the full attribute set.
//
// The clause scopes the list to notificationEventType "Update to attributes of the subscribed-to
// resource" (net=1) and to its blocking variant (net=7, which mobius4 does not implement), so the
// net=2/3/4 branches are deliberately left alone.
//
// Names are compared as they arrive on the wire (short names). No long/short translation is done:
// the update representation and the condition list are both written by the same Originator in the
// same naming, and translating one side only would make them stop matching.
function attribute_condition_matches(enc, req_prim) {
    // An empty list cannot arrive through the API -- the create/update schema requires min(1),
    // because m2m:attributeList carries xs:minLength 1. Treating a hand-edited empty row as "no
    // condition" keeps it from silencing a subscription outright.
    if (!Array.isArray(enc.atr) || enc.atr.length === 0) return true;
    return updated_attribute_names(req_prim).some(name => enc.atr.includes(name));
}

async function check_and_send_noti(req_prim, resp_prim, event_type) {
    const sub_res_pi = req_prim.ri;

    // Fire this SELECT off first (it is awaited further down). hostingCSE.delete_a_res runs the
    // notification path and the cascade delete at the same time, so if the query for this
    // resource's own subscriptions were pushed behind the net=4 lookup and went out late,
    // SUB.destroy in delete_resources would get there first and this resource's net=2
    // notification would silently vanish. Issuing the SELECT in the same tick, before the net=4
    // await, eliminates that race.
    // Obsolete subscriptions are excluded here, not left to the sweep. TS-0004:7.5.1.2.2 does not
    // name expirationTime among its steps, but a notification is the one externally visible proof
    // that a subscription is still live, and TS-0001:9.6.1.3.2 calls the resource 'obsolete' from
    // the moment its et passes. The same clause pairing is already made for aggregation in
    // TS-0004:7.5.1.2.6 — "the group-hosting CSE shall perform notification aggregation **while
    // the <group> resource has not expired**". Reported by a client whose crash-recovery design
    // leaned on et as a lease: notifications kept being published for a whole sweep interval to
    // targets that had gone away (DEC-094).
    const sub_res_p = SUB.findAll({ where: { pi: sub_res_pi, ...not_obsolete_where() } });

    // net=4 has to look at the subscriptions under the **parent** of the deleted resource, so it
    // is handled **before** the self-based query below and its "return early if there are zero
    // subscriptions" shortcut. That keeps net=4 from being missed entirely when a resource with
    // no subscriptions beneath itself — a CIN, for example — is deleted and the early return hits.
    //
    // int_cr_req marks internal requests such as eviction. Whether indirect deletion is supposed
    // to raise a notification is still awaiting a spec check (SQ-001, DEC-039), so for now it
    // does not fire.
    //
    // The .catch isolates failures: if a net=4 subscription on the parent throws (a bad nu, say),
    // that exception would propagate out of this function and block the whole net=1/2/3 path
    // below — losing the deleted resource's *own* notification because of a fault on the parent
    // side is collateral damage beyond what this function is responsible for.
    if (event_type === 'delete' && req_prim.int_cr_req !== true) {
        await notify_parent_of_child_deletion(resp_prim.pc, req_prim.to_ty)
            .catch((err) => logger.warn({ err }, 'net=4 parent notification failed'));
    }

    const sub_res = (await sub_res_p).map(sub => sub.toJSON());

    if (sub_res.length === 0) return;

    // pre-fetch all AE poa values in one batch to avoid N+1 queries
    const ae_poa_map = await prefetch_ae_poa(sub_res);

    // The resource the comparison conditions are measured against. TS-0001:9.6.8 table 9.6.8-3
    // scopes the other conditions to the selected notificationEventType -- for net=3 that is the
    // created child, which is what resp_prim.pc holds on the create path, and for net=1/2 the
    // subscribed-to resource, which is what it holds on the update and delete paths. In every case
    // it is the same object the notification carries as nev.rep.
    //
    // Deliberately not req_prim.pc, even for an nct=2 subscription. req_prim.pc is the UPDATE
    // request body, and ct/lt/st/cs are server-assigned -- they can never appear in it. Evaluating
    // the comparison conditions against it would silently make every one of them false, so nct
    // governs only what is sent, not what is judged.
    const event_res = resource_of(resp_prim.pc);

    await Promise.all(sub_res.map(async (sub) => {
        if (!sub.enc) sub.enc = { net: [1] };

        if (!comparison_conditions_match(sub.enc, event_res)) return;

        if (sub.enc.net.includes(3) && event_type === 'create') {
            const this_ty = req_prim.ty;
            if (!sub.enc.chty || sub.enc.chty.includes(this_ty)) {
                await send_a_noti(sub, resp_prim.pc, 3, ae_poa_map);
            }
        } else if (sub.enc.net.includes(1) && event_type === 'update') {
            if (attribute_condition_matches(sub.enc, req_prim)) {
                const pc = sub.nct === 2 ? req_prim.pc : resp_prim.pc;
                await send_a_noti(sub, pc, 1, ae_poa_map);
            }
        } else if (sub.enc.net.includes(2) && event_type === 'delete') {
            await send_a_noti(sub, resp_prim.pc, 2, ae_poa_map);
        }
    }));

    return true;
}

// net=4 (Delete of Direct Child Resource): the subscription sits under the **parent** of the
// deleted child, not under the child itself. The default query in check_and_send_noti
// (pi === req_prim.ri) only finds subscriptions that are children of the deleted resource, so it
// would never find a net=4 one. Hence this separate parent-based query.
//
// Why this is split out to take only the deleted resource's representation and type (DEC-039):
// eviction and cascade descendant deletion are out of scope until the spec check (SQ-001) is
// settled, but once it is, the feature can be extended by adding call sites alone.
async function notify_parent_of_child_deletion(deleted_pc, deleted_ty) {
    const deleted_res = deleted_pc && Object.values(deleted_pc)[0];
    const parent_ri = deleted_res && deleted_res.pi;
    if (!parent_ri) return false;

    // Same expiry gate as check_and_send_noti — net=4 reads a different row set (the parent's
    // subscriptions), so it needs the predicate of its own.
    const parent_subs = (await SUB.findAll({ where: { pi: parent_ri, ...not_obsolete_where() } }))
        .map(sub => sub.toJSON());
    if (parent_subs.length === 0) return false;

    const targets = parent_subs.filter((sub) => {
        // With no enc the default is Update_of_Resource, so it is not a net=4 target
        // (TS-0004:7.5.1.2.2 Step 1.0).
        if (!sub.enc || !Array.isArray(sub.enc.net) || !sub.enc.net.includes(4)) return false;
        // When chty is present, fire only if the deleted child's type is in the list. When it
        // is absent, fire for every child type (same clause Step 1.0 — the rule net=3 follows).
        if (!comparison_conditions_match(sub.enc, resource_of(deleted_pc))) return false;
        return !sub.enc.chty || sub.enc.chty.includes(deleted_ty);
    });
    if (targets.length === 0) return false;

    const ae_poa_map = await prefetch_ae_poa(targets);
    await Promise.all(targets.map(sub => send_a_noti(sub, deleted_pc, 4, ae_poa_map)));
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

    // TS-0004:7.5.1.2.2 step 2.1 (repeated in 7.5.1.2.3/.4/.19/.20): "if the <subscription>
    // resource instance has the creator attribute, the Originator shall set the creator element
    // of the notification data object to the value of the <subscription> resource's creator
    // attribute."
    //
    // Without it a consumer cannot tell, from the notification alone, whose subscription produced
    // it — which is what a gateway needs in order to drop the echo of its own writes. Note this
    // is the *subscription's* creator; the changed resource's own cr travels inside nev.rep and
    // is a different attribute.
    if (sub_res.cr) sgn["m2m:sgn"].cr = sub_res.cr;

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
                // A notification is a request primitive, and TS-0004:6.4.1 gives Release Version
                // Indicator multiplicity 1 -- it is mandatory on every one. This header was
                // missing, and a receiver that checks its request parameters rejected the
                // notification because of it. The value is the first entry of cse.versions, the
                // same source the MQTT notification path and the retargeting path already use, so
                // all three agree on what release this CSE speaks.
                "X-M2M-RVI": config.cse.versions[0],
                "Content-Type": "application/json",
            },
            data: sgn,
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

    // Published to the broker the URL names, not to this CSE's own. TS-0010:6.6.2 makes the
    // authority part of the URL meaningful; sending everything to the local broker delivered the
    // right topic to the wrong server, which looks identical in the logs and delivers nothing.
    // bindings/mqtt-outbound.js short-circuits back to the local client when the URL does name it.
    const mqtt_outbound = require('../bindings/mqtt-outbound');
    const result = await mqtt_outbound.publish_to_url(noti_target, req_prim, { topic_override: topic });
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
    self_noti_handler,
    // Used by cse/missing-data-subscription.js, which is triggered by the sweep rather than by a
    // resource CRUD event and so cannot go through check_and_send_noti.
    send_a_noti,
    prefetch_ae_poa,
};
