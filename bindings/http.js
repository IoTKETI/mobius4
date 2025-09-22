const config = require("config");
const http = require("http");
const https = require("https");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const app = express();


const enums = require("../config/enums");
const reqPrim = require("../cse/reqPrim");


// JSON parsing middleware (application/json)
app.use(express.json({
  limit: '10mb',
  type: ['application/json', 'application/vnd.onem2m-res+json', 'application/*+json']
}));
// URL-encoded parsing middleware (if needed)
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cors());

// JSON parsing error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    // JSON parsing error
    console.log('JSON parsing error:', error.message);
    
    const resp_prim = {
      rsc: enums.rsc_str["BAD_REQUEST"],
      pc: { "m2m:dbg": `JSON parsing error: ${error.message}` }
    };
    
    res.status(400).json(resp_prim.pc);
    return;
  }
  
  // other error, pass to the next error handler
  next(error);
});


// http server setup
http.globalAgent.maxSockets = 100 * 100;
const server = http.createServer(app).listen(config.http.port);
server.keep_alive_timeout = config.cse.keep_alive_timeout * 1000;
if (server) {
  console.log("HTTP server is listening on port: " + config.http.port);
}

// https server setup
const ca = fs.readFileSync("certs/ca.crt");
const https_options = {
  key: fs.readFileSync("certs/wdc.key"),
  cert: fs.readFileSync("certs/wdc.crt"),
  ca: [ca],
  requestCert: true,
  rejectUnauthorized: true,
};

const https_server = https
  .createServer(https_options, app)
  .listen(config.https.port);

if (https_server) {
  console.log("HTTPs server is listening on port: " + config.https.port);
}

// CRUD mapping for HTTP / HTTPs server
app.post('/*', async (req, resp) => {
  const req_prim = httpToPrim(req);
  
  // depending on the Result Content value, response primitive looks different
  let resp_prim = {}; // life-time of this response primitive is equal to this post function
  if ("parsingError" in req_prim) {
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": req_prim.parsingError };
  } else {
    resp_prim = await reqPrim.prim_handling(req_prim);
  }
  
  console.log("\nresponse primitive: \n", JSON.stringify(resp_prim, null, 2));


  // convert the response primitive into HTTP response to send back
  primToHttp(resp_prim, resp);

  // send the response
  if (resp_prim.rsc == enums.rsc_str["CREATED"]) {
    if (resp_prim.pc) {
      resp.status(201).json(resp_prim.pc);
    } else {
      resp.status(201).end();
    }
  }
  // for fanout responses, by the spec, it returns 'OK'
  else if (resp_prim.rsc == enums.rsc_str["OK"]) {
    if (resp_prim.pc) {
      resp.status(200).json(resp_prim.pc);
    } else {
      resp.status(200).end();
    }
  }
  // 400 Bad Request
  else if (resp_prim.rsc == enums.rsc_str["BAD_REQUEST"]) {
    if (resp_prim.pc && resp_prim.pc["m2m:dbg"]) {
      resp.status(400).json(resp_prim.pc);
    } else {
      resp.status(400).end();
    }
  }
  // 403 Forbidden
  else if (
    resp_prim.rsc == enums.rsc_str["TARGET_NOT_SUBSCRIBABLE"] ||
    resp_prim.rsc == enums.rsc_str["ORIGINATOR_HAS_NO_PRIVILEGE"] ||
    resp_prim.rsc == enums.rsc_str["INVALID_CHILD_RESOURCE_TYPE"] ||
    resp_prim.rsc == enums.rsc_str["ORIGINATOR_HAS_ALREADY_REGISTERED"]
  ) {
    if (resp_prim.pc && resp_prim.pc["m2m:dbg"]) {
      resp.status(403).json(resp_prim.pc);
    } else {
      resp.status(403).end();
    }
  }
  // 404 Not Found
  else if (resp_prim.rsc == enums.rsc_str["NOT_FOUND"]) {
    resp.status(404).end();
  }
  // 405 Method Not Allowed
  else if (resp_prim.rsc == enums.rsc_str["OPERATION_NOT_ALLOWED"]) {
    resp.status(405).end();
  }
  // 406 Not Acceptable
  else if (resp_prim.rsc == enums.rsc_str["NOT_ACCEPTABLE"]) {
    resp.status(406).end();
  }
  // 409 Conflict
  else if (resp_prim.rsc == enums.rsc_str["CONFLICT"]) {
    if (resp_prim.pc && resp_prim.pc["m2m:dbg"]) {
      resp.status(409).json(resp_prim.pc);
    } else {
      resp.status(409).end();
    }
  }
  // 500 Internal server error
  else if (resp_prim.rsc == enums.rsc_str["INTERNAL_SERVER_ERROR"]) {
    if (resp_prim.pc) {
      resp.status(500).json(resp_prim.pc);
    } else {
      resp.status(500).end();
    }
  }
  // 501 Not implemented
  else if (resp_prim.rsc == enums.rsc_str["NOT_IMPLEMENTED"]) {
    if (resp_prim.pc) {
      resp.status(501).json(resp_prim.pc);
    } else {
      resp.status(501).end();
    }
  }
});

