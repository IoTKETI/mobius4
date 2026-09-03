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

// The same rule cse/noti.js uses to decide whether an nu entry needs a poa lookup. Kept
// identical on purpose: if the two ever disagree, a target would be notified but never
// verified (or the reverse), and neither failure announces itself.
const URL_SCHEMES = ["http", "https", "mqtt", "coap"];

function is_resource_id_target(nu_entry) {
    if (typeof nu_entry !== "string") return false;
    return !URL_SCHEMES.some((scheme) => nu_entry.startsWith(scheme + "://") || nu_entry.startsWith(scheme));
}

function verification_targets(nu_list, originator) {
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
