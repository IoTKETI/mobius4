"use strict";
// Builds config/specializations.json from a manifest of XSDs.
//
// Why a manifest, and why cnd and xsd are separate fields: containerDefinition is an identifier,
// not a location. TS-0023:6.4.1 calls it one, and the values the standard actually assigns are
// reverse-DNS strings that point nowhere -- "org.onem2m.common.moduleclass.alarmSpeaker"
// (TS-0023:6.4.3), "org.onem2m.management.device.flexNode" (TS-0023:5.8.1). Its XSD type is
// xs:anyURI, which permits a URL but does not require one. So the XSD's location cannot be derived
// from the cnd; it has to be declared, and this file is where.
//
// Run by an operator, not on any request path:
//   node scripts/build-specializations.js [--manifest <path>] [--out <path>]
//
// The registry is read once at startup (cse/specialization.js), so a rebuild takes effect on the
// next restart. That is the whole reason this is a build step and not an API: restarting mobius4
// costs about a third of a second, and several specializations can be added in one pass.

const fs = require("node:fs");
const path = require("node:path");
const { extractSpecialization } = require("./lib/xsd-specialization");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_MANIFEST = path.join(REPO_ROOT, "config", "specializations.manifest.json");
const DEFAULT_OUT = path.join(REPO_ROOT, "config", "specializations.json");

// Bounds on reading an XSD over the network. This runs as a deliberate operator command rather than
// on a request path, so the exposure is small -- but an unbounded fetch in a build step is still a
// build step that can hang forever.
const FETCH_TIMEOUT_MS = 10000;
const MAX_XSD_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;

function readManifest(manifestPath) {
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch (err) {
    throw new Error(`cannot read the manifest at ${manifestPath}: ${err.message}`);
  }

  let entries;
  try {
    entries = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${manifestPath} is not valid JSON: ${err.message}`);
  }

  if (!Array.isArray(entries)) {
    throw new Error(`${manifestPath} must contain a JSON array of entries`);
  }

  const seen = new Set();
  for (const [i, entry] of entries.entries()) {
    if (!entry || typeof entry !== "object") throw new Error(`entry ${i} is not an object`);
    if (!entry.cnd || typeof entry.cnd !== "string") {
      throw new Error(`entry ${i} has no 'cnd' — the containerDefinition the resource will carry`);
    }
    if (!entry.xsd || typeof entry.xsd !== "string") {
      throw new Error(`entry ${i} (${entry.cnd}) has no 'xsd' — a path or an http(s) URL`);
    }
    // Keeping the last of a duplicate pair would make the registry depend on manifest order, and
    // an operator who pasted an entry twice with different XSDs would not be told.
    if (seen.has(entry.cnd)) throw new Error(`duplicate cnd in the manifest: ${entry.cnd}`);
    seen.add(entry.cnd);
  }
  return entries;
}

async function fetchXsd(url, cnd) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (Buffer.byteLength(text) > MAX_XSD_BYTES) {
      throw new Error(`larger than ${MAX_XSD_BYTES} bytes`);
    }
    return text;
  } catch (err) {
    throw new Error(`${cnd}: cannot read ${url} — ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function resolveSource(entry, manifestDir) {
  const src = entry.xsd;
  if (/^https?:\/\//i.test(src)) return fetchXsd(src, entry.cnd);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) {
    throw new Error(`${entry.cnd}: only http and https URLs are read, got ${src}`);
  }
  const file = path.resolve(manifestDir, src);
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`${entry.cnd}: cannot read ${file} — ${err.message}`);
  }
}

async function buildRegistry(entries, manifestDir) {
  const registry = {};
  for (const entry of entries) {
    const xsdText = await resolveSource(entry, manifestDir);
    registry[entry.cnd] = extractSpecialization(xsdText, { cnd: entry.cnd });
  }
  return registry;
}

module.exports = {
  readManifest, resolveSource, buildRegistry,
  DEFAULT_MANIFEST, DEFAULT_OUT, MAX_REDIRECTS,
};
