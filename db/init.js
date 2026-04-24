const { Pool } = require('pg');
const config = require('config');
const moment = require('moment');
const { generate_ri } = require('../cse/utils');
const logger = require('../logger').forFile(__filename);
const timestamp_format = config.get('cse.timestamp_format');
const len = config.get('length');

/**
 * Builds a parameterized INSERT query using the object's keys as columns and values as parameters.
 * @param {string} table - Table name
 * @param {Object} data  - Object in { column: value } format
 * @returns {{ text: string, values: any[] }}
 */
function build_insert(table, data) {
    const keys = Object.keys(data);
    const cols = keys.join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    return {
        text: `INSERT INTO ${table} (${cols}) VALUES (${placeholders})`,
        values: Object.values(data),
    };
}

// Create PostgreSQL connection pool
const pool = new Pool({
    user: config.get('db.user'),
    host: config.get('db.host'),
    database: config.get('db.name'),
    password: config.get('db.pw'),
    port: config.get('db.port'),
});

// Test PostgreSQL connection
async function testConnection() {
    try {
        const client = await pool.connect();
        logger.info('PostgreSQL connected');
        client.release();
        return true;
    } catch (err) {
        logger.fatal({ err }, 'PostgreSQL connection failed');
        return false;
    }
}

// Database initialization
exports.init_db = async function () {
    // Test connection first — throws on failure, caller (mobius4.js) handles process.exit(1)
    const isConnected = await testConnection();
    if (!isConnected) {
        throw new Error('PostgreSQL connection failed');
    }

    // Enable PostGIS extension
    const client = await pool.connect();
    try {
        await client.query('CREATE EXTENSION IF NOT EXISTS postgis;');

        // create resource tables
        await create_tables(client);

        // check if <cb> resource exists
        const cbResult = await client.query('SELECT ri FROM cb WHERE ty = 5');

        let cb_ri = null;
        if (cbResult.rows.length === 0) {
            // create <cb> resource
            cb_ri = await create_cb(client);
        } else {
            cb_ri = cbResult.rows[0].ri;
            logger.info({ ri: cb_ri }, 'cb resource already exists');
        }

        // create default <acp> resource
        if (await create_default_acp(client, cb_ri)) {
            logger.info({ sid: `${config.cse.csebase_rn}/${config.cb.default_acp.rn}` }, 'default acp created');
        } else {
            logger.info('default acp already exists, skipped');
        }
    } finally {
        client.release();
    }
};

