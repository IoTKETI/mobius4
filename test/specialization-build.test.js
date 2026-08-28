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

// ---------------------------------------------------------------------------------------------
// Pinning the two refusals the mutation testing found unprotected, and the elements the
// direct-children pass cannot see.
// ---------------------------------------------------------------------------------------------

test("refuses an element that declares neither a type nor an inline type", () => {
  // Such an element is xs:anyType, which is any of the six or none of them. Answering "object" --
  // what this did before -- tells a client sending {"mode":"ON"} that mode must be an object, and
  // answering anything else is a guess. There is no reading of the XSD that settles it.
  const xsd = schema(`
  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:sequence><xs:element name="mode" minOccurs="0"/></xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>`);

  assert.throws(() => extractSpecialization(xsd, { cnd: "urn:example:parkingBlock" }), (err) => {
    assert.match(err.message, /urn:example:parkingBlock/);
    assert.match(err.message, /mode/);
    assert.match(err.message, /anyType/);
    return true;
  });
});

test("refuses an inline xs:simpleType that is an xs:list or an xs:union", () => {
  // An xs:list is a whitespace-separated string on the wire, not a JSON array, and an xs:union is
  // whichever member type the value happens to satisfy. Calling either an object -- what this did
  // before -- switched that attribute's validation off for every value a client could send.
  for (const [kind, body] of [
    ["xs:list", '<xs:list itemType="xs:string"/>'],
    ["xs:union", '<xs:union memberTypes="xs:integer xs:string"/>'],
  ]) {
    const xsd = schema(`
  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:sequence>
        <xs:element name="mode" minOccurs="0"><xs:simpleType>${body}</xs:simpleType></xs:element>
      </xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>`);

    assert.throws(
      () => extractSpecialization(xsd, { cnd: "urn:example:parkingBlock" }),
      (err) => {
        assert.match(err.message, /urn:example:parkingBlock/);
        assert.match(err.message, /mode/);
        assert.match(err.message, /xs:list or xs:union/);
        return true;
      },
      `an inline ${kind} must be refused`,
    );
  }
});

test("refuses a custom attribute declared inside a nested particle", () => {
  // Only the extension's direct children are read, so a nested particle used to yield an empty
  // attribute set and no error -- after which validate_custom rejected every custom attribute as
  // undeclared. That is the same silent failure reading all three particle containers fixed one
  // level up, and refusing is what this module's doctrine says to do when it cannot see.
  const xsd = schema(`
  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:sequence>
        <xs:sequence>
          <xs:element name="spots" type="xs:integer" minOccurs="0"/>
        </xs:sequence>
      </xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>`);

  assert.throws(() => extractSpecialization(xsd, { cnd: "urn:example:parkingBlock" }), (err) => {
    assert.match(err.message, /urn:example:parkingBlock/);
    assert.match(err.message, /spots/);
    return true;
  });
});

test("refuses a nested xs:choice holding named elements", () => {
  // The nested-choice position is where every corpus specialization puts childResource, which is
  // structure and exempt. A named element that is NOT childResource sitting there is a custom
  // attribute this cannot see.
  const xsd = schema(`
  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:sequence>
        <xs:element name="enable" type="xs:boolean"/>
        <xs:choice minOccurs="0">
          <xs:element name="childResource" type="m2m:childResourceRef" maxOccurs="unbounded"/>
          <xs:element name="spots" type="xs:integer"/>
        </xs:choice>
      </xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>`);

  assert.throws(() => extractSpecialization(xsd, { cnd: "urn:example:parkingBlock" }), (err) => {
    assert.match(err.message, /spots/);
    assert.ok(!/childResource/.test(err.message), "childResource is structure and must not be named");
    return true;
  });
});

