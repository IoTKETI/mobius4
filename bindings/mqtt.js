const MQTT = require("async-mqtt");
const config = require("config");

const reqPrim = require('../cse/reqPrim');
let mqtt_client = {};

exports.init_client = async function () {
    const mqtt_endpoint = 'tcp://' + config.mqtt.ip + ':' + config.mqtt.port;
    mqtt_client = MQTT.connect(mqtt_endpoint);
    
    // mqtt_client.on('connect', mqtt_init);
    mqtt_client.on('message', mqtt_receiver);
    
    console.log("MQTT client is connecting to: ", mqtt_endpoint);
    try {
        await mqtt_client.subscribe(`/oneM2M/req/+${config.cse.cse_id}/json`);
        await mqtt_client.subscribe('self/datasetManager/#');
    } catch (err) {
        console.log(err.stack);
        await mqtt_client.end();
    }
}

async function mqtt_receiver(req_topic, req_prim_str) {
    const originator = req_topic.split('/')[3]; // topic: /oneM2M/req/<originator>/<receiver_id>/json
    const resp_topic = '/oneM2M/resp/' + originator +  '/' + config.cse.cse_id.split('/')[1] + '/json';

    const req_prim = JSON.parse(req_prim_str.toString());

    console.log('\na req prim received over MQTT: ', JSON.stringify(req_prim, null, 2));

    if (req_topic.startsWith('self/datasetManager/')) {
        const { self_noti_handler } = require('../cse/noti');
        self_noti_handler(req_topic, req_prim);
        // self notification is not ordinary oneM2M requests so return here
        return;
    }

    const resp_prim = await reqPrim.prim_handling(req_prim);

    try {
        await mqtt_client.publish(resp_topic, JSON.stringify(resp_prim));
        console.log('\nmqtt client sent a msg to the topic: ', resp_topic);
        console.log('mqtt client sent this msg: ', JSON.stringify(resp_prim, null, 2));
    } catch (err) {
        console.log(err.stack);
    }
}

exports.mqtt_transmitter = async function (req_topic, req_prim) {
    try {
        await mqtt_client.publish(req_topic, JSON.stringify(req_prim));
        console.log('\nmqtt client sent a msg to the topic: ', req_topic);
        console.log('a prim sent over MQTT: ', JSON.stringify(req_prim, null, 2));
    } catch (err) {
        console.log(err.stack);
        return false;
    }

    return true;
}
