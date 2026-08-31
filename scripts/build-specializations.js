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
//   node scripts/build-specializations.js [--manifest <path>] [--out <path>] [--allow-removals]
//
// Both --flag value and --flag=value are accepted. Anything else is refused rather than ignored:
// the defaults are the production paths, so a silently dropped argument rewrites the real registry.
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
//
// Redirects are not one of the bounds: fetchXsd passes redirect: "follow" and leaves the limit to
// fetch's own default. There is deliberately no constant for it -- a named limit that nothing
// enforces reads like a guarantee this file does not make.
const FETCH_TIMEOUT_MS = 10000;
const MAX_XSD_BYTES = 1024 * 1024;

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
  // Null prototype, for the same reason extractSpecialization uses one for the attribute map: a cnd
  // of __proto__ would rewrite the prototype instead of adding a key, so the specialization would
  // vanish from Object.keys() while `cnd in registry` still answered true for every inherited name
  // -- checkNoSilentDeletion would then read a removal as present and drop it silently.
  const registry = Object.create(null);
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
  let raw;
  try {
    raw = fs.readFileSync(outPath, "utf8");
  } catch (err) {
    // ENOENT is the only read failure that is safe to pass over: there is no previous registry, so
    // nothing can be lost. Every other failure means a registry may well exist and could not be
    // read -- returning here would skip the removal check and then overwrite a file whose contents
    // were never compared, which is the exact loss this function exists to prevent.
    if (err.code === "ENOENT") return;
    throw new Error(`cannot read the existing registry at ${outPath} — ${err.message}`);
  }

  let previous;
  try {
    previous = JSON.parse(raw);
  } catch (err) {
    throw new Error(`the existing registry at ${outPath} is not valid JSON — ${err.message}`);
  }

  // JSON.parse accepts a bare scalar, so `null`, `5` and `true` all parse. Object.keys(null) then
  // throws a TypeError that names neither the file nor the problem, and a scalar simply has no
  // keys -- so the removal check passed silently over a file it had not understood.
  if (previous === null || typeof previous !== "object" || Array.isArray(previous)) {
    const found = previous === null ? "null" : Array.isArray(previous) ? "an array" : `a ${typeof previous}`;
    throw new Error(
      `the existing registry at ${outPath} is not a JSON object of containerDefinitions — found ${found}`
    );
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
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 4)}\n`, "utf8");
    fs.renameSync(tmp, outPath);
  } finally {
    // The temp file is an implementation detail of the rename and must not outlive this call. If
    // the write or the rename throws it is otherwise left beside the real registry, where the next
    // operator finds a specializations.json.tmp-8167 and has to work out whether it matters. After
    // a successful rename there is nothing at this path, which is what `force` covers.
    fs.rmSync(tmp, { force: true });
  }
}

// Flags that take a value, mapped to the field each one sets.
const VALUE_FLAGS = { "--manifest": "manifestPath", "--out": "outPath" };
const BOOLEAN_FLAGS = { "--allow-removals": "allowRemovals" };
const USAGE = "usage: node scripts/build-specializations.js [--manifest <path>] [--out <path>] [--allow-removals]";

// Both `--flag value` and `--flag=value` are accepted; anything else -- an unrecognised token, a
// flag whose value is missing, a value on a boolean flag -- is a hard error naming the argument.
//
// Strict on purpose. The defaults are the production paths, so a parser that ignores what it does
// not understand turns a rehearsal on temporary paths into a rewrite of the real registry: the
// equals form used to be an unrecognised token, and `--out` with nothing after it used to be a
// silent fallback. Both exited 0 and printed a success summary. Falling back is only right when
// the operator supplied nothing at all, which is the argv.length === 0 case below.
function parseArgs(argv) {
  const parsed = { manifestPath: DEFAULT_MANIFEST, outPath: DEFAULT_OUT, allowRemovals: false };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);

    if (Object.hasOwn(BOOLEAN_FLAGS, name)) {
      if (eq !== -1) throw new Error(`${name} takes no value, but got ${token}\n${USAGE}`);
      parsed[BOOLEAN_FLAGS[name]] = true;
      continue;
    }
    if (!Object.hasOwn(VALUE_FLAGS, name)) {
      throw new Error(`unrecognised argument: ${token}\n${USAGE}`);
    }

    let value;
    if (eq !== -1) {
      value = token.slice(eq + 1);
    } else {
      value = argv[i + 1];
      i += 1;
      // A following token that is itself a flag is a missing value, not a path: `--out
      // --allow-removals` means the operator dropped the path.
      if (typeof value === "string" && value.startsWith("--")) value = "";
    }
    if (!value) {
      throw new Error(`${name} needs a path — it was given none\n${USAGE}`);
    }
    parsed[VALUE_FLAGS[name]] = value;
  }

  parsed.manifestPath = path.resolve(parsed.manifestPath);
  parsed.outPath = path.resolve(parsed.outPath);
  return parsed;
}

async function main(argv) {
  const { manifestPath, outPath, allowRemovals } = parseArgs(argv);

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
  parseArgs, main,
  DEFAULT_MANIFEST, DEFAULT_OUT, MAX_XSD_BYTES,
};
