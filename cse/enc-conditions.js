"use strict";
// The ten value-comparison condition tags of eventNotificationCriteria, and the operation that
// combines them.
//
// TS-0001:9.6.8 table 9.6.8-3 defines each one as a comparison between one attribute of the
// resource and a value the subscriber supplied. The table is the authority for the direction,
// because the names read backwards in two places: modifiedSince matches a lastModifiedTime that is
// *after* the value, and unmodifiedSince one that is *before* it.
//
// The same ten tags also exist in filterCriteria (discovery), which is why the table below is
// exported rather than inlined: one statement of "which attribute, which direction", so the two
// call sites cannot drift into giving different answers for the same tag.
//
//   TS-0001:9.6.8 table 9.6.8-3, verbatim:
//     createdBefore    creationTime is chronologically before the specified value
//     createdAfter     creationTime is chronologically after the specified value
//     modifiedSince    lastModifiedTime is chronologically after the specified value
//     unmodifiedSince  lastModifiedTime is chronologically before the specified value
//     stateTagSmaller  stateTag is smaller than the specified value
//     stateTagBigger   stateTag is bigger than the specified value
//     expireBefore     expirationTime is chronologically before the specified value
//     expireAfter      expirationTime is chronologically after the specified value
//     sizeAbove        contentSize of the <contentInstance> is equal to or greater than the value
//     sizeBelow        contentSize of the <contentInstance> is smaller than the value
//
// sizeAbove is the only inclusive one. The other nine are strict.

// tag -> { attr: short name of the compared attribute, op: comparison direction }
const COMPARISON_TAGS = Object.freeze({
    crb: { attr: 'ct', op: 'lt' },
    cra: { attr: 'ct', op: 'gt' },
    ms:  { attr: 'lt', op: 'gt' },
    us:  { attr: 'lt', op: 'lt' },
    sts: { attr: 'st', op: 'lt' },
    stb: { attr: 'st', op: 'gt' },
    exb: { attr: 'et', op: 'lt' },
    exa: { attr: 'et', op: 'gt' },
    sza: { attr: 'cs', op: 'gte' },
    szb: { attr: 'cs', op: 'lt' },
});

// m2m:filterOperation, CDT-enumerationTypes.xsd:1366. Three values, and note this is not
// m2m:logicalOperator (same file, two values) -- they are different types.
const FILTER_OPERATION = Object.freeze({ AND: 1, OR: 2, XOR: 3 });

// Timestamps are compared as strings. m2m:timestamp is YYYYMMDDThhmmss with an optional comma and
// up to six fractional digits (CDT-commonTypes.xsd:213), all components mandatory, no reduced
// forms, and TS-0004:6.3.3 forbids any timezone suffix -- every value is UTC. The format is
// therefore fixed-width and big-endian down to the second, so byte order is chronological order.
//
// The one place that is not exact: two spellings of the same instant that differ only in how the
// fraction is written ("120000" / "120000,0" / "120000,000") compare as unequal, and since nine of
// the ten conditions are strict inequalities that reads as "strictly before". TS-0004:6.3.3 grants
// a CSE latitude here -- "it need not act on a timestamp with the level of precision that is
// implied by its fractional part" -- and the stored ct/lt/et never carry a fraction, so the case
// needs a subscriber to send one. Integers (st, cs) compare numerically.
function compare(op, value, threshold) {
    switch (op) {
        case 'lt': return value < threshold;
        case 'gt': return value > threshold;
        case 'gte': return value >= threshold;
        // Unreachable: op comes from COMPARISON_TAGS above, which is frozen. Returning false
        // rather than true keeps a future typo from opening the gate instead of closing it.
        default: return false;
    }
}

// Which of the ten tags this enc actually carries.
function present_tags(enc) {
    if (!enc || typeof enc !== 'object') return [];
    return Object.keys(COMPARISON_TAGS).filter(t => enc[t] !== undefined && enc[t] !== null);
}

// Evaluates the comparison group of an eventNotificationCriteria against one resource.
//
// `resource` is the plain attribute object, not the envelope -- the caller unwraps, because the
// envelope key is data-driven for <flexContainer> and cannot be assumed to start with "m2m:".
//
// Two things the spec does not say, decided here and not inferred from it:
//
//  1. A resource that does not carry the compared attribute at all. stateTag exists only on
//     <container>, <contentInstance> and <flexContainer>; contentSize only on <contentInstance>,
//     <flexContainer> and <timeSeriesInstance>. TS-0001:9.6.8 table 9.6.8-3 says "The stateTag
//     attribute of the resource is smaller than the specified value" and is silent on a resource
//     that has none. Read here as **false**: a resource with no stateTag does not satisfy a
//     statement about its stateTag. The alternative -- skipping the condition -- would make an OR
//     of two unevaluable conditions fire, which is the opposite of what a subscriber asking to be
//     filtered wants. <container> carries currentByteSize (cbs), which is a different attribute
//     from contentSize and is deliberately not substituted for it.
//
//  2. No comparison tag present. Read as **true**, so an enc carrying only net behaves exactly as
//     it did before these tags existed. This follows TS-0004:7.5.1.2.2 step 1.0, which presupposes
//     there is a criterion to check, but the clause does not state it.
//
// The combining rule is TS-0001:9.6.8: "Different condition tags shall use the AND/OR/XOR logical
// operation based on the filterOperation specified", default AND, and "The XOR operation evaluates
// to true if and only if an odd number of its inputs are true" -- odd parity, not exactly-one. The
// companion rule "Same condition tags shall use OR" cannot arise here: every one of the ten is
// 0..1 in eventNotificationCriteria (CDT-commonTypes.xsd:659-668), so none can repeat.
function comparison_conditions_match(enc, resource) {
    const tags = present_tags(enc);
    if (tags.length === 0) return true;

    const res = resource && typeof resource === 'object' ? resource : {};
    const results = tags.map((tag) => {
        const { attr, op } = COMPARISON_TAGS[tag];
        const value = res[attr];
        if (value === undefined || value === null) return false;
        return compare(op, value, enc[tag]);
    });

    switch (enc.fo) {
        case FILTER_OPERATION.OR: return results.some(Boolean);
        case FILTER_OPERATION.XOR: return results.filter(Boolean).length % 2 === 1;
        // AND is the default when fo is absent (TS-0001:9.6.8, and TS-0004:7.5.1.2.2 step 1.0
        // states it normatively: "By default, the logical AND operation shall be used if the
        // filterOperation condition is not present"). fo is refused by the schema unless it is
        // 1, 2 or 3, so no other value reaches here.
        default: return results.every(Boolean);
    }
}

// The attribute object inside a notification representation. The envelope key is data-driven for
// <flexContainer> (its ek, e.g. "hd:devLt"), so it is taken positionally rather than by name.
function resource_of(pc) {
    if (!pc || typeof pc !== 'object') return null;
    const first = Object.values(pc)[0];
    return first && typeof first === 'object' ? first : null;
}

module.exports = { COMPARISON_TAGS, FILTER_OPERATION, comparison_conditions_match, resource_of, present_tags };
