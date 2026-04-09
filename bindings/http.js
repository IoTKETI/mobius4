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
        rvi: req.headers["x-m2m-rvi"]
      };
    },
    res(res) {
      return {
        statusCode: res.statusCode,
        rsc: res.getHeader ? res.getHeader("x-m2m-rsc") : undefined
      };
    }
  },
  autoLogging: { ignore: (req) => req.url === "/health" || req.url === "/metrics" }
}));

// JSON parsing middleware (application/json)
app.use(express.json({
  limit: config.get("request.max_body_size"),
  type: ['application/json', 'application/vnd.onem2m-res+json', 'application/*+json']
}));
// URL-encoded parsing middleware (if needed)
app.use(express.urlencoded({ extended: true, limit: config.get("request.max_body_size") }));
app.use(cors());

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
server.keep_alive_timeout = config.cse.keep_alive_timeout * 1000;
if (server) {
  logger.info({ port: config.http.port }, 'HTTP server listening');
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
  logger.info({ port: config.https.port }, 'HTTPS server listening');
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
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
    resp.status(404).end();
  }
  else if (resp_prim.rsc == enums.rsc_str["OPERATION_NOT_ALLOWED"]) {
    resp.status(405).end();
  }
  else if (resp_prim.rsc == enums.rsc_str["NOT_ACCEPTABLE"]) {
    resp.status(406).end();
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
  else if (resp_prim.rsc == enums.rsc_str["NOT_IMPLEMENTED"]) {
    if (resp_prim.pc) {
      resp.status(501).json(resp_prim.pc);
    } else {
      resp.status(501).end();
    }
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
    resp.status(404).end();
  }
  else if (resp_prim.rsc == enums.rsc_str["OPERATION_NOT_ALLOWED"]) {
    resp.status(405).end();
  }
  else if (resp_prim.rsc == enums.rsc_str["NOT_ACCEPTABLE"]) {
    resp.status(406).end();
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
  if (resp_prim.rsc == enums.rsc_str["OK"]) {
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
    resp.status(404).end();
  }
  else if (resp_prim.rsc == enums.rsc_str["OPERATION_NOT_ALLOWED"]) {
    resp.status(405).end();
  }
});

// both used for request and response
function httpToPrim(http_req) {
  let prim = { fc: {} };
  let query = "";

  // parsing 'To' param
  prim.to = http_req.url.split("?")[0];
  if (prim.to.includes("/_")) {
    prim.to = prim.to.replace("/_/", "//");
  } else if (prim.to.includes("/~")) {
    prim.to = prim.to.replace("/~/", "/");
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
