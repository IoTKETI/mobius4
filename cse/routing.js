const config = require('config');
const logger = require('../logger').child({ module: 'routing' });

function check_to_is_mine(to) {
    var str, cse_id_token, sp_id_token;
    logger.trace({ to }, 'check_to_is_mine');

    // in CSE-relative format, then I think it's mine
    if ('/' != to[0]) {
        return true;
    }
    // in SP-relative format, if the CSE-ID is mine, then it's mine
    if ('/' === to[0] && '/' != to[1]) {
        cse_id_token = to.slice(1).split('/')[0];

        if (cse_id_token === config.get('cse.cse_id').slice(1)) {
            return true;
        }
    }
    // in Absolute format, if the SP-ID and CSE-ID are mine, then it's mine
    if ('/' === to[0] && '/' === to[1]) {
        sp_id_token = to.slice(2).split('/')[0];
        cse_id_token = to.slice(2).split('/')[1];

        if (config.get('cse.sp_id').slice(2) === sp_id_token && config.get('cse.cse_id').slice(1) === cse_id_token) {
            return true;
        }
    }
    return false;
}

// simply forwarding with http
// to-do-later: use proper bindings for the next hop
async function request_forwarding(req, binding) {
    logger.debug({ binding }, 'forwarding a request');
    return
}


module.exports.check_to_is_mine = check_to_is_mine;
module.exports.request_forwarding = request_forwarding;