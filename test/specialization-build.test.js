"use strict";
// <flexContainer> specialization 레지스트리 생성 (BACKLOG-024).
//
// TS-0018 has no test purpose for this: how the registry gets filled is a deployment procedure,
// not CSE behaviour, and test purposes judge behaviour. The validation the registry drives is
// already covered by test/flexcontainer.test.js and does not change here. So these assertions come
// from TS-0001:9.6.35 and from CDT-commonTypes.xsd's flexContainerResource base type, and carry no
// TP identifier rather than an invented one.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { extractSpecialization } = require("../scripts/lib/xsd-specialization");

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
  assert.deepEqual(got.attributes, {
    type: { type: "string" },
    name: { type: "string" },
    category: { type: "array" },
    availableSpotNumber: { type: "integer" },
    totalSpotNumber: { type: "integer" },
    refParkingSpot: { type: "array" },
  });
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