app.get('/*', async (req, resp) => {
  // // in case of HTTPs connection, after the certificate-based authentication, check the "fr" param
  // const cert = req.socket.getPeerCertificate();
  // console.log("Certificate subject:", cert.subject);
  // console.log("Certificate SAN:", cert.subjectaltname);

  // let https_client_SAN = cert.subjectaltname;
  // if (
  //   https_client_SAN.startsWith("URI:") ||
  //   https_client_SAN.startsWith("DNS:")
  // ) {
  //   https_client_SAN = https_client_SAN.substring("URI:".length);
  //   https_client_SAN = https_client_SAN.split("/").pop();
  //   console.log(
  //     "originator ID (from param) after successful authentication: ",
  //     https_client_SAN
  //   );
  // }

  const req_prim = httpToPrim(req);

  // // check ID impersonation
  // if (req_prim.fr != https_client_SAN) {
  //   console.log(
  //     `fr (${req_prim.fr}) is different from subjectAltName (${https_client_SAN}) from the client certificate \n`
  //   );
  //   resp.status(403).end();
  //   return;
  // } else {
  //   console.log(
  //     "fr param is confirmed from the client certificate, which is:",
  //     https_client_SAN
  //   );
  // }
  let resp_prim = {};
  try {
    resp_prim = await reqPrim.prim_handling(req_prim);
  } catch (err) {
    console.error(err);
  }
  primToHttp(resp_prim, resp);

  // send the response
  if (resp_prim.rsc == enums.rsc_str["OK"]) {
    if (resp_prim.pc) {
      resp.status(200).json(resp_prim.pc);
    } else {
      resp.status(200).end();
    }
  }
  // 400 Bad Request
  else if (resp_prim.rsc == enums.rsc_str["BAD_REQUEST"]) {
    if (resp_prim.pc) {
      resp.status(400).json(resp_prim.pc);
    } else {
      resp.status(400).end();
    }
  }
  // 403 Forbidden
  else if (resp_prim.rsc == enums.rsc_str["ORIGINATOR_HAS_NO_PRIVILEGE"]) {
    if (resp_prim.pc) {
      resp.status(403).json(resp_prim.pc);
    } else {
      resp.status(403).end();
    }
  }
  // 404 Not found
  else if (resp_prim.rsc == enums.rsc_str["NOT_FOUND"]) {
    if (resp_prim.pc) {
      resp.status(404).json(resp_prim.pc);
    } else {
      resp.status(404).end();
    }
  }
  // 500 Internal server error
  else if (resp_prim.rsc == enums.rsc_str["INTERNAL_SERVER_ERROR"]) {
    if (resp_prim.pc) {
      resp.status(500).json(resp_prim.pc);
    } else {
      resp.status(500).end();
    }
  }
  // 501 Not implemented
  else if (resp_prim.rsc == enums.rsc_str["NOT_IMPLEMENTED"]) {
    if (resp_prim.pc) {
      resp.status(501).json(resp_prim.pc);
    } else {
      resp.status(501).end();
    }
  }
});

