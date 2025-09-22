const { Pool } = require('pg');
const config = require('config');
const moment = require('moment');
const { generate_ri } = require('../cse/utils');
const timestamp_format = config.get('cse.timestamp_format');
const len = config.get('length');

// PostgreSQL 연결 풀 생성
const pool = new Pool({
    user: config.get('db.user'),
    host: config.get('db.host'),
    database: config.get('db.name'),
    password: config.get('db.pw'),
    port: config.get('db.port'),
});

// PostgreSQL 연결 테스트
async function testConnection() {
    try {
        const client = await pool.connect();
        console.log('Successfully connected to PostgreSQL');
        client.release();
        return true;
    } catch (err) {
        console.error('Error connecting to PostgreSQL:', err);
        return false;
    }
}

// DB 초기화 함수
exports.init_db = async function () {
    try {
        // 먼저 연결 테스트
        const isConnected = await testConnection();
        if (!isConnected) {
            throw new Error('Failed to connect to PostgreSQL');
        }

        // PostGIS 확장 활성화
        const client = await pool.connect();
        try {
            await client.query('CREATE EXTENSION IF NOT EXISTS postgis;');
            
            // create resource tables
            await create_tables(client);
            
            // check if <cb> resource exists
            const cbResult = await client.query('SELECT ri FROM cb WHERE ty = 5');
            
            if (cbResult.rows.length === 0) {
                // create <cb> resource
                const cb_ri = await create_cb(client);
                
                // create default <acp> resource
                if (await create_default_acp(client, cb_ri)) {
                    console.log(`default <acp> resource is created as ${config.cse.csebase_rn}/${config.cb.default_acp.rn} and acpi of <cb> resource updated`);
                } else {
                    console.log('default <acp> resource creation failed');
                }
            } else {
                console.log('\n<cb> resource already exists with ri:', cbResult.rows[0].ri);
            }
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('Error in init_db:', err);
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
                ri VARCHAR(${len.ri}) PRIMARY KEY,
                ty INTEGER NOT NULL,
                rn VARCHAR(${len.str_token}) NOT NULL,
                sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
                lvl INTEGER NOT NULL,
                pi VARCHAR(${len.ri}),
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
                ri VARCHAR(${len.ri}) PRIMARY KEY,
                ty INTEGER NOT NULL DEFAULT 5,
                sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
                rn VARCHAR(${len.str_token}) NOT NULL,
                pi VARCHAR(${len.ri}),
                ct VARCHAR(${len.timestamp}) NOT NULL,
                lt VARCHAR(${len.timestamp}) NOT NULL,
                acpi VARCHAR(${len.structured_res_id})[],
                lbl VARCHAR(${len.str_token})[],
                cst INTEGER NOT NULL,
                csi VARCHAR(${len.str_token}) NOT NULL,
                srt INTEGER[],
                poa VARCHAR(${len.url})[],
                csz VARCHAR(10)[],
                loc GEOMETRY(GEOMETRY, 4326)
            );
        `);

        // create acp table
        await client.query(`
            CREATE TABLE IF NOT EXISTS acp (
                ri VARCHAR(${len.ri}) PRIMARY KEY,
                ty INTEGER NOT NULL DEFAULT 1,
                sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
                cr VARCHAR(${len.str_token}),
                int_cr VARCHAR(${len.str_token}),
                rn VARCHAR(${len.str_token}) NOT NULL,
                pi VARCHAR(${len.ri}),
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
                ri VARCHAR(${len.ri}) PRIMARY KEY,
                ty INTEGER NOT NULL DEFAULT 23,
                sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
                cr VARCHAR(${len.str_token}),
                int_cr VARCHAR(${len.str_token}),
                rn VARCHAR(${len.str_token}) NOT NULL,
                pi VARCHAR(${len.ri}),
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
              ri VARCHAR(${len.ri}) PRIMARY KEY,
              ty INTEGER NOT NULL DEFAULT 3,
              sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
              cr VARCHAR(${len.str_token}),
              int_cr VARCHAR(${len.str_token}),
              rn VARCHAR(${len.str_token}) NOT NULL,
              pi VARCHAR(${len.ri}),
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
              cin_list VARCHAR(${len.structured_res_id})[],
              loc GEOMETRY(GEOMETRY, 4326)
            );
          `);

        // create cin table
        await client.query(`
            CREATE TABLE IF NOT EXISTS cin (
                ri VARCHAR(${len.ri}) PRIMARY KEY,
                ty INTEGER NOT NULL DEFAULT 4,
                rn VARCHAR(${len.str_token}) NOT NULL,
                pi VARCHAR(${len.ri}),
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
              ri VARCHAR(${len.ri}) PRIMARY KEY,
              ty INTEGER NOT NULL DEFAULT 9,
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
              mt INTEGER DEFAULT 0,
              cnm INTEGER DEFAULT 0,
              mnm INTEGER,
              csy INTEGER DEFAULT 1,
              mid VARCHAR(${len.structured_res_id})[],
              gn VARCHAR(${len.str_token})
            );
        `);

        // create mrp table
        await client.query(`
            CREATE TABLE IF NOT EXISTS mrp (
              ri VARCHAR(${len.ri}) PRIMARY KEY,
              ty INTEGER NOT NULL DEFAULT 101,
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
              ri VARCHAR(${len.ri}) PRIMARY KEY,
              ty INTEGER NOT NULL DEFAULT 107,
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
              ri VARCHAR(24) PRIMARY KEY,
              ty INTEGER NOT NULL DEFAULT 103,
              sid VARCHAR(255) NOT NULL UNIQUE,
              int_cr VARCHAR(255),
              rn VARCHAR(255) NOT NULL,
              pi VARCHAR(255),
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
              ri VARCHAR(${len.ri}) PRIMARY KEY,
              ty INTEGER NOT NULL DEFAULT 104,
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
              ri VARCHAR(${len.ri}) PRIMARY KEY,
              ty INTEGER NOT NULL DEFAULT 105,
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
              ri VARCHAR(${len.ri}) PRIMARY KEY,
              ty INTEGER NOT NULL DEFAULT 106,
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
              dspi VARCHAR(${len.structured_res_id}),
              lof VARCHAR(${len.str_token})[],
              dsf_list VARCHAR(${len.structured_res_id})[]
            );
        `);

        // create dsf table
        await client.query(`
            CREATE TABLE IF NOT EXISTS dsf (
              ri VARCHAR(${len.ri}) PRIMARY KEY,
              ty INTEGER NOT NULL DEFAULT 107,
              sid VARCHAR(${len.structured_res_id}) NOT NULL UNIQUE,
              int_cr VARCHAR(${len.str_token}),
              rn VARCHAR(${len.str_token}) NOT NULL,
              pi VARCHAR(${len.ri}),
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
                ri VARCHAR(${len.ri}) PRIMARY KEY,
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
                ri VARCHAR(${len.ri}) PRIMARY KEY,
                ty INTEGER NOT NULL DEFAULT 16,
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

        await client.query('COMMIT');
        console.log('resource tables created successfully');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error creating tables:', err);
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
        acpi: [],
        lbl: ['Mobius4'],
        cst: config.cse.cse_type,
        csi: config.cse.cse_id,
        srt: [1, 2, 3, 4, 5, 9, 23, 28],
        poa: config.cse.supported_resource_types,
        csz: config.cse.serializations
    };

    try {
        await client.query('BEGIN');

        // insert data into cb table
        await client.query(`
            INSERT INTO cb (ri, ty, sid, rn, pi, ct, lt, acpi, lbl, cst, csi, srt, poa, csz)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        `, [
            cb_res.ri, cb_res.ty, cb_res.sid, cb_res.rn, cb_res.pi,
            cb_res.ct, cb_res.lt, cb_res.acpi, cb_res.lbl, cb_res.cst,
            cb_res.csi, cb_res.srt, cb_res.poa, cb_res.csz
        ]);

        // insert data into lookup table
        await client.query(`
            INSERT INTO lookup (ri, ty, rn, sid, lvl, pi, cr, int_cr, et)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
            cb_res.ri, cb_res.ty, cb_res.rn, cb_res.sid, cb_res.lvl, cb_res.pi,
            config.cse.admin, config.cse.admin, null
        ]);

        await client.query('COMMIT');
        console.log(`\n<cb> resource is created with ri: ${cb_res.ri}`);
        return cb_res.ri;
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error creating CB resource:', err);
        throw err;
    }
}

// create default <acp> resource
async function create_default_acp(client, cb_ri) {
    const ri = generate_ri();
    const now = moment().utc().format(timestamp_format);
    const et = moment().utc().add(config.resource.et_dur_year, 'year').format(timestamp_format);

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
        await client.query(`
            INSERT INTO acp (ri, ty, sid, rn, pi, et, ct, lt, cr, pv, pvs)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `, [
            acp_res.ri, acp_res.ty, acp_res.sid, acp_res.rn, acp_res.pi,
            acp_res.et, acp_res.ct, acp_res.lt, acp_res.cr,
            JSON.stringify(acp_res.pv), JSON.stringify(acp_res.pvs)
        ]);

        // insert data into lookup table
        await client.query(`
            INSERT INTO lookup (ri, ty, rn, sid, lvl, pi, cr, int_cr, et)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
            acp_res.ri, acp_res.ty, acp_res.rn, acp_res.sid, acp_res.lvl, acp_res.pi,
            config.cse.admin, config.cse.admin, et
        ]);

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
        console.error('Error creating default ACP:', err);
        return false;
    }
}