test("refuses an xs:group reference, whose elements are declared out of sight", () => {
  // A group ref contributes elements this cannot enumerate without resolving the reference into
  // another schema. Nothing named is missing from the subtree -- there is simply nothing there --
  // so the nested-element check alone would let it through as an empty attribute set.
  const xsd = schema(`
  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:sequence>
        <xs:group ref="m2m:parkingBlockAttributes"/>
      </xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>`);

  assert.throws(() => extractSpecialization(xsd, { cnd: "urn:example:parkingBlock" }), (err) => {
    assert.match(err.message, /urn:example:parkingBlock/);
    assert.match(err.message, /parkingBlockAttributes/);
    return true;
  });
});

test("the nested childResource every corpus specialization declares is structure, not an attribute", () => {
  // Verbatim from CDT-allJoynSvcObject.xsd:32-45. All eight specializations in the corpus put
  // childResource in a nested xs:choice, so a guard that refused named elements there without
  // exempting it would refuse every one of them -- the extraction would go from seven to none.
  const xsd = schema(`
  <xs:element name="allJoynSvcObject" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:sequence>
        <xs:element name="objectPath" type="xs:string"/>
        <xs:element name="enable" type="xs:boolean"/>
        <xs:choice minOccurs="0" maxOccurs="1">
          <xs:element name="childResource" type="m2m:childResourceRef" minOccurs="1" maxOccurs="unbounded"/>
          <xs:choice minOccurs="0" maxOccurs="unbounded">
            <xs:element ref="m2m:semanticDescriptor"/>
            <xs:element ref="m2m:subscription"/>
          </xs:choice>
        </xs:choice>
      </xs:sequence>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>`);

  assert.deepEqual(
    extractSpecialization(xsd, { cnd: "urn:example:allJoynSvcObject" }).attributes,
    bare({ objectPath: { type: "string" }, enable: { type: "boolean" } }),
  );
});

test("childResource directly under the extension is structure too, not an array attribute", () => {
  // The inverse of the nested case. typeOf answers on maxOccurs before it ever looks at the type,
  // and the corpus always declares childResource maxOccurs="unbounded" -- so in this position it
  // used to register silently as a custom attribute of type 'array', and the registry would then
  // accept a client's `childResource` as a [customAttribute] of the specialization.
  const xsd = schema(`
  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource">
    <xs:complexType><xs:complexContent><xs:extension base="m2m:flexContainerResource">
      <xs:choice>
        <xs:element name="childResource" type="m2m:childResourceRef" maxOccurs="unbounded"/>
        <xs:element name="spots" type="xs:integer"/>
      </xs:choice>
    </xs:extension></xs:complexContent></xs:complexType>
  </xs:element>`);

  assert.deepEqual(
    extractSpecialization(xsd, { cnd: "urn:example:parkingBlock" }).attributes,
    bare({ spots: { type: "integer" } }),
  );
});

// ---------------------------------------------------------------------------------------------
// Task 2: refusal paths the file above did not yet pin (BACKLOG-024 task-2-brief.md). Verified
// against the current implementation by running it, not against the brief's original regexes --
// several of those were written against Task 1's first cut and no longer match.
// ---------------------------------------------------------------------------------------------

test("an extension that redeclares an inherited attribute is refused", () => {
  // The guard the structural exclusion cannot provide: xs:extension not repeating the base's
  // elements only keeps INHERITED_ELEMENTS out when the author follows that convention. If this
  // were accepted, 'labels' would be registered as a [customAttribute] while the runtime already
  // treats 'lbl' as a reserved one.
  const xsd = SAMPLE_XSD.replace(
    '<xs:element name="type" type="xs:string" minOccurs="0"/>',
    '<xs:element name="labels" type="xs:string" minOccurs="0"/>'
  );

  assert.throws(
    () => extractSpecialization(xsd, { cnd: "urn:example:bad" }),
    /urn:example:bad.*labels.*must not be redeclared/s
  );
});

test("an XSD type the registry cannot express is refused, naming the attribute", () => {
  // cse/specialization.js's type_matches returns true for a type it does not recognise, so passing
  // one through would turn that attribute's validation off silently. Failing here is the point.
  const xsd = SAMPLE_XSD.replace('type="xs:integer"', 'type="m2m:geoCoordinates"');

  assert.throws(
    () => extractSpecialization(xsd, { cnd: "urn:example:bad" }),
    /urn:example:bad.*availableSpotNumber.*m2m:geoCoordinates/s
  );
});

