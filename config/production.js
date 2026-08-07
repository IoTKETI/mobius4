// Deliberately empty.
//
// node-config warns on every start when NODE_ENV names an environment it has no file for:
//
//   WARNING: NODE_ENV value of 'production' did not match any deployment config file names.
//
// The container image sets NODE_ENV=production — bindings/http.js and logger.js both read it,
// and Express changes behaviour on it — but its configuration arrives through NODE_CONFIG,
// assembled by docker/entrypoint.js from the compose environment. There is nothing to put in a
// file here, and SUPPRESS_NO_CONFIG_WARNING does not cover this particular warning (it covers
// "no configurations found", which is not the case: config/default.json is right there).
//
// So this file exists to be found. Leave it empty: deployment values belong in config/local.json
// or in NODE_CONFIG, both of which override this and neither of which is committed. Putting
// values here would apply them to every production deployment of mobius4, including ones that
// never asked.
module.exports = {};
