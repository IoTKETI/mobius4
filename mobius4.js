// mobius 4 version number: 0.1.0

// load environment variables from .env
require('dotenv').config();

const logger = require('./logger');
const db = require('./db/init');
const mqtt = require('./bindings/mqtt');

const config = require('config');

async function main() {
    logger.info('mobius4 starting up');

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
    mqtt.init_client();

    // start CSE registration if this is MN-CSE or ASN-CSE
    if (config.cse.cse_type === 2 || config.cse.cse_type === 3) {
        const { registree } = require('./cse/registree');
        registree();
    }

    // start expired resource cleanup
    const { expired_resource_cleanup } = require('./cse/hostingCSE');
    const cleanupIntervalMs = config.cse.expired_resource_cleanup_interval_days * 24 * 60 * 60 * 1000;
    setInterval(expired_resource_cleanup, cleanupIntervalMs);
    logger.info({ intervalDays: config.cse.expired_resource_cleanup_interval_days }, 'expired resource cleanup scheduled');
}

main();

// graceful shutdown
async function shutdown(signal) {
    logger.info({ signal }, 'shutdown initiated');

    const timeout = setTimeout(() => {
        logger.fatal('forced shutdown after timeout');
        process.exit(1);
    }, 30000);

    try {
        const { server, https_server } = require('./bindings/http');
        await new Promise((resolve) => server.close(resolve));
        await new Promise((resolve) => https_server.close(resolve));
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
