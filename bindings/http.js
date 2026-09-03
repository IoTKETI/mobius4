const config = require("config");
const http = require("http");
const https = require("https");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const pinoHttp = require("pino-http");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const app = express();

const logger = require("../logger");
const enums = require("../config/enums");
const reqPrim = require("../cse/reqPrim");
const metrics = require("../metrics");
const pool = require("../db/connection");

// Security: Helmet (configurable, default off)
if (config.get("security.helmet.enabled")) {
  app.use(helmet());
}

// Security: Rate limiting (configurable, default off)
const rateLimitConfig = config.get("security.rateLimit");
if (rateLimitConfig.enabled) {
  app.use(rateLimit({
    windowMs: rateLimitConfig.windowMs,
    max: rateLimitConfig.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { "m2m:dbg": "Too many requests, please try again later." }
  }));
}

// JSON body parsing BEFORE pinoHttp so req.body is available in the serializer
app.use(express.json({
  limit: config.get("request.max_body_size"),
  type: ['application/json', 'application/vnd.onem2m-res+json', 'application/*+json']
}));
app.use(express.urlencoded({ extended: true, limit: config.get("request.max_body_size") }));
app.use(cors());

// Capture response body so pino-http res serializer can include it
app.use((req, res, next) => {
  const _json = res.json.bind(res);
  res.json = function(body) {
    res._body = body;
    return _json(body);
  };
  next();
});

// HTTP request/response structured logging
app.use(pinoHttp({
  logger,
  genReqId: (req) => req.headers["x-m2m-ri"] || req.headers["x-request-id"],
  customLogLevel(req, res, err) {
    if (res.statusCode >= 500 || err) return "error";
    if (res.statusCode >= 400) return "warn";
    return "debug";
  },
  serializers: {
    req(req) {
      return {
        method: req.method,
        url: req.url,
        op: req.headers["x-m2m-op"],
        fr: req.headers["x-m2m-origin"],
        rqi: req.headers["x-m2m-ri"],
        rvi: req.headers["x-m2m-rvi"],
        body: req.body || undefined,
      };
    },
    res(res) {
      return {
        statusCode: res.statusCode,
        rsc: res.getHeader ? res.getHeader("x-m2m-rsc") : undefined,
        body: res._body || undefined,
      };
    }
  },
  autoLogging: { ignore: (req) => req.url === "/health" || req.url === "/metrics" }
}));

// HTTP metrics middleware (no-op when metrics.enabled is false)
app.use((req, res, next) => {
  const end = metrics.httpRequestDuration.startTimer({ method: req.method });
  res.on('finish', () => {
    metrics.httpRequestsTotal.inc({ method: req.method, status_code: res.statusCode });
    end();
  });
  next();
});

// JSON parsing error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    logger.warn({ err: error, url: req.url }, 'JSON parsing error');
    const resp_prim = {
      rsc: enums.rsc_str["BAD_REQUEST"],
      pc: { "m2m:dbg": `JSON parsing error: ${error.message}` }
    };
    res.status(400).json(resp_prim.pc);
    return;
  }
  next(error);
});


// http server setup
http.globalAgent.maxSockets = 100 * 100;
const server = http.createServer(app).listen(config.http.port);
// keepAliveTimeout, not keep_alive_timeout. Node's property is camelCase, so the snake_case
// spelling here only ever added an unused property to the server object -- cse.keep_alive_timeout
// was read, multiplied, assigned, and then had no effect at all. Every deployment ran on Node's
// default of 5 seconds regardless of what it configured, and a client holding a session open saw
// it closed under it with "Keep-Alive: timeout=5" in the responses.
server.keepAliveTimeout = config.cse.keep_alive_timeout * 1000;

