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

const CONNECT_TIMEOUT_MS = 5000;
const RECONNECT_PERIOD_MS = 2000;
const FAILURE_COOLDOWN_MS = 30000;
// A ceiling so that a resource tree full of distinct broker URLs cannot open unbounded sockets.
// Reaching it evicts the least recently used idle connection rather than refusing the new one.
const MAX_BROKERS = 20;
// Long on purpose: this is garbage collection, not connection pooling. A notification path that
// fires a few times an hour must keep finding a warm socket.
const IDLE_TTL_MS = 30 * 60 * 1000;
const IDLE_SWEEP_MS = 5 * 60 * 1000;

/**
 * Connection lifetime — why nothing closes on a timer.
 *
 * A connection is not per message. Opening one costs a TCP handshake and a CONNECT/CONNACK round
 * trip, so closing after each publish would turn MQTT into a slower HTTP and throw away the reason
 * to use it: a warm connection that delivers the next notification immediately. A gateway pushing
 * a steady stream to one broker, and a <remoteCSE> that is forwarded to all day, both want the
 * same socket to stay up.
 *
 * So connections are opened on first use and kept warm. They are reclaimed two ways, both of them
 * slow enough not to interfere with an active path:
 *
 *   - **Idle collection.** A connection that has carried nothing for IDLE_TTL_MS is closed. The
 *     window is deliberately long — a subscription may notify once an hour and should still find
 *     the socket up — but without it a broker used once at startup holds a connection for the life
 *     of the process. Anything with a request in flight is never collected.
 *   - **Pressure.** At MAX_BROKERS a new authority evicts the least recently used idle connection
 *     rather than being refused.
 *
 * Reconnection is the broker's client's job (RECONNECT_PERIOD_MS) rather than being deferred to
 * the next publish, so a broker that comes back finds us already there — and any response topic we
 * were listening on is re-subscribed, since MQTT subscriptions do not survive a session.
 */
const clients = new Map();   // authority -> Entry
const failures = new Map();  // authority -> timestamp of the last failed connect

/**
 * @typedef Entry
 * @property client      the async-mqtt client
 * @property subscribed  topics this connection is listening on, kept so they can be restored
 * @property pending     rqi -> { resolve, timer } for forwarded requests awaiting an answer
 * @property last_used   for eviction under pressure
 */

function touch(entry) {
    entry.last_used = Date.now();
}

let sweep_timer = null;

/** Closes connections that have carried nothing for IDLE_TTL_MS. */
async function sweep_idle() {
    const cutoff = Date.now() - IDLE_TTL_MS;
    for (const [authority, entry] of [...clients]) {
        if (entry.pending.size > 0) continue;   // a request is waiting on this one
        if (entry.last_used > cutoff) continue;

        clients.delete(authority);
        logger.info({ authority, idle_ms: Date.now() - entry.last_used },
            'closing an idle outbound broker connection');
        try {
            await entry.client.end(false);
        } catch (err) {
            logger.warn({ err, authority }, 'idle disconnect error');
        }
    }
    if (clients.size === 0) stop_sweep();
}

function start_sweep() {
    if (sweep_timer) return;
    sweep_timer = setInterval(() => {
        sweep_idle().catch((err) => logger.warn({ err }, 'idle sweep failed'));
    }, IDLE_SWEEP_MS);
    // The sweep must not be the reason the process stays alive.
    if (sweep_timer.unref) sweep_timer.unref();
}

function stop_sweep() {
    if (!sweep_timer) return;
    clearInterval(sweep_timer);
    sweep_timer = null;
}

/** Frees a slot when MAX_BROKERS is reached: the oldest connection with nothing in flight. */
async function evict_one() {
    let victim = null;
    for (const [authority, entry] of clients) {
        if (entry.pending.size > 0) continue; // never cut a request off mid-flight
        if (!victim || entry.last_used < victim.entry.last_used) victim = { authority, entry };
    }
    if (!victim) return false;

    clients.delete(victim.authority);
    logger.info({ authority: victim.authority }, 'evicting the least recently used outbound broker');
    try {
        await victim.entry.client.end(false);
    } catch (err) {
        logger.warn({ err, authority: victim.authority }, 'eviction disconnect error');
    }
    return true;
}

