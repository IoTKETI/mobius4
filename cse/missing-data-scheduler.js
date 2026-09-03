"use strict";
// When the missing-data sweep runs.
//
// TS-0001:10.2.4.29 puts a missing data point's detection at "expected dataGenerationTime +
// missingDataDetectTimer". A fixed cadence makes that late by up to a whole interval, so the sweep
// books each pass from the data: every pass reports the earliest instant any detecting
// <timeSeries> could next have something to judge, and the next pass runs then.
//
// That leaves one hole, which is the reason this file exists rather than a few lines in mobius4.js.
// A pass that finds nothing to detect has no due time to work from and falls back to the ceiling --
// and a CSE that has been up for a while with no detecting <timeSeries> is asleep for exactly that
// long. Everything created during the sleep is invisible until it ends. Measured on a warm CSE
// before this: a <timeSeries> with pei 5000 and mdt 1000 whose gap is real at six seconds still
// reported missingDataCurrentNr 0 at nine, and only caught up at twenty.
//
// So the sleep is not the only thing that ends a pass: wake() ends it too. It is called where a
// resource starts being detectable -- a <timeSeries> created or updated into detecting, and the
// <timeSeriesInstance> that first gives it an anchor.
//
// wake() is deliberately not called on every <timeSeriesInstance>. After the anchor exists the
// sweep's own pacing is right, and a busy time series would otherwise force a pass per instance.
const logger = require('../logger').forFile(__filename);

// A floor on the delay, so a very small periodicInterval cannot turn the sweep into a spin.
const MIN_DELAY_MS = 250;

let timer = null;
let ceilingMs = null;
let running = false;
let sweep = null;

function schedule(delayMs) {
    if (ceilingMs === null) return;   // stopped
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, Math.min(ceilingMs, Math.max(MIN_DELAY_MS, delayMs)));
}

async function run() {
    timer = null;
    if (running) return;              // a wake() landed mid-pass; that pass will reschedule
    running = true;
    let nextMs = ceilingMs;
    try {
        const result = await sweep();
        if (result && result.next_due_s !== null && result.next_due_s !== undefined) {
            nextMs = result.next_due_s * 1000 - Date.now();
        }
    } catch (err) {
        logger.error({ err }, 'missing-data sweep failed');
    } finally {
        running = false;
    }
    schedule(nextMs);
}

/**
 * @param {object} opts
 * @param {number} opts.ceilingSeconds  the longest the sweep may sleep
 * @param {function} opts.sweep         the sweep, returning { next_due_s }
 */
function start({ ceilingSeconds, sweep: sweepFn }) {
    ceilingMs = ceilingSeconds * 1000;
    sweep = sweepFn;
    schedule(MIN_DELAY_MS);
    logger.info({ ceilingSeconds, minDelayMs: MIN_DELAY_MS },
        'missing data sweep scheduled (paced by the data, bounded by the configured interval)');
}

function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
    ceilingMs = null;
}

// Re-evaluate now rather than at the end of the current sleep. A no-op when this instance is not
// the one running the sweep (start() was never called here), which is also what happens on an
// instance that lost the singleton role -- in a multi-instance deployment a <timeSeries> created on
// another instance is picked up at the ceiling instead.
function wake() {
    if (ceilingMs === null || running) return;
    schedule(0);
}

module.exports = { start, stop, wake, MIN_DELAY_MS };
