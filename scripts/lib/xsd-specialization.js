"use strict";
// Reads a <flexContainer> specialization XSD and returns the registry entry for it.
//
// TS-0001:9.6.35 says the data types of a specialization's [customAttribute]s "will be described
// both in the specification document or XSD file which are referred by the value of
// containerDefinition attribute" -- so the XSD is the source, and this turns it into the shape
// cse/specialization.js already reads.
//
// Pure: a string in, an object out. No file system, no network, no process.exit. That is what lets
// the tests run without a server, a database or a fixture directory.
//
// Everything here refuses rather than guesses. cse/specialization.js's type_matches returns true
// for a type it does not recognise -- deliberately, so a registry authoring mistake is not turned
// into a client error -- which means anything this module lets through unrecognised switches that
// attribute's validation off without saying so. A thrown error is the only safe way to be unsure.

const { XMLParser } = require("fast-xml-parser");

// The elements m2m:flexContainerResource declares, from CDT-commonTypes.xsd:1701 (TS-0004). An
// xs:extension does not repeat its base's elements, so these are excluded structurally rather than
// by this list -- the list is a guard for the case where an XSD declares one anyway, which would
// otherwise register an inherited attribute as a custom one and collide with the short name the
// runtime uses for it.
//
// These are LONG names. cse/specialization.js's RESERVED_ATTRS holds the SHORT names (ty, ri, cnd)
// because that is what appears on the wire. The two lists live in different name spaces and are not
// copies of each other, so they do not need to be kept in sync.
const INHERITED_ELEMENTS = new Set([
  "resourceType", "resourceID", "parentID", "creationTime", "lastModifiedTime", "labels",
  "accessControlPolicyIDs", "expirationTime", "dynamicAuthorizationConsultationIDs", "announceTo",
  "announcedAttribute", "announceSyncType", "stateTag", "creator", "location", "custodian",
  "containerDefinition", "ontologyRef", "contentSize", "nodeLink", "maxNrOfInstances",
  "maxInstanceAge", "maxByteSize", "currentNrOfInstances", "currentByteSize",
]);

// XSD built-in types mapped onto the six the registry knows (cse/specialization.js's type_matches).
// Anything not here is refused rather than passed through.
//
// Null prototype on purpose: as a plain object this map answers to every member of
// Object.prototype, so type="xs:constructor" resolved to the Object function and was handed back as
// an attribute's declared type -- the exact silent validation-off this module exists to prevent.
const TYPE_MAP = Object.assign(Object.create(null), {
  string: "string", normalizedString: "string", token: "string", anyURI: "string",
  NCName: "string", QName: "string", date: "string", dateTime: "string", time: "string",
  duration: "string", base64Binary: "string", hexBinary: "string",
  integer: "integer", int: "integer", long: "integer", short: "integer", byte: "integer",
  positiveInteger: "integer", nonNegativeInteger: "integer",
  negativeInteger: "integer", nonPositiveInteger: "integer",
  unsignedInt: "integer", unsignedLong: "integer", unsignedShort: "integer", unsignedByte: "integer",
  float: "number", double: "number", decimal: "number",
  boolean: "boolean",
});

// The head of the substitution group every <flexContainer> specialization joins, and the complex
// type it extends (CDT-commonTypes.xsd). Both comparisons are case sensitive, which is what keeps
// the announced twin -- sg_announcedFlexContainerResource / announcedFlexContainerResource -- out.
const SUBSTITUTION_GROUP_HEAD = "sg_flexContainerResource";
const BASE_TYPE = "flexContainerResource";

// The particles an xs:extension may put its added elements in. XSD allows any of the three and
// oneM2M's own specializations happen to use xs:sequence, but reading only that one turned an
// xs:all or xs:choice into an empty attribute set -- after which the runtime rejected every custom
// attribute as undeclared.
const PARTICLE_CONTAINERS = ["sequence", "all", "choice"];

const XML_COMMENT = /<!--[\s\S]*?-->/g;

function toArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function localName(qname) {
  const text = String(qname);
  return text.includes(":") ? text.split(":").pop() : text;
}

