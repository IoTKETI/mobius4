const MQTT = require("async-mqtt");
const config = require("config");

const logger = require("../logger").forFile(__filename);
const reqPrim = require('../cse/reqPrim');
const metrics = require('../metrics');

let mqtt_client = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let isConnected = false;
let shuttingDown = false;

function computeBackoffDelay() {
    const cfg = config.get('mqtt.reconnect');
    const delay = Math.min(
        cfg.initialDelayMs * Math.pow(cfg.multiplier, reconnectAttempts),
        cfg.maxDelayMs
    );
    // ±jitter 랜덤 분산 적용
    return delay * (1 + (Math.random() * 2 - 1) * cfg.jitter);
}

function scheduleReconnect(endpoint) {
    if (shuttingDown) return;

    const maxAttempts = config.get('mqtt.reconnect.maxAttempts');
    if (maxAttempts > 0 && reconnectAttempts >= maxAttempts) {
        logger.error({ attempts: reconnectAttempts }, 'mqtt max reconnect attempts reached, giving up');
        return;
    }

    const delayMs = Math.round(computeBackoffDelay());
    logger.warn({ attempt: reconnectAttempts + 1, delayMs, endpoint }, 'mqtt scheduling reconnect');

    reconnectTimer = setTimeout(() => {
        reconnectAttempts++;
        mqtt_client.reconnect();
    }, delayMs);
}

exports.init_client = async function () {
    if (!config.get('mqtt.enabled')) {
        logger.info('mqtt binding disabled by configuration');
        return;
    }

    const mqtt_endpoint = 'tcp://' + config.mqtt.ip + ':' + config.mqtt.port;
    mqtt_client = MQTT.connect(mqtt_endpoint, {
        reconnectPeriod: 0,      // 자동 재연결 비활성화 — 수동 지수 백오프로 제어
        connectTimeout: 30000
    });

    // Re-subscribe on every connect (handles both initial connect and reconnects)
    mqtt_client.on('connect', async () => {
        isConnected = true;
        reconnectAttempts = 0;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        try {
            await mqtt_client.subscribe(`/oneM2M/req/+${config.cse.cse_id}/json`);
            await mqtt_client.subscribe('self/datasetManager/#');
            logger.info({ cseId: config.cse.cse_id }, 'mqtt subscriptions ready');
        } catch (err) {
            logger.error({ err }, 'mqtt subscription failed');
        }
    });

    mqtt_client.on('close', () => {
        isConnected = false;
        scheduleReconnect(mqtt_endpoint);
    });

    mqtt_client.on('message', mqtt_receiver);

    // Prevent unhandled EventEmitter error from crashing the process
    mqtt_client.on('error', (err) => {
        logger.warn({ err, endpoint: mqtt_endpoint }, 'mqtt connection error');
    });

    logger.info({ endpoint: mqtt_endpoint }, 'mqtt client connecting');

    // Wait for initial connection up to initialConnectTimeoutMs.
    // On timeout, log a warning and continue HTTP-only — background reconnect remains active.
    const timeoutMs = config.get('mqtt.initialConnectTimeoutMs');
    const connected = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        mqtt_client.once('connect', () => { clearTimeout(timer); resolve(true); });
    });

    if (!connected) {
        logger.warn({ endpoint: mqtt_endpoint, timeoutMs },
            'mqtt broker not reachable at startup, running HTTP-only (background reconnect active)');
    }
};

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

    metrics.mqttMessagesTotal.inc();

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
    if (!mqtt_client || !isConnected) {
        logger.warn({ topic: req_topic }, 'mqtt transmit skipped: mqtt is not connected');
        return false;
    }

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

exports.disconnect = async function () {
    if (!mqtt_client) return;
    shuttingDown = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    try {
        await mqtt_client.end(false); // false = graceful (flush pending messages first)
        isConnected = false;
        logger.info('mqtt client disconnected');
    } catch (err) {
        logger.error({ err }, 'mqtt disconnect error');
    }
};

exports.isConnected = () => isConnected;
