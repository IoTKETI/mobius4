/**
 * Outbound MQTT: publishing to a broker named by a URL, rather than only to this CSE's own.
 *
 * bindings/mqtt.js holds one client — the broker this CSE listens on. Everything outbound went
 * through it, so a `<subscription>` whose notificationURI named a different host was published to
 * the wrong broker (the local one) under the right topic, and a `<remoteCSE>` reachable only over
 * MQTT could not be reached at all.
 *
 * Connections are cached per authority and reused. A notification burst to one AE must not open a
 * connection per message, and a broker that is down must not be retried on every notification, so
 * a failed connection is remembered briefly before being tried again.
 */

const MQTT = require('async-mqtt');
const config = require('config');
const logger = require('../logger').forFile(__filename);

// Cache of live clients, keyed by "scheme://host:port".
const clients = new Map();
// Authorities whose last connection attempt failed, and when. Cleared on success.
const failures = new Map();

const CONNECT_TIMEOUT_MS = 5000;
const FAILURE_COOLDOWN_MS = 30000;
// A ceiling so that a resource tree full of distinct broker URLs cannot open unbounded sockets.
const MAX_BROKERS = 20;

/**
 * Splits an oneM2M MQTT URL into the broker to connect to and the topic to publish on.
 *
 * TS-0010:6.6.2 gives the form `mqtt://<authority>[/<path>]`, with default ports 1883 for mqtt and
 * 8883 for mqtts. TS-0010:6.6.4: a URL used anywhere other than a pointOfAccess "shall contain a
 * path component. That path gives the entire MQTT topic string" — so the path is the topic, whole,
 * and is not required to match any of the standard topic patterns.
 */
