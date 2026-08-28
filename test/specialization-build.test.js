"use strict";
// Building the <flexContainer> specialization registry (BACKLOG-024).
//
// TS-0018 has no test purpose for this: how the registry gets filled is a deployment procedure,
// not CSE behaviour, and test purposes judge behaviour. The validation the registry drives is
// already covered by test/flexcontainer.test.js and does not change here. So these assertions come
// from TS-0001:9.6.35 and from CDT-commonTypes.xsd's flexContainerResource base type, and carry no
// TP identifier rather than an invented one.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { extractSpecialization } = require("../scripts/lib/xsd-specialization");

// extractSpecialization builds `attributes` with a null prototype, because an XSD may legally
// declare an attribute called __proto__ and a plain object would swallow it. A strict deep
// comparison also compares prototypes, so the expected value needs a null prototype too.
const bare = (obj) => Object.assign(Object.create(null), obj);

// A specialization XSD in the shape TS-0001:9.6.35 describes: an extension of
// m2m:flexContainerResource that adds [customAttribute] elements. The base type's own elements
// (containerDefinition, labels, contentSize, ...) are declared once in CDT-commonTypes.xsd:1701
// and are NOT repeated in an extension -- which is what makes the extraction structural.
const SAMPLE_XSD = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           xmlns:m2m="http://www.onem2m.org/xml/protocols"
           xmlns:sc="http://www.example.com/schema"
           targetNamespace="http://www.example.com/schema"
           elementFormDefault="unqualified">
  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType>
      <xs:complexContent>
        <xs:extension base="m2m:flexContainerResource">
          <xs:sequence>
            <xs:element name="type" type="xs:string" minOccurs="0"/>
            <xs:element name="name" type="xs:string" minOccurs="0"/>
            <xs:element name="category" type="xs:string" minOccurs="0" maxOccurs="unbounded"/>
            <xs:element name="availableSpotNumber" type="xs:integer" minOccurs="0"/>
            <xs:element name="totalSpotNumber" type="xs:integer" minOccurs="0"/>
            <xs:element name="refParkingSpot" type="xs:anyURI" minOccurs="0" maxOccurs="unbounded"/>
          </xs:sequence>
        </xs:extension>
      </xs:complexContent>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

test("extracts the type name, namespace prefix and custom attributes", () => {
  const got = extractSpecialization(SAMPLE_XSD, { cnd: "urn:example:parkingBlock" });

  assert.equal(got.typeName, "parkingBlock");
  assert.equal(got.namespacePrefix, "sc");
  assert.deepEqual(got.attributes, bare({
    type: { type: "string" },
    name: { type: "string" },
    category: { type: "array" },
    availableSpotNumber: { type: "integer" },
    totalSpotNumber: { type: "integer" },
    refParkingSpot: { type: "array" },
  }));
});

test("the base type's inherited attributes never appear as custom attributes", () => {
  // Structural: xs:extension does not repeat the base's elements, so reading only the extension's
  // children is what excludes them. Asserted anyway -- if the extraction ever reached for the whole
  // complexType instead of the extension, every inherited attribute would silently become a
  // [customAttribute] and the registry would start accepting `containerDefinition` as one.
  const got = extractSpecialization(SAMPLE_XSD, { cnd: "urn:example:parkingBlock" });

  for (const inherited of ["containerDefinition", "labels", "contentSize", "resourceType", "creationTime"]) {
    assert.ok(!(inherited in got.attributes), `${inherited} is inherited and must not be a custom attribute`);
  }
});

// ---------------------------------------------------------------------------------------------
// Regression tests for the review findings on the first cut of this extraction.
// ---------------------------------------------------------------------------------------------