test("an XSD that is not an extension of flexContainerResource is refused", () => {
  // The brief's original fixture for this case (a bare top-level element, no substitutionGroup) is
  // caught earlier by specializationElementOf's "no top-level element is a specialization" error --
  // a different message than this one guards. Reaching the actual "is not an extension" throw needs
  // an element that DOES join the substitution group but was never given a complexType/extension at
  // all (e.g. authored with a plain @type instead), which is the shape verified against the code.
  const xsd = schema(
    '  <xs:element name="parkingBlock" substitutionGroup="m2m:sg_flexContainerResource" type="xs:string"/>'
  );

  assert.throws(
    () => extractSpecialization(xsd, { cnd: "urn:example:bad" }),
    /urn:example:bad.*parkingBlock.*is not an extension/s
  );
});

test("malformed XML is refused, naming the cnd", () => {
  // fast-xml-parser is lenient about most malformed input (e.g. an unclosed element tag just yields
  // an incomplete tree, no exception) -- verified by running it. An unterminated attribute value is
  // what actually drives the parser itself to throw, exercising parseXsd's try/catch rather than a
  // downstream check that happens to also mention the cnd.
  assert.throws(
    () => extractSpecialization('<xs:schema attr="unterminated>', { cnd: "urn:example:broken" }),
    /urn:example:broken.*could not be parsed/s
  );
});

test("a schema with no targetNamespace is refused", () => {
  // The exact phrase, not just the word "targetNamespace" -- namespacePrefixOf's own fallback path
  // (bound only to the default xmlns) also mentions "targetNamespace" in its message, once `target`
  // is undefined, so a looser regex kept passing even with this guard removed.
  const xsd = SAMPLE_XSD.replace(' targetNamespace="http://www.example.com/schema"', "");

  assert.throws(
    () => extractSpecialization(xsd, { cnd: "urn:example:nons" }),
    /urn:example:nons: the schema has no targetNamespace/
  );
});

// --- build-specializations.js: reading a manifest and resolving each entry's XSD ---
//
// cnd and xsd are separate fields on purpose: TS-0023:6.4.1 calls containerDefinition "a unique
// identifier", and the values the standard actually assigns are reverse-DNS strings that point
// nowhere ("org.onem2m.common.moduleclass.alarmSpeaker", TS-0023:6.4.3). Its XSD type is
// xs:anyURI, which permits a URL but does not require one, so the XSD's location cannot be
// derived from the cnd -- it has to be declared in the manifest.

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const {
  readManifest, buildRegistry, checkNoSilentDeletion, writeAtomically, resolveSource, MAX_XSD_BYTES,
  main, parseArgs, DEFAULT_OUT,
} = require("../scripts/build-specializations");

