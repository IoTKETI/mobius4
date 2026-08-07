'use strict';

// Where the container's administrator identity comes from.
//
// cse.admin names the identity the admin <accessControlPolicy> grants all six operations to.
// config/validate.js refuses to start without it, and refuses "SM" — the value mobius4 shipped
// up to v4.5.1, which is therefore known to anyone who has read the repository. A container has
// to have one before mobius4 boots, and it must be the *same* one every time.
//
// That last part is the constraint that shapes this file. db/init.js writes cse.admin into the
// admin ACP's privileges on first boot and skips the whole step when the ACP already exists
// ("admin acp already exists, skipped"). Changing cse.admin afterwards does not update the
// policy — that is what db/migrations/v4.6.0.sql exists for. So an identity generated fresh on
// every start would lock the deployment out of its own CSE on the second start: the ACP would
// still name the first one.
//
// Hence three sources, in order:
//
//   1. CSE_ADMIN in the environment — from .env or the compose file. The intended path: the
//      operator chooses the value and keeps it wherever they keep credentials.
//   2. The identity file, if it has one from a previous start. This is what makes generated
//      values survive `docker compose down && up`.
//   3. Generate one, and write it to the identity file.
//
// The file lives on a Docker volume, not in the image and not in the build context — see
// docker-compose.yml and docs/docker.md.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// The first character of an AE-ID-Stem is not decoration. TS-0001:7.2: "First character of
// AE-ID-Stem is 'S': The AE-ID-Stem is assigned by the M2M-SP. In this case, the AE-ID-Stem
// shall be unique within the context of the M2M-SP Domain." An administrator identity chosen by
// the deployment is exactly that, so generated values start with 'S'. It is also the shape
// operators already recognise from the "SM" that used to ship.
const PREFIX = 'S';

// The remaining characters come from the unreserved set of RFC 3986, which the same clause gives
// as the alphabet for an AE-ID-Stem ("a sequence of characters that may include any of the
// unreserved characters defined in clause 2.3 of the IETF RFC 3986"). '~' is left out: it is
// unreserved, but it is also a shell glob and a home-directory shorthand, and this value gets
// pasted into curl commands and configuration files.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._';

// Total length, including the prefix. TS-0001:7.2 sets no length limit — this is a security
// choice, not a conformance one. The identity is a bearer credential: anything sending
// X-M2M-Origin with this value gets whatever the admin policy allows, on every resource
// carrying it, over plain HTTP as much as over TLS.
//
// 11 generated characters over a 65-character alphabet is about 2^66 combinations. At six
// characters — the shape of "SM" — it would be about 2^30, which a client that is not
// rate-limited can work through in days. The deployment default for security.rateLimit.enabled
// is false, and .env.example turns it on, but a credential should not depend on that being left
// alone.
const DEFAULT_LENGTH = 12;

function generate(length = DEFAULT_LENGTH) {
    if (length < 2) {
        throw new Error(`admin identity length must be at least 2, got ${length}`);
    }
    // randomInt is rejection-sampled, so the alphabet does not have to be a power of two for the
    // distribution to stay uniform.
    let out = PREFIX;
    for (let i = 1; i < length; i++) {
        out += ALPHABET[crypto.randomInt(ALPHABET.length)];
    }
    return out;
}

/**
 * Resolves the administrator identity and reports where it came from.
 *
 * @param {object} options
 * @param {string} [options.fromEnv]   value of CSE_ADMIN, if set
 * @param {string} options.file        path to the identity file on the persistent volume
 * @param {number} [options.length]    total length of a generated identity
 * @param {object} [options.io]        fs functions, for tests
 * @returns {{ identity: string, source: 'environment'|'file'|'generated', file: string }}
 */
function resolveAdminIdentity({ fromEnv, file, length = DEFAULT_LENGTH, io = fs }) {
    const configured = (fromEnv || '').trim();
    if (configured !== '') {
        return { identity: configured, source: 'environment', file };
    }

    let stored = '';
    try {
        stored = io.readFileSync(file, 'utf8').trim();
    } catch (err) {
        // Anything other than "not there yet" is worth failing on rather than papering over by
        // generating a second identity: an unreadable file usually means the volume is mounted
        // but the permissions are wrong, and the value that is already in it is the one the
        // database agrees with.
        if (err.code !== 'ENOENT') throw err;
    }

    if (stored !== '') {
        return { identity: stored, source: 'file', file };
    }

    const identity = generate(length);
    io.mkdirSync(path.dirname(file), { recursive: true });
    // 0600: the value is a credential, and the volume may be shared with anything else that
    // mounts it.
    io.writeFileSync(file, `${identity}\n`, { mode: 0o600 });
    return { identity, source: 'generated', file };
}

module.exports = { resolveAdminIdentity, generate, PREFIX, ALPHABET, DEFAULT_LENGTH };
