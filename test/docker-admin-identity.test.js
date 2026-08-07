"use strict";
// Where the container's administrator identity comes from — docker/admin-identity.js.
//
// The container has to have a cse.admin before mobius4 boots (config/validate.js exits without
// one) and it has to be the *same* one on every start. db/init.js writes the identity into the
// admin <accessControlPolicy> on first boot and skips the step forever after, so an identity
// regenerated on the second start would leave the deployment locked out of its own CSE: the
// policy would still name the first one, and every administrator request would come back 4103.
//
// That is what these tests are about. The order of the three sources is not a preference, it is
// the thing that keeps a generated identity stable.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveAdminIdentity, generate, PREFIX, ALPHABET, DEFAULT_LENGTH } =
  require("../docker/admin-identity");

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobius4-identity-"));
  return { dir, file: path.join(dir, "sub", "cse-admin") };
}

test("takes the environment value when one is set, and writes nothing", () => {
  const { dir, file } = tmpFile();
  try {
    const got = resolveAdminIdentity({ fromEnv: "Sops-chosen", file });
    assert.equal(got.identity, "Sops-chosen");
    assert.equal(got.source, "environment");
    assert.equal(fs.existsSync(file), false,
      "an operator-supplied identity has somewhere to live already; the volume copy would be a second place to keep it in sync");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("treats a blank or whitespace environment value as absent", () => {
  // docker-compose.yml passes CSE_ADMIN: ${CSE_ADMIN:-}, so an unset variable in .env arrives as
  // an empty string rather than not arriving. Taking it literally would hand config/validate.js
  // an empty identity and stop the container with a message about configuration the operator
  // never wrote.
  for (const blank of ["", "   ", "\n"]) {
    const { dir, file } = tmpFile();
    try {
      const got = resolveAdminIdentity({ fromEnv: blank, file });
      assert.equal(got.source, "generated", `"${JSON.stringify(blank)}" should not be taken as an identity`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("generates on the first start and reuses the same value on every start after", () => {
  // The regression this file exists for. Three starts, one identity.
  const { dir, file } = tmpFile();
  try {
    const first = resolveAdminIdentity({ file });
    assert.equal(first.source, "generated");

    const second = resolveAdminIdentity({ file });
    const third = resolveAdminIdentity({ file });

    assert.equal(second.source, "file");
    assert.equal(third.source, "file");
    assert.equal(second.identity, first.identity,
      "a second start must not generate a new identity: the database still names the first one");
    assert.equal(third.identity, first.identity);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the environment wins over a stored identity", () => {
  // So that an operator can move to a chosen identity without deleting the volume — paired, in
  // the entrypoint, with a check against what the database already records.
  const { dir, file } = tmpFile();
  try {
    const generated = resolveAdminIdentity({ file }).identity;
    const got = resolveAdminIdentity({ fromEnv: "Schosen-later", file });

    assert.equal(got.identity, "Schosen-later");
    assert.equal(got.source, "environment");
    assert.equal(fs.readFileSync(file, "utf8").trim(), generated,
      "the stored value should be left alone, not overwritten by the environment");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writes the identity file so that only its owner can read it", () => {
  const { dir, file } = tmpFile();
  try {
    resolveAdminIdentity({ file });
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, `the identity is a credential; mode was ${mode.toString(8)}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable identity file is an error, not a reason to generate a second identity", () => {
  // A volume that is mounted but not writable, or a file that lost its permissions, would
  // otherwise look exactly like "no identity yet" — and the value already in it is the one the
  // database agrees with. Failing loudly is recoverable; generating past it is not.
  const io = {
    readFileSync() { const err = new Error("EACCES"); err.code = "EACCES"; throw err; },
    mkdirSync() { throw new Error("should not have reached generation"); },
    writeFileSync() { throw new Error("should not have reached generation"); },
  };
  assert.throws(() => resolveAdminIdentity({ file: "/nowhere/cse-admin", io }), /EACCES/);
});

test("a generated identity starts with S, as an SP-assigned AE-ID-Stem does", () => {
  // TS-0001:7.2 — "First character of AE-ID-Stem is 'S': The AE-ID-Stem is assigned by the
  // M2M-SP. In this case, the AE-ID-Stem shall be unique within the context of the M2M-SP
  // Domain." An administrator identity chosen by the deployment is exactly that.
  for (let i = 0; i < 50; i++) {
    assert.equal(generate()[0], PREFIX);
  }
});

test("a generated identity uses only characters an AE-ID-Stem may contain", () => {
  // Same clause: the stem is "a sequence of characters that may include any of the unreserved
  // characters defined in clause 2.3 of the IETF RFC 3986". Anything outside that set would be
  // an identity the standard does not allow — and this value travels in X-M2M-Origin.
  const RFC3986_UNRESERVED = /^[A-Za-z0-9\-._~]+$/;
  for (let i = 0; i < 50; i++) {
    const id = generate(24);
    assert.match(id, RFC3986_UNRESERVED, `${id} contains a character outside the unreserved set`);
  }
  assert.ok(!ALPHABET.includes("~"),
    "'~' is unreserved but is also a shell glob and a home-directory shorthand, and this value gets pasted into commands");
});

test("generated identities do not repeat", () => {
  // Not a proof of entropy — a collision here would mean something is badly wrong, such as a
  // seeded or time-based generator.
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(generate());
  assert.equal(seen.size, 500);
});

test("the default length is 12, and a length can be asked for", () => {
  // 11 generated characters over a 65-character alphabet is about 2^66. The value is a bearer
  // credential — anything sending it as X-M2M-Origin gets what the admin policy allows — so the
  // default is not the six characters that "SM" suggests, which would be about 2^30.
  assert.equal(DEFAULT_LENGTH, 12);
  assert.equal(generate().length, 12);
  assert.equal(generate(6).length, 6);
  assert.equal(generate(32).length, 32);
  assert.throws(() => generate(1), /at least 2/);
});
