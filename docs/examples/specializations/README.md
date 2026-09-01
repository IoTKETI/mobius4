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

### Mandatory attributes

**An attribute is mandatory unless it says `minOccurs="0"`.** XSD's default for an omitted
`minOccurs` is 1, so writing nothing makes the attribute required:

```xml
<xs:element name="totalSpotNumber" type="xs:integer"/>                 <!-- mandatory -->
<xs:element name="totalSpotNumber" type="xs:integer" minOccurs="1"/>   <!-- mandatory, spelled out -->
<xs:element name="name"            type="xs:string"  minOccurs="0"/>   <!-- optional -->
```

This is how oneM2M's own specializations mark it — none of them writes a literal `minOccurs="1"` on
a custom attribute; `CDT-allJoynSvcObject.xsd` declares `objectPath` and `enable` with no
`minOccurs` at all, and marks only its optional attributes. `parkingBlock.xsd` here declares all
six `minOccurs="0"`, so nothing in it is mandatory.

A CREATE that omits a mandatory attribute is rejected with 4000, and a mandatory attribute cannot
be deleted by sending `null` on UPDATE. Enforcement arrives when you rebuild the registry: an entry
with no mandatory flag is read as declaring nothing mandatory, so an existing deployment keeps
behaving as it did until you rebuild.

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

The build runs **on the host**, in a checkout of this repository. A Docker deployment runs the same
script inside the image instead, without needing Node on the host — see
[Under Docker](#under-docker) below.

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

## Under Docker

The image carries this script, the XSD reader it uses (`scripts/lib/xsd-specialization.js`) and
`fast-xml-parser`, so a deployment with no Node toolchain on the host can still build a registry.
That is why `fast-xml-parser` is a runtime dependency rather than a development one.

Run it in a throwaway container with your checkout's `config/` mounted over the image's, so the
registry lands on the host rather than inside a container that the next `docker compose up` replaces:

```bash
docker compose run --rm --no-deps --entrypoint node \
  -v "$PWD/config:/app/config" mobius4 scripts/build-specializations.js
```

```
build-specializations: wrote 1 specialization(s) to /app/config/specializations.json
  http://developers.iotocean.org/schema/parkingBlock.xsd -> sc:parkingBlock (6 custom attribute(s))
restart mobius4 for this to take effect — the registry is read once at startup
```

⚠️ **On Linux, check who owns your checkout.** The container writes as uid 1000 (the image's `node`
user), so if `config/` is owned by a different uid the command above fails with a bare `EACCES`.
Add your own uid to it:

```bash
docker compose run --rm --no-deps --entrypoint node --user "$(id -u):$(id -g)" \
  -v "$PWD/config:/app/config" mobius4 scripts/build-specializations.js
```

**The Linux failure above was not reproduced here.** The testing behind this page was done on macOS
(Rancher Desktop), where the file-sharing layer maps ownership and the plain command succeeds
whatever the checkout's uid; the `--user` form was run there and also succeeds, but what it is for
is reasoned from how bind mounts pass host uids through, not measured.

Then rebuild and restart. The image copies `config/` in, so this is what carries the new registry
into the running CSE:

```bash
docker compose up -d --build
```

That last step assumes you deploy by building from a checkout, which is what `docker-compose.yml`
here does (`build: context: .`). If you deploy a published image instead, there is no rebuild to
bake the registry into — generate `config/specializations.json` wherever that image is built, or
mount the file in at run time.

Three details decide the shape of that `docker compose run` command.

- **`--entrypoint node`.** The image's entrypoint is `docker/entrypoint.js`, which starts the CSE
  rather than exec'ing its arguments, so `docker run <image> node scripts/build-specializations.js`
  starts mobius4 and ignores the rest — and mints and prints a new administrator identity on the
  way, so a mistyped invocation looks like something worse than it is. (`docker compose exec` needs
  no override, since it does not go through the entrypoint, but it is not a route to a new registry
  either: it writes inside the running container, whose `/app/config` is the image's root-owned
  copy, and anything written elsewhere lasts only as long as that container.)
- **Mounted at `/app/config`, not at some other path.** A relative `xsd` resolves from the
  manifest's own directory, and the shipped entry points at
  `../docs/examples/specializations/parkingBlock.xsd` — `/app/docs/...` in the image, which is the
  one file `.dockerignore` re-admits from `docs/`. Mount the directory anywhere else and that path
  resolves to nothing. Your own XSDs are simplest kept in `config/` beside the manifest and named
  `./yourBlock.xsd`; they then arrive with the same mount and need no second one.
- **The whole directory, not the two files.** A single-file bind mount is a mount point, and the
  build writes a temporary file and renames it over the target, which a mount point refuses:
  `EBUSY: resource busy or locked, rename '/app/config/specializations.json.tmp-1' -> '/app/config/specializations.json'`.

To rehearse without touching your checkout, leave the mount off and write to a scratch path inside
the container. `mobius4:local` is the tag `docker-compose.yml` gives the image it builds, so you
have it once you have run `docker compose build` (or `docker compose up --build`); otherwise Docker
answers "Unable to find image".

```bash
docker run --rm --entrypoint node mobius4:local \
  scripts/build-specializations.js --out /tmp/specializations.json
```

`--out` matters here. The image's `/app/config` is root-owned and the CSE runs as `node`, so an
unmounted container cannot write the registry in place — which is deliberate: `config/enums.js` and
`config/validate.js` are loaded on request paths, and they stay unwritable by the uid the CSE runs
as.

`docker-compose.yml` deliberately mounts no host `config/` of its own. It could, and a rebuilt
registry would then need only `docker compose restart` — but the same mount would carry
`config/local*.json` into a deployment the `Dockerfile` goes out of its way to keep them out of, and
would shadow a newer image's `config/default.json` with whatever an older checkout happens to hold.
Generating the registry into the checkout — with the mounted `docker compose run` above, or on the
host — and then rebuilding the image keeps a generated file where generated files belong.
