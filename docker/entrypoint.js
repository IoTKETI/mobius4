#!/usr/bin/env node
'use strict';

// Container entrypoint: work out the configuration, check the one thing that can silently lock a
// deployment out of its own CSE, then hand over to mobius4.
//
// Configuration reaches mobius4 through NODE_CONFIG, which node-config merges over
// config/default.json. That JSON is assembled here rather than in docker-compose.yml. The
// compose file can do it — a YAML block scalar holding a JSON object — but every value then has
// to survive two levels of quoting, an empty variable turns `"port":${X}` into invalid JSON, and
// the administrator identity is not known until this script has run anyway.
//
// Only variables that are actually set are written, so anything left out of .env keeps whatever
// config/default.json says instead of being overridden with an empty string.

const path = require('node:path');
const { resolveAdminIdentity, DEFAULT_LENGTH } = require('./admin-identity');
const { buildNodeConfig } = require('./node-config');

const IDENTITY_FILE = process.env.CSE_ADMIN_FILE || '/var/lib/mobius4/cse-admin';

function fail(message) {
    process.stderr.write(`\nmobius4 entrypoint: ${message}\n\n`);
    process.exit(1);
}

const env = (name) => {
    const value = process.env[name];
    return value === undefined || value.trim() === '' ? undefined : value.trim();
};

const bool = (name) => {
    const value = env(name);
    if (value === undefined) return undefined;
    if (['true', '1', 'yes', 'on'].includes(value.toLowerCase())) return true;
    if (['false', '0', 'no', 'off'].includes(value.toLowerCase())) return false;
    fail(`${name} must be true or false, got "${value}"`);
};

const number = (name) => {
    const value = env(name);
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n)) fail(`${name} must be a number, got "${value}"`);
    return n;
};


// ── the administrator identity ────────────────────────────────────────────────────────────────

const length = number('CSE_ADMIN_LENGTH') || DEFAULT_LENGTH;
let resolved;
try {
    resolved = resolveAdminIdentity({ fromEnv: process.env.CSE_ADMIN, file: IDENTITY_FILE, length });
} catch (err) {
    fail(`could not read or write the administrator identity file at ${IDENTITY_FILE}: ${err.message}\n` +
         'It lives on a Docker volume; check that the volume is mounted and writable.');
}

if (resolved.source === 'generated') {
    // Said once, loudly, and only on the start that created it. It is also on the volume, which
    // is the copy that matters — a line in a log scrolls away, and this value cannot be
    // recovered from the running system once the volume is gone.
    process.stdout.write(
        '\n' +
        '  ┌──────────────────────────────────────────────────────────────────────────┐\n' +
        '  │  A new administrator identity was generated for this deployment.         │\n' +
        '  └──────────────────────────────────────────────────────────────────────────┘\n' +
        `\n      cse.admin = ${resolved.identity}\n\n` +
        `  Stored on the identity volume at ${resolved.file}, and reused on every start.\n` +
        '  It is a credential: whatever sends it as X-M2M-Origin gets everything the admin\n' +
        '  <accessControlPolicy> allows. Copy it somewhere safe now — `docker compose down -v`\n' +
        '  deletes the volume, and the database records the identity separately, so losing the\n' +
        '  file while keeping the database leaves the CSE unreachable.\n' +
        '  To set your own instead, put CSE_ADMIN in .env. See docs/docker.md.\n\n'
    );
}

// ── NODE_CONFIG ───────────────────────────────────────────────────────────────────────────────

const nodeConfig = buildNodeConfig({ env, bool, number }, resolved.identity);

process.env.NODE_CONFIG = JSON.stringify(nodeConfig);

// ── the lockout guard ─────────────────────────────────────────────────────────────────────────

// db/init.js writes cse.admin into the admin <accessControlPolicy> on first boot and skips the
// step forever after. If the identity we are about to start with is not the one already recorded
// there, mobius4 will come up perfectly and answer 4103 to every request the administrator makes
// -- with nothing in the logs to say why. That happens when the identity volume is lost while
// the database volume survives, which is exactly the pair a partial `docker compose down` leaves
// behind.
//
// So it is checked before starting, and refused with the two ways out. Missing table, missing
// row and unreachable database all mean "nothing to compare against yet" and are not errors:
// this runs on first boot too.
async function guardAgainstIdentityMismatch() {
    const config = require('config');
    const { Client } = require('pg');

    const client = new Client({
        host: config.get('db.host'),
        port: config.get('db.port'),
        database: config.get('db.name'),
        user: config.get('db.user'),
        password: config.get('db.pw'),
        connectionTimeoutMillis: 5000,
    });

    try {
        await client.connect();
    } catch {
        return;
    }

    try {
        const { rows } = await client.query(
            'SELECT pv FROM acp WHERE rn = $1', [config.get('cb.admin_acp.rn')]);
        if (rows.length === 0) return;

        const pv = typeof rows[0].pv === 'string' ? JSON.parse(rows[0].pv) : rows[0].pv;
        const recorded = (pv && pv.acr || []).flatMap((rule) => rule.acor || []);
        if (recorded.length === 0 || recorded.includes(resolved.identity)) return;

        fail(
            'the administrator identity does not match the one this database was initialised with.\n\n' +
            `  starting with : ${resolved.identity}  (from the ${resolved.source})\n` +
            `  database has  : ${recorded.join(', ')}\n\n` +
            'mobius4 would start and then refuse every administrator request with 4103, because\n' +
            `the admin <accessControlPolicy> still names the old identity -- db/init.js writes it\n` +
            'once and skips the step on later starts.\n\n' +
            'Two ways out:\n' +
            `  * Use the identity the database already has: put CSE_ADMIN=${recorded[0]} in .env.\n` +
            '  * Keep the new identity and update the database: run db/migrations/v4.6.0.sql\n' +
            '    against it, which rewrites the recorded identity. See docs/docker.md.\n'
        );
    } catch (err) {
        // An acp table that is not there yet is the first-boot case.
        if (err.code !== '42P01') {
            process.stderr.write(`mobius4 entrypoint: could not verify the administrator identity: ${err.message}\n`);
        }
    } finally {
        await client.end().catch(() => {});
    }
}

// ── hand over ─────────────────────────────────────────────────────────────────────────────────

guardAgainstIdentityMismatch().then(() => {
    // require, not spawn. This process is PID 1, and PID 1 is where Docker delivers SIGTERM on
    // `docker compose stop`. A child process would not receive it -- the parent would have to
    // forward it and then wait, which is a second implementation of something mobius4.js already
    // does properly (its own SIGTERM handler closes the listeners, the MQTT client and the
    // database pools before exiting). Loading it here means those handlers are PID 1's handlers.
    //
    // NODE_CONFIG is already set above, so node-config picks it up when mobius4's modules
    // require it.
    require(path.join(__dirname, '..', 'mobius4.js'));
});
