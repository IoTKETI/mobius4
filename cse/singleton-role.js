// Which work belongs to exactly one process when several are running.
//
// Most of what mobius4 does is per-request and safe to run in every instance. Two things are
// not: subscribing to the MQTT request topic, and the periodic sweep for expired resources.
// Both are driven by something other than an incoming HTTP request, so running them N times
// does the work N times.
//
// Measured with two instances against one database (2026-08-05):
//
//   - MQTT: no client id is set, so each instance connects under its own and the broker
//     delivers every request message to all of them. One <container> CREATE over MQTT was
//     processed by both; only one resource was stored, because the unique index on lookup.sid
//     caught the second, but the work and the response were duplicated. The waste grows with
//     the instance count.
//   - Cleanup: setInterval fires in every process, so the same sweep runs N times. Deletes are
//     idempotent so no data is lost, but concurrent deletes of the same rows contend — and
//     lock contention on this codebase has already produced one deadlock (see the eviction
//     statement in cse/resources/cin.js).
//
// PM2 sets NODE_APP_INSTANCE per worker in cluster mode; instance 0 takes these roles. Outside
// PM2, or in fork mode, the variable is absent and the single process takes them — which is
// what a development run and the test suite need.
//
// This is deliberately the simple answer rather than a lease or an election. It has one real
// weakness: if instance 0 dies, PM2 restarts it, but until it is back nobody is subscribed to
// the MQTT topic. That is a worse failure than the duplication it replaces only if MQTT is the
// primary binding, so it is written down here rather than hidden. An MQTT 5 shared
// subscription ($share/) would spread the load across instances instead, and is the better
// answer once the broker in use is known to support it.
function isSingletonInstance() {
    const id = process.env.NODE_APP_INSTANCE;
    return id === undefined || id === '' || id === '0';
}

module.exports = { isSingletonInstance };
