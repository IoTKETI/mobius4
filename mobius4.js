// mobius 4 vesion number: 0.1.0

// .env 파일에서 환경변수 로드
require('dotenv').config();

const dbDebugger = require('debug')('mobius4:db');
const db = require('./db/init');

const mqtt = require('./bindings/mqtt');

if ("dev" === process.env.NODE_ENV) {
    // do something
    dbDebugger('debugging in dev environment');
}

// db connect
db.init_db();

// start http server
require('./bindings/http');

// start mqtt client
mqtt.init_client();



const config = require('config');

// start CSE registration if this is MN-CSE or ASN-CSE
if (config.cse.cse_type === 2 || config.cse.cse_type === 3) {
    const { registree } = require('./cse/registree');
    registree();
}


// start expired resource cleanup
const { expired_resource_cleanup } = require('./cse/hostingCSE');

setInterval(expired_resource_cleanup, config.cse.expired_resource_cleanup_interval_days * 24 * 60 * 60 * 1000);