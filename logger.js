'use strict';

const path = require('path');
const pino = require('pino');
const config = require('config');

const logConfig = config.get('logging');

const targets = [];

if (logConfig.console.enabled) {
    if (logConfig.console.pretty && process.env.NODE_ENV !== 'production') {
        targets.push({
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
                ignore: 'pid',
                messageFormat: '[{module}] {msg}'
            }
        });
    } else {
        targets.push({ target: 'pino/file', options: { destination: 1 } });
    }
}

if (logConfig.file.enabled) {
    targets.push({
        target: 'pino-roll',
        options: {
            file: path.join(__dirname, logConfig.file.path),
            frequency: logConfig.file.rotate,
            size: logConfig.file.maxSize,
            limit: { count: logConfig.file.maxFiles },
            mkdir: true
        }
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
        timestamp: pino.stdTimeFunctions.isoTime
    },
    pino.transport({ targets, sync: true })
);

module.exports = logger;
