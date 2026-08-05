const config = require('config');

// How many PostgreSQL connections one mobius4 process may open.
//
// There are two pools — Sequelize's, used by the models, and the raw pg pool in
// db/connection.js, used by the hand-written SQL. Both used to read db.pool.max and apply it
// as their own limit, so the setting meant twice what it says: max: 30 opened up to 60
// connections, and a process under load was measured holding 53.
//
// That matters beyond tidiness. PostgreSQL's default max_connections is 100, so a second
// mobius4 instance already exceeds it — raising db.pool.max to 60 produced "too many clients"
// and failed a fifth of requests in measurement. Any capacity planning for running more than
// one instance has to start from a number that means what it says.
//
// db.pool.max is therefore the process-wide total, split evenly here. The floor of 2 per pool
// matches Sequelize's min and keeps a very small setting from starving either side.
//
// The size itself is not critical: at concurrency 100, 10 connections per pool reached 3,069
// requests per second against 3,139 for 30 — a 2% difference for three times the connections.
// It is set low on purpose so that instance count, not connection count, is what a deployment
// has to think about.
function perPoolMax() {
    const total = config.get('db.pool.max');
    return Math.max(2, Math.floor(total / 2));
}

module.exports = { perPoolMax };
