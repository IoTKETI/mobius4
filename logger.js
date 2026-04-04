'use strict';

const pino = require('pino');
const config = require('config');

const logConfig = config.get('logging');

const streams = [];

if (logConfig.console.enabled) {
    if (logConfig.console.pretty && process.env.NODE_ENV !== 'production') {
        streams.push({
            stream: require('pino-pretty')({
                colorize: true,
                translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
                ignore: 'pid',
                messageFormat: '[{module}] {msg}'
            })
        });
    } else {
        streams.push({ stream: process.stdout });
    }
}

if (logConfig.file.enabled) {
    const roll = require('pino-roll');
    streams.push({
        stream: roll(logConfig.file.path, {
            frequency: logConfig.file.rotate,
            size: logConfig.file.maxSize,
            limit: { count: logConfig.file.maxFiles }
        })
    });
}

const logger = pino(
    {
        level: logConfig.level,
        redact: {
            paths: logConfig.http.redactPaths,
            censor: '[REDACTED]'
        },
        base: {
            pid: process.pid,
            cseId: config.get('cse.cse_id')
        },
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: {
            level(label) {
                return { level: label };
            }
        }
    },
    pino.multistream(streams)
);

module.exports = logger;