app.put('/*', async (req, resp) => {
  const req_prim = httpToPrim(req);

  let resp_prim = {}; // life-time of this response primitive is equal to this put function
  if (req_prim === null) {
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": "JSON parsing error" };
  } else {
    resp_prim = await reqPrim.prim_handling(req_prim);
  }

  // convert the response primitive into HTTP response to send back
  primToHttp(resp_prim, resp);

  // send a response
  if (resp_prim.rsc == enums.rsc_str["UPDATED"]) {
    if (resp_prim.pc) {
      resp.status(200).json(resp_prim.pc);
    } else {
      resp.status(200).end();
    }
  }
  // for fanout responses, by the spec, it returns 'OK'
  else if (resp_prim.rsc == enums.rsc_str["OK"]) {
    if (resp_prim.pc) {
      resp.status(200).json(resp_prim.pc);
    } else {
      resp.status(200).end();
    }
  }
  // 400 Bad Request
  else if (resp_prim.rsc == enums.rsc_str["BAD_REQUEST"]) {
    if (resp_prim.pc && resp_prim.pc.hasOwnProperty("m2m:dbg")) {
      resp.status(400).json(resp_prim.pc);
    } else {
      resp.status(400).end();
    }
  }
  // 403 Forbidden
  else if (resp_prim.rsc == enums.rsc_str["ORIGINATOR_HAS_NO_PRIVILEGE"]) {
    if (resp_prim.pc && resp_prim.pc.hasOwnProperty("m2m:dbg")) {
      resp.status(403).json(resp_prim.pc);
    } else {
      resp.status(403).end();
    }
  }
  // 404 Not Found
  else if (resp_prim.rsc == enums.rsc_str["NOT_FOUND"]) {
    resp.status(404).end();
  }
  // 405 Method Not Allowed
  else if (resp_prim.rsc == enums.rsc_str["OPERATION_NOT_ALLOWED"]) {
    resp.status(405).end();
  }
  // 406 Not Acceptable
  else if (resp_prim.rsc == enums.rsc_str["NOT_ACCEPTABLE"]) {
    resp.status(406).end();
  }
});

app.delete('/*', async (req, resp) => {
  const req_prim = httpToPrim(req);
  let resp_prim = {}; // life-time of this response primitive is equal to this delete function

  resp_prim = await reqPrim.prim_handling(req_prim);

  primToHttp(resp_prim, resp);

  // send a response
  if (resp_prim.rsc == enums.rsc_str["DELETED"]) {
    if (resp_prim.pc) {
      resp.status(200).json(resp_prim.pc);
    } else {
      resp.status(200).end();
    }
  }
  // for fanout responses, by the spec, it returns 'OK'
  if (resp_prim.rsc == enums.rsc_str["OK"]) {
    if (resp_prim.pc) {
      resp.status(200).json(resp_prim.pc);
    } else {
      resp.status(200).end();
    }
  }
  // 400 Bad Request
  else if (resp_prim.rsc == enums.rsc_str["BAD_REQUEST"]) {
    if (resp_prim.pc && resp_prim.pc.hasOwnProperty("m2m:dbg")) {
      resp.status(400).json(resp_prim.pc);
    } else {
      resp.status(400).end();
    }
  }
  // 403 Forbidden
  else if (resp_prim.rsc == enums.rsc_str["ORIGINATOR_HAS_NO_PRIVILEGE"]) {
    if (resp_prim.pc && resp_prim.pc.hasOwnProperty("m2m:dbg")) {
      resp.status(403).json(resp_prim.pc);
    } else {
      resp.status(403).end();
    }
  }
  // 404 Not Found
  else if (resp_prim.rsc == enums.rsc_str["NOT_FOUND"]) {
    resp.status(404).end();
  }
  // 405 Method Not Allowed
  else if (resp_prim.rsc == enums.rsc_str["OPERATION_NOT_ALLOWED"]) {
    resp.status(405).end();
  }
});

