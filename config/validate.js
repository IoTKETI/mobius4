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

function validate_config(logger) {
    validate_admin_identity(logger);
}

module.exports = { validate_config, PUBLISHED_ADMIN_IDENTITIES, EXAMPLE_ADMIN_IDENTITY };
