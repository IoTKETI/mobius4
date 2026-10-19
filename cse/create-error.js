const enums = require('../config/enums');

// PostgreSQL's unique_violation. Sequelize wraps it as SequelizeUniqueConstraintError; the
// hand-written SQL in cse/resources/cin.js goes through node-postgres and surfaces the raw
// code, so both shapes are recognised here.
const PG_UNIQUE_VIOLATION = '23505';

// Failures of the database itself, not of the request. Sequelize's connection error classes plus
// the PostgreSQL classes for a cancelled statement (57), a connection exception (08) and an
// unavailable/locked resource (53, 55).
//
// Why this list exists: everything that was not a unique violation was answered 4000 BAD_REQUEST,
// so during a database outage a client was told its request was malformed. TS-0004:6.6.2
// Table 6.6.2-1 reserves 4xxx for "the request was malformed by the Originator" and 5xxx for "an
// error condition at the Receiver CSE" — a connection that could not be acquired is squarely the
// latter, and the distinction is what decides whether a client retries with backoff or gives up.
const DB_FAILURE_NAMES = [
    'SequelizeConnectionError',
    'SequelizeConnectionRefusedError',
    'SequelizeConnectionTimedOutError',
    'SequelizeConnectionAcquireTimeoutError',
    'SequelizeHostNotFoundError',
    'SequelizeHostNotReachableError',
    'SequelizeInvalidConnectionError',
];
const DB_FAILURE_PG_CLASSES = ['08', '53', '55', '57'];

function is_db_failure(err) {
    const name = err?.name ?? err?.parent?.name ?? err?.original?.name;
    if (DB_FAILURE_NAMES.includes(name)) return true;

    const code = err?.code ?? err?.original?.code ?? err?.parent?.code;
    if (typeof code === 'string' && DB_FAILURE_PG_CLASSES.includes(code.slice(0, 2))) return true;

    // node-postgres reports a dropped socket with a message and no SQLSTATE.
    const message = err?.message ?? '';
    return message.startsWith('Connection terminated');
}

// A SQLSTATE is always exactly 5 characters (the PostgreSQL manual, appendix A). Used below to
// tell a database rejection from an ordinary validation failure when the error is neither a
// unique violation nor one of the DB_FAILURE_NAMES/_PG_CLASSES above.
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

function get_sqlstate(err) {
    const code = err?.code ?? err?.original?.code ?? err?.parent?.code;
    return typeof code === 'string' && SQLSTATE_PATTERN.test(code) ? code : null;
}

// Whether an error came from the database at all, as opposed to a bug or an assertion elsewhere
// in the request path. Sequelize's own error classes (SequelizeDatabaseError and friends) all
// start with "Sequelize"; a raw node-postgres error carries no such name but does carry a
// SQLSTATE, which nothing outside a database connection produces.
function is_db_error(err) {
    const name = err?.name ?? '';
    return name.startsWith('Sequelize') || get_sqlstate(err) !== null;
}

/**
 * Classifies an error thrown while creating a resource.
 *
 * create_a_res checks up front whether the resourceName is taken and answers 4105 CONFLICT
 * (TS-0001:9.6.1.3.1, and 4105 in TS-0004:6.6.3.5). Requests that arrive together all pass
 * that check before any of them commits, so the loser is stopped by the unique index on
 * lookup.sid instead — and that arrived at the client as 4000 BAD_REQUEST, because every
 * create handler mapped any exception to it.
 *
 * Nothing was ever created twice; the defect was what the client was told. It matters because
 * 4000 means "your request was malformed", which an originator cannot distinguish from a
 * payload it should stop sending, while 4105 is the answer that says "try another name". It
 * shows up on a single instance under concurrent creates (measured: 21 of 24 losing requests)
 * and on every one of them once more than one instance shares a database.
 */
function classify_create_error(err) {
    const unique_violation =
        err?.name === 'SequelizeUniqueConstraintError' ||
        err?.code === PG_UNIQUE_VIOLATION ||
        err?.original?.code === PG_UNIQUE_VIOLATION ||
        err?.parent?.code === PG_UNIQUE_VIOLATION;

    if (unique_violation) {
        return {
            rsc: enums.rsc_str['CONFLICT'],
            dbg: "requested 'rn' is already used",
        };
    }

    if (is_db_failure(err)) {
        return {
            rsc: enums.rsc_str['INTERNAL_SERVER_ERROR'],
            dbg: err?.message,
        };
    }

    // Everything else that reaches here used to answer 4000 with err.message verbatim, which is
    // how a database's own wording -- "value too long for type character varying(10)", when
    // ACME's MIME-spelled csz slipped past validation -- ended up in a client-facing m2m:dbg.
    // TS-0004:6.6.2 reserves 4xxx for a fault in the request as the Originator could describe
    // it; a column's storage width is an implementation detail the Originator never sent and
    // cannot act on, so it is not shown. A non-database error (a thrown assertion, a bug) still
    // gets its own message -- there is no schema leak to guard against there, and swallowing it
    // would make the bug harder to find.
    if (is_db_error(err)) {
        const sqlstate = get_sqlstate(err);
        return {
            rsc: enums.rsc_str['BAD_REQUEST'],
            dbg: sqlstate?.slice(0, 2) === '22'
                ? 'an attribute value does not fit what this CSE can store'
                : 'the request could not be stored',
        };
    }

    return {
        rsc: enums.rsc_str['BAD_REQUEST'],
        dbg: err?.message,
    };
}

module.exports = { classify_create_error, is_db_failure };
