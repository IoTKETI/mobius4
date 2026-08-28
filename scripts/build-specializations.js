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
// on a request path, so the exposure is small -- but the two constants guard different failure
// modes. FETCH_TIMEOUT_MS bounds how long a stalled or slow host can hang the build (enforced via
// the AbortController below). MAX_XSD_BYTES bounds how much of the response body ever sits in
// memory at once -- fetchXsd counts bytes as they stream in and aborts as soon as the running total
// crosses the cap, so a misbehaving host serving an arbitrarily large response is never buffered in
// full before the cap can fire.
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
    // Count bytes as they arrive instead of materializing the whole body first, so an oversized
    // response is caught while only part of it has been read -- not after it is already in memory.
    let total = 0;
    const chunks = [];
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > MAX_XSD_BYTES) {
        controller.abort();
        throw new Error(`larger than ${MAX_XSD_BYTES} bytes`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
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
  // path.resolve lets an absolute src or a `..` escape read outside manifestDir. That is fine here:
  // the manifest is authored by the operator running this script with their own filesystem access,
  // not by an untrusted request -- do not "fix" this into a restriction that breaks a legitimate
  // absolute path.
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

// Refuses to drop a cnd that the previous registry had. The manifest is the source of truth, so a
// removal is a legitimate thing to want -- but it is also exactly what happens when an operator
// runs this for the first time without having moved the hand-written entries across, and losing a
// specialization means every <flexContainer> using it starts answering 4125.
function checkNoSilentDeletion(registry, outPath) {
  let previous;
  try {
    previous = JSON.parse(fs.readFileSync(outPath, "utf8"));
  } catch {
    return; // no previous registry, or it is unreadable: nothing can be lost
  }
  const removed = Object.keys(previous).filter((cnd) => !(cnd in registry));
  if (removed.length === 0) return;
  throw new Error(
    `these containerDefinitions are in ${outPath} but not in the manifest, and would be removed:\n` +
    removed.map((c) => `  - ${c}`).join("\n") +
    `\nAdd them to the manifest, or pass --allow-removals if the removal is intended.`
  );
}

// Writes through a temporary file in the same directory, then renames. rename is atomic within a
// filesystem, so a reader either sees the old registry or the new one and never a half-written
// file -- which matters because mobius4 reads this at startup and a truncated read means every
// containerDefinition is refused.
function writeAtomically(registry, outPath) {
  const tmp = `${outPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 4)}\n`, "utf8");
  fs.renameSync(tmp, outPath);
}

async function main(argv) {
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const manifestPath = path.resolve(arg("--manifest", DEFAULT_MANIFEST));
  const outPath = path.resolve(arg("--out", DEFAULT_OUT));
  const allowRemovals = argv.includes("--allow-removals");

  const entries = readManifest(manifestPath);
  const registry = await buildRegistry(entries, path.dirname(manifestPath));
  if (!allowRemovals) checkNoSilentDeletion(registry, outPath);
  writeAtomically(registry, outPath);

  const names = Object.keys(registry);
  console.log(`build-specializations: wrote ${names.length} specialization(s) to ${outPath}`);
  for (const cnd of names) {
    console.log(`  ${cnd} -> ${registry[cnd].namespacePrefix}:${registry[cnd].typeName} ` +
                `(${Object.keys(registry[cnd].attributes).length} custom attribute(s))`);
  }
  console.log("restart mobius4 for this to take effect — the registry is read once at startup");
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    // Loud and specific: the operator is adding several at once and needs to know which one.
    console.error(`build-specializations: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  readManifest, resolveSource, buildRegistry, checkNoSilentDeletion, writeAtomically,
  DEFAULT_MANIFEST, DEFAULT_OUT, MAX_REDIRECTS, MAX_XSD_BYTES,
};
