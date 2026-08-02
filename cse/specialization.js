const fs = require('node:fs');
const path = require('node:path');
const logger = require('../logger').forFile(__filename);

// <flexContainer> specialization registry.
//
// oneM2M (TS-0004:7.4.37.2.1) requires the hosting CSE to validate a <flexContainer>
// against the schema referenced by its containerDefinition (cnd) attribute, returning
// SPECIALIZATION_SCHEMA_NOT_FOUND when that schema is unavailable. Fetching and parsing
// an arbitrary XSD at request time would put an external network dependency on the CREATE
// path, so the schema contract is declared locally instead: the registry maps a cnd URI to
// the specialization's type name, namespace prefix and custom attributes.
//
// The registry is its own file rather than a key in config/default.json. It is data about
// the deployment's information model, not CSE settings, and it grows one entry per
// specialization — keeping it separate means adding a specialization never touches the
// settings file, and the two can be reviewed, diffed and deployed independently.
//
// Custom attribute names are stored and matched exactly as they appear on the wire. No
// long-name/short-name translation is performed: TS-0004:8.2.1 confines the short-name
// tables to clauses 8.2.2-8.2.5, which cover only oneM2M-defined names. A third-party
// specialization has no such table, so its own attribute names are the wire names.

const REGISTRY_PATH = path.join(__dirname, '..', 'config', 'specializations.json');

// Read once at startup, like the rest of the configuration. Adding a specialization
// therefore requires a restart; loading it dynamically is tracked separately.
let REGISTRY = {};
try {
    REGISTRY = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    logger.info({ path: REGISTRY_PATH, count: Object.keys(REGISTRY).length },
        'flexContainer specialization registry loaded');
} catch (err) {
    // Not fatal: a deployment that uses no <flexContainer> has no reason to carry this file.
    // Log loudly anyway — with an empty registry every cnd is answered with 4125, and that is
    // far easier to diagnose from this line than from the rejections alone.
    logger.warn({ err, path: REGISTRY_PATH },
        'flexContainer specialization registry unavailable — every containerDefinition will be rejected with SPECIALIZATION_SCHEMA_NOT_FOUND');
}

// Universal, common and <flexContainer>-specific attributes from TS-0004:7.4.37.1
// tables 7.4.37.1-1 and 7.4.37.1-2. Any key outside this set is a [customAttribute].
const RESERVED_ATTRS = new Set([
    // universal
    'ty', 'ri', 'rn', 'pi', 'ct', 'lt',
    // common
    'lbl', 'acpi', 'et', 'daci', 'cstn', 'at', 'aa', 'ast', 'st', 'cr', 'loc',
    // <flexContainer> specific
    'cnd', 'or', 'cs', 'nl', 'mni', 'mia', 'mbs', 'cni', 'cbs',
]);

// Returns the registry entry for a cnd URI, or null when the specialization is unknown.
// A null result is what the caller turns into SPECIALIZATION_SCHEMA_NOT_FOUND (4125).
function lookup(cnd) {
    if (!cnd) return null;
    return REGISTRY[cnd] || null;
}

// The envelope key a payload for this specialization must use, e.g. 'sc:parkingBlock'.
function expected_envelope_key(entry) {
    return `${entry.namespacePrefix}:${entry.typeName}`;
}

// Splits a resource representation into reserved attributes and custom attributes.
function split_attributes(prim_res) {
    const reserved = {}, custom = {};
    for (const [key, value] of Object.entries(prim_res)) {
        if (RESERVED_ATTRS.has(key)) reserved[key] = value;
        else custom[key] = value;
    }
    return { reserved, custom };
}

function type_matches(declared, value) {
    switch (declared) {
        case 'string': return typeof value === 'string';
        case 'integer': return Number.isInteger(value);
        case 'number': return typeof value === 'number';
        case 'boolean': return typeof value === 'boolean';
        case 'array': return Array.isArray(value);
        case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
        // An unknown declared type is a registry authoring error, not a client error —
        // accept the value rather than rejecting a well-formed request.
        default: return true;
    }
}

// Validates custom attributes against the specialization's declaration.
// A null value means "delete this attribute" (oneM2M UPDATE convention) and is always
// accepted for a declared name, so its type is not checked.
function validate_custom(entry, custom) {
    const declared = entry.attributes || {};

    for (const [key, value] of Object.entries(custom)) {
        if (!(key in declared)) {
            return { ok: false, message: `${key} is not declared by specialization ${entry.typeName}` };
        }
        if (value === null) continue;
        if (!type_matches(declared[key].type, value)) {
            return { ok: false, message: `${key} must be of type ${declared[key].type}` };
        }
    }

    return { ok: true };
}

module.exports = {
    RESERVED_ATTRS,
    lookup,
    expected_envelope_key,
    split_attributes,
    validate_custom,
};
