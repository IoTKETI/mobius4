const MQTT = require("async-mqtt");
const config = require("config");

const logger = require("../logger").forFile(__filename);
const reqPrim = require('../cse/reqPrim');
const enums = require('../config/enums');
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
    // apply ±jitter random spread
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
        reconnectPeriod: 0,      // disable auto-reconnect — controlled by manual exponential backoff
        connectTimeout: 30000
    });

    // Re-subscribe on every connect (handles both initial connect and reconnects)
    mqtt_client.on('connect', async () => {
        isConnected = true;
        reconnectAttempts = 0;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        // Subscribing is what makes an instance handle inbound MQTT requests, and the broker
        // delivers each message to every subscriber — so with several instances running, one
        // request would be processed by all of them. Only instance 0 subscribes; the others
        // keep their connection, which is what mqtt_transmitter publishes notifications
        // through. See cse/singleton-role.js.
        const { isSingletonInstance } = require('../cse/singleton-role');
        if (!isSingletonInstance()) {
            logger.info({ instance: process.env.NODE_APP_INSTANCE },
                'mqtt request topics are served by instance 0; this instance publishes only');
            return;
        }

        try {
            await mqtt_client.subscribe(`/oneM2M/req/+${config.cse.cse_id}/json`);
            // TS-0010:6.4.4 Initial Registration. An Originator that does not yet know its AE-ID
            // or CSE-ID cannot address the topic above, whose <originator> segment is that very
            // ID, so the specification gives registration a topic pair of its own carrying a
            // Credential-ID instead. Only the topic names differ -- "except that they use Topics
            // containing a credential ID" -- so the handling below is the ordinary request path.
            await mqtt_client.subscribe(`/oneM2M/reg_req/+${config.cse.cse_id}/json`);
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

// The resource types a request on the registration topic may create. TS-0010:6.4.4 exists for an
// Originator that "might not initially know its AE-ID or CSE-ID", and TS-0010:6.3.3 names the same
// pair -- so <AE> and <remoteCSE> registration are what the topic is for. Anything else arriving
// there is refused rather than served, so that the topic name means what it says; see the guard in
// mqtt_receiver for why that is worth the two lines.
const REGISTRATION_TYPES = [2, 16]; // <AE>, <remoteCSE>

async function mqtt_receiver(req_topic, req_prim_str) {
    // topic: /oneM2M/req/<originator>/<receiver_id>/json, or /oneM2M/reg_req/... for an initial
    // registration (TS-0010:6.4.4). The segment index is the same in both, and so is the response
    // topic's shape -- only the literal changes, req/resp becoming reg_req/reg_resp.
    const segments = req_topic.split('/');
    const originator = segments[3];
    const is_registration = segments[2] === 'reg_req';
    const resp_literal = is_registration ? 'reg_resp' : 'resp';
    const resp_topic = '/oneM2M/' + resp_literal + '/' + originator + '/' + config.cse.cse_id.split('/')[1] + '/json';

    const req_prim = JSON.parse(req_prim_str.toString());

    logger.debug({ topic: req_topic, originator, rqi: req_prim.rqi, op: req_prim.op, to: req_prim.to }, 'mqtt request received');
    logger.debug({ prim: req_prim }, 'mqtt request full primitive');

    if (req_topic.startsWith('self/datasetManager/')) {
        const { self_noti_handler } = require('../cse/noti');
        self_noti_handler(req_topic, req_prim);
        return;
    }

    metrics.mqttMessagesTotal.inc();

    // The registration topic serves registration only.
    //
    // Nothing in TS-0010:6.4.4 forbids other operations there, and letting them through would be
    // fewer lines. It is refused anyway because the alternative is worse later: a topic that
    // accepts everything is an alias for /oneM2M/req with a different name, clients come to rely
    // on that, and narrowing it afterwards breaks them. Refusing now costs nothing, since
    // registration is the only thing an Originator without an AE-ID can do.
    //
    // What this does NOT do is authenticate. TS-0010:6.4.4 calls the <originator> segment a
    // Credential-ID, which is a TS-0003 concept, and mobius4 has no authentication layer at all
    // (BACKLOG-104 in mobius4-dev-tool). The segment is carried as an opaque string and is used
    // only to address the response, exactly as the ordinary request topic's originator segment is.
    // Reaching this topic proves nothing about who is asking. Saying so here because the last
    // mechanism that looked like proof and was not -- the mTLS listener removed in v4.7.0 -- read
    // as an assurance to everyone who found it.
    if (is_registration && !(req_prim.op === 1 && REGISTRATION_TYPES.includes(req_prim.ty))) {
        const refused = {
            rqi: req_prim.rqi,
            rvi: req_prim.rvi || config.cse.versions[0],
            rsc: enums.rsc_str['OPERATION_NOT_ALLOWED'],
            pc: { 'm2m:dbg': 'the registration topic accepts only <AE> and <remoteCSE> creation' },
        };
        logger.warn({ topic: req_topic, op: req_prim.op, ty: req_prim.ty, rqi: req_prim.rqi },
            'non-registration request on the registration topic');
        try {
            await mqtt_client.publish(resp_topic, JSON.stringify(refused));
        } catch (err) {
            logger.error({ err, topic: resp_topic }, 'mqtt publish failed');
        }
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
