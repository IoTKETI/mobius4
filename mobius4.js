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
let missingDataIntervalId;

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

        // Sweep once now as well. setInterval alone fires first only after a full interval, so a
        // deployment restarted more often than the interval — `restart: unless-stopped` plus any
        // redeploy cadence under a day — never swept at all, and "cleanup runs daily" was not a
        // true statement about it. Deliberately not awaited: readiness must not wait on a sweep
        // whose size is a property of the data, and the first sweep after an upgrade from a
        // version that never swept can be large.
        //
        // BACKLOG-098: 'startup-sweep-done' is sent once this (unawaited) sweep finishes, purely
        // so test/expiry.test.js can wait for it before creating fixtures that must survive
        // "until the sweep runs" — otherwise that test races this same sweep and fails roughly
        // one run in three (measured). This does not change when 'ready' fires above; production
        // startup is unaffected.
        expired_resource_cleanup()
            .catch((err) => logger.error({ err }, 'startup expired resource cleanup failed'))
            .finally(() => { if (process.send) process.send('startup-sweep-done'); });

        // Missing-data detection for <timeSeries> (TS-0001:10.2.4.29). Same singleton gate as the
        // cleanup above and for the same reason: the sweep is global, so running it in every
        // process would do the work N times and have N writers contend for the same rows.
        //
        // The interval is the upper bound on how late a detection can be, so it is much shorter
        // than the cleanup's — which is measured in days.
        // The sweep schedules itself from the data rather than running on a fixed cadence.
        //
        // TS-0001:10.2.4.29 puts a missing data point's detection at "expected dataGenerationTime +
        // missingDataDetectTimer". A fixed interval makes that late by up to a whole interval,
        // which the shipped 30 seconds turns into a real defect once periodicInterval is measured
        // in seconds: a <timeSeries> with pei 5000 and mdt 1000 has a genuine gap at six seconds
        // and still reports missingDataCurrentNr 0 at twenty. Measured, on the shipped
        // configuration, before this changed.
        //
        // Each pass reports the earliest instant any candidate could next have something to detect,
        // and the next pass is booked for then. One timer, not one per <timeSeries>: per-resource
        // timers would have to be created, cancelled and re-created on every create, update,
        // delete and expiry, survive restarts, and respect the singleton rule below -- the same
        // answer for much more state. And one timer on a short fixed tick would pay for every
        // resource on every tick (each candidate costs a children query and a save) whether or not
        // anything was due.
        //
        // The delay is clamped at both ends. Never below MIN_SWEEP_DELAY_MS, so a pei of a few
        // milliseconds cannot spin. Never above the configured interval, so a <timeSeries> created
        // or edited while the timer sleeps is picked up without anything having to wake it.
        const MIN_SWEEP_DELAY_MS = 250;
        const sweepIntervalMs = config.cse.missing_data_sweep_interval_seconds * 1000;
        const { sweep_missing_data } = require('./cse/missing-data');

        const scheduleMissingDataSweep = (delayMs) => {
            missingDataIntervalId = setTimeout(async () => {
                let nextMs = sweepIntervalMs;
                try {
                    const result = await sweep_missing_data();
                    if (result && result.next_due_s !== null && result.next_due_s !== undefined) {
                        nextMs = result.next_due_s * 1000 - Date.now();
                    }
                } catch (err) {
                    logger.error({ err }, 'missing-data sweep failed');
                }
                scheduleMissingDataSweep(Math.min(sweepIntervalMs, Math.max(MIN_SWEEP_DELAY_MS, nextMs)));
            }, delayMs);
        };
        scheduleMissingDataSweep(MIN_SWEEP_DELAY_MS);
        logger.info({ maxIntervalSeconds: config.cse.missing_data_sweep_interval_seconds, minDelayMs: MIN_SWEEP_DELAY_MS },
            'missing data sweep scheduled (self-pacing, bounded by the configured interval)');
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
        if (missingDataIntervalId) clearTimeout(missingDataIntervalId);
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
