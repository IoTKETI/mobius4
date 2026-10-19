"use strict";
// Normalizes a contentSerialization (csz) list to the short form TS-0004:6.3.3 enumerates --
// xml, json, cbor -- while also accepting the MIME media types TS-0004:6.7 lists for the same
// three serializations over the HTTP binding: application/xml, application/vnd.onem2m-res+xml,
// application/json, application/vnd.onem2m-res+json, application/cbor and
// application/vnd.onem2m-res+cbor.
//
// Why this exists: csz is stored in a VARCHAR(10)[] column, sized for the short form. A CSE
// sending a MIME spelling (ACME, acting as an MN-CSE, does) got the value written as-is, and
// Postgres answered "value too long for type character varying(10)" -- a database error string
// that then leaked into the client's m2m:dbg as a 4000. Folding known spellings here, before
// anything reaches the database, is what stops both the rejection and the leak.

const ENUM_VALUES = ["xml", "json", "cbor"];

const MIME_TO_ENUM = {
    "application/xml": "xml",
    "application/vnd.onem2m-res+xml": "xml",
    "application/json": "json",
    "application/vnd.onem2m-res+json": "json",
    "application/cbor": "cbor",
    "application/vnd.onem2m-res+cbor": "cbor",
};

// Folds one csz entry to its short form, or returns null if it is neither a recognised short
// form nor one of the TS-0004:6.7 media types. MIME type/subtype matching is case-insensitive
// and parameters after ';' (e.g. "application/json; charset=utf-8") are ignored -- RFC 6838
// syntax, not anything csz-specific.
function normalize_one(raw) {
    const candidate = String(raw).split(";")[0].trim().toLowerCase();
    if (ENUM_VALUES.includes(candidate)) return candidate;
    if (MIME_TO_ENUM[candidate]) return MIME_TO_ENUM[candidate];
    return null;
}

/**
 * Normalizes a csz list. Returns { value } on success -- the recognised short forms, duplicates
 * dropped and first-occurrence order kept, which is what TS-0001:9.6.4 means by "the list is
 * ordered starting with the most preferred format" -- or { error } with the first original
 * value this CSE could not recognise.
 *
 * null/undefined pass through unchanged: csz is optional on both Create and Update of
 * <remoteCSE> and <AE> (TS-0004:7.4.4.1), and its absence means "leave this attribute alone",
 * which the caller already handles.
 */
function normalize_serializations(list) {
    if (list === null || list === undefined) return { value: list };

    const result = [];
    for (const raw of list) {
        const normalized = normalize_one(raw);
        if (normalized === null) return { error: raw };
        if (!result.includes(normalized)) result.push(normalized);
    }
    return { value: result };
}

module.exports = { normalize_serializations };