// headersTimeout has to outlast keepAliveTimeout. It bounds how long the request line and headers
// may take to arrive, and Node's default is 60 seconds -- so a keep-alive above that would let a
// socket be kept open longer than the server is willing to wait for the next request on it, which
// closes connections the client believed were good. Kept a margin above rather than equal, because
// the two timers start from different events and an exact tie is a race.
if (server.headersTimeout <= server.keepAliveTimeout) {
  server.headersTimeout = server.keepAliveTimeout + 5000;
}
if (server) {
  logger.info({ port: config.http.port }, 'HTTP server listening');
}

// https server setup
//
// Optional, and off by default. It used to be neither: the three readFileSync calls below ran at
// module load with no condition and no try/catch, so a deployment without certs/ could not start
// at all -- which is also why `docker compose up` could not work until this became a flag.
//
// Server authentication only. Until v4.7.0 this listener also set requestCert and
// rejectUnauthorized, which reads as mutual TLS, but nothing ever looked at the certificate the
// client presented: there is no getPeerCertificate call anywhere in this source, so the identity
// proved by the handshake was never compared with the X-M2M-Origin the request claimed. Any
// holder of a certificate signed by the configured CA could act as any originator, including the
// administrator. Keeping the mechanism would have meant keeping an assurance that was not there.
// Binding a certificate to an originator is worth doing (TS-0003 territory) and is tracked
// separately; this listener now claims only what it delivers, which is an encrypted channel and
// an authenticated server.
let https_server;

if (config.https.enabled) {
  // Turning HTTPS on and leaving the files unreadable is a misconfiguration, not a reason to
  // serve plain HTTP silently: whoever set the flag meant to encrypt. So it stops, the way
  // config/validate.js stops for a missing cse.admin, and says which path failed -- an ENOENT
  // stack trace names the file but not the setting that asked for it.
  const read = (label, key) => {
    const path = config.get(key);
    try {
      return fs.readFileSync(path);
    } catch (err) {
      logger.fatal({ err, path, setting: key },
        `https.enabled is true but the ${label} at "${path}" could not be read. Point ${key} ` +
        'at a readable file or set https.enabled to false. See docs/tls.md.');
      process.exit(1);
    }
  };

  const https_options = {
    key: read('private key', 'https.key'),
    cert: read('certificate', 'https.cert'),
  };

  // A chain file is optional: it is needed when the server certificate is issued by an
  // intermediate CA that clients may not already hold.
  if (config.has('https.chain') && config.get('https.chain')) {
    https_options.ca = read('certificate chain', 'https.chain');
  }

  https_server = https.createServer(https_options, app).listen(config.https.port);
  logger.info({ port: config.https.port }, 'HTTPS server listening');
} else {
  logger.info('HTTPS is disabled (https.enabled is false); serving HTTP only');
}

