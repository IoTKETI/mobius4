// Shared in-process registry of in-flight CREATE operations.
// Maps resource sid → Promise<void> that resolves when the transaction commits.
// set_ri_sid awaits the promise when a Lookup miss races a concurrent CREATE.
// Redis phase (Phase 9): replace this Map with Redis pub/sub.
const pendingCreates = new Map();
module.exports = pendingCreates;
