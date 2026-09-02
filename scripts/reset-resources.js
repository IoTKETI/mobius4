"use strict";
// Empties every oneM2M resource from a deployment, leaving its configuration alone.
//
// The need is a test environment that has to start from nothing repeatedly. Doing it by hand means
// dropping the `public` schema in a database client and recreating it, which works but takes the
// PostGIS extension with it and depends on remembering to recreate the schema before the CSE
// starts. This does the same thing with one command and without touching anything the CSE was not
// asked to forget.
//
// WHAT IS DESTROYED: every row of every table the CSE created -- <AE>, <container>,
// <contentInstance>, <timeSeries>, <subscription>, <group>, <accessControlPolicy>, <remoteCSE>,
// the AI/ML tree, and the `lookup` index. There is no soft delete anywhere in this codebase, so
// this is not recoverable from inside the system.
//
// WHAT IS KEPT: config/*.json and every setting in it, the database itself, the schema, indexes,
// the PostGIS extension, the administrator identity file under /var/lib/mobius4, and
// config/specializations.json. Nothing outside the CSE's own tables is read or written.
//
// WHY THE CSE COMES BACK UP: db/init.js is idempotent. On the next start it finds no <CSEBase>,
// recreates it from config, and recreates the default and administrator access control policies
// from config.cse.admin. So "configuration is preserved" is not just that the files survive -- the
// resources the configuration describes are rebuilt from them.
//
// Usage:
//   node scripts/reset-resources.js                 # dry run: says what it would delete
//   node scripts/reset-resources.js --yes           # delete
//   node scripts/reset-resources.js --yes --expect mobius4_test
//
// Stop the CSE first. The script refuses while anything is connected to the target database, for
// two reasons: a running CSE holds caches that would silently disagree with an emptied database
// (cse/datasetManager.js and bindings/mqtt-outbound.js build theirs as requests arrive), and a
// production deployment is always connected, so this cannot empty one out from under itself.

const { Client } = require("pg");
const config = require("config");

const say = (msg) => console.log(`reset-resources: ${msg}`);

function parseArgs(argv) {
    const opts = { yes: false, expect: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--yes") { opts.yes = true; continue; }
        if (arg === "--expect" || arg.startsWith("--expect=")) {
            const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
            if (!value) throw new Error("--expect needs a database name");
            opts.expect = value;
            continue;
        }
        // Refuse rather than ignore. A typo in a destructive command must not be read as consent
        // by silently falling through to the default.
        throw new Error(`unrecognised argument '${arg}'. Usage: reset-resources.js [--yes] [--expect <database>]`);
    }
    return opts;
}

// The CSE's own tables, asked of the database rather than listed here.
//
// Two things this gets right that a hardcoded list would not. A table added by a future migration
// is included without anyone remembering to add it. And a table belonging to an extension is
// excluded: PostGIS owns `spatial_ref_sys`, which holds roughly 8500 coordinate system
// definitions. Emptying it would break every spatial query, and it would not come back --
// db/init.js runs CREATE EXTENSION IF NOT EXISTS, which does nothing when the extension is already
// registered, so the damage would be silent and permanent until someone reinstalled PostGIS.
const OWN_TABLES = `
    SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND NOT EXISTS (
             SELECT 1 FROM pg_depend d
              WHERE d.classid = 'pg_class'::regclass
                AND d.objid = c.oid
                AND d.deptype = 'e')
     ORDER BY 1`;

async function main(argv) {
    const opts = parseArgs(argv);

    const { host, port, user, pw, name } = {
        host: config.get("db.host"), port: config.get("db.port"),
        user: config.get("db.user"), pw: config.get("db.pw"), name: config.get("db.name"),
    };

    if (opts.expect && opts.expect !== name) {
        throw new Error(
            `--expect said '${opts.expect}' but the configuration resolves to '${name}'. ` +
            `Refusing: the configuration in effect is not the one you meant.`);
    }

    const client = new Client({ host, port, user, password: pw, database: name });
    await client.connect();
    try {
        // Anything else connected means the CSE is probably running. Checked before the counts so
        // a live deployment is refused as early as possible.
        const { rows: [{ others }] } = await client.query(
            `SELECT count(*)::int AS others FROM pg_stat_activity
              WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]);
        if (others > 0) {
            throw new Error(
                `${others} other connection(s) are open to '${name}'. Stop the CSE and try again — ` +
                `emptying the database under a running CSE leaves its in-memory state disagreeing ` +
                `with it.`);
        }

        const { rows: tables } = await client.query(OWN_TABLES);
        if (tables.length === 0) {
            say(`'${name}' on ${host}:${port} has no CSE tables — nothing to do`);
            return;
        }

        // Count before destroying. The failure this guards against is not a wrong command but a
        // wrong *database*: seeing "0 rows" where you expected thousands, or the reverse, is the
        // moment to stop.
        let total = 0;
        const counts = [];
        for (const { name: table } of tables) {
            const { rows: [{ n }] } = await client.query(`SELECT count(*)::int AS n FROM "${table}"`);
            total += n;
            if (n > 0) counts.push(`${table}=${n}`);
        }

        say(`target   ${user}@${host}:${port}/${name}`);
        say(`tables   ${tables.length} (${counts.length ? counts.join(" ") : "all empty"})`);
        say(`rows     ${total}`);

        if (!opts.yes) {
            say("dry run — nothing was deleted. Add --yes to empty these tables.");
            return;
        }

        // One statement: CASCADE settles the foreign keys between lookup and the resource tables
        // regardless of the order they come back in, and RESTART IDENTITY resets any sequence a
        // future table might own.
        const list = tables.map((t) => `"${t.name}"`).join(", ");
        await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);

        say(`emptied ${tables.length} table(s), ${total} row(s) deleted`);
        say("start mobius4 — it recreates the <CSEBase> and the access control policies from config");
    } finally {
        await client.end();
    }
}

module.exports = { parseArgs, OWN_TABLES, main };

if (require.main === module) {
    main(process.argv.slice(2)).catch((err) => {
        console.error(`reset-resources: ${err.message}`);
        process.exit(1);
    });
}
