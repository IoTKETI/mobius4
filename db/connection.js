const { Pool } = require('pg');
const config = require('config');

// PostgreSQL 연결 풀 생성
const pool = new Pool({
    user: config.get('db.user'),
    host: config.get('db.host'),
    database: config.get('db.name'),
    password: config.get('db.pw'),
    port: config.get('db.port'),
});

module.exports = pool;