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

Your specialization has its own `targetNamespace`, so it also needs an
`<xs:import namespace="http://www.onem2m.org/xml/protocols" …/>` for the two `m2m:` names it uses.
The build tool never resolves imports and does not care, but an XML tool validating your XSD does:
without it the schema fails to compile. `parkingBlock.xsd` carries the import with
`schemaLocation="CDT-commonTypes.xsd"` — oneM2M's schemas are not redistributed here, so point that
at your own copy of the TS-0004 schema set.

Attribute types must be XSD built-ins that map onto the six the registry understands:

| XSD | registry |
| --- | --- |
| `xs:string`, `xs:anyURI`, `xs:token`, `xs:dateTime`, … | `string` |
| `xs:integer`, `xs:int`, `xs:long`, `xs:positiveInteger`, … | `integer` |
| `xs:float`, `xs:double`, `xs:decimal` | `number` |
| `xs:boolean` | `boolean` |
| any type with `maxOccurs` greater than 1 | `array` |
| no `type`, with an inline `xs:complexType` | `object` |
| no `type`, with an inline `xs:simpleType` restricting a built-in | whatever the `restriction`'s `base` maps to |

The last row is the enumeration case, and it is a common one in TS-0023: an element with no `type`
whose inline `xs:simpleType` restricts `xs:string` with a list of `xs:enumeration` values comes out
as **`string`**, not `object`. Only an inline `xs:complexType` gives `object`. The registry records
the wire type and not the permitted values, so the enumeration itself is not enforced by the CSE.

An inline `xs:simpleType` that is an `xs:list` or `xs:union` rather than an `xs:restriction` has no
single base to map, and is refused.

Anything else is refused rather than guessed at, because the runtime accepts a value whose declared
type it does not recognise — an unmapped type would switch that attribute's validation off silently.

## Using it

The build runs **on the host**, in a checkout of this repository. There is no `docker compose exec`
form of it: the deployment image contains no `scripts/` directory (see the `COPY` list in the
`Dockerfile`), and its `/app` is owned by root while the process runs as `node`, so nothing in the
container could write the registry anyway. A Docker deployment builds the registry here and rebuilds
its image, which copies `config/` in.

Rehearse first, where the example ships. This reads the manifest in place and writes somewhere
temporary, so nothing under `config/` is touched:

```bash
node scripts/build-specializations.js \
  --manifest docs/examples/specializations/manifest.example.json \
  --out /tmp/specializations.example.json
```

```
build-specializations: wrote 1 specialization(s) to /tmp/specializations.example.json
  http://www.example.com/schema/parkingBlock.xsd -> sc:parkingBlock (6 custom attribute(s))
restart mobius4 for this to take effect — the registry is read once at startup
```

Then make it yours. ⚠️ **`config/specializations.manifest.json` already exists in this repository,
and the copy below overwrites it** — keep a copy first if it holds entries you need:

```bash
cp config/specializations.manifest.json config/specializations.manifest.json.bak
cp docs/examples/specializations/manifest.example.json config/specializations.manifest.json
```

Now edit it: your `cnd` values, your XSD paths or URLs. **A relative `xsd` path resolves from the
manifest's own directory**, which after that copy is `config/` — so the example's
`./parkingBlock.xsd` no longer resolves and has to become `../docs/examples/specializations/parkingBlock.xsd`,
an absolute path, or the path to your own XSD. An `http(s)` URL is fetched as it stands and does not
depend on where the manifest lives.

```bash
node scripts/build-specializations.js
```

A manifest holds as many entries as you like. A second one looks like this — it is **not** in the
example manifest, because the XSD it names is not in this repository and the manifest ships only
entries that run as they stand. The path below is a placeholder for a file you supply:

```json
{
  "cnd": "org.onem2m.common.moduleclass.alarmSpeaker",
  "xsd": "/srv/mobius4/xsd/alarmSpeaker.xsd",
  "description": "A TS-0023 standard containerDefinition. It is an identifier, not a location, so the XSD path is unrelated to it."
}
```

Then **restart mobius4**. The registry is read once at startup, so nothing changes until you do.

Adding several at once and restarting once is the intended way to use this. If any entry fails, the
build stops and `config/specializations.json` is not touched at all — you never get half of them.

The build also stops rather than dropping a `cnd` that the existing registry already has. You meet
this the first time you build after copying the example over the shipped manifest, since the example
carries a `cnd` of its own and the shipped registry's is then missing:

```
build-specializations: these containerDefinitions are in /Users/you/mobius4/config/specializations.json but not in the manifest, and would be removed:
  - http://developers.iotocean.org/schema/parkingBlock.xsd
Add them to the manifest, or pass --allow-removals if the removal is intended.
```

Nothing is written when it stops. Move the named entries into the manifest, or pass
`--allow-removals` if losing them is what you meant — every `<flexContainer>` using a `cnd` that
leaves the registry starts answering 4125.
