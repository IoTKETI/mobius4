const config = require('config');

// Startup validation of deployment configuration.
//
// This runs before anything else so that a misconfigured deployment fails loudly at boot
// rather than serving requests in an unsafe state.

// Admin identities that shipped as a working default in a released version of mobius4.
// Anyone who has read the source or the docs knows them, so a deployment still using one is
// handing full rights to whoever can reach the port: the admin <accessControlPolicy> created
// by db/init.js grants this identity all six operations on every resource carrying it, over
// plain HTTP as much as over TLS.
//
// Only values that were actually distributed belong here. Adding a value that no deployment
// ever ran would break upgrades for no security gain.
const PUBLISHED_ADMIN_IDENTITIES = ['SM'];

// The placeholder used in config/local.json.example. It has never shipped as a default, so it
// is not refused — but a deployment that copied the example verbatim has an admin identity
// printed in this repository's documentation, which is worth saying out loud.
const EXAMPLE_ADMIN_IDENTITY = 'Superuser';

function fail(logger, message, detail) {
    logger.fatal({ ...detail }, message);
    process.exit(1);
}

/**
 * Verifies that cse.admin names an identity chosen by this deployment.
 *
 * Refuses to start when it is missing or is a value mobius4 once shipped, because either way
 * the identity is known to anyone who can reach the CSE and grants full access.
 */
function validate_admin_identity(logger) {
    if (!config.has('cse.admin')) {
        fail(logger,
            'cse.admin is not set. Set it to an identity unique to this deployment in ' +
            'config/local.json (see config/local.json.example). It grants unconditional ' +
            'access to every resource, so it must not be guessable.');
        return;
    }

    const admin = config.get('cse.admin');

    if (typeof admin !== 'string' || admin.trim() === '') {
        fail(logger,
            'cse.admin is empty. It names the identity the admin <accessControlPolicy> grants ' +
            'all six operations to, and must be unique to this deployment.',
            { admin });
        return;
    }

    if (PUBLISHED_ADMIN_IDENTITIES.includes(admin)) {
        fail(logger,
            `cse.admin is "${admin}", which shipped as the default in earlier versions of ` +
            'mobius4 and is therefore known to anyone who can reach this CSE. Any request ' +
            `sending "X-M2M-Origin: ${admin}" is granted full access, bypassing every ` +
            '<accessControlPolicy>. Choose an identity unique to this deployment and set it ' +
            'in config/local.json, then run db/migrations/v4.6.0.sql to update the identity ' +
            'already recorded in the database.',
            { admin });
        return;
    }

    if (admin === EXAMPLE_ADMIN_IDENTITY) {
        logger.warn({ admin },
            `cse.admin is "${admin}", the placeholder from config/local.json.example. It is ` +
            'published in this repository, so it is not secret. Replace it with an identity ' +
            'unique to this deployment.');
    }
}

// The protocol bindings this CSE implements (bindings/http.js, bindings/mqtt.js,
// bindings/coap.js, bindings/ws.js, each with and without TLS). This list is not a oneM2M
// clause requirement -- the spec does not constrain pointOfAccess to a fixed scheme set -- it
// is mobius4's own misconfiguration guard: a poa entry outside it is an address this CSE could
// never actually be reached on.
const ALLOWED_POA_SCHEMES = ['http', 'https', 'mqtt', 'mqtts', 'coap', 'coaps', 'ws', 'wss'];

const POA_EXAMPLE = 'http://192.0.2.10:7599';

/**
 * Verifies that cse.poa lists at least one well-formed access point.
 *
 * pointOfAccess is what other CSEs and AEs use to reach this CSE (TS-0001:9.6.3), and
 * db/init.js's sync_cb_with_config() writes it into the <CSEBase> on every boot. Letting a
 * malformed entry through here means it gets written silently and is only discovered later,
 * when some remote request built from it fails -- a different process, on a different machine,
 * a deploy away from this check.
 */
function validate_poa(logger) {
    const poa = config.has('cse.poa') ? config.get('cse.poa') : undefined;

    if (!Array.isArray(poa) || poa.length === 0) {
        fail(logger,
            `cse.poa is not set or empty. It is the address other CSEs and AEs use to reach ` +
            `this one; set it to an array with at least one address, e.g. ["${POA_EXAMPLE}"].`,
            { poa });
        return;
    }

    for (const value of poa) {
        let url;
        try {
            url = new URL(value);
        } catch (err) {
            fail(logger,
                `cse.poa contains "${value}", which is not a valid URL. Example: "${POA_EXAMPLE}".`,
                { value });
            return;
        }

        const scheme = url.protocol.slice(0, -1); // URL.protocol keeps the trailing ':'

        if (!ALLOWED_POA_SCHEMES.includes(scheme)) {
            // new URL() treats anything before the first ":" as the scheme, so a value missing
            // one entirely -- "localhost:7599" -- parses "cleanly" with scheme "localhost"
            // instead of failing outright. Worth saying explicitly, since the actual mistake
            // ("I forgot http://") looks nothing like the error ("localhost" is not a scheme).
            const missingSchemeHint = value.includes('://')
                ? ''
                : ` (no "://" in "${value}" -- this looks like a missing scheme rather than an unsupported one)`;
            fail(logger,
                `cse.poa contains "${value}", whose scheme "${scheme}" is none of this CSE's ` +
                `protocol bindings (${ALLOWED_POA_SCHEMES.join(', ')}).${missingSchemeHint} ` +
                `Example: "${POA_EXAMPLE}".`,
                { value, scheme });
            return;
        }

        if (!url.hostname) {
            fail(logger,
                `cse.poa contains "${value}", which has no host. Example: "${POA_EXAMPLE}".`,
                { value });
            return;
        }
    }
}

/**
 * Warns when a deployment still sets cse.supported_resource_types.
 *
 * DEC-137 (mobius4-dev-tool): srt (TS-0001:9.6.3) now comes from the fixed list of
 * oneM2M-standard types this CSE actually implements (cse/resource-types.js), written at
 * create and kept in step on every boot (db/init.js's sync_cb_with_config), not from
 * configuration -- an operator cannot make the CSE advertise a type it does not implement, or
 * hide one it does, by editing a config value. A deployment whose config/local.json still sets
 * this key (from before v4.25.0) is not refused -- the key simply no longer does anything.
 */
function validate_supported_resource_types(logger) {
    if (!config.has('cse.supported_resource_types')) return;

    logger.warn(
        'cse.supported_resource_types is set but ignored since v4.25.0: the <CSEBase>\'s srt ' +
        'now comes from the resource types this CSE actually implements ' +
        '(cse/resource-types.js), not from configuration. This key can be removed.'
    );
}

function validate_config(logger) {
    validate_admin_identity(logger);
    validate_poa(logger);
    validate_supported_resource_types(logger);
}

module.exports = {
    validate_config,
    PUBLISHED_ADMIN_IDENTITIES,
    EXAMPLE_ADMIN_IDENTITY,
    ALLOWED_POA_SCHEMES,
};
