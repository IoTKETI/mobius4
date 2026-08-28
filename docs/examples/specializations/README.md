# `<flexContainer>` specialization examples

A `<flexContainer>` carries attributes this specification does not define. Which ones, and of what
type, comes from the schema its `containerDefinition` (`cnd`) refers to — `TS-0001:9.6.35`: "The
actual data types of [customAttribute] will be described both in the specification document or XSD
file which are referred by the value of *containerDefinition* attribute."

Mobius4 keeps that information in `config/specializations.json`, and
`scripts/build-specializations.js` generates it from your XSDs so you do not transcribe it by hand.

## `cnd` is an identifier, not a location

This is the part that surprises people. `containerDefinition` is typed `xs:anyURI`, so a URL is
allowed — but the standard's own values are not URLs:

| Source | Value |
| --- | --- |
| `TS-0023:6.4.3` | `org.onem2m.common.moduleclass.alarmSpeaker` |
| `TS-0023:6.4.5` | `org.onem2m.common.subdevice.subDevicePowerOutlet` |
| `TS-0023:5.8.1` | `org.onem2m.management.device.flexNode` |

`TS-0023:6.4.1` calls it "a unique identifier". None of those can be fetched. So the manifest keeps
**`cnd`** (what the resource will carry) and **`xsd`** (where the definition is read from) as two
separate fields. They may be the same string; they often are not.

## Writing a specialization XSD

Extend `m2m:flexContainerResource` and add only your own attributes — see `parkingBlock.xsd` here.
The base type's attributes are inherited and must not be repeated.

Attribute types must be XSD built-ins that map onto the six the registry understands:

| XSD | registry |
| --- | --- |
| `xs:string`, `xs:anyURI`, `xs:token`, `xs:dateTime`, … | `string` |
| `xs:integer`, `xs:int`, `xs:long`, `xs:positiveInteger`, … | `integer` |
| `xs:float`, `xs:double`, `xs:decimal` | `number` |
| `xs:boolean` | `boolean` |
| any type with `maxOccurs` greater than 1 | `array` |
| an element with no `type` (an inline `complexType`) | `object` |

Anything else is refused rather than guessed at, because the runtime accepts a value whose declared
type it does not recognise — an unmapped type would switch that attribute's validation off silently.

## Using it

```bash
cp docs/examples/specializations/manifest.example.json config/specializations.manifest.json
# edit it: your cnd values, your XSD paths or URLs

node scripts/build-specializations.js
```

Under Docker: `docker compose exec mobius4 node scripts/build-specializations.js`.

Then **restart mobius4**. The registry is read once at startup, so nothing changes until you do.

Adding several at once and restarting once is the intended way to use this. If any entry fails, the
build stops and `config/specializations.json` is not touched at all — you never get half of them.