// Wraps a schema body in the declarations every fixture below shares, so each test only shows the
// part it is about.
function schema(body, { attrs = 'xmlns:sc="http://www.example.com/schema"' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           xmlns:m2m="http://www.onem2m.org/xml/protocols"
           ${attrs}
           targetNamespace="http://www.example.com/schema"
           elementFormDefault="unqualified">
${body}
</xs:schema>`;
}

// A specialization element and its announced twin, the shape every real oneM2M specialization XSD
// has (verified on CDT-allJoynSvcObject.xsd: allJoynSvcObject + allJoynSvcObjectAnnc).
const TWIN_XSD = schema(`
  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:sequence>
        <xs:element name="totalSpotNumber" type="xs:integer" minOccurs="0"/>
      </xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>
  <xs:element name="parkingBlockAnnc" substitutionGroup="m2m:sg_announcedFlexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:announcedFlexContainerResource">
      <xs:sequence>
        <xs:element name="totalSpotNumber" type="xs:integer" minOccurs="0"/>
      </xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>`);

test("picks the specialization out of an XSD that also declares its announced twin", () => {
  // Every real specialization XSD declares two top-level elements. Counting them and demanding one
  // refused all fourteen of them in the corpus.
  const got = extractSpecialization(TWIN_XSD, { cnd: "urn:example:parkingBlock" });

  assert.equal(got.typeName, "parkingBlock");
  assert.deepEqual(got.attributes, bare({ totalSpotNumber: { type: "integer" } }));
});

test("falls back to the extension base when no substitutionGroup is declared", () => {
  const xsd = schema(`
  <xs:element name="parkingBlock">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:sequence><xs:element name="spots" type="xs:integer"/></xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>
  <xs:element name="parkingBlockAnnc">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:announcedFlexContainerResource">
      <xs:sequence><xs:element name="spots" type="xs:integer"/></xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>`);

  assert.equal(extractSpecialization(xsd, { cnd: "urn:example:parkingBlock" }).typeName, "parkingBlock");
});

test("refuses an XSD in which no element is a flexContainer specialization", () => {
  const xsd = schema(`
  <xs:element name="somethingElse">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:announceableSubordinateResource">
      <xs:sequence><xs:element name="spots" type="xs:integer"/></xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>`);

  assert.throws(() => extractSpecialization(xsd, { cnd: "urn:example:none" }), (err) => {
    assert.match(err.message, /urn:example:none/);
    assert.match(err.message, /flexContainerResource/);
    return true;
  });
});

test("refuses two flexContainer specializations in one XSD as ambiguous, naming both", () => {
  const xsd = schema(`
  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:sequence><xs:element name="spots" type="xs:integer"/></xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>
  <xs:element name="parkingLot" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:sequence><xs:element name="spots" type="xs:integer"/></xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>`);

  assert.throws(() => extractSpecialization(xsd, { cnd: "urn:example:two" }), (err) => {
    assert.match(err.message, /parkingBlock/);
    assert.match(err.message, /parkingLot/);
    return true;
  });
});

test("a <xs:schema> tag inside an XML comment does not decide the namespace prefix", () => {
  // Every oneM2M XSD opens with a large copyright comment. A comment that happens to contain a
  // schema tag used to hand back that tag's prefix, and expected_envelope_key then rejected every
  // well-formed CREATE.
  const xsd = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Superseded revision, kept for reference:
     <xs:schema xmlns:old="http://www.example.com/schema"
                targetNamespace="http://www.example.com/schema"> -->
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           xmlns:m2m="http://www.onem2m.org/xml/protocols"
           xmlns:sc="http://www.example.com/schema"
           targetNamespace="http://www.example.com/schema">
  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:sequence><xs:element name="spots" type="xs:integer"/></xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>
</xs:schema>`;

  assert.equal(extractSpecialization(xsd, { cnd: "urn:example:parkingBlock" }).namespacePrefix, "sc");
});

test("reads custom attributes declared under xs:all", () => {
  const xsd = schema(`
  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:all>
        <xs:element name="spots" type="xs:integer" minOccurs="0"/>
        <xs:element name="label" type="xs:string" minOccurs="0"/>
      </xs:all>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>`);

  assert.deepEqual(
    extractSpecialization(xsd, { cnd: "urn:example:parkingBlock" }).attributes,
    bare({ spots: { type: "integer" }, label: { type: "string" } }),
  );
});

test("reads custom attributes declared under xs:choice", () => {
  const xsd = schema(`
  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:choice>
        <xs:element name="spots" type="xs:integer"/>
        <xs:element name="label" type="xs:string"/>
      </xs:choice>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>`);

  assert.deepEqual(
    extractSpecialization(xsd, { cnd: "urn:example:parkingBlock" }).attributes,
    bare({ spots: { type: "integer" }, label: { type: "string" } }),
  );
});

test("an inline xs:simpleType is the type it restricts, not an object", () => {
  // An enumeration over xs:string is a string on the wire. Calling it an object told a client
  // sending {"mode":"ON"} that mode "must be of type object".
  const xsd = schema(`
  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:sequence>
        <xs:element name="mode" minOccurs="0">
          <xs:simpleType>
            <xs:restriction base="xs:string">
              <xs:enumeration value="ON"/>
              <xs:enumeration value="OFF"/>
            </xs:restriction>
          </xs:simpleType>
        </xs:element>
      </xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>`);

  assert.deepEqual(
    extractSpecialization(xsd, { cnd: "urn:example:parkingBlock" }).attributes,
    bare({ mode: { type: "string" } }),
  );
});