async function get_entry(authority) {
    const existing = clients.get(authority);
    if (existing) {
        touch(existing);
        return existing;
    }

    const failed_at = failures.get(authority);
    if (failed_at && Date.now() - failed_at < FAILURE_COOLDOWN_MS) {
        logger.debug({ authority }, 'skipping broker in failure cooldown');
        return null;
    }

    if (clients.size >= MAX_BROKERS && !(await evict_one())) {
        logger.warn({ authority, open: clients.size },
            'outbound broker limit reached and every connection is busy');
        return null;
    }

    try {
        // connectAsync would reject on a failed first connect while leaving the underlying client
        // retrying forever, because reconnectPeriod applies from the start -- a broker that is
        // simply not there would leave a timer running for the life of the process. So the first
        // connect is awaited by hand and the client is destroyed if it does not come up.
        const client = await new Promise((resolve, reject) => {
            const c = MQTT.connect(authority, {
                connectTimeout: CONNECT_TIMEOUT_MS,
                reconnectPeriod: RECONNECT_PERIOD_MS,
            });
            const give_up = (err) => {
                c.removeListener('connect', on_connect);
                c.end(true).catch(() => {});
                reject(err);
            };
            const on_connect = () => {
                clearTimeout(timer);
                c.removeListener('error', give_up);
                resolve(c);
            };
            const timer = setTimeout(() => give_up(new Error('connect timed out')), CONNECT_TIMEOUT_MS);
            c.once('connect', on_connect);
            c.once('error', (err) => { clearTimeout(timer); give_up(err); });
        });

        const entry = { client, subscribed: new Set(), pending: new Map(), last_used: Date.now() };

        // One listener for the life of the connection. Adding one per request leaked listeners and
        // made every handler see every message.
        client.on('message', (topic, payload) => {
            let resp;
            try {
                resp = JSON.parse(payload.toString());
            } catch (err) {
                logger.warn({ err, topic, authority }, 'unparsable mqtt message');
                return;
            }
            // One response topic carries the answers to every request in flight to that CSE, so
            // the rqi decides whose answer this is.
            const waiter = entry.pending.get(resp.rqi);
            if (!waiter) return;
            entry.pending.delete(resp.rqi);
            clearTimeout(waiter.timer);
            waiter.resolve(resp);
        });

        // A reconnect starts a fresh MQTT session, and subscriptions do not survive one.
        client.on('connect', () => {
            for (const topic of entry.subscribed) {
                client.subscribe(topic).catch((err) =>
                    logger.warn({ err, topic, authority }, 'could not restore subscription'));
            }
        });

        client.on('error', (err) => logger.warn({ err, authority }, 'outbound mqtt error'));

        clients.set(authority, entry);
        failures.delete(authority);
        start_sweep();
        logger.info({ authority }, 'connected to an outbound mqtt broker');
        return entry;
    } catch (err) {
        failures.set(authority, Date.now());
        logger.warn({ err, authority }, 'could not connect to outbound mqtt broker');
        return null;
    }
}

/** Subscribes once and remembers it; repeated calls for the same topic are free. */
async function ensure_subscribed(entry, topic, authority) {
    if (entry.subscribed.has(topic)) return true;
    try {
        await entry.client.subscribe(topic);
        entry.subscribed.add(topic);
        return true;
    } catch (err) {
        logger.warn({ err, topic, authority }, 'could not subscribe to a response topic');
        return false;
    }
}

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
    return authority === `mqtt://${config.mqtt.ip}:${config.mqtt.port}`;
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

    const entry = await get_entry(parsed.authority);
    if (!entry) return false;

    try {
        await entry.client.publish(topic, JSON.stringify(payload));
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

    const entry = await get_entry(parsed.authority);
    if (!entry) return null;

    // Subscribed once and left in place. Subscribing per request and unsubscribing afterwards
    // meant two extra round trips on every forward -- and worse, two concurrent forwards to the
    // same CSE share this topic, so the first to finish would have unsubscribed the second and
    // left it waiting for an answer it could no longer receive.
    if (!(await ensure_subscribed(entry, resp_topic, parsed.authority))) return null;

    return await new Promise((resolve) => {
        const timer = setTimeout(() => {
            entry.pending.delete(req_prim.rqi);
            logger.warn({ resp_topic, rqi: req_prim.rqi, timeout_ms }, 'mqtt request timed out');
            resolve(null);
        }, timeout_ms);

        // Registered before publishing: the answer can arrive before publish() resolves.
        entry.pending.set(req_prim.rqi, { resolve, timer });
        touch(entry);

        entry.client.publish(req_topic, JSON.stringify(req_prim)).catch((err) => {
            entry.pending.delete(req_prim.rqi);
            clearTimeout(timer);
            logger.warn({ err, req_topic }, 'mqtt request could not be sent');
            resolve(null);
        });
    });
}

/** Closes every outbound connection. Called on shutdown alongside the inbound client. */
async function disconnect_all() {
    stop_sweep();
    const open = [...clients.entries()];
    clients.clear();
    failures.clear();
    await Promise.all(open.map(async ([authority, entry]) => {
        try {
            for (const waiter of entry.pending.values()) {
                clearTimeout(waiter.timer);
                waiter.resolve(null); // shutting down: nothing is coming
            }
            await entry.client.end(false);
        } catch (err) {
            logger.warn({ err, authority }, 'outbound mqtt disconnect error');
        }
    }));
}

/** Ages a connection so a test can drive the idle sweep without waiting IDLE_TTL_MS. */
function __set_last_used_for_test(authority, when) {
    const entry = clients.get(authority);
    if (entry) entry.last_used = when;
}

/** How many outbound broker connections are currently held. Used by tests. */
function open_broker_count() {
    return clients.size;
}

module.exports = {
    open_broker_count,
    __set_last_used_for_test,
    sweep_idle,
    IDLE_TTL_MS,
    parse_mqtt_url,
    publish_to_url,
    request_topic,
    response_topic,
    request_over_mqtt,
    disconnect_all,
};