// create resource tables
async function create_tables(client) {
    try {
        await client.query('BEGIN');

        // create lookup table
        // <cb> resource does not have 'et'
        await client.query(`
            CREATE TABLE IF NOT EXISTS lookup (
                ri VARCHAR(${len.ri_max}) PRIMARY KEY,
                ty INTEGER NOT NULL,
                rn VARCHAR(${len.str_token}) NOT NULL,
                sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
                lvl INTEGER NOT NULL,
                pi VARCHAR(${len.ri_max}),
                cr VARCHAR(${len.str_token}),
                int_cr VARCHAR(${len.str_token}),
                et VARCHAR(${len.timestamp}) NULL, 
                loc GEOMETRY(GEOMETRY, 4326)
            );
            CREATE INDEX IF NOT EXISTS idx_lookup_loc ON lookup USING GIST (loc);
        `);

        // create cb table
        await client.query(`
            CREATE TABLE IF NOT EXISTS cb (
                ri VARCHAR(${len.ri_max}) PRIMARY KEY,
                ty INTEGER NOT NULL DEFAULT 5,
                sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
                rn VARCHAR(${len.str_token}) NOT NULL,
                pi VARCHAR(${len.ri_max}),
                ct VARCHAR(${len.timestamp}) NOT NULL,
                lt VARCHAR(${len.timestamp}) NOT NULL,
                acpi VARCHAR(${len.structured_res_id})[],
                lbl VARCHAR(${len.str_token})[],
                cst INTEGER NOT NULL,
                csi VARCHAR(${len.str_token}) NOT NULL,
                srt INTEGER[],
                srv VARCHAR(${len.url})[],
                nl VARCHAR(${len.structured_res_id}),
                poa VARCHAR(${len.url})[],
                csz VARCHAR(10)[],
                loc GEOMETRY(GEOMETRY, 4326)
            );
        `);

        // create acp table
        await client.query(`
            CREATE TABLE IF NOT EXISTS acp (
                ri VARCHAR(${len.ri_max}) PRIMARY KEY,
                ty INTEGER NOT NULL DEFAULT 1,
                sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
                cr VARCHAR(${len.str_token}),
                int_cr VARCHAR(${len.str_token}),
                rn VARCHAR(${len.str_token}) NOT NULL,
                pi VARCHAR(${len.ri_max}),
                et VARCHAR(${len.timestamp}) NOT NULL,
                ct VARCHAR(${len.timestamp}) NOT NULL,
                lt VARCHAR(${len.timestamp}) NOT NULL,
                acpi VARCHAR(${len.structured_res_id})[],
                lbl VARCHAR(${len.str_token})[],
                pv JSONB,
                pvs JSONB
            );
        `);

        // create sub table
        await client.query(`
            CREATE TABLE IF NOT EXISTS sub (
                ri VARCHAR(${len.ri_max}) PRIMARY KEY,
                ty INTEGER NOT NULL DEFAULT 23,
                sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
                cr VARCHAR(${len.str_token}),
                int_cr VARCHAR(${len.str_token}),
                rn VARCHAR(${len.str_token}) NOT NULL,
                pi VARCHAR(${len.ri_max}),
                et VARCHAR(${len.timestamp}) NOT NULL,
                ct VARCHAR(${len.timestamp}) NOT NULL,
                lt VARCHAR(${len.timestamp}) NOT NULL,
                acpi VARCHAR(${len.structured_res_id})[],
                lbl VARCHAR(${len.str_token})[],
                enc JSONB,
                exc INTEGER,
                nu VARCHAR(${len.url})[],
                nct INTEGER,
                su VARCHAR(${len.str_token})
            );
        `);

        // create cnt table
        await client.query(`
            CREATE TABLE IF NOT EXISTS cnt (
              ri VARCHAR(${len.ri_max}) PRIMARY KEY,
              ty INTEGER NOT NULL DEFAULT 3,
              sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
              cr VARCHAR(${len.str_token}),
              int_cr VARCHAR(${len.str_token}),
              rn VARCHAR(${len.str_token}) NOT NULL,
              pi VARCHAR(${len.ri_max}),
              et VARCHAR(${len.timestamp}) NOT NULL,
              ct VARCHAR(${len.timestamp}) NOT NULL,
              lt VARCHAR(${len.timestamp}) NOT NULL,
              acpi VARCHAR(${len.structured_res_id})[],
              lbl VARCHAR(${len.str_token})[],
              st INTEGER DEFAULT 0,
              cni INTEGER DEFAULT 0,
              cbs INTEGER DEFAULT 0,
              mni INTEGER,
              mbs INTEGER,
              mia INTEGER,
              loc GEOMETRY(GEOMETRY, 4326)
            );
          `);

        // create cin table
        await client.query(`
            CREATE TABLE IF NOT EXISTS cin (
                ri VARCHAR(${len.ri_max}) PRIMARY KEY,
                ty INTEGER NOT NULL DEFAULT 4,
                rn VARCHAR(${len.str_token}) NOT NULL,
                pi VARCHAR(${len.ri_max}),
                sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
                et VARCHAR(${len.timestamp}),
                ct VARCHAR(${len.timestamp}),
                lt VARCHAR(${len.timestamp}),
                acpi VARCHAR(${len.structured_res_id})[],
                lbl VARCHAR(${len.str_token})[],
                st INTEGER,
                cr VARCHAR(${len.str_token}),
                loc GEOMETRY(GEOMETRY, 4326),
                cnf VARCHAR(255),
                cs INTEGER,
                con JSONB
            );
        `);

        // create grp table
        await client.query(`
            CREATE TABLE IF NOT EXISTS grp (
              ri VARCHAR(${len.ri_max}) PRIMARY KEY,
              ty INTEGER NOT NULL DEFAULT 9,
              sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
              cr VARCHAR(${len.str_token}),
              int_cr VARCHAR(${len.str_token}),
              rn VARCHAR(${len.str_token}) NOT NULL,
              pi VARCHAR(${len.ri_max}),
              et VARCHAR(${len.timestamp}),
              ct VARCHAR(${len.timestamp}),
              lt VARCHAR(${len.timestamp}),
              acpi VARCHAR(${len.structured_res_id})[],
              lbl VARCHAR(${len.str_token})[],
              mt INTEGER DEFAULT 0,
              mtv BOOLEAN DEFAULT NULL,
              cnm INTEGER DEFAULT 0,
              mnm INTEGER,
              csy INTEGER DEFAULT 1,
              mid VARCHAR(${len.structured_res_id})[],
              macp VARCHAR(${len.structured_res_id})[],
              gn VARCHAR(${len.str_token})
            );
        `);

        // create mrp table
        await client.query(`
            CREATE TABLE IF NOT EXISTS mrp (
              ri VARCHAR(${len.ri_max}) PRIMARY KEY,
              ty INTEGER NOT NULL DEFAULT 101,
              sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
              cr VARCHAR(${len.str_token}),
              int_cr VARCHAR(${len.str_token}),
              rn VARCHAR(${len.str_token}) NOT NULL,
              pi VARCHAR(${len.ri_max}),
              et VARCHAR(${len.timestamp}),
              ct VARCHAR(${len.timestamp}),
              lt VARCHAR(${len.timestamp}),
              acpi VARCHAR(${len.structured_res_id})[],
              lbl VARCHAR(${len.str_token})[],
              cnmo INTEGER DEFAULT 0,
              cbmo INTEGER DEFAULT 0,
              mnmo INTEGER,
              mbmo INTEGER,
              mid VARCHAR(${len.structured_res_id})[]
            );
        `);

        // create mmd table
        await client.query(`
            CREATE TABLE IF NOT EXISTS mmd (
              ri VARCHAR(${len.ri_max}) PRIMARY KEY,
              ty INTEGER NOT NULL DEFAULT 107,
              sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
              cr VARCHAR(${len.str_token}),
              int_cr VARCHAR(${len.str_token}),
              rn VARCHAR(${len.str_token}) NOT NULL,
              pi VARCHAR(${len.ri_max}),
              et VARCHAR(${len.timestamp}),
              ct VARCHAR(${len.timestamp}),
              lt VARCHAR(${len.timestamp}),
              acpi VARCHAR(${len.structured_res_id})[],
              lbl VARCHAR(${len.str_token})[],
              nm VARCHAR(${len.str_token}),
              vr VARCHAR(${len.str_token}),
              plf VARCHAR(${len.str_token}),
              mlt VARCHAR(${len.str_token}),
              dc TEXT,
              ips TEXT,
              ous TEXT,
              mmd TEXT,
              mms INTEGER DEFAULT 0,
              mmu VARCHAR(${len.url})
            );
        `);

        // create mdp table
        await client.query(`
            CREATE TABLE IF NOT EXISTS mdp (
              ri VARCHAR(${len.ri_max}) PRIMARY KEY,
              ty INTEGER NOT NULL DEFAULT 103,
              sid VARCHAR(255) NOT NULL UNIQUE,
              int_cr VARCHAR(255),
              rn VARCHAR(255) NOT NULL,
              pi VARCHAR(${len.ri_max}),
              et VARCHAR(20),
              ct VARCHAR(20),
              lt VARCHAR(20),
              acpi VARCHAR(255)[],
              lbl VARCHAR(255)[],
              cr VARCHAR(255),
              ndm INTEGER DEFAULT 0,
              nrm INTEGER DEFAULT 0,
              nsm INTEGER DEFAULT 0,
              dpm_list VARCHAR(255)[]
            );
        `);

        // create dpm table
        await client.query(`
            CREATE TABLE IF NOT EXISTS dpm (
              ri VARCHAR(${len.ri_max}) PRIMARY KEY,
              ty INTEGER NOT NULL DEFAULT 104,
              sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
              cr VARCHAR(${len.str_token}),
              int_cr VARCHAR(${len.str_token}),
              rn VARCHAR(${len.str_token}) NOT NULL,
              pi VARCHAR(${len.ri_max}),
              et VARCHAR(${len.timestamp}),
              ct VARCHAR(${len.timestamp}),
              lt VARCHAR(${len.timestamp}),
              acpi VARCHAR(${len.structured_res_id})[],
              lbl VARCHAR(${len.str_token})[],
              moid VARCHAR(${len.structured_res_id}),
              mcmd INTEGER DEFAULT 0,
              mds INTEGER DEFAULT 0,
              inr VARCHAR(${len.structured_res_id}),
              our VARCHAR(${len.structured_res_id})
            );
        `);

        // create dsp table
        await client.query(`
            CREATE TABLE IF NOT EXISTS dsp (
              ri VARCHAR(${len.ri_max}) PRIMARY KEY,
              ty INTEGER NOT NULL DEFAULT 105,
              sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
              cr VARCHAR(${len.str_token}),
              int_cr VARCHAR(${len.str_token}),
              rn VARCHAR(${len.str_token}) NOT NULL,
              pi VARCHAR(${len.ri_max}),
              et VARCHAR(${len.timestamp}),
              ct VARCHAR(${len.timestamp}),
              lt VARCHAR(${len.timestamp}),
              acpi VARCHAR(${len.structured_res_id})[],
              lbl VARCHAR(${len.str_token})[],
              sri VARCHAR(${len.structured_res_id})[] NOT NULL,
              dst VARCHAR(${len.timestamp}),
              det VARCHAR(${len.timestamp}),
              tcst VARCHAR(${len.timestamp}),
              tcd INTEGER,
              nvp INTEGER,
              dsfm INTEGER NOT NULL,
              hdi VARCHAR(${len.structured_res_id}),
              ldi VARCHAR(${len.structured_res_id}),
              nrhd INTEGER,
              nrld INTEGER
            );
        `);

        // create dts table
        await client.query(`
            CREATE TABLE IF NOT EXISTS dts (
              ri VARCHAR(${len.ri_max}) PRIMARY KEY,
              ty INTEGER NOT NULL DEFAULT 106,
              sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
              cr VARCHAR(${len.str_token}),
              int_cr VARCHAR(${len.str_token}),
              rn VARCHAR(${len.str_token}) NOT NULL,
              pi VARCHAR(${len.ri_max}),
              et VARCHAR(${len.timestamp}),
              ct VARCHAR(${len.timestamp}),
              lt VARCHAR(${len.timestamp}),
              acpi VARCHAR(${len.structured_res_id})[],
              lbl VARCHAR(${len.str_token})[],
              dspi VARCHAR(${len.structured_res_id}),
              lof VARCHAR(${len.str_token})[],
              dsf_list VARCHAR(${len.structured_res_id})[]
            );
        `);

        // create dsf table
        await client.query(`
            CREATE TABLE IF NOT EXISTS dsf (
              ri VARCHAR(${len.ri_max}) PRIMARY KEY,
              ty INTEGER NOT NULL DEFAULT 107,
              sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
              int_cr VARCHAR(${len.str_token}),
              rn VARCHAR(${len.str_token}) NOT NULL,
              pi VARCHAR(${len.ri_max}),
              et VARCHAR(${len.timestamp}),
              ct VARCHAR(${len.timestamp}),
              lt VARCHAR(${len.timestamp}),
              acpi VARCHAR(${len.structured_res_id})[],
              lbl VARCHAR(${len.str_token})[],
              cr VARCHAR(${len.str_token}),
              dfst VARCHAR(${len.timestamp}),
              dfet VARCHAR(${len.timestamp}),
              nrf INTEGER,
              dsfr JSONB,
              dsfm INTEGER
            );
        `);

        // create ae table
        await client.query(`
            CREATE TABLE IF NOT EXISTS ae (
                ri VARCHAR(${len.ri_max}) PRIMARY KEY,
                ty INTEGER NOT NULL DEFAULT 2,
                sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
                cr VARCHAR(${len.str_token}),
                int_cr VARCHAR(${len.str_token}),
                rn VARCHAR(${len.str_token}) NOT NULL,
                pi VARCHAR(${len.ri}),
                et VARCHAR(${len.timestamp}),
                ct VARCHAR(${len.timestamp}),
                lt VARCHAR(${len.timestamp}),
                acpi VARCHAR(${len.structured_res_id})[],
                lbl VARCHAR(${len.str_token})[],
                api VARCHAR(${len.structured_res_id}),
                apn VARCHAR(${len.str_token}),
                aei VARCHAR(${len.entity_id}),
                poa VARCHAR(${len.url})[],
                rr BOOLEAN NOT NULL,
                srv VARCHAR(10)[],
                csz VARCHAR(10)[],
                loc GEOMETRY(GEOMETRY, 4326)
            );
        `);

        // create csr table
        await client.query(`
            CREATE TABLE IF NOT EXISTS csr (
                ri VARCHAR(${len.ri_max}) PRIMARY KEY,
                ty INTEGER NOT NULL DEFAULT 16,
                sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
                cr VARCHAR(${len.str_token}),
                int_cr VARCHAR(${len.str_token}),
                rn VARCHAR(${len.str_token}) NOT NULL,
                pi VARCHAR(${len.ri_max}),
                et VARCHAR(${len.timestamp}),
                ct VARCHAR(${len.timestamp}),
                lt VARCHAR(${len.timestamp}),
                acpi VARCHAR(${len.structured_res_id})[],
                lbl VARCHAR(${len.str_token})[],
                cst INTEGER,
                poa VARCHAR(${len.url})[],
                nl VARCHAR(${len.structured_res_id}),
                cb VARCHAR(${len.structured_res_id}),
                csi VARCHAR(${len.entity_id}),
                rr BOOLEAN NOT NULL,
                csz VARCHAR(10)[],
                srv VARCHAR(10)[],
                loc GEOMETRY(GEOMETRY, 4326)
            );
        `);

        // --- Performance indexes ---
        // lookup: pi for child-resource queries, et for expiry cleanup, (pi,ty) for typed child lookups
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_lookup_pi    ON lookup (pi);
            CREATE INDEX IF NOT EXISTS idx_lookup_et    ON lookup (et);
            CREATE INDEX IF NOT EXISTS idx_lookup_pi_ty ON lookup (pi, ty);
        `);

        // sub: pi is queried on every CRUD operation to find subscriptions
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_sub_pi ON sub (pi);
        `);

        // cnt: pi for child-resource queries
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_cnt_pi ON cnt (pi);
        `);

        // cin: pi for child-resource queries, ct for oldest-CIN lookup (mni/mbs eviction)
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_cin_pi ON cin (pi);
            CREATE INDEX IF NOT EXISTS idx_cin_ct ON cin (ct);
        `);

        // ae: pi for child-resource queries
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_ae_pi ON ae (pi);
        `);

        await client.query('COMMIT');
        logger.info('resource tables and indexes created');
    } catch (err) {
        await client.query('ROLLBACK');
        logger.error({ err }, 'create tables failed');
        throw err;
    }
}

// create <cb> resource
async function create_cb(client) {
    const ri = generate_ri();
    const now = moment().utc().format(timestamp_format);

    const cb_res = {
        ri,
        ty: 5,
        sid: config.cse.csebase_rn,
        lvl: 1,
        rn: config.cse.csebase_rn,
        pi: '',
        ct: now,
        lt: now,
        acpi: [`${config.cse.csebase_rn}/${config.cb.default_acp.rn}`],
        lbl: ['Mobius4'],
        cst: config.cse.cse_type,
        csi: config.cse.cse_id,
        srt: config.cse.supported_resource_types,
        srv: config.cse.versions,
        nl: 'Mobius/nl', // this resource does not exist
        poa: config.cse.poa,
        csz: config.cse.serializations
    };

    try {
        await client.query('BEGIN');

        // insert data into cb table
        await client.query(build_insert('cb', {
            ri:   cb_res.ri,
            ty:   cb_res.ty,
            sid:  cb_res.sid,
            rn:   cb_res.rn,
            pi:   cb_res.pi,
            ct:   cb_res.ct,
            lt:   cb_res.lt,
            acpi: cb_res.acpi,
            lbl:  cb_res.lbl,
            cst:  cb_res.cst,
            csi:  cb_res.csi,
            srt:  cb_res.srt,
            srv:  cb_res.srv,
            nl:   cb_res.nl,
            poa:  cb_res.poa,
            csz:  cb_res.csz,
        }));

        // insert data into lookup table
        await client.query(build_insert('lookup', {
            ri:     cb_res.ri,
            ty:     cb_res.ty,
            rn:     cb_res.rn,
            sid:    cb_res.sid,
            lvl:    cb_res.lvl,
            pi:     cb_res.pi,
            cr:     config.cse.admin,
            int_cr: config.cse.admin,
            et:     null,
        }));

        await client.query('COMMIT');
        logger.info({ ri: cb_res.ri }, 'cb resource created');
        return cb_res.ri;
    } catch (err) {
        await client.query('ROLLBACK');
        logger.error({ err }, 'create cb resource failed');
        throw err;
    }
}

// create default <acp> resource
async function create_default_acp(client, cb_ri) {
    const ri = generate_ri();
    const now = moment().utc().format(timestamp_format);
    const et = moment().utc().add(config.default.common.et_month, 'month').format(timestamp_format);

    const acp_res = {
        ri,
        ty: 1,
        sid: `${config.cse.csebase_rn}/${config.cb.default_acp.rn}`,
        lvl: 2, // level of this 'sid' is 2
        rn: config.cb.default_acp.rn,
        pi: cb_ri,
        et,
        ct: now,
        lt: now,
        int_cr: config.cse.cse_id,
        pv: {
            acr: [{
                acor: ['all'],
                acop: config.cb.default_acp.create + config.cb.default_acp.retrieve * 2 + 
                      config.cb.default_acp.update * 4 + config.cb.default_acp.discovery * 32
            }]
        },
        pvs: {
            acr: [{
                acor: [config.cse.admin],
                acop: 63
            }]
        }
    };

    try {
        await client.query('BEGIN');

        // insert data into acp table
        await client.query(build_insert('acp', {
            ri:  acp_res.ri,
            ty:  acp_res.ty,
            sid: acp_res.sid,
            rn:  acp_res.rn,
            pi:  acp_res.pi,
            et:  acp_res.et,
            ct:  acp_res.ct,
            lt:  acp_res.lt,
            cr:  acp_res.cr,
            pv:  JSON.stringify(acp_res.pv),
            pvs: JSON.stringify(acp_res.pvs),
        }));

        // insert data into lookup table
        await client.query(build_insert('lookup', {
            ri:     acp_res.ri,
            ty:     acp_res.ty,
            rn:     acp_res.rn,
            sid:    acp_res.sid,
            lvl:    acp_res.lvl,
            pi:     acp_res.pi,
            cr:     config.cse.admin,
            int_cr: config.cse.admin,
            et:     et,
        }));

        // update acpi of <cb> resource
        await client.query(`
            UPDATE cb 
            SET acpi = array_append(acpi, $1)
            WHERE ri = $2
        `, [`${config.cse.csebase_rn}/${config.cb.default_acp.rn}`, cb_ri]);

        await client.query('COMMIT');
        return true;
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code !== '23505') {
            logger.error({ err }, 'create default acp failed');
        }
        return false;
    }
}