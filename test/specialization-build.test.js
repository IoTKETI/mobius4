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
