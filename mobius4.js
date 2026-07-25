// mobius 4 — 버전의 정본은 package.json이다. 여기 하드코딩하면 갈라진다(오래도록
// 0.1.0으로 남아 package.json의 4.x와 어긋나 있었다).

// load environment variables from .env
require('dotenv').config();

const logger = require('./logger');
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

    // start expired resource cleanup
    const { expired_resource_cleanup } = require('./cse/hostingCSE');
    const cleanupIntervalMs = config.cse.expired_resource_cleanup_interval_days * 24 * 60 * 60 * 1000;
    cleanupIntervalId = setInterval(expired_resource_cleanup, cleanupIntervalMs);
    logger.info({ intervalDays: config.cse.expired_resource_cleanup_interval_days }, 'expired resource cleanup scheduled');
}

main().then(() => {
    if (process.send) process.send('ready'); // PM2 wait_ready 연동
});

// graceful shutdown
async function shutdown(signal) {
    logger.info({ signal }, 'shutdown initiated');

    const timeout = setTimeout(() => {
        logger.fatal('forced shutdown after timeout');
        process.exit(1);
    }, 30000);

    try {
        // 1. 인터벌 정지 (새 작업 스케줄링 차단)
        if (cleanupIntervalId) clearInterval(cleanupIntervalId);
        require('./cse/datasetManager').shutdown();

        // 2. HTTP 서버 종료 — 새 연결 차단 + keep-alive 커넥션 즉시 해제
        const { server, https_server } = require('./bindings/http');
        await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
        await new Promise((resolve) => { https_server.close(resolve); https_server.closeAllConnections(); });

        // 3. MQTT 연결 해제
        await mqtt.disconnect();

        // 4. DB 커넥션 종료
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
