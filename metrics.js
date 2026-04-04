const config = require('config');

const enabled = config.get('metrics.enabled');

if (!enabled) {
    const noop = () => {};
    module.exports = {
        enabled: false,
        register: null,
        httpRequestsTotal:     { inc: noop },
        httpRequestDuration:   { startTimer: () => noop },
        mqttMessagesTotal:     { inc: noop },
        resourcesCreatedTotal: { inc: noop },
    };
} else {
    const client = require('prom-client');
    const fs = require('fs');
    const path = require('path');

    client.collectDefaultMetrics();

    const httpRequestsTotal = new client.Counter({
        name: 'mobius4_http_requests_total',
        help: 'Total HTTP requests',
        labelNames: ['method', 'status_code'],
    });

    const httpRequestDuration = new client.Histogram({
        name: 'mobius4_http_request_duration_seconds',
        help: 'HTTP response time in seconds',
        labelNames: ['method'],
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    });

    const mqttMessagesTotal = new client.Counter({
        name: 'mobius4_mqtt_messages_total',
        help: 'Total MQTT messages received',
    });

    const resourcesCreatedTotal = new client.Counter({
        name: 'mobius4_resources_created_total',
        help: 'Total oneM2M resources created',
        labelNames: ['ty'],
    });

    const logDir = path.dirname(config.get('logging.file.path'));

    new client.Gauge({
        name: 'mobius4_log_files_total',
        help: 'Current number of log files',
        collect() {
            try {
                const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log'));
                this.set(files.length);
            } catch { this.set(0); }
        },
    });

    new client.Gauge({
        name: 'mobius4_log_size_bytes',
        help: 'Total size of all log files in bytes',
        collect() {
            try {
                const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log'));
                const total = files.reduce((sum, f) => sum + fs.statSync(path.join(logDir, f)).size, 0);
                this.set(total);
            } catch { this.set(0); }
        },
    });

    module.exports = {
        enabled: true,
        register: client.register,
        httpRequestsTotal,
        httpRequestDuration,
        mqttMessagesTotal,
        resourcesCreatedTotal,
    };
}