// Prometheus metrics endpoint (always registered to prevent /metrics falling through to oneM2M handler)
app.get('/metrics', async (req, res) => {
  if (!metrics.enabled) {
    return res.status(404).end();
  }
  try {
    res.set('Content-Type', metrics.register.contentType);
    res.end(await metrics.register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

// Health check endpoint.
//
// This is a *readiness* probe: it answers "can this process serve a request", not merely "is the
// process alive". Mobius4 cannot serve anything without its database — every request path starts
// with a lookup — so a health check that skips the database reports a healthy container that
// answers 5000 to everything. An orchestrator would leave it in the load balancer.
//
// The probe reads the `lookup` table rather than issuing `SELECT 1`. `SELECT 1` only proves the
// connection is up, and a reachable database with a missing or unmigrated schema fails every real
// request while passing that check. One indexed row is as cheap as the constant.
//
// It is bounded by the pool's own connectionTimeoutMs, so a wedged database fails this endpoint
// rather than hanging it.
app.get('/health', async (req, res) => {
  const body = { status: 'ok', uptime: process.uptime() };
  try {
    await pool.query('SELECT ri FROM lookup LIMIT 1');
    body.db = 'ok';
    res.json(body);
  } catch (err) {
    // 503, not 500: the process is fine and the condition is expected to clear on its own.
    logger.error({ err }, 'health check: database unreachable');
    res.status(503).json({ status: 'unavailable', uptime: process.uptime(), db: 'unreachable' });
  }
});

// CRUD mapping for HTTP / HTTPs server
app.post('/*', async (req, resp) => {
  const req_prim = httpToPrim(req);

  let resp_prim = {};
  if ("parsingError" in req_prim) {
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": req_prim.parsingError };
  } else {
    resp_prim = await reqPrim.prim_handling(req_prim);
  }

  primToHttp(resp_prim, resp);

  if (resp_prim.rsc == enums.rsc_str["CREATED"]) {
    if (resp_prim.pc) {
      resp.status(201).json(resp_prim.pc);
    } else {
      resp.status(201).end();
    }
  }
  else if (resp_prim.rsc == enums.rsc_str["OK"]) {
    if (resp_prim.pc) {
      resp.status(200).json(resp_prim.pc);
    } else {
      resp.status(200).end();
    }
  }
  else if (
    resp_prim.rsc == enums.rsc_str["BAD_REQUEST"] ||
    resp_prim.rsc == enums.rsc_str["MAX_NUMBER_OF_MEMBER_EXCEEDED"] ||
    resp_prim.rsc == enums.rsc_str["GROUP_MEMBER_TYPE_INCONSISTENT"]) {
    if (resp_prim.pc && resp_prim.pc["m2m:dbg"]) {
      resp.status(400).json(resp_prim.pc);
    } else {
      resp.status(400).end();
    }
  }
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
  else if (resp_prim.rsc == enums.rsc_str["NOT_FOUND"]) {
    send_error(resp, 404, resp_prim);
  }
  else if (resp_prim.rsc == enums.rsc_str["OPERATION_NOT_ALLOWED"]) {
    send_error(resp, 405, resp_prim);
  }
  else if (resp_prim.rsc == enums.rsc_str["NOT_ACCEPTABLE"]) {
    send_error(resp, 406, resp_prim);
  }
  else if (resp_prim.rsc == enums.rsc_str["CONFLICT"]) {
    if (resp_prim.pc && resp_prim.pc["m2m:dbg"]) {
      resp.status(409).json(resp_prim.pc);
    } else {
      resp.status(409).end();
    }
  }
  else if (resp_prim.rsc == enums.rsc_str["INTERNAL_SERVER_ERROR"]) {
    if (resp_prim.pc) {
      resp.status(500).json(resp_prim.pc);
    } else {
      resp.status(500).end();
    }
  }
  else if (
    resp_prim.rsc == enums.rsc_str["NOT_IMPLEMENTED"] ||
    // TS-0009:6.3.2 maps 4125 to 501, in the same group as 4001/5001/5206
    resp_prim.rsc == enums.rsc_str["SPECIALIZATION_SCHEMA_NOT_FOUND"]) {
    if (resp_prim.pc) {
      resp.status(501).json(resp_prim.pc);
    } else {
      resp.status(501).end();
    }
  }
  else {
    send_unmapped_rsc(resp_prim, resp, 'POST');
  }
});

app.get('/*', async (req, resp) => {
  const req_prim = httpToPrim(req);

  let resp_prim = {};
  try {
    resp_prim = await reqPrim.prim_handling(req_prim);
  } catch (err) {
    logger.error({ err }, 'GET request handling failed');
  }
  primToHttp(resp_prim, resp);

  if (resp_prim.rsc == enums.rsc_str["OK"]) {
    if (resp_prim.pc) {
      resp.status(200).json(resp_prim.pc);
    } else {
      resp.status(200).end();
    }
  }
  else if (resp_prim.rsc == enums.rsc_str["BAD_REQUEST"]) {
    if (resp_prim.pc) {
      resp.status(400).json(resp_prim.pc);
    } else {
      resp.status(400).end();
    }
  }
  else if (resp_prim.rsc == enums.rsc_str["ORIGINATOR_HAS_NO_PRIVILEGE"]) {
    if (resp_prim.pc) {
      resp.status(403).json(resp_prim.pc);
    } else {
      resp.status(403).end();
    }
  }
  else if (resp_prim.rsc == enums.rsc_str["NOT_FOUND"]) {
    if (resp_prim.pc) {
      resp.status(404).json(resp_prim.pc);
    } else {
      resp.status(404).end();
    }
  }
  else if (resp_prim.rsc == enums.rsc_str["INTERNAL_SERVER_ERROR"]) {
    if (resp_prim.pc) {
      resp.status(500).json(resp_prim.pc);
    } else {
      resp.status(500).end();
    }
  }
  else if (
    resp_prim.rsc == enums.rsc_str["NOT_IMPLEMENTED"] ||
    resp_prim.rsc == enums.rsc_str["SPECIALIZATION_SCHEMA_NOT_FOUND"]) {
    if (resp_prim.pc) {
      resp.status(501).json(resp_prim.pc);
    } else {
      resp.status(501).end();
    }
  }
  else {
    send_unmapped_rsc(resp_prim, resp, 'GET');
  }
});

app.put('/*', async (req, resp) => {
  const req_prim = httpToPrim(req);

  let resp_prim = {};
  if (req_prim === null) {
    resp_prim.rsc = enums.rsc_str["BAD_REQUEST"];
    resp_prim.pc = { "m2m:dbg": "JSON parsing error" };
  } else {
    resp_prim = await reqPrim.prim_handling(req_prim);
  }

  primToHttp(resp_prim, resp);

  if (resp_prim.rsc == enums.rsc_str["UPDATED"]) {
    if (resp_prim.pc) {
      resp.status(200).json(resp_prim.pc);
    } else {
      resp.status(200).end();
    }
  }
  else if (resp_prim.rsc == enums.rsc_str["OK"]) {
    if (resp_prim.pc) {
      resp.status(200).json(resp_prim.pc);
    } else {
      resp.status(200).end();
    }
  }
  else if (
    resp_prim.rsc == enums.rsc_str["BAD_REQUEST"] ||
    resp_prim.rsc == enums.rsc_str["MAX_NUMBER_OF_MEMBER_EXCEEDED"] ||
    resp_prim.rsc == enums.rsc_str["GROUP_MEMBER_TYPE_INCONSISTENT"]) {
    if (resp_prim.pc && resp_prim.pc.hasOwnProperty("m2m:dbg")) {
      resp.status(400).json(resp_prim.pc);
    } else {
      resp.status(400).end();
    }
  }
  else if (resp_prim.rsc == enums.rsc_str["ORIGINATOR_HAS_NO_PRIVILEGE"]) {
    if (resp_prim.pc && resp_prim.pc.hasOwnProperty("m2m:dbg")) {
      resp.status(403).json(resp_prim.pc);
    } else {
      resp.status(403).end();
    }
  }
  else if (resp_prim.rsc == enums.rsc_str["NOT_FOUND"]) {
    send_error(resp, 404, resp_prim);
  }
  else if (resp_prim.rsc == enums.rsc_str["OPERATION_NOT_ALLOWED"]) {
    send_error(resp, 405, resp_prim);
  }
  else if (resp_prim.rsc == enums.rsc_str["NOT_ACCEPTABLE"]) {
    send_error(resp, 406, resp_prim);
  }
  else if (
    resp_prim.rsc == enums.rsc_str["NOT_IMPLEMENTED"] ||
    resp_prim.rsc == enums.rsc_str["SPECIALIZATION_SCHEMA_NOT_FOUND"]) {
    if (resp_prim.pc) {
      resp.status(501).json(resp_prim.pc);
    } else {
      resp.status(501).end();
    }
  }
  else {
    send_unmapped_rsc(resp_prim, resp, 'PUT');
  }
});

app.delete('/*', async (req, resp) => {
  const req_prim = httpToPrim(req);
  let resp_prim = {};

  resp_prim = await reqPrim.prim_handling(req_prim);

  primToHttp(resp_prim, resp);

  if (resp_prim.rsc == enums.rsc_str["DELETED"]) {
    if (resp_prim.pc) {
      resp.status(200).json(resp_prim.pc);
    } else {
      resp.status(200).end();
    }
  }
  // 'else if', not 'if': as a separate chain the trailing else below would fire again on a
  // DELETED response and Express would throw on the second write.
  else if (resp_prim.rsc == enums.rsc_str["OK"]) {
    if (resp_prim.pc) {
      resp.status(200).json(resp_prim.pc);
    } else {
      resp.status(200).end();
    }
  }
  else if (resp_prim.rsc == enums.rsc_str["BAD_REQUEST"]) {
    if (resp_prim.pc && resp_prim.pc.hasOwnProperty("m2m:dbg")) {
      resp.status(400).json(resp_prim.pc);
    } else {
      resp.status(400).end();
    }
  }
  else if (resp_prim.rsc == enums.rsc_str["ORIGINATOR_HAS_NO_PRIVILEGE"]) {
    if (resp_prim.pc && resp_prim.pc.hasOwnProperty("m2m:dbg")) {
      resp.status(403).json(resp_prim.pc);
    } else {
      resp.status(403).end();
    }
  }
  else if (resp_prim.rsc == enums.rsc_str["NOT_FOUND"]) {
    send_error(resp, 404, resp_prim);
  }
  else if (resp_prim.rsc == enums.rsc_str["OPERATION_NOT_ALLOWED"]) {
    send_error(resp, 405, resp_prim);
  }
  else {
    send_unmapped_rsc(resp_prim, resp, 'DELETE');
  }
});

// Sends an error response, carrying the CSE's own explanation when there is one.
//
// TS-0004:7.5.2 note 5 makes m2m:debugInfo "a plain text message which can optionally be included
// as debugging information in error responses", TS-0004:7.2.1.2 lists it among the things a
// response's Content may be, and TS-0009:6.5 maps the Content parameter to the message-body "for
// all primitives" with two named exceptions -- partial Retrieve requests, and a 4103 carrying
// Token Request Information. None of the codes below is an exception.
//
// Eight branches ended in a bare .end() and threw the message away: 404, 405 and 406 in the POST,
// PUT and DELETE handlers (DELETE has no 406). The CSE had already built the text -- the
// <contentInstance> size refusal names mbs, and the <modelDeployment> compatibility refusal names
// the exact features the dataset was missing -- and the client got Content-Length: 0. Meanwhile
// GET's own 404 branch already did carry it, so the file disagreed with itself.
//
// Only the eight broken sites are routed through here. The branches that were already correct
// (400, 403, 409, GET's 404, 500) keep their inline form: converting them would be a change to
// code that works, in a commit about code that does not.
function send_error(resp, status, resp_prim) {
  if (resp_prim.pc && resp_prim.pc["m2m:dbg"]) {
    resp.status(status).json(resp_prim.pc);
  } else {
    resp.status(status).end();
  }
}

// Last-resort responder for an RSC no branch above matched.
//
// Each verb handler is an if/else-if chain over known response status codes. Without a final
// else an unmapped RSC leaves the request with no response at all, so the client blocks until
// its own timeout rather than seeing an error — the same failure mode as the unwired ty=24/34
// dispatch entries. Answering 500 keeps a missing mapping to a visible bug in one request
// instead of a hung connection.
function send_unmapped_rsc(resp_prim, resp, method) {
  if (resp.headersSent) return;
  logger.error({ method, rsc: resp_prim.rsc }, 'no HTTP status mapping for response status code');
  resp.status(500).json(resp_prim.pc || { "m2m:dbg": `no HTTP status mapping for rsc ${resp_prim.rsc}` });
}

// both used for request and response
function httpToPrim(http_req) {
  let prim = { fc: {} };
  let query = "";

  // parsing 'To' param
  //
  // TS-0009:6.2.2.1 defines "/_" and "/~" as *prefixes* of the path component, marking the
  // Absolute and SP-Relative forms of the To parameter respectively; anything else is
  // CSE-Relative and only needs its leading slash removed.
  //
  // These have to be matched at the start of the path, not merely found somewhere in it.
  // Testing with includes() misread any path holding a segment that begins with "_" -- a
  // resource named "_config" made "/CSEBase/ae/_config" take the Absolute branch, where the
  // replacement found no "/_/" to act on and, worse, the leading slash was never stripped
  // because that only happens in the final branch. To then read "/CSEBase/ae/_config" while
  // every sid in the lookup table is stored without the leading slash, so the resource
  // became unreachable by its hierarchical path -- created successfully, then answering 4004
  // to both retrieve and delete, while remaining reachable by its unstructured resource ID.
  prim.to = http_req.url.split("?")[0];
  if (prim.to.startsWith("/_/")) {
    prim.to = `/${prim.to.slice("/_".length)}`;
  } else if (prim.to.startsWith("/~/")) {
    prim.to = prim.to.slice("/~".length);
  } else {
    prim.to = prim.to.replace(/^\/+/g, "");
  }

  // parsing 'From' parameter
  if (http_req.headers["x-m2m-origin"] != null) {
    prim.fr = http_req.headers["x-m2m-origin"];
  }

  // parsing 'M2M Service User' parameter
  if (http_req.headers["x-m2m-user"] != null) {
    prim.user = http_req.headers["x-m2m-user"];
  }

  // parsing 'Request Identifier' parameter
  if (http_req.headers["x-m2m-ri"] != null) {
    prim.rqi = http_req.headers["x-m2m-ri"];
  }

  // parsing 'Request Version Indicator' parameter
  if (http_req.headers["x-m2m-rvi"]) {
    prim.rvi = http_req.headers["x-m2m-rvi"];
  }

  // 'operation' mapping
  if (http_req.headers["content-type"] != null) {
    if (http_req.headers["content-type"].split(";")[1] == null) {
      if (http_req.method === "GET") {
        prim.op = 2;
      } else if (http_req.method === "PUT") {
        prim.op = 3;
      } else if (http_req.method === "DELETE") {
        prim.op = 4;
      } else {
        prim.op = 5;
      }
    } else {
      prim.op = 1;
    }

    if (http_req.headers["content-type"].includes(";") == true) {
      try {
        prim.ty = parseInt(
          http_req.headers["content-type"].split(";")[1].split("=")[1]
        );
      } catch (err) {
        logger.warn({ err, contentType: http_req.headers["content-type"] }, 'failed to parse resource type from Content-Type');
      }
    }
  } else {
    if (http_req.method == "GET") {
      prim.op = 2;
    } else if (http_req.method == "DELETE") {
      prim.op = 4;
    } else {
      logger.warn({ method: http_req.method, url: http_req.url }, 'op param could not be resolved');
    }
  }

  query = http_req.query;

  if (query.fu) prim.fc.fu = parseInt(query.fu);
  if (query.crb) prim.fc.crb = query.crb;
  if (query.cra) prim.fc.cra = query.cra;
  if (query.ms) prim.fc.ms = query.ms;
  if (query.us) prim.fc.us = query.us;
  if (query.sts) prim.fc.sts = parseInt(query.sts);
  if (query.stb) prim.fc.stb = parseInt(query.stb);
  if (query.exb) prim.fc.exb = query.exb;
  if (query.exa) prim.fc.exa = query.exa;
  if (query.lbl) prim.fc.lbl = query.lbl.split(" ");
  if (query.ty) {
    if (Array.isArray(query.ty))
      prim.fc.ty = query.ty.map((ty) => parseInt(ty));
    else {
      str_tys = query.ty.split(" ");
      prim.fc.ty = str_tys.map((ty) => parseInt(ty));
    }
  }
  if (query.sza) prim.fc.sza = parseInt(query.sza);
  if (query.szb) prim.fc.szb = parseInt(query.szb);
  if (query.lim) prim.fc.lim = parseInt(query.lim);
  if (query.cty) prim.fc.cty = query.cty.split(" ");
  if (query.fo) prim.fc.fo = query.fo;
  if (query.lvl) prim.fc.lvl = parseInt(query.lvl);
  if (query.ofst) prim.fc.ofst = parseInt(query.ofst);
  if (query.rt) prim.rt = { rtv: parseInt(query.rt) };
  if (query.rcn) prim.rcn = parseInt(query.rcn);
  if (query.drt) prim.drt = parseInt(query.drt);
  if (query.atrl) {
    let atrl = query.atrl.split(" ");
    prim.pc = { atrl };
  }
  if (query.tids) prim.fc.tids = query.tids.split(" ");

  if (query.rn) prim.fc.rn = query.rn;
  if (query.cr) prim.fc.cr = query.cr;
  if (query.aei) prim.fc.aei = query.aei;
  if (query.name) prim.fc.name = query.name.split(" ");
  if (query.cnd) prim.fc.cnd = query.cnd.split(" ");
  if (query.smf) prim.fc.smf = query.smf;
  if (query.or) prim.fc.or = query.or.split(" ");
  if (query.sqi) {
    try {
      prim.sqi = JSON.parse(query.sqi);
    } catch (err) {
      logger.warn({ err }, 'sqi parameter parsing failed');
      prim.parsingError = 'semantic query indicator (sqi) shall be either "true" or "false"';
      return prim;
    }
  }

  if (query.gmty) prim.fc.gmty = parseInt(query.gmty);
  if (query.gsf) prim.fc.gsf = parseInt(query.gsf);
  if (query.geom) {
    try {
      prim.fc.geom = JSON.parse(query.geom);
    } catch (err) {
      logger.warn({ err }, 'geom parameter JSON parsing failed');
      prim.parsingError = `Geometry query parameter JSON parsing error: ${err.message}`;
      return prim;
    }
  }

  try {
    // Only when there is something in it. express.json() hands back {} for a request with no body
    // at all, and {} is truthy -- so every GET and DELETE arrived carrying an empty Content, which
    // then travelled with the primitive. Two things came of that: a forwarded DELETE was sent to
    // the next CSE with "{}" as its body, and the atrl partial-retrieve assignment a few lines
    // above (prim.pc = { atrl }) was overwritten by it, so ?atrl=... silently returned the whole
    // resource.
    //
    // Content is 0..1 in a request primitive (TS-0004:6.4.1). Absent is the correct spelling of
    // "no content"; an empty object is a content that says nothing.
    const body = http_req.body;
    const has_content = body !== undefined && body !== null &&
        (typeof body !== 'object' || Array.isArray(body) ? true : Object.keys(body).length > 0);
    if (has_content) prim.pc = body;
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

  if (prim.cnst !== undefined) resp.set("X-M2M-CTS", prim.cnst); // Content Status
  if (prim.cnot !== undefined) resp.set("X-M2M-CTO", prim.cnot); // Content Offset

  if (prim.pc) {
    resp.set("Content-Type", "application/json");
  }
}

// global error handler
app.use((error, req, res, next) => {
  logger.error({ err: error, url: req.url }, 'unhandled request error');

  const resp_prim = {
    rsc: enums.rsc_str["INTERNAL_SERVER_ERROR"],
    pc: { "m2m:dbg": "Internal server error" }
  };

  res.status(500).json(resp_prim.pc);
});

// unhandled Promise rejection handler
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise: String(promise) }, 'unhandled promise rejection');
});

// uncaught exception handler
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception');
});

exports.server = server;
exports.https_server = https_server;
