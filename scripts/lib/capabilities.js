"use strict";
// The judgement calls in the capability probe, separated from the work of running it.
//
// scripts/probe-capabilities.js has to start a server, a database and a notification sink to do
// anything at all. The decisions it makes along the way — is this response "supported", has the
// committed file drifted, what does the summary say — need none of that, and they are the parts
// that can be quietly wrong. A probe that mistakes a working feature for a missing one produces
// a file that looks exactly like a real answer, and CI then enforces it.
//
// That is not hypothetical: the notification check was written with a predicate over the array
// of received notifications where the sink hands its predicate each notification, so it matched
// nothing and recorded a working feature as unsupported. It was caught by reading the output,
// which is not a method.

/**
 * A probe response, judged.
 *
 * Only a success-class status counts as support. Everything else keeps the status that came
 * back rather than collapsing to a bare false, because "refused on purpose" (a <CSEBase> UPDATE
 * answering 4005 OPERATION_NOT_ALLOWED, which is correct behaviour) and "not implemented" are
 * different facts and the reader has to be able to tell them apart.
 */
function support(res) {
  const raw = res && res.rsc;
  // The absent header has to be tested for before the conversion. `fetch`'s headers.get returns
  // null when a header is missing and Number(null) is 0 — a finite number — so a response that
  // never reached the oneM2M layer was being recorded as `rsc: 0`: a status code that does not
  // exist, sitting where a real refusal would be, and indistinguishable from one.
  if (raw === null || raw === undefined || raw === "") {
    return { supported: false, rsc: null, note: "no X-M2M-RSC header" };
  }
  const rsc = Number(raw);
  if (!Number.isFinite(rsc)) return { supported: false, rsc: null, note: "no X-M2M-RSC header" };
  return { supported: rsc >= 2000 && rsc < 3000, rsc };
}

/**
 * The part of a capabilities file that must not change silently.
 *
 * `probed_at` and the commit move on every run; comparing them would make the drift check fail
 * always, which is the same as not having one. What has to stay put is the behaviour.
 */
function observedOf(manifest) {
  return JSON.stringify({
    // The format version is part of what the file asserts, not metadata about the run: bumping
    // it in the producer without regenerating would leave a file claiming a shape it does not
    // have. Including it here makes the CI check force the regeneration.
    formatVersion: (manifest && manifest.formatVersion) || null,
    entries: (manifest && manifest.entries) || [],
    procedures: (manifest && manifest.procedures) || [],
  });
}

/**
 * Whether a consumer written for `supported` can read `found`.
 *
 * Only the same version is readable. A newer file may have moved a field or changed what one
 * means, and the failure mode of guessing is not a crash — it is a plausible wrong answer, in a
 * file whose whole purpose is to be trusted. An older file is refused for the same reason
 * rather than read leniently: leniency here buys a shape nobody tested.
 */
function isReadableFormat(found, supported) {
  return found === supported;
}

function hasDrifted(previous, current) {
  return observedOf(previous) !== observedOf(current);
}

/**
 * Counts for the run summary.
 *
 * A procedure that was not probed carries `supported: null`, and it is counted separately
 * rather than with the failures: an unasked question is not a negative answer, and rolling the
 * two together would understate what the CSE does.
 */
function summarize(manifest) {
  const entries = manifest.entries || [];
  const procedures = manifest.procedures || [];
  return {
    resourceTypes: entries.length,
    supportedOperations: entries.reduce(
      (n, e) => n + Object.values(e.operations || {}).filter((o) => o.supported).length,
      0
    ),
    procedures: procedures.length,
    supportedProcedures: procedures.filter((p) => p.supported === true).length,
    unprobedProcedures: procedures.filter((p) => p.supported === null).length,
  };
}

module.exports = { support, observedOf, hasDrifted, summarize, isReadableFormat };
