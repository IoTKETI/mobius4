module.exports = {
    apps: [{
        name: 'mobius4',
        script: 'mobius4.js',
        instances: 1,       // cluster mode is not possible due to global MQTT/DB state
        exec_mode: 'fork',

        // PM2 waits for the process.send('ready') signal
        wait_ready: true,
        listen_timeout: 15000,  // upper bound on waiting for ready (allows for DB+MQTT init time)

        // set with more headroom than the app's own 30s shutdown timeout
        kill_timeout: 35000,

        // restart policy
        autorestart: true,
        max_restarts: 10,
        min_uptime: 5000,   // must stay up at least 5s to count as a successful start
        restart_delay: 1000,

        // Pino handles file logging + rotation under logs/, so PM2's log files are disabled
        out_file: '/dev/null',
        error_file: '/dev/null',

        // per-environment settings — secrets are managed in config/local.json
        env: {
            NODE_ENV: 'dev'
        },
        env_production: {
            NODE_ENV: 'production'
        }
    }]
};