test("an inline xs:complexType is still an object", () => {
  const xsd = schema(`
  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:sequence>
        <xs:element name="position" minOccurs="0">
          <xs:complexType>
            <xs:sequence><xs:element name="lat" type="xs:decimal"/></xs:sequence>
          </xs:complexType>
        </xs:element>
      </xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>`);

  assert.deepEqual(
    extractSpecialization(xsd, { cnd: "urn:example:parkingBlock" }).attributes,
    bare({ position: { type: "object" } }),
  );
});

test("refuses an inline xs:simpleType whose restriction base does not map", () => {
  const xsd = schema(`
  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:sequence>
        <xs:element name="mode" minOccurs="0">
          <xs:simpleType>
            <xs:restriction base="m2m:someImportedType"><xs:enumeration value="ON"/></xs:restriction>
          </xs:simpleType>
        </xs:element>
      </xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>`);

  assert.throws(() => extractSpecialization(xsd, { cnd: "urn:example:parkingBlock" }), (err) => {
    assert.match(err.message, /urn:example:parkingBlock/);
    assert.match(err.message, /mode/);
    return true;
  });
});

test("accepts single-quoted xmlns declarations", () => {
  const xsd = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'
           xmlns:m2m='http://www.onem2m.org/xml/protocols'
           xmlns:sc='http://www.example.com/schema'
           targetNamespace='http://www.example.com/schema'>
  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:sequence><xs:element name="spots" type="xs:integer"/></xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>
</xs:schema>`;

  assert.equal(extractSpecialization(xsd, { cnd: "urn:example:parkingBlock" }).namespacePrefix, "sc");
});

test("says so specifically when the targetNamespace is bound only to the default xmlns", () => {
  // Refusing is right -- the envelope key needs a prefix -- but "no xmlns prefix is bound" sent the
  // reader looking for a missing declaration that is in fact there.
  const xsd = `<?xml version="1.0" encoding="UTF-8"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"
           xmlns:m2m="http://www.onem2m.org/xml/protocols"
           xmlns="http://www.example.com/schema"
           targetNamespace="http://www.example.com/schema">
  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:sequence><xs:element name="spots" type="xs:integer"/></xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>
</xs:schema>`;

  assert.throws(() => extractSpecialization(xsd, { cnd: "urn:example:parkingBlock" }), (err) => {
    assert.match(err.message, /default/);
    return true;
  });
});

test("refuses two prefixes bound to the same targetNamespace as ambiguous, naming both", () => {
  const xsd = schema("", { attrs: 'xmlns:sc="http://www.example.com/schema" xmlns:pk="http://www.example.com/schema"' })
    .replace("</xs:schema>", `
  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:sequence><xs:element name="spots" type="xs:integer"/></xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>
</xs:schema>`);

  assert.throws(() => extractSpecialization(xsd, { cnd: "urn:example:parkingBlock" }), (err) => {
    assert.match(err.message, /\bsc\b/);
    assert.match(err.message, /\bpk\b/);
    return true;
  });
});

test("a type named after an Object.prototype member is refused, not read off the prototype", () => {
  // TYPE_MAP used to be a plain object, so type="constructor" resolved to Object and was handed
  // back as the attribute's type -- and type_matches returns true for a type it does not know,
  // which is exactly the silent validation-off this module exists to prevent.
  for (const inherited of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
    const xsd = schema(`
  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:sequence><xs:element name="spots" type="xs:${inherited}"/></xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>`);

    assert.throws(
      () => extractSpecialization(xsd, { cnd: "urn:example:parkingBlock" }),
      /does not map to any of the six/,
      `type="xs:${inherited}" must be refused`,
    );
  }
});

test("an attribute named __proto__ becomes an own property of attributes", () => {
  // Assigning it on a plain object rewrites the prototype instead of adding a property, so the
  // attribute vanished from the registry and every request carrying it was rejected as undeclared.
  const xsd = schema(`
  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:sequence><xs:element name="__proto__" type="xs:string" minOccurs="0"/></xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>`);

  const got = extractSpecialization(xsd, { cnd: "urn:example:parkingBlock" });
  assert.ok(Object.hasOwn(got.attributes, "__proto__"), "__proto__ must be an own property");
  assert.deepEqual(Object.getOwnPropertyDescriptor(got.attributes, "__proto__").value, { type: "string" });
});
