const { Pool } = require('pg');
const config = require('config');

// Create PostgreSQL connection pool
const pool = new Pool({
    user: config.get('db.user'),
    host: config.get('db.host'),
    database: config.get('db.name'),
    password: config.get('db.pw'),
    port: config.get('db.port'),
    max: config.get('db.pool.max'),
    idleTimeoutMillis: config.get('db.pool.idleTimeoutMs'),
    connectionTimeoutMillis: config.get('db.pool.connectionTimeoutMs'),
    statement_timeout: config.get('db.pool.statementTimeoutMs'),
});

module.exports = pool;