// A throwaway directory holding a manifest and its XSD, so the manifest's relative paths are
// exercised the way an operator would write them.
function makeManifestDir(entries, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-build-"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(entries, null, 2));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

// What SAMPLE_XSD declares, as it survives a JSON round trip: JSON.parse yields ordinary
// Object.prototype objects, so this is a plain literal rather than the null-prototype `bare()`
// the extraction tests above compare against.
const SAMPLE_ATTRIBUTES = {
  type: { type: "string" },
  name: { type: "string" },
  category: { type: "array" },
  availableSpotNumber: { type: "integer" },
  totalSpotNumber: { type: "integer" },
  refParkingSpot: { type: "array" },
};

test("a manifest entry resolves a relative XSD path and produces a registry keyed by cnd", async () => {
  const dir = makeManifestDir(
    [{ cnd: "org.onem2m.example.moduleclass.parkingBlock", xsd: "./xsd/parkingBlock.xsd" }],
    { "xsd/parkingBlock.xsd": SAMPLE_XSD }
  );

  const entries = readManifest(path.join(dir, "manifest.json"));
  const registry = await buildRegistry(entries, dir);

  assert.deepEqual(Object.keys(registry), ["org.onem2m.example.moduleclass.parkingBlock"]);
  assert.equal(registry["org.onem2m.example.moduleclass.parkingBlock"].typeName, "parkingBlock");
  assert.equal(registry["org.onem2m.example.moduleclass.parkingBlock"].namespacePrefix, "sc");
});

test("a manifest entry with no cnd is refused", () => {
  const dir = makeManifestDir([{ xsd: "./x.xsd" }]);
  assert.throws(() => readManifest(path.join(dir, "manifest.json")), /cnd/);
});

test("a manifest entry with no xsd is refused", () => {
  const dir = makeManifestDir([{ cnd: "urn:example:x" }]);
  assert.throws(() => readManifest(path.join(dir, "manifest.json")), /xsd/);
});

test("two manifest entries with the same cnd are refused", () => {
  // Silently keeping the last one would make the registry depend on manifest order.
  const dir = makeManifestDir([
    { cnd: "urn:example:dup", xsd: "./a.xsd" },
    { cnd: "urn:example:dup", xsd: "./b.xsd" },
  ]);
  assert.throws(() => readManifest(path.join(dir, "manifest.json")), /urn:example:dup/);
});

test("a manifest that is not an array is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-build-"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ cnd: "x" }));
  assert.throws(() => readManifest(path.join(dir, "manifest.json")), /array/i);
});

test("a missing XSD file names the cnd, not just the path", async () => {
  const dir = makeManifestDir([{ cnd: "urn:example:missing", xsd: "./nope.xsd" }]);
  const entries = readManifest(path.join(dir, "manifest.json"));

  await assert.rejects(() => buildRegistry(entries, dir), /urn:example:missing/);
});

test("an XSD that extractSpecialization refuses propagates through buildRegistry with the cnd intact", async () => {
  // Not the brief's literal claim that this input is "malformed XML" -- fast-xml-parser parses it
  // fine (verified directly against extractSpecialization). It fails a downstream structural check
  // instead: no top-level element joins the flexContainer substitution group or extends the base
  // type. What matters for this test is only that buildRegistry does not catch and reword whatever
  // extractSpecialization throws -- the cnd and the original message both have to survive.
  const dir = makeManifestDir([
    { cnd: "urn:example:not-a-specialization", xsd: "./bad.xsd" },
  ], { "bad.xsd": "<xs:schema><nonsense/></xs:schema>" });
  const entries = readManifest(path.join(dir, "manifest.json"));

  await assert.rejects(
    () => buildRegistry(entries, dir),
    /urn:example:not-a-specialization: no top-level element is a <flexContainer> specialization/
  );
});

// --- fetchXsd: the size cap must stream, not buffer-then-check ---
//
// A naive "does fetching an oversized URL throw" test passes against both a streaming cap and a
// cap applied after res.text() has already read the whole body -- the old implementation throws
// too, just later. What distinguishes them is how much of the body was ever allowed onto the wire:
// a streaming cap aborts the connection a few chunks past MAX_XSD_BYTES; a buffer-then-check cap
// lets the server finish sending everything it has; the client only rejects afterwards. So this
// server counts the bytes it actually manages to write and the test asserts that count stays far
// below the body's true (much larger) size.

// Serves a body far larger than MAX_XSD_BYTES, in small paced chunks, so a client that aborts
// mid-stream visibly stops it short -- and a client that reads to the end lets it finish.
function startOversizedXsdServer(totalBytes, chunkSize) {
  return new Promise((resolvePromise) => {
    let bytesWritten = 0;
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.on("error", () => {}); // client aborted mid-write -- nothing to do about it here
      const chunk = Buffer.alloc(chunkSize, "a");
      const writeNext = () => {
        if (res.destroyed || bytesWritten >= totalBytes) {
          if (!res.destroyed) res.end();
          return;
        }
        res.write(chunk);
        bytesWritten += chunk.length;
        setTimeout(writeNext, 2);
      };
      writeNext();
    });
    server.listen(0, "127.0.0.1", () => {
      resolvePromise({ server, getBytesWritten: () => bytesWritten });
    });
  });
}

