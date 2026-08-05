const { Pool } = require('pg');
const config = require('config');
const { perPoolMax } = require('./pool-size');

// Create PostgreSQL connection pool
const pool = new Pool({
    user: config.get('db.user'),
    host: config.get('db.host'),
    database: config.get('db.name'),
    password: config.get('db.pw'),
    port: config.get('db.port'),
    // Half of db.pool.max — see db/pool-size.js. This process also runs a Sequelize pool.
    max: perPoolMax(),
    idleTimeoutMillis: config.get('db.pool.idleTimeoutMs'),
    connectionTimeoutMillis: config.get('db.pool.connectionTimeoutMs'),
    statement_timeout: config.get('db.pool.statementTimeoutMs'),
});

module.exports = pool;