function parse_mqtt_url(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (!['mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(parsed.protocol)) return null;

    const port = parsed.port || (parsed.protocol === 'mqtts:' ? '8883' : '1883');
    return {
        authority: `${parsed.protocol}//${parsed.hostname}:${port}`,
        // Leading "/" belongs to the URL, not to the topic.
        topic: parsed.pathname.replace(/^\//, ''),
        query: parsed.search,
    };
}

/** True when the authority is the broker this CSE is already connected to as a client. */
function is_own_broker(authority) {
    if (!config.mqtt || !config.mqtt.enabled) return false;
    const own = `mqtt://${config.mqtt.ip}:${config.mqtt.port}`;
    return authority === own;
}

async function get_client(authority) {
    const existing = clients.get(authority);
    if (existing) return existing;

    const failed_at = failures.get(authority);
    if (failed_at && Date.now() - failed_at < FAILURE_COOLDOWN_MS) {
        logger.debug({ authority }, 'skipping broker in failure cooldown');
        return null;
    }

    if (clients.size >= MAX_BROKERS) {
        logger.warn({ authority, open: clients.size },
            'outbound broker limit reached; not connecting to another');
        return null;
    }

    try {
        const client = await MQTT.connectAsync(authority, {
            connectTimeout: CONNECT_TIMEOUT_MS,
            // Deliberately no automatic reconnect: a client kept alive for a broker nobody is
            // publishing to any more is a socket held for nothing. A later publish reconnects.
            reconnectPeriod: 0,
        });
        client.on('close', () => clients.delete(authority));
        client.on('error', (err) => logger.warn({ err, authority }, 'outbound mqtt error'));
        clients.set(authority, client);
        failures.delete(authority);
        logger.info({ authority }, 'connected to an outbound mqtt broker');
        return client;
    } catch (err) {
        failures.set(authority, Date.now());
        logger.warn({ err, authority }, 'could not connect to outbound mqtt broker');
        return null;
    }
}

/**
 * Publishes a payload to the broker and topic named by an mqtt URL.
 * Returns true when the broker accepted the PUBLISH.
 */
async function publish_to_url(url, payload, { topic_override } = {}) {
    const parsed = parse_mqtt_url(url);
    if (!parsed) {
        logger.warn({ url }, 'not a usable mqtt URL');
        return false;
    }

    const topic = topic_override ?? parsed.topic;
    if (!topic) {
        logger.warn({ url }, 'mqtt URL carries no topic (TS-0010:6.6.4 requires a path component)');
        return false;
    }

    // The CSE's own broker already has a connected client with its subscriptions and reconnect
    // handling; opening a second connection to it would be wasteful and would split the state.
    if (is_own_broker(parsed.authority)) {
        const { mqtt_transmitter } = require('./mqtt');
        return await mqtt_transmitter(topic, payload);
    }

    const client = await get_client(parsed.authority);
    if (!client) return false;

    try {
        await client.publish(topic, JSON.stringify(payload));
        logger.debug({ authority: parsed.authority, topic }, 'published to an outbound broker');
        return true;
    } catch (err) {
        logger.warn({ err, authority: parsed.authority, topic }, 'outbound mqtt publish failed');
        return false;
    }
}

/**
 * An identifier as it appears in a topic name (TS-0010:6.4.2).
 *
 * The two forms are treated differently, and the difference is one character:
 *   SP-relative  "/mobius4"            -> "mobius4"          (leading "/"s dropped)
 *   Absolute     "//sp.example/in-cse" -> ":sp.example:in-cse" (leading "//" becomes ":")
 * Every remaining "/" becomes ":" in both.
 */
function as_topic_id(id) {
    const s = String(id);
    const body = s.startsWith('//') ? ':' + s.slice(2) : s.replace(/^\/+/, '');
    return body.replace(/\//g, ':');
}

/**
 * The request topic of TS-0010:6.4.2:
 *   /oneM2M/req/<originator>/<receiver>/<type>
 * with each identifier's leading "/" dropped and its remaining "/" turned into ":".
 */
function request_topic(originator, receiver, type = 'json') {
    return `/oneM2M/req/${as_topic_id(originator)}/${as_topic_id(receiver)}/${type}`;
}

/** The matching response topic (TS-0010:6.4.3), same identifier order. */
function response_topic(originator, receiver, type = 'json') {
    return `/oneM2M/resp/${as_topic_id(originator)}/${as_topic_id(receiver)}/${type}`;
}

/**
 * Sends a request primitive to a CSE over MQTT and waits for its response.
 *
 * Unlike a notification this is a round trip: the response comes back on a separate topic and has
 * to be matched to the request by rqi, because one subscription carries the answers to every
 * request in flight to that CSE.
 */
async function request_over_mqtt(poa_url, req_prim, receiver_cse_id, timeout_ms = 10000) {
    const parsed = parse_mqtt_url(poa_url);
    if (!parsed) return null;

    // A pointOfAccess names the broker, not a topic (TS-0010:6.6.3) — the topic is the standard
    // request topic built from the two identities.
    const originator = config.cse.cse_id;
    const req_topic = request_topic(originator, receiver_cse_id);
    const resp_topic = response_topic(originator, receiver_cse_id);

    if (is_own_broker(parsed.authority)) {
        logger.warn({ poa_url },
            "forwarding over the CSE's own broker is not supported; it would answer itself");
        return null;
    }

    const client = await get_client(parsed.authority);
    if (!client) return null;

    return await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            client.removeListener('message', on_message);
            client.unsubscribe(resp_topic).catch(() => {});
            resolve(value);
        };

        const on_message = (topic, payload) => {
            if (topic !== resp_topic) return;
            try {
                const resp = JSON.parse(payload.toString());
                // One subscription carries every answer from this CSE; only ours is ours.
                if (resp.rqi !== req_prim.rqi) return;
                finish(resp);
            } catch (err) {
                logger.warn({ err, topic }, 'unparsable mqtt response');
            }
        };

        const timer = setTimeout(() => {
            logger.warn({ resp_topic, rqi: req_prim.rqi, timeout_ms }, 'mqtt request timed out');
            finish(null);
        }, timeout_ms);

        client.on('message', on_message);
        client.subscribe(resp_topic)
            .then(() => client.publish(req_topic, JSON.stringify(req_prim)))
            .catch((err) => {
                logger.warn({ err, req_topic }, 'mqtt request could not be sent');
                finish(null);
            });
    });
}

/** Closes every outbound connection. Called on shutdown alongside the inbound client. */
async function disconnect_all() {
    const open = [...clients.entries()];
    clients.clear();
    failures.clear();
    await Promise.all(open.map(async ([authority, client]) => {
        try {
            await client.end(false);
        } catch (err) {
            logger.warn({ err, authority }, 'outbound mqtt disconnect error');
        }
    }));
}

module.exports = {
    parse_mqtt_url,
    publish_to_url,
    request_topic,
    response_topic,
    request_over_mqtt,
    disconnect_all,
};