// both used for requeset and response
function httpToPrim(http_req) {
  let prim = { fc: {} };
  let query = "";

  // parsing 'To' param

  prim.to = http_req.url.split("?")[0];
  if (prim.to.includes("/_")) {
    // console.log('absolute');
    prim.to = prim.to.replace("/_/", "//"); // '/_' => '//', Absolute format
  } else if (prim.to.includes("/~")) {
    // console.log('sp-relative');
    prim.to = prim.to.replace("/~/", "/"); // '/~' => '/', SP-relative format
  } else {
    // console.log('cse-relative');
    prim.to = prim.to.replace(/^\/+/g, ""); // remove leading slash, CSE-relative format, this handling should be the last one
  }

  // parsing 'From' paramter
  if (http_req.headers["x-m2m-origin"] != null) {
    //
    prim.fr = http_req.headers["x-m2m-origin"];
  }

  // parsing 'M2M Service User' paramter
  if (http_req.headers["x-m2m-user"] != null) {
    //
    prim.user = http_req.headers["x-m2m-user"];
  }

  // parsing 'Request Identifier' paramter
  if (http_req.headers["x-m2m-ri"] != null) {
    //
    prim.rqi = http_req.headers["x-m2m-ri"];
  }

  // parsing 'Request Version Indicator' paramter
  if (http_req.headers["x-m2m-rvi"]) {
    //
    prim.rvi = http_req.headers["x-m2m-rvi"];
  }

  // parsing HTTP Content-Type

  // 'operation' mapping
  if (http_req.headers["content-type"] != null) {
    // CREATE, UPDATE or NOTIFY
    // Content-Type for CREATE request: e.g. "application/json; ty=3"
    if (http_req.headers["content-type"].split(";")[1] == null) {
      if (http_req.method === "GET") {
        prim.op = 2; // DELETE
      } else if (http_req.method === "PUT") {
        prim.op = 3; // UPDATE
      } else if (http_req.method === "DELETE") {
        prim.op = 4; // DELETE
      } else {
        prim.op = 5; // NOTIFY
      }
    } else {
      prim.op = 1; // CREATE
    }

    // 'resource type' (ty) mapping
    if (http_req.headers["content-type"].includes(";") == true) {
      try {
        prim.ty = parseInt(
          http_req.headers["content-type"].split(";")[1].split("=")[1]
        );
      } catch (err) {
        console.error(err);
      }
    }
  } else {
    // map other operations from REQ METHOD
    if (http_req.method == "GET") {
      prim.op = 2;
    } else if (http_req.method == "DELETE") {
      prim.op = 4;
    } else {
      console.log("This shall not happen: OP param is not resolved!\n");
    }
  }

  //
  // parsing HTTP query string
  //

  query = http_req.query;

  if (query.fu) prim.fc.fu = parseInt(query.fu); // filter usage
  if (query.crb) prim.fc.crb = query.crb; // created before
  if (query.cra) prim.fc.cra = query.cra; // created after
  if (query.ms) prim.fc.ms = query.ms; // modified since
  if (query.us) prim.fc.us = query.us; // unmodified since
  if (query.sts) prim.fc.sts = parseInt(query.sts); // stateTag smaller
  if (query.stb) prim.fc.stb = parseInt(query.stb); // stateTag bigger
  if (query.exb) prim.fc.exb = query.exb; // expire before
  if (query.exa) prim.fc.exa = query.exa; // expire after
  if (query.lbl) prim.fc.lbl = query.lbl.split(" "); // label => 0..n (delimeter for multi tags are '+')
  if (query.ty) {
    if (Array.isArray(query.ty))
      prim.fc.ty = query.ty.map((ty) => {
        return parseInt(ty);
      });
    else {
      str_tys = query.ty.split(" "); // resource type => 0..n
      prim.fc.ty = str_tys.map((ty) => {
        return parseInt(ty);
      });
    }
  }
  if (query.sza) prim.fc.sza = parseInt(query.sza); // size above
  if (query.szb) prim.fc.szb = parseInt(query.szb); // size below
  if (query.lim) prim.fc.lim = parseInt(query.lim); // limit
  if (query.cty) prim.fc.cty = query.cty.split(" "); // content type => 0..n
  if (query.fo) prim.fc.fo = query.fo; // filter operation
  if (query.lvl) prim.fc.lvl = parseInt(query.lvl); // level
  if (query.ofst) prim.fc.ofst = parseInt(query.ofst); // offset
  if (query.rt) prim.rt = { rtv: parseInt(query.rt) }; // result type
  if (query.rcn) prim.rcn = parseInt(query.rcn); // result content type
  if (query.drt) prim.drt = parseInt(query.drt); // desired identifier result type	
  if (query.atrl) {
    let atrl = query.atrl.split(" ");
    prim.pc = { atrl };
  } // attribue list, this shall be mapped to 'content' param
  if (query.tids) prim.fc.tids = query.tids.split(" ");

  // 'attribute' criteria
  // note that 'attribute' does not appeal in the HTTP query-string, but below elements are shown
  // to-do: check if this is correct per spec ('rn=aa&rn=bb') 
  if (query.rn) prim.fc.rn = query.rn;
  if (query.cr) prim.fc.cr = query.cr;
  if (query.aei) prim.fc.aei = query.aei;
  if (query.name) prim.fc.name = query.name.split(" ");
  if (query.cnd) prim.fc.cnd = query.cnd.split(" ");
  if (query.smf) prim.fc.smf = query.smf; // semantic filer which is URL encoded SPARQL query
  if (query.or) prim.fc.or = query.or.split(" "); // semantic filer which is URL encoded SPARQL query
  if (query.sqi) {
    try {
      prim.sqi = JSON.parse(query.sqi);
    } catch (err) {
      console.log(err.message);
      prim.parsingError =
        'semantic query indicator (sqi) shall be either "true" or "false"';
      return prim;
    }
  }

  // geo-query filter criteria
  if (query.gmty) prim.fc.gmty = parseInt(query.gmty);
  if (query.gsf) prim.fc.gsf = parseInt(query.gsf);
  if (query.geom) {
    try {
      prim.fc.geom = JSON.parse(query.geom);
    } catch (err) {
      console.log('Geometry JSON parsing error:', err.message);
      prim.parsingError = `Geometry query parameter JSON parsing error: ${err.message}`;
      return prim;
    }
  }


  // to-do: after # never gets delivered
  // prim.to.replace('%23', '#'); // convert '%23' to '#' of url
  try {
    if (http_req.body) prim.pc = http_req.body;
  } catch {
    prim.parsingError = "HTTP body parsing error";
    return prim;
  }

  return prim;
}

// convert response primitive into HTTP response
function primToHttp(prim, resp) {
  resp.set("X-M2M-RI", prim.rqi);
  resp.set("X-M2M-RSC", prim.rsc);
  resp.set("X-M2M-RVI", prim.rvi);
  
  // Set primitive content (pc) as HTTP response payload if it exists
  if (prim.pc) {
    resp.set("Content-Type", "application/json");
  } 
}

// global error handler
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  
  const resp_prim = {
    rsc: enums.rsc_str["INTERNAL_SERVER_ERROR"],
    pc: { "m2m:dbg": "Internal server error" }
  };
  
  res.status(500).json(resp_prim.pc);
});

// unhandled Promise rejection handler
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // do not terminate the app, just log the error
});

// uncaught exception handler
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // do not terminate the app, just log the error
});