// Reads one attribute out of a start tag, accepting either quote style. XML gives ' and " equal
// standing, and rejecting the single-quoted form claimed a binding was missing when it was there.
function attrValue(tag, name) {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`));
  if (!match) return undefined;
  return match[2] !== undefined ? match[2] : match[3];
}

function parseXsd(xsdText, cnd) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,   // xs:element -> element, so the code does not depend on the prefix
                            // the author happened to choose for the XMLSchema namespace.
    isArray: (name) => name === "element",
  });
  let doc;
  try {
    doc = parser.parse(xsdText);
  } catch (err) {
    throw new Error(`${cnd}: the XSD could not be parsed (${err.message})`);
  }
  if (!doc || !doc.schema) throw new Error(`${cnd}: no <xs:schema> root element`);
  return doc.schema;
}

// The namespace prefix the payload's envelope key uses, e.g. 'sc' in 'sc:parkingBlock'. It is the
// prefix bound to the schema's own targetNamespace -- the specialization's elements live there.
//
// This reads the raw XSD text rather than the parsed `schema` object: fast-xml-parser's
// removeNSPrefix (needed elsewhere in this file so the code does not depend on the author's choice
// of prefix for the XMLSchema namespace itself, e.g. xs:element vs. xsd:element) drops every
// xmlns:* declaration outright rather than renaming it -- there is no "@_xmlns:sc" left to read
// once parsing is done, so the prefix has to be recovered from the source text instead.
//
// Reading source text means reading comments too, so they go first. Every oneM2M XSD opens with a
// large copyright block, and a comment that quotes a schema tag would otherwise hand back that
// tag's prefix -- after which expected_envelope_key rejects every well-formed CREATE.
function namespacePrefixOf(schema, xsdText, cnd) {
  const target = schema["@_targetNamespace"];
  if (!target) throw new Error(`${cnd}: the schema has no targetNamespace`);

  const tags = stripXmlComments(xsdText).match(/<[\w.-]*:?schema\b[^>]*>/g) ?? [];
  if (tags.length === 0) throw new Error(`${cnd}: no <xs:schema> root element`);
  // The tag that actually declares this targetNamespace, not merely the first one that looks like
  // a schema element.
  const rootTag = tags.find((tag) => attrValue(tag, "targetNamespace") === target) ?? tags[0];

  const nsDecl = /(?:^|\s)xmlns:([\w.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  const prefixes = [];
  let match;
  while ((match = nsDecl.exec(rootTag))) {
    const bound = match[3] !== undefined ? match[3] : match[4];
    if (bound === target) prefixes.push(match[1]);
  }

  if (prefixes.length === 1) return prefixes[0];
  if (prefixes.length > 1) {
    // Both are correct XML, so there is no reading of the document that makes one of them the
    // envelope key. Picking the first would have been a coin toss recorded as a fact.
    throw new Error(
      `${cnd}: ${prefixes.length} prefixes are bound to the targetNamespace ${target} ` +
      `(${prefixes.join(", ")}), so the envelope key is ambiguous. Bind exactly one.`
    );
  }

  if (attrValue(rootTag, "xmlns") === target) {
    throw new Error(
      `${cnd}: the targetNamespace ${target} is bound to the default xmlns, which has no prefix. ` +
      `The envelope key of a flexContainer payload is prefixed (e.g. 'sc:parkingBlock'), so the ` +
      `schema must also bind the targetNamespace to a named prefix.`
    );
  }
  throw new Error(`${cnd}: no xmlns prefix is bound to the targetNamespace ${target}`);
}

function stripXmlComments(text) {
  return text.replace(XML_COMMENT, "");
}

function extensionOf(element) {
  return element?.complexType?.complexContent?.extension;
}

// Picks the one top-level element that is the specialization.
//
// A real specialization XSD declares two: the resource and its announced twin (verified on
// CDT-allJoynSvcObject.xsd -- allJoynSvcObject and allJoynSvcObjectAnnc). Counting them and
// demanding exactly one refused every specialization XSD oneM2M publishes.
function specializationElementOf(elements, cnd) {
  const named = elements.filter((e) => e && e["@_name"]);

  let candidates = named.filter(
    (e) => localName(e["@_substitutionGroup"] ?? "") === SUBSTITUTION_GROUP_HEAD
  );
  // An XSD may omit substitutionGroup; extending the base type says the same thing.
  if (candidates.length === 0) {
    candidates = named.filter((e) => localName(extensionOf(e)?.["@_base"] ?? "") === BASE_TYPE);
  }

  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new Error(
      `${cnd}: no top-level element is a <flexContainer> specialization — one must join the ` +
      `m2m:sg_flexContainerResource substitution group or extend m2m:flexContainerResource ` +
      `(TS-0001:9.6.35)`
    );
  }
  const names = candidates.map((e) => e["@_name"]).join(", ");
  throw new Error(
    `${cnd}: ${candidates.length} top-level elements are <flexContainer> specializations ` +
    `(${names}), so which one this cnd names is ambiguous. One XSD, one specialization.`
  );
}

// The elements the extension adds, from whichever particle holds them. Only direct children count:
// a nested xs:choice is the base type's child-resource list, not a [customAttribute].
function declaredElementsOf(extension) {
  const found = [];
  for (const container of PARTICLE_CONTAINERS) {
    for (const particle of toArray(extension[container])) {
      found.push(...toArray(particle?.element));
    }
  }
  return found;
}

function mapBuiltinType(declared, cnd, owner) {
  const local = localName(declared);
  if (Object.hasOwn(TYPE_MAP, local)) return TYPE_MAP[local];
  // A named type from another namespace (m2m:labels, sc:somethingComplex). It cannot be resolved
  // without following the import, and guessing is what this refuses to do.
  throw new Error(
    `${cnd}: attribute '${owner}' has type '${declared}', which does not map to any of the six ` +
    `types the registry understands. Add it to TYPE_MAP in scripts/lib/xsd-specialization.js if ` +
    `it is a built-in, or declare the attribute with a built-in type.`
  );
}

// An element with no @type carries its type inline. Which kind of inline type decides the answer:
// only xs:complexType is an object on the wire. An inline xs:simpleType -- an enumeration over
// xs:string is the common one in TS-0023 specializations -- is whatever it restricts, so calling it
// an object told a client sending {"mode":"ON"} that mode "must be of type object".
function inlineTypeOf(element, cnd, owner) {
  if (element.complexType !== undefined) return "object";

  const simple = element.simpleType;
  if (simple !== undefined) {
    const base = simple?.restriction?.["@_base"];
    if (base === undefined) {
      throw new Error(
        `${cnd}: attribute '${owner}' has an inline xs:simpleType that is not an xs:restriction ` +
        `(an xs:list or xs:union), so its wire type cannot be determined. Declare it with a ` +
        `built-in type instead.`
      );
    }
    return mapBuiltinType(base, cnd, owner);
  }

  throw new Error(
    `${cnd}: attribute '${owner}' declares neither a type nor an inline xs:simpleType or ` +
    `xs:complexType, so it is xs:anyType and its wire type cannot be determined. Declare it with ` +
    `a built-in type.`
  );
}

function typeOf(element, cnd, owner) {
  // maxOccurs greater than one is a list regardless of the item type, which is how the registry
  // spells it (cse/specialization.js's type_matches checks Array.isArray for 'array').
  const maxOccurs = element["@_maxOccurs"];
  if (maxOccurs === "unbounded" || (maxOccurs !== undefined && Number(maxOccurs) > 1)) return "array";

  const declared = element["@_type"];
  if (declared === undefined) return inlineTypeOf(element, cnd, owner);
  return mapBuiltinType(declared, cnd, owner);
}

function extractSpecialization(xsdText, { cnd }) {
  const schema = parseXsd(xsdText, cnd);

  const elements = toArray(schema.element);
  const root = specializationElementOf(elements, cnd);
  const typeName = root["@_name"];

  const extension = extensionOf(root);
  if (!extension) {
    throw new Error(
      `${cnd}: <${typeName}> is not an extension of m2m:flexContainerResource — a specialization ` +
      `must be one (TS-0001:9.6.35)`
    );
  }

  // Null prototype: an XSD may legally declare an attribute called __proto__, and assigning that
  // key on a plain object rewrites the prototype instead of adding a property -- the attribute
  // would disappear from the registry and every request carrying it be rejected as undeclared.
  const attributes = Object.create(null);
  for (const el of declaredElementsOf(extension)) {
    const name = el["@_name"];
    if (!name) continue;
    if (INHERITED_ELEMENTS.has(name)) {
      throw new Error(
        `${cnd}: '${name}' is an attribute of m2m:flexContainerResource and must not be redeclared ` +
        `by a specialization`
      );
    }
    attributes[name] = { type: typeOf(el, cnd, name) };
  }

  return { typeName, namespacePrefix: namespacePrefixOf(schema, xsdText, cnd), attributes };
}

module.exports = { extractSpecialization, INHERITED_ELEMENTS, TYPE_MAP };
