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
// Anything not here is refused rather than passed through: type_matches returns true for a type it
// does not recognise -- deliberately, so a registry authoring mistake is not turned into a client
// error -- which means an unmapped type would silently switch that attribute's validation off.
const TYPE_MAP = {
  string: "string", normalizedString: "string", token: "string", anyURI: "string",
  NCName: "string", QName: "string", date: "string", dateTime: "string", time: "string",
  duration: "string", base64Binary: "string", hexBinary: "string",
  integer: "integer", int: "integer", long: "integer", short: "integer", byte: "integer",
  positiveInteger: "integer", nonNegativeInteger: "integer",
  negativeInteger: "integer", nonPositiveInteger: "integer",
  unsignedInt: "integer", unsignedLong: "integer", unsignedShort: "integer", unsignedByte: "integer",
  float: "number", double: "number", decimal: "number",
  boolean: "boolean",
};

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
function namespacePrefixOf(schema, xsdText, cnd) {
  const target = schema["@_targetNamespace"];
  if (!target) throw new Error(`${cnd}: the schema has no targetNamespace`);
  const rootTag = xsdText.match(/<[\w.-]*:?schema\b[^>]*>/);
  if (!rootTag) throw new Error(`${cnd}: no <xs:schema> root element`);
  const nsDecl = /xmlns:([\w.-]+)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = nsDecl.exec(rootTag[0]))) {
    if (match[2] === target) return match[1];
  }
  throw new Error(`${cnd}: no xmlns prefix is bound to the targetNamespace ${target}`);
}

function typeOf(element, cnd, owner) {
  // maxOccurs greater than one is a list regardless of the item type, which is how the registry
  // spells it (cse/specialization.js's type_matches checks Array.isArray for 'array').
  const maxOccurs = element["@_maxOccurs"];
  if (maxOccurs === "unbounded" || (maxOccurs !== undefined && Number(maxOccurs) > 1)) return "array";

  const declared = element["@_type"];
  // An element with no @type carries an inline complexType: an object on the wire.
  if (declared === undefined) return "object";

  const local = String(declared).includes(":") ? String(declared).split(":").pop() : String(declared);
  const mapped = TYPE_MAP[local];
  if (mapped) return mapped;
  // A named type from another namespace (m2m:labels, sc:somethingComplex). It cannot be resolved
  // without following the import, and guessing is what this refuses to do.
  throw new Error(
    `${cnd}: attribute '${owner}' has type '${declared}', which does not map to any of the six ` +
    `types the registry understands. Add it to TYPE_MAP in scripts/lib/xsd-specialization.js if ` +
    `it is a built-in, or declare the attribute with a built-in type.`
  );
}

function extractSpecialization(xsdText, { cnd }) {
  const schema = parseXsd(xsdText, cnd);

  const elements = Array.isArray(schema.element) ? schema.element : (schema.element ? [schema.element] : []);
  const roots = elements.filter((e) => e && e["@_name"]);
  if (roots.length !== 1) {
    throw new Error(`${cnd}: expected exactly one top-level element, found ${roots.length}`);
  }
  const root = roots[0];
  const typeName = root["@_name"];

  const extension = root?.complexType?.complexContent?.extension;
  if (!extension) {
    throw new Error(
      `${cnd}: <${typeName}> is not an extension of m2m:flexContainerResource — a specialization ` +
      `must be one (TS-0001:9.6.35)`
    );
  }

  const added = extension?.sequence?.element ?? [];
  const attributes = {};
  for (const el of added) {
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
