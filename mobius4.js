// mobius 4 — package.json is the single source of truth for the version. Hardcoding it
// here makes the two diverge (it sat at 0.1.0 long after package.json had moved to 4.x).

// load environment variables from .env
require('dotenv').config();

const logger = require('./logger');

// Before anything else. A deployment whose admin identity is missing or is one mobius4 once
// shipped has no effective access control, and that must stop the process rather than surface
// as a rejected request later.
require('./config/validate').validate_config(logger);

const db = require('./db/init');
const mqtt = require('./bindings/mqtt');

const config = require('config');

let cleanupIntervalId;

async function main() {
    const { version } = require('./package.json');
    logger.info({ version }, 'mobius4 starting up');

    // db connect
    try {
        await db.init_db();
    } catch (err) {
        logger.fatal({ err }, 'database initialization failed, shutting down');
        process.exit(1);
    }

    // start http server
    require('./bindings/http');

    // start mqtt client
    await mqtt.init_client();

    // start CSE registration if this is MN-CSE or ASN-CSE
    if (config.cse.cse_type === 2 || config.cse.cse_type === 3) {
        const { registree } = require('./cse/registree');
        registree();
    }

    // start expired resource cleanup — on one instance only, since the sweep is global and
    // running it in every process would repeat the same deletes (see cse/singleton-role.js)
    const { isSingletonInstance } = require('./cse/singleton-role');
    if (isSingletonInstance()) {
        const { expired_resource_cleanup } = require('./cse/hostingCSE');
        const cleanupIntervalMs = config.cse.expired_resource_cleanup_interval_days * 24 * 60 * 60 * 1000;
        cleanupIntervalId = setInterval(expired_resource_cleanup, cleanupIntervalMs);
        logger.info({ intervalDays: config.cse.expired_resource_cleanup_interval_days }, 'expired resource cleanup scheduled');
    } else {
        logger.info({ instance: process.env.NODE_APP_INSTANCE }, 'expired resource cleanup runs on instance 0; skipped here');
    }
}

main().then(() => {
    if (process.send) process.send('ready'); // ties into PM2 wait_ready
});

// graceful shutdown
async function shutdown(signal) {
    logger.info({ signal }, 'shutdown initiated');

    const timeout = setTimeout(() => {
        logger.fatal('forced shutdown after timeout');
        process.exit(1);
    }, 30000);

    try {
        // 1. Stop the intervals (blocks any new work from being scheduled)
        if (cleanupIntervalId) clearInterval(cleanupIntervalId);
        require('./cse/datasetManager').shutdown();

        // 2. Close the HTTP servers — refuse new connections + drop keep-alive connections at once
        const { server, https_server } = require('./bindings/http');
        await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
        // https_server is undefined when https.enabled is false, which is the default.
        if (https_server) {
            await new Promise((resolve) => { https_server.close(resolve); https_server.closeAllConnections(); });
        }

        // 3. Disconnect MQTT — the inbound client, and any broker opened for outbound
        //    notifications or forwarding (bindings/mqtt-outbound.js).
        await mqtt.disconnect();
        await require('./bindings/mqtt-outbound').disconnect_all();

        // 4. Close the DB connections
        const sequelize = require('./db/sequelize');
        await sequelize.close();
        const pool = require('./db/connection');
        await pool.end();

        clearTimeout(timeout);
        logger.info('shutdown complete');
        process.exit(0);
    } catch (err) {
        logger.error({ err }, 'error during shutdown');
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
