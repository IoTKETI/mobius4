const MQTT = require("async-mqtt");
const config = require("config");

const logger = require("../logger").child({ module: "mqtt", binding: "mqtt" });
const reqPrim = require('../cse/reqPrim');
let mqtt_client = {};

exports.init_client = async function () {
    const mqtt_endpoint = 'tcp://' + config.mqtt.ip + ':' + config.mqtt.port;
    mqtt_client = MQTT.connect(mqtt_endpoint, {
        reconnectPeriod: 5000,
        connectTimeout: 30000
    });

    mqtt_client.on('message', mqtt_receiver);
    mqtt_client.on('reconnect', () => logger.warn({ endpoint: mqtt_endpoint }, 'mqtt reconnecting'));
    mqtt_client.on('offline', () => logger.error({ endpoint: mqtt_endpoint }, 'mqtt offline'));

    logger.info({ endpoint: mqtt_endpoint }, 'mqtt client connecting');
    try {
        await mqtt_client.subscribe(`/oneM2M/req/+${config.cse.cse_id}/json`);
        await mqtt_client.subscribe('self/datasetManager/#');
        logger.info({ cseId: config.cse.cse_id }, 'mqtt subscriptions ready');
    } catch (err) {
        logger.fatal({ err, endpoint: mqtt_endpoint }, 'mqtt subscription failed');
        await mqtt_client.end();
    }
}

async function mqtt_receiver(req_topic, req_prim_str) {
    const originator = req_topic.split('/')[3]; // topic: /oneM2M/req/<originator>/<receiver_id>/json
    const resp_topic = '/oneM2M/resp/' + originator + '/' + config.cse.cse_id.split('/')[1] + '/json';

    const req_prim = JSON.parse(req_prim_str.toString());

    logger.debug({ topic: req_topic, originator, rqi: req_prim.rqi, op: req_prim.op, to: req_prim.to }, 'mqtt request received');
    logger.debug({ prim: req_prim }, 'mqtt request full primitive');

    if (req_topic.startsWith('self/datasetManager/')) {
        const { self_noti_handler } = require('../cse/noti');
        self_noti_handler(req_topic, req_prim);
        return;
    }

    const resp_prim = await reqPrim.prim_handling(req_prim);

    try {
        await mqtt_client.publish(resp_topic, JSON.stringify(resp_prim));
        logger.debug({ topic: resp_topic, rsc: resp_prim.rsc, rqi: resp_prim.rqi }, 'mqtt response sent');
        logger.debug({ prim: resp_prim }, 'mqtt response full primitive');
    } catch (err) {
        logger.error({ err, topic: resp_topic }, 'mqtt publish failed');
    }
}

exports.mqtt_transmitter = async function (req_topic, req_prim) {
    try {
        await mqtt_client.publish(req_topic, JSON.stringify(req_prim));
        logger.debug({ topic: req_topic, op: req_prim.op, rqi: req_prim.rqi }, 'mqtt transmitter sent');
        logger.debug({ prim: req_prim }, 'mqtt transmit full primitive');
    } catch (err) {
        logger.error({ err, topic: req_topic }, 'mqtt transmit failed');
        return false;
    }

    return true;
}
