'use strict';

const path = require('path');
const pino = require('pino');
const config = require('config');

const logConfig = config.get('logging');

function localIsoTime() {
    const now = new Date();
    const offsetMin = -now.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const hh = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, '0');
    const mm = String(Math.abs(offsetMin) % 60).padStart(2, '0');
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return `,"time":"${local.toISOString().slice(0, -1)}${sign}${hh}:${mm}"`;
}

// Collapse innermost arrays onto a single line (e.g. "ty": [3] instead of multiline)
function compactPrim(value) {
    return JSON.stringify(value, null, 2)
        .replace(/\[([^\[\]]*?)\]/gs, (_, inner) =>
            '[' + inner.replace(/\s+/g, ' ').trim() + ']'
        );
}

const streams = [];

if (logConfig.console.enabled) {
    if (logConfig.console.pretty && process.env.NODE_ENV !== 'production') {
        // pino-pretty used as a direct stream (not transport worker) so that
        // customPrettifiers can accept functions — functions cannot be cloned to workers
        const pretty = require('pino-pretty');
        streams.push({
            level: logConfig.level,
            stream: pretty({
                colorize: true,
                translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
                ignore: 'pid',
                messageFormat: '[{module}] {msg}',
                customPrettifiers: { prim: compactPrim }
            })
        });
    } else {
        streams.push({ level: logConfig.level, stream: process.stdout });
    }
}

if (logConfig.file.enabled) {
    streams.push({
        level: logConfig.level,
        stream: pino.transport({
            target: 'pino-roll',
            options: {
                file: path.join(__dirname, logConfig.file.path),
                frequency: logConfig.file.rotate,
                size: logConfig.file.maxSize,
                limit: { count: logConfig.file.maxFiles },
                mkdir: true
            }
        })
    });
}

const dest = streams.length === 1
    ? streams[0].stream
    : pino.multistream(streams);

const logger = pino(
    {
        level: logConfig.level,
        redact: {
            paths: logConfig.http.redactPaths,
            censor: '[REDACTED]'
        },
        base: { pid: process.pid },
        timestamp: localIsoTime
    },
    dest
);

const PROJECT_ROOT = __dirname;

module.exports = logger;
module.exports.forFile = function(filename) {
    const rel = path.relative(PROJECT_ROOT, filename).replace(/\\/g, '/');
    return logger.child({ module: rel });
};
