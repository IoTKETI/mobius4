'use strict';

// Turns the container's environment into the NODE_CONFIG object mobius4 starts from.
//
// Kept apart from entrypoint.js so it can be tested: entrypoint.js resolves an identity file,
// talks to PostgreSQL and finally requires mobius4.js, none of which a test of "does this
// variable reach this setting" should have to do. This module reads nothing and writes nothing.
//
// The rule the whole file follows: a variable that is not set must not appear in the output.
// node-config merges NODE_CONFIG over config/default.json, so an empty string here does not mean
// "use the default", it means "override the default with nothing".

// Drops undefined values so that an unset variable does not override config/default.json.
// Recursive, so a block whose every value is unset disappears entirely rather than arriving as
// an empty object -- which is what lets the registrar block below be absent by default.
function only(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v === undefined) continue;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            const inner = only(v);
            if (Object.keys(inner).length > 0) out[k] = inner;
        } else {
            out[k] = v;
        }
    }
    return out;
}

// readers: { env, bool, number } — supplied by the caller so that a validation failure can stop
// the container in entrypoint.js and merely throw in a test.
function buildNodeConfig({ env, bool, number }, adminIdentity) {
    return only({
        cse: {
            admin: adminIdentity,
            // 1 IN-CSE, 2 MN-CSE, 3 ASN-CSE (TS-0001 table 6.2.0-1). This decides whether the CSE
            // registers with anyone at all: mobius4.js only calls registree() for 2 and 3, so
            // without it a container could never be anything but a standalone IN-CSE.
            cse_type: number('CSE_TYPE'),
            cse_id: env('CSE_ID'),
            sp_id: env('CSE_SP_ID'),
            csebase_rn: env('CSE_BASE_RN'),
            poa: env('CSE_POA') ? [env('CSE_POA')] : undefined,
            // The CSE this one registers with, read by cse/registree.js. The whole block was
            // missing, and because this script overwrites NODE_CONFIG it could not be injected from
            // outside either — so a containerised MN-CSE had no way to reach its registrar
            // (found 2026-08-08 while building the two-CSE test environment). only() drops the
            // block entirely when none of these are set, leaving config/default.json in charge.
            registrar: {
                cse_type: number('REGISTRAR_CSE_TYPE'),
                cse_id: env('REGISTRAR_CSE_ID'),
                csebase_rn: env('REGISTRAR_CSE_BASE_RN'),
                ip: env('REGISTRAR_HOST'),
                port: number('REGISTRAR_PORT'),
            },
        },
        http: { port: number('HTTP_PORT') },
        https: {
            enabled: bool('HTTPS_ENABLED'),
            port: number('HTTPS_PORT'),
            key: env('HTTPS_KEY'),
            cert: env('HTTPS_CERT'),
            chain: env('HTTPS_CHAIN'),
        },
        db: {
            host: env('DB_HOST'),
            port: number('DB_PORT'),
            name: env('DB_NAME'),
            user: env('DB_USER'),
            pw: env('DB_PW'),
            // Exposed because the value that needs adjusting is environment-specific: a cold
            // container on a throttled host takes longer to hand out a connection than a laptop does.
            // Unset falls through to config/default.json rather than overriding it with undefined.
            pool: {
                max: number('DB_POOL_MAX'),
                connectionTimeoutMs: number('DB_POOL_CONNECTION_TIMEOUT_MS'),
                statementTimeoutMs: number('DB_POOL_STATEMENT_TIMEOUT_MS'),
            },
        },
        mqtt: {
            enabled: bool('MQTT_ENABLED'),
            ip: env('MQTT_HOST'),
            port: number('MQTT_PORT'),
        },
        security: {
            helmet: { enabled: bool('HELMET_ENABLED') },
            rateLimit: { enabled: bool('RATELIMIT_ENABLED'), max: number('RATELIMIT_MAX') },
        },
        // Containers log to stdout and let the log driver deal with rotation; a file inside the
        // container is invisible to `docker compose logs` and grows in a layer nobody backs up.
        logging: {
            level: env('LOG_LEVEL'),
            console: { enabled: true, pretty: false },
            file: { enabled: false },
        },
    });
}

module.exports = { buildNodeConfig, only };
