// What a registree CSE (an MN-CSE or ASN-CSE, cse_type 2 or 3) owes its registrar about the
// CSEs registered below it, and the routing decision that depends on the same list.
//
// TS-0001:9.6.4 defines descendantCSEs on <remoteCSE> as "a list of CSE-IDs of descendant CSEs of
// the registering/registree CSE" -- set by the registree when it registers, and not set on the
// <remoteCSE> that represents the registrar. TS-0004:7.4.4.2.1/.3/.4 (Recv-6.5) then has a CSE
// that accepts a registration, an update of descendantCSEs or a de-registration, and is itself
// registered, send the corresponding update of its own <remoteCSE>.descendantCSEs to its
// registrar. That is what lets the IN-CSE route to a grandchild it has never seen
// (TS-0004:7.3.2.6, matched against descendantCSEs).
//
// Before this module an MN-CSE registered once at startup (cse/registree.js) and never told its
// registrar anything again, so a CSE registered below it was unreachable from above.

const axios = require('axios');
const config = require('config');
const logger = require('../logger').forFile(__filename);
const CSR = require('../models/csr-model');

// The resource ID the registrar gave our <remoteCSE> on it, kept from the CREATE response in
// registree(). Unset when registration failed: there is then nothing to update, and a report
// is skipped with a warning rather than sent to a guessed address.
let own_csr_ri = null;

function is_registree() {
    return config.cse.cse_type === 2 || config.cse.cse_type === 3;
}

function set_own_csr_ri(ri) {
    own_csr_ri = ri || null;
}

function get_own_csr_ri() {
    return own_csr_ri;
}

// A CSE-ID as SP-relative: a dcse entry may be written in Absolute form (sp_id + CSE-ID), and
// both spellings name the same CSE inside our own SP domain.
function strip_own_sp_id(id) {
    const sp_id = config.cse.sp_id;
    if (typeof id === 'string' && sp_id && id.startsWith(sp_id + '/')) return id.slice(sp_id.length);
    return id;
}

// The descendant list out of a set of <remoteCSE> rows. Pure so it can be tested without a
// database. The registrar's <remoteCSE> is left out -- the registrar is above us, not below
// (TS-0001:9.6.4: descendantCSEs is not set on the <remoteCSE> representing the registrar).
// Each remaining row contributes its own csi (a child) and every entry of its dcse (that
// child's descendants, our grandchildren and below). Duplicates are dropped, first occurrence
// kept; an empty result is null, since m2m:listOfM2MID has minLength 1 and the registrar stores
// an empty list as null anyway.
function collect_descendants(csr_rows, registrar_cse_id) {
    const out = [];
    const seen = new Set();
    const add = (id) => {
        if (typeof id !== 'string' || id === '') return;
        const key = strip_own_sp_id(id);
        if (seen.has(key)) return;
        seen.add(key);
        out.push(id);
    };

    for (const row of csr_rows || []) {
        if (!row || strip_own_sp_id(row.csi) === strip_own_sp_id(registrar_cse_id)) continue;
        add(row.csi);
        if (Array.isArray(row.dcse)) row.dcse.forEach(add);
    }
    return out.length > 0 ? out : null;
}

async function compute_descendants() {
    const rows = await CSR.findAll({ attributes: ['csi', 'dcse'] });
    return collect_descendants(rows, config.cse.registrar.cse_id);
}

async function send_report() {
    if (!own_csr_ri) {
        logger.warn('descendantCSEs not reported: this CSE holds no <remoteCSE> on its registrar (registration failed or has not completed)');
        return;
    }
    const registrar = config.cse.registrar;
    const dcse = await compute_descendants();
    // The whole list, replacing what the registrar holds. The standard says "corresponding
    // updates" without fixing their form; a full replacement is what this CSE's own UPDATE of
    // dcse does as a registrar (cse/resources/csr.js), so the two ends agree.
    const url = `http://${registrar.ip}:${registrar.port}/${own_csr_ri}`;
    const headers = {
        'X-M2M-RI': `dcse_report_${Date.now()}`,
        'X-M2M-Origin': config.cse.cse_id,
        'X-M2M-RVI': config.cse.versions[0],
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    };
    try {
        await axios.put(url, { 'm2m:csr': { dcse } }, { headers,
            timeout: config.cse.forwarding_timeout_seconds * 1000 });
        logger.info({ registrarUrl: url, dcse }, 'descendantCSEs reported to registrar');
    } catch (err) {
        logger.warn({ err, registrarUrl: url, status: err.response?.status,
            rsc: err.response?.headers?.['x-m2m-rsc'] }, 'descendantCSEs report to registrar failed');
    }
}

// Reports run one at a time. Each computes the list when it runs, not when it was asked for,
// and a slower earlier UPDATE finishing after a later one would otherwise leave the registrar
// with the older list.
let chain = Promise.resolve();

function report_descendants() {
    chain = chain.then(send_report).catch((err) => {
        logger.error({ err }, 'descendantCSEs report failed');
    });
    return chain;
}

// The hook the resource code calls when a local <remoteCSE> appears, changes its dcse or goes.
// Fire-and-forget: the client's request has already succeeded and must not wait for, or fail
// on, a request to another CSE. A change to the registrar's own <remoteCSE> does not change
// the list and is not reported.
function on_local_csr_change(csi) {
    if (!is_registree()) return;
    if (csi !== undefined && strip_own_sp_id(csi) === strip_own_sp_id(config.cse.registrar.cse_id)) return;
    report_descendants();
}

// TS-0004:7.3.2.6: with no matching <remoteCSE>, a CSE that is not the IN-CSE retargets the
// request to its registrar if it "received the request from an AE or a descendant CSE", and
// answers NOT_FOUND if it received it from its registrar. The From parameter (already in
// SP-relative or Absolute form) is what tells the two apart: an AE of this CSE carries our
// CSE-ID as its prefix, and anything from below carries a descendant's CSE-ID.
function is_from_below(fr, descendants) {
    if (typeof fr !== 'string') return false;
    const from = strip_own_sp_id(fr);
    const own = config.cse.cse_id;
    if (from === own || from.startsWith(own + '/')) return true;
    for (const d of descendants || []) {
        const id = strip_own_sp_id(d);
        if (from === id || from.startsWith(id + '/')) return true;
    }
    return false;
}

// Request Identifiers of requests this CSE has retargeted to its registrar, so that one coming
// back down (stale descendantCSEs at the registrar) is recognised -- see request_forwarding.
// Kept for twice the forwarding timeout: long enough to cover the round trip to the registrar
// and back, short enough that an Originator reusing an identifier later is not refused.
const sent_up = new Map();

function mark_sent_up(rqi) {
    if (rqi === undefined || rqi === null || rqi === '') return;
    const ttl_ms = 2 * config.cse.forwarding_timeout_seconds * 1000;
    const now = Date.now();
    for (const [k, exp] of sent_up) if (exp <= now) sent_up.delete(k);
    sent_up.set(rqi, now + ttl_ms);
}

function was_sent_up(rqi) {
    if (rqi === undefined || rqi === null || rqi === '') return false;
    const exp = sent_up.get(rqi);
    if (exp === undefined) return false;
    if (exp <= Date.now()) { sent_up.delete(rqi); return false; }
    return true;
}

module.exports = {
    mark_sent_up,
    was_sent_up,
    is_registree,
    set_own_csr_ri,
    get_own_csr_ri,
    collect_descendants,
    compute_descendants,
    report_descendants,
    on_local_csr_change,
    is_from_below,
};
