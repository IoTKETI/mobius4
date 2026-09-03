"use strict";
// Subscription verification -- TS-0004:7.4.8.2.1 Recv-6.4 and TS-0004:7.5.1.2.3.
//
// Recv-6.4: "If any of the notificationURI entries are not the Originator and are formatted as
// oneM2M-compliant resource-IDs, the Hosting CSE may send a Subscription Verification request
// primitive to each of them as described in clause 7.5.1.2.3."
//
// It is "may", not "shall" -- so this is off by default and turned on for conformance testing.
// See the design document for why: turning it on makes a subscription creation that used to
// succeed fail whenever the notification target does not answer, and that target belongs to
// somebody else's deployment.
const config = require("config");

// The same rule cse/noti.js uses to decide whether an nu entry needs a poa lookup, which is
// literally `startsWith('http')` and `startsWith('mqtt')` there. Kept identical on purpose: if
// the two ever disagree, a target would be notified but never verified (or the reverse), and
// neither failure announces itself.
//
// Identical includes the parts that are arguably wrong. "http" catches https, so it is not listed
// separately. coap is NOT listed even though the standard names it as a binding, because mobius4
// has no coap binding and noti.js does not exclude it -- adding it here would have made a
// coap:// target a URL to this module and a resource-ID to noti.js, which is exactly the split
// this comment claims does not exist. And an <AE> named "httpSink" is misread as a URL by both.
// Fix them together or not at all.
const URL_SCHEMES = ["http", "mqtt"];

function is_resource_id_target(nu_entry) {
    if (typeof nu_entry !== "string") return false;
    return !URL_SCHEMES.some((scheme) => nu_entry.startsWith(scheme + "://") || nu_entry.startsWith(scheme));
}

// Two entries can name the same entity in different spellings -- "/Mobius4/Mobius/ae1" and
// "Mobius/ae1" are one AE -- so the Originator is excluded by identity, not by string equality.
// get_to_info collapses a local ID to its CSE-relative form; for a resource on another CSE it is
// a passthrough, so two foreign spellings still compare unequal. That is a known limit, not an
// oversight: resolving a foreign ID would need that CSE, which this check cannot reach.
function verification_targets(nu_list, originator) {
    // Required lazily: reqPrim requires this module's callers, and a top-level require here
    // closes the cycle.
    const { get_to_info } = require("./reqPrim");
    const normalise = (v) => {
        if (typeof v !== "string" || v === "") return v;
        const { shortest_to } = get_to_info({ to: v });
        return shortest_to || v;
    };
    const own = normalise(originator);
    return (nu_list || []).filter((nu) => {
        if (!is_resource_id_target(nu)) return false;
        return nu !== originator && normalise(nu) !== own;
    });
}

function verification_enabled() {
    return config.cse.subscription_verification === true;
}

module.exports = { is_resource_id_target, verification_targets, verification_enabled };
