const config = require('config');


exports.grant_owner_update = function (target_res, originator) {
    // when a target resource already has owner
    // old owner shall be the request originator
    if (target_res.own && target_res.own == originator)
        return true;

    // when there is no written owner
    // check if the originator is the resource creator before
    if (!target_res.own && target_res.int_cr && target_res.int_cr == originator)
        return true;

    // system admin always gets full access
    if (originator === config.cse.admin)
        return true;

    return false
}