test("fetchXsd aborts once the streamed total crosses MAX_XSD_BYTES, instead of buffering the whole body first", async () => {
  const chunkSize = 256 * 1024; // 256 KiB
  const totalBytes = MAX_XSD_BYTES * 50; // 50x the cap -- large enough that "read to completion" and
  // "stopped near the cap" are unmistakably different outcomes.
  const { server, getBytesWritten } = await startOversizedXsdServer(totalBytes, chunkSize);
  const cnd = "urn:example:oversized";

  try {
    const { port } = server.address();

    await assert.rejects(
      () => resolveSource({ cnd, xsd: `http://127.0.0.1:${port}/` }, "."),
      (err) => {
        assert.match(err.message, /urn:example:oversized/);
        assert.match(err.message, /larger than/);
        return true;
      }
    );

    // Let the aborted connection actually stop the server's write loop (the abort is signalled
    // asynchronously over the socket, not the instant fetchXsd throws).
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));

    // The load-bearing assertion: against the old buffer-then-check implementation, res.text()
    // reads until the server ends the response, so the server would be left to write the entire
    // totalBytes body (getBytesWritten() === totalBytes) before the byte-length check ever runs.
    // Streaming instead cuts the connection a few chunks past MAX_XSD_BYTES, so the server is
    // stopped far short of the full body it was prepared to send.
    assert.ok(
      getBytesWritten() < MAX_XSD_BYTES * 10,
      `expected the connection to be aborted within a few chunks of MAX_XSD_BYTES ` +
        `(${MAX_XSD_BYTES}), but the server wrote ${getBytesWritten()} of ${totalBytes} bytes -- ` +
        "the whole body was buffered before the cap fired"
    );
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

// --- checkNoSilentDeletion / writeAtomically: the migration-safety half of this task ---

test("an existing cnd that the manifest no longer lists stops the build", async () => {
  // The migration hazard. The current config/specializations.json was written by hand; running the
  // build before moving that entry into the manifest would delete it. Stopping is the only answer
  // that does not lose something silently.
  const dir = makeManifestDir(
    [{ cnd: "urn:example:kept", xsd: "./x.xsd" }],
    { "x.xsd": SAMPLE_XSD }
  );
  const out = path.join(dir, "specializations.json");
  fs.writeFileSync(out, JSON.stringify({
    "urn:example:kept": { typeName: "a", namespacePrefix: "sc", attributes: {} },
    "urn:example:about-to-vanish": { typeName: "b", namespacePrefix: "sc", attributes: {} },
  }));

  const entries = readManifest(path.join(dir, "manifest.json"));
  const registry = await buildRegistry(entries, dir);

  assert.throws(() => checkNoSilentDeletion(registry, out), /urn:example:about-to-vanish/);
});

test("a failed build leaves the existing registry byte-for-byte unchanged", async () => {
  // An operator adding five specializations must not end up with three of them applied.
  const dir = makeManifestDir(
    [
      { cnd: "urn:example:good", xsd: "./good.xsd" },
      { cnd: "urn:example:bad", xsd: "./bad.xsd" },
    ],
    { "good.xsd": SAMPLE_XSD, "bad.xsd": "<xs:schema><nonsense/></xs:schema>" }
  );
  const out = path.join(dir, "specializations.json");
  const before = JSON.stringify({ "urn:example:old": { typeName: "old", namespacePrefix: "sc", attributes: {} } });
  fs.writeFileSync(out, before);

  const entries = readManifest(path.join(dir, "manifest.json"));
  await assert.rejects(() => buildRegistry(entries, dir), /urn:example:bad/);

  assert.equal(fs.readFileSync(out, "utf8"), before, "nothing may be written when any entry fails");
});

test("the written registry is what cse/specialization.js reads back", async () => {
  // The round trip. Everything above tests the builder against its own idea of the format; this is
  // the only test that shows the CSE agrees.
  const dir = makeManifestDir(
    [{ cnd: "urn:example:roundtrip", xsd: "./x.xsd" }],
    { "x.xsd": SAMPLE_XSD }
  );
  const out = path.join(dir, "specializations.json");
  const entries = readManifest(path.join(dir, "manifest.json"));
  writeAtomically(await buildRegistry(entries, dir), out);

  const written = JSON.parse(fs.readFileSync(out, "utf8"));
  const entry = written["urn:example:roundtrip"];

  // What cse/specialization.js's lookup(), expected_envelope_key() and validate_custom() require
  // of an entry -- asserted as exact values, not as shapes. The earlier version of this test only
  // checked that whatever happened to be present looked plausible, and every one of those checks
  // holds vacuously for an entry whose attributes are {}: Object.values({}) iterates nothing, and
  // typeof null === "object". Emptying the registry entry is precisely the regression that matters
  // -- validate_custom does `key in declared`, so an entry with no attribute names rejects every
  // custom attribute a client can send with "is not declared by specialization".
  //
  // lookup() keys the registry by cnd, and returns null (-> 4125) for anything it does not hold.
  assert.deepEqual(Object.keys(written), ["urn:example:roundtrip"]);
  // expected_envelope_key() concatenates these two, so both must be the exact strings the XSD gave.
  assert.equal(entry.namespacePrefix, "sc");
  assert.equal(entry.typeName, "parkingBlock");
  assert.equal(`${entry.namespacePrefix}:${entry.typeName}`, "sc:parkingBlock");
  // validate_custom() matches wire names against these keys, so the names are the contract.
  assert.deepEqual(entry.attributes, SAMPLE_ATTRIBUTES);
  assert.deepEqual(Object.keys(entry.attributes), Object.keys(SAMPLE_ATTRIBUTES));
  for (const [name, decl] of Object.entries(SAMPLE_ATTRIBUTES)) {
    assert.ok(name in entry.attributes, `${name} must be declared, or every payload carrying it is refused`);
    assert.equal(entry.attributes[name].type, decl.type);
    // type_matches() understands exactly these six and returns true for anything else, which would
    // switch that attribute's validation off silently.
    assert.ok(["string", "integer", "number", "boolean", "array", "object"].includes(decl.type),
      `type_matches only understands six types, got ${decl.type}`);
  }
});

// ---------------------------------------------------------------------------------------------
// main(): the CLI itself. Everything above exercises the pieces; nothing exercised the operator's
// actual entry point, so the order it runs them in -- build, then check for removals, then write --
// was guaranteed by reading the code alone.
//
// Every test here points --manifest and --out at a throwaway directory. The real
// config/specializations.json is never a target: the parseArgs interlock in the --out= test below
// exists so that a regression in argument parsing fails the assertion instead of rewriting it.
// ---------------------------------------------------------------------------------------------

// main() prints a summary for the operator. These tests care about what it writes, not what it
// says, and a silent suite is easier to read.
async function runMain(argv) {
  const realLog = console.log;
  console.log = () => {};
  try {
    return await main(argv);
  } finally {
    console.log = realLog;
  }
}

test("main builds the manifest and writes the registry to --out", async () => {
  const dir = makeManifestDir(
    [{ cnd: "urn:example:main", xsd: "./x.xsd" }],
    { "x.xsd": SAMPLE_XSD }
  );
  const out = path.join(dir, "specializations.json");

  await runMain(["--manifest", path.join(dir, "manifest.json"), "--out", out]);

  const written = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.deepEqual(Object.keys(written), ["urn:example:main"]);
  assert.equal(written["urn:example:main"].typeName, "parkingBlock");
  assert.equal(written["urn:example:main"].namespacePrefix, "sc");
  assert.deepEqual(written["urn:example:main"].attributes, SAMPLE_ATTRIBUTES);
});

test("main leaves an existing registry byte-for-byte unchanged when one manifest entry fails", async () => {
  // The headline property, through the CLI rather than through buildRegistry directly: an operator
  // adding five specializations must not end up with three of them applied -- or, worse, with the
  // registry replaced by an empty one because the write happened before the build.
  const dir = makeManifestDir(
    [
      { cnd: "urn:example:good", xsd: "./good.xsd" },
      { cnd: "urn:example:bad", xsd: "./bad.xsd" },
    ],
    { "good.xsd": SAMPLE_XSD, "bad.xsd": "<xs:schema><nonsense/></xs:schema>" }
  );
  const out = path.join(dir, "specializations.json");
  const before = JSON.stringify({
    "urn:example:old": { typeName: "old", namespacePrefix: "sc", attributes: {} },
  });
  fs.writeFileSync(out, before);

  await assert.rejects(
    () => runMain(["--manifest", path.join(dir, "manifest.json"), "--out", out]),
    /urn:example:bad/
  );

  assert.equal(fs.readFileSync(out, "utf8"), before, "a failed build may not touch the registry");
});

test("main stops on a cnd the manifest would drop, and --allow-removals lets it through", async () => {
  const dir = makeManifestDir(
    [{ cnd: "urn:example:kept", xsd: "./x.xsd" }],
    { "x.xsd": SAMPLE_XSD }
  );
  const out = path.join(dir, "specializations.json");
  const before = JSON.stringify({
    "urn:example:kept": { typeName: "a", namespacePrefix: "sc", attributes: {} },
    "urn:example:about-to-vanish": { typeName: "b", namespacePrefix: "sc", attributes: {} },
  });
  fs.writeFileSync(out, before);
  const argv = ["--manifest", path.join(dir, "manifest.json"), "--out", out];

  await assert.rejects(() => runMain(argv), /urn:example:about-to-vanish/);
  assert.equal(fs.readFileSync(out, "utf8"), before, "the refusal must not have written anything");

  await runMain([...argv, "--allow-removals"]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(out, "utf8"))), ["urn:example:kept"]);
});

test("main honours --out=<path> instead of falling back to the production registry", async () => {
  // The dangerous form. `--out=/tmp/o.json` used to be an unrecognised token that the parser
  // ignored, so a rehearsal on temporary paths exited 0, printed a success summary, and rewrote
  // config/specializations.json.
  const dir = makeManifestDir(
    [{ cnd: "urn:example:equals", xsd: "./x.xsd" }],
    { "x.xsd": SAMPLE_XSD }
  );
  const out = path.join(dir, "specializations.json");

  // Interlock, deliberately before main() runs: if --out= ever resolves to DEFAULT_OUT again this
  // fails here, rather than proving the point by overwriting the real registry.
  assert.equal(parseArgs([`--out=${out}`]).outPath, out);
  assert.notEqual(parseArgs([`--out=${out}`]).outPath, DEFAULT_OUT);

  await runMain([`--manifest=${path.join(dir, "manifest.json")}`, `--out=${out}`]);

  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(out, "utf8"))), ["urn:example:equals"]);
});

test("parseArgs reads --flag=value and --flag value the same way", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-build-"));
  const manifest = path.join(dir, "manifest.json");
  const out = path.join(dir, "out.json");

  const equalsForm = parseArgs([`--manifest=${manifest}`, `--out=${out}`, "--allow-removals"]);
  const spacedForm = parseArgs(["--manifest", manifest, "--out", out, "--allow-removals"]);

  assert.deepEqual(equalsForm, spacedForm);
  assert.equal(equalsForm.manifestPath, manifest);
  assert.equal(equalsForm.outPath, out);
  assert.equal(equalsForm.allowRemovals, true);
  assert.notEqual(equalsForm.outPath, DEFAULT_OUT);
});

test("parseArgs refuses a flag whose value is missing, rather than falling back to the default", () => {
  // Falling back is what makes this dangerous rather than merely wrong: the fallback is the real
  // config/specializations.json, and the operator is told the build succeeded.
  for (const argv of [["--out"], ["--manifest"], ["--out", "--allow-removals"], ["--out="], ["--manifest="]]) {
    assert.throws(
      () => parseArgs(argv),
      (err) => {
        assert.match(err.message, /--(out|manifest)/);
        return true;
      },
      `${JSON.stringify(argv)} must be refused`
    );
  }
});

test("parseArgs refuses an unrecognised argument, naming it", () => {
  assert.throws(() => parseArgs(["--output", "/tmp/o.json"]), /--output/);
  assert.throws(() => parseArgs(["--allow-removal"]), /--allow-removal/);
  assert.throws(() => parseArgs(["specializations.manifest.json"]), /specializations\.manifest\.json/);
  assert.throws(() => parseArgs(["--allow-removals=yes"]), /--allow-removals/);
});

test("parseArgs with no arguments is the documented default run", () => {
  // The one case where falling back to the production paths is correct: the operator supplied
  // nothing, so nothing can have been misread.
  assert.deepEqual(parseArgs([]), {
    manifestPath: require("../scripts/build-specializations").DEFAULT_MANIFEST,
    outPath: DEFAULT_OUT,
    allowRemovals: false,
  });
});

// --- checkNoSilentDeletion: only a missing registry is safe to skip over ---

test("no previous registry at all is not an error -- nothing can be lost", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-build-"));
  checkNoSilentDeletion({ "urn:example:new": {} }, path.join(dir, "specializations.json"));
});

test("a previous registry that cannot be parsed stops the build instead of skipping the check", () => {
  // "There is no previous registry" and "there is one and I could not read it" are opposite
  // situations: the first loses nothing, the second overwrites a file whose contents were never
  // compared. Both used to take the same silent early return.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-build-"));
  const out = path.join(dir, "specializations.json");
  fs.writeFileSync(out, '{"urn:example:kept": {"typeName": "a", "namespaceP');

  assert.throws(() => checkNoSilentDeletion({}, out), (err) => {
    assert.match(err.message, /specializations\.json/);
    assert.match(err.message, /JSON/i);
    return true;
  });
});

test("a previous registry that is not a JSON object stops the build, saying what was found", () => {
  // JSON.parse("null") succeeds and Object.keys(null) then throws a TypeError that names neither
  // the file nor the problem; a scalar like 5 or true has no keys, so the removal check passed
  // over a file it had not understood.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-build-"));
  for (const [raw, expected] of [
    ["null", /null/],
    ["5", /number/],
    ["true", /boolean/],
    ['"a string"', /string/],
    ['["urn:example:kept"]', /array/],
  ]) {
    const out = path.join(dir, `registry-${Buffer.from(raw).toString("hex")}.json`);
    fs.writeFileSync(out, raw);

    assert.throws(() => checkNoSilentDeletion({}, out), (err) => {
      assert.match(err.message, /registry-/);
      assert.match(err.message, expected);
      return true;
    }, `a previous registry of ${raw} must be refused`);
  }
});

test("a previous registry that exists but cannot be read stops the build", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-build-"));
  const out = path.join(dir, "specializations.json");
  fs.writeFileSync(out, JSON.stringify({ "urn:example:kept": {} }));
  fs.chmodSync(out, 0o000);

  let readable = true;
  try {
    fs.readFileSync(out, "utf8");
  } catch {
    readable = false;
  }
  // Running as root ignores the mode bits, so there is nothing to assert there.
  if (readable) return;

  assert.throws(() => checkNoSilentDeletion({}, out), (err) => {
    assert.match(err.message, /specializations\.json/);
    assert.match(err.message, /EACCES|permission denied/i);
    return true;
  });
  fs.chmodSync(out, 0o600);
});

// --- writeAtomically: the temp file is an implementation detail and must not outlive the call ---

test("a write that fails leaves no temp file beside the registry", () => {
  // A directory at the target path makes the rename throw EISDIR after the temp file is already
  // written. The stray file then sits next to the real registry, where the next operator finds a
  // specializations.json.tmp-8167 and has to work out whether it matters.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-build-"));
  const out = path.join(dir, "specializations.json");
  fs.mkdirSync(out);

  assert.throws(() => writeAtomically({ "urn:example:x": { typeName: "x" } }, out));

  assert.deepEqual(fs.readdirSync(dir), ["specializations.json"],
    "the temp file must be removed even when the write or the rename throws");
});
