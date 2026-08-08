
## Useful interfaces for your applications

### Subscription/Notification

oneM2M standard supports two types of notification target, which is included in `notificationURI` (`nu`) attribute of `subscription` resources. One is resource ID of oneM2M Entity, the other is an URL.

When `nu` includes a resource ID (e.g. `Mobius/ae1`), the Hosting CSE get the address to send notification from the `pointOfAccess` (`poa`) attribute of the resource. The `poa` attribute is defined as a list of addresses. Mobius4 tries each addresse (either in HTTP or MQTT), until the successful notification delivery. Therefore the order of each address in the `poa` matters.

On the other hand, `nu` can represent a URL. As well as HTTP URL, oneM2M defines MQTT URL convention as below.
```curl
    mqtt://broker-address:port/topic
```
For the following subscription resource (partial) example, Mobius4 sends notifications to the MQTT topic `noti/temperature` to the local MQTT broker.
```json
{
    "m2m:sub": {
    	"rn": "sub1",
        "enc": {
        	"net" : [1, 3],
            "chty": [4]
        },
        "nu" : ["mqtt://localhost:1883/noti/temperature"],
        "nct": 1
    }
}
```


### Group fan-out

Group feature with `group` and `fanOutPoint` resource type in the oneM2M specification provides request fan-out which is basically the batch resource access (CRUD) feature. One use case is that retrieving  `contentInstance` resources of multiple `container` resources that represent different sensor readings.

Mobius4 supports non-blocking access to group members during the group fan-out. Also, adding postfix to fan-out target, which is the standard feature, is implemented.

Here's the example group resource creation request HTTP body:
```json
{
    "m2m:grp": {
    	"rn": "grp1",
        "mnm" : 10,
        "mid" : [
            "Mobius/cnt1/la",
            "Mobius/cnt2/la"
        ]
    }
}
```
In this example, `memberIDs` (`mid`) includes two `latest` (`la`) virtual resources of the two `container` resources. When an AE requests to retrieve the `fanOutPoint` (`fopt`) virtual resource (e.g. `Mobius/grp1/fopt`), the two latest `contentInstance` resources are returned.

There is another way of doing the same. The `group` resource creation request below includes the containers as the group members. After the creation, to get the latest `contentInstances` from this group is to send the retrieve request to `Mobius/grp2/fopt/la` for instance. Note that there is `/la` path in the end of the request target, which is appended in the end of each group member during the fan-out. (e.g. `Mobius/cnt1/la`).

```json
{
    "m2m:grp": {
    	"rn": "grp2",
        "mnm" : 10,
        "mid" : [
            "Mobius/cnt1",
            "Mobius/cnt2"
        ]
    }
}
```

### _Result Content_ parameter

_Result Content_ (`rcn`) request parameter specifies what content will be included in a response. Mobius4 supports the following `rcn` values for child resources.

| `rcn` | Returns | Target's own attributes |
|-------|---------|-------------------------|
| 4 | child resources inline | included |
| 8 | child resources inline | omitted |
| 5 | child resource *references* (`ch`) | included |
| 6 | child resource *references* (`m2m:rrl`) | omitted |

These four values work on **DELETE** as well as RETRIEVE (`TS-0001:8.1.2` Table 8.1.2-1): the
response carries the resources as they were immediately before removal, which is the only chance to
see them. The default for DELETE is still "nothing".

The two families are mutually exclusive by schema: `CDT-<resourceType>.xsd` puts the reference
form and the inline form in the same `xs:choice`, so a response carries one or the other.

For better performance, it is suggested to limit the level and resource type (e.g. `lvl=1&ty=4` in HTTP query string). 

**Descendants are nested under their own parent** when `lvl` reaches beyond the direct children
(`TS-0004:8.4.3` EXAMPLE 3). Retrieving `Mobius/sensors?rcn=4&lvl=2` over a tree of
`sensors > {humid01 > h1, temp01 > (t1, t2), sub-a}` gives:

```jsonc
{"m2m:cnt": {"rn": "sensors", /* ... */
   "m2m:cnt": [{"rn": "humid01", /* ... */ "m2m:cin": [{"rn": "h1"}]},
               {"rn": "temp01",  /* ... */ "m2m:cin": [{"rn": "t1"}, {"rn": "t2"}]}],
   "m2m:sub": [{"rn": "sub-a"}]}}
```

**Pagination.** `lim` bounds the number of resources returned and cuts only on subtree
boundaries — a direct child whose descendants do not all fit is left out whole, as
`TS-0001:8.1.2` requires. When that happens the response carries `X-M2M-CTS: 1` (partial) and
`X-M2M-CTO`, the index of the next unprocessed **direct child**; send that value back as `ofst`
to continue. If a single direct child's subtree is larger than `lim` the response has no children
at all and only a larger `lim` helps — the server logs a warning in that case.

Check the response format with the following examples.

`rcn=4` HTTP request and response example targeting a container resource.

 ```curl
    GET Mobius/cnt1?rcn=4&lvl=1&ty=4 HTTP/1.1
 ```

HTTP response body looks like:
```json
{
    "m2m:cnt": {
        "ty": 3,
        "et": "20260830T022649",
        "ct": "20250830T022649",
        "lt": "20250830T022649",
        "ri": "lhteublh9s",
        "rn": "cnt1",
        "pi": "nqtzgi6ksx",
        "cni": 9,
        "cbs": 136,
        "st": 12,
        "mni": 10000,
        "mbs": 10000000,
        "mia": 2592000,
        "m2m:cin": [
            {
                "ty": 4,
                "et": "20260830T022833",
                "ct": "20250830T022833",
                "lt": "20250830T022833",
                "ri": "9ek106jsc6",
                "rn": "cin-1bcRDKUcfY",
                "pi": "lhteublh9s",
                "st": 4,
                "cs": 16,
                "con": {
                    "humi": 40.4716042688265,
                    "temp": 22.70711665195612
                }
            },
            {
                "ty": 4,
                "et": "20260830T022903",
                "ct": "20250830T022903",
                "lt": "20250830T022903",
                "ri": "8hdwfdwewc",
                "rn": "cin-1v8Hy4uABc",
                "pi": "lhteublh9s",
                "st": 10,
                "cs": 16,
                "con": {
                    "humi": 44.41566784040748,
                    "temp": 20.185816629431198
                }
            }
        ]
    }
}
```

`rcn=8` HTTP request and response example targeting a container resource.

 ```curl
    GET Mobius/cnt1?rcn=8&lvl=1&ty=4 HTTP/1.1
 ```

HTTP response body looks like:

```json
{
    "m2m:cnt": {
        "m2m:cin": [
            {
                "ty": 4,
                "et": "20260830T022833",
                "ct": "20250830T022833",
                "lt": "20250830T022833",
                "ri": "9ek106jsc6",
                "rn": "cin-1bcRDKUcfY",
                "pi": "lhteublh9s",
                "st": 4,
                "cs": 16,
                "con": {
                    "humi": 40.4716042688265,
                    "temp": 22.70711665195612
                }
            },
            {
                "ty": 4,
                "et": "20260830T022903",
                "ct": "20250830T022903",
                "lt": "20250830T022903",
                "ri": "8hdwfdwewc",
                "rn": "cin-1v8Hy4uABc",
                "pi": "lhteublh9s",
                "st": 10,
                "cs": 16,
                "con": {
                    "humi": 44.41566784040748,
                    "temp": 20.185816629431198
                }
            }
        ]
    }
}
```


### flexContainer specializations

A `<container>` keeps its data in `<contentInstance>` children. A `<flexContainer>` instead
carries the data **directly on itself**, as attributes whose names and types are chosen by
whoever defines the specialization — a smart parking block, a light bulb, a thermostat. oneM2M
calls those `[customAttribute]` members, and the `containerDefinition` (`cnd`) attribute is what
says which set applies.

#### 1. Register the specialization

`cnd` is a URI identifying the document that defines the specialization. TS-0004:7.4.37.2.1
requires the CSE to validate every request against that definition, and to answer
`SPECIALIZATION_SCHEMA_NOT_FOUND` when it cannot find it. Each specialization you intend to
accept is declared once in **`config/specializations.json`**, whose whole content is the
registry, keyed by `cnd` URI:

```json
{
    "http://developers.iotocean.org/schema/parkingBlock.xsd": {
        "typeName": "parkingBlock",
        "namespacePrefix": "sc",
        "attributes": {
            "type":                { "type": "string"  },
            "name":                { "type": "string"  },
            "category":            { "type": "array"   },
            "availableSpotNumber": { "type": "integer" },
            "totalSpotNumber":     { "type": "integer" },
            "refParkingSpot":      { "type": "array"   }
        }
    }
}
```

Add your own entries to that file — it is separate from `config/default.json` and is read
directly rather than through the `config` package, so `local.json` layering does not apply.
The full key reference is in
[Configuration](configuration.md#flexcontainer-specializations). **The CSE reads this at
startup, so restart after editing.**

> **`cnd` is an identifier, not something the CSE fetches.** It is typed `xs:anyURI`, and
> nothing in oneM2M requires it to be dereferenceable. The official conformance suite uses
> values like `urn:m2m:CDT-gis-v2_21_0.xsd` and `org.onem2m.home.device.deviceLight`, neither of
> which resolves to anything over the network. Mobius4 matches the value as an opaque string
> against the table above and never issues a request for it — resolving an arbitrary URL on the
> CREATE path would make resource creation depend on an external host being reachable.
>
> An `http(s)` URL that really does serve the XSD is still a good choice, because it gives
> people reading your payloads somewhere to look. Just treat publishing the file as
> documentation for humans and other tools, not as something this CSE consumes.

Two things in that entry decide what a valid request looks like:

- `namespacePrefix` + `typeName` form the **envelope key**: `sc:parkingBlock`. This is not
  `m2m:` — TS-0004:7.4.37.1 allows a specialization to use its own namespace, and Mobius4 stores
  the key you send and replays it in every response and notification.
- `attributes` is the set of custom attribute names you may use. Names are matched exactly as
  they appear on the wire; the CSE performs no long-name/short-name translation, because the
  oneM2M short-name tables (TS-0004 clauses 8.2.2–8.2.5) only cover oneM2M-defined names and a
  third-party specialization has none.

#### 2. Create

`ty=28` in the `Content-Type` selects the operation, exactly as with other resource types.
`cnd` is mandatory here and cannot be changed afterwards.

```curl
curl -X POST http://127.0.0.1:7599/Mobius \
  -H 'X-M2M-Origin: CAE1' -H 'X-M2M-RI: 12345' -H 'X-M2M-RVI: 3' \
  -H 'Content-Type: application/json; ty=28' \
  -d '{
        "sc:parkingBlock": {
            "rn": "flx1",
            "cnd": "http://developers.iotocean.org/schema/parkingBlock.xsd",
            "type": "ParkingBlock",
            "name": "KETI_Block_A",
            "category": [],
            "availableSpotNumber": 3,
            "totalSpotNumber": 49,
            "refParkingSpot": ["wdc_base/sync_parking/parkingLot_KETI/parkingSpot_001"]
        }
      }'
```

A `<flexContainer>` may be created under `<CSEBase>`, `<AE>`, `<remoteCSE>`, `<container>`, or
another `<flexContainer>`. It can itself hold `<container>`, `<subscription>` and nested
`<flexContainer>` children.

The response echoes the resource with the attributes the CSE generated — note `cs`
(`contentSize`, the size of the custom attributes) and `st` (`stateTag`), both of which are
read-only and must not be sent in a request:

```json
{
    "sc:parkingBlock": {
        "ty": 28,
        "et": "20270802T063056",
        "ct": "20260802T063056",
        "lt": "20260802T063056",
        "ri": "runwgwrlz5",
        "rn": "flx1",
        "pi": "awjnpfnrnh",
        "st": 0,
        "cnd": "http://developers.iotocean.org/schema/parkingBlock.xsd",
        "cs": 170,
        "name": "KETI_Block_A",
        "type": "ParkingBlock",
        "category": [],
        "refParkingSpot": ["wdc_base/sync_parking/parkingLot_KETI/parkingSpot_001"],
        "totalSpotNumber": 49,
        "availableSpotNumber": 3
    }
}
```

Custom attributes come back in a different order than they were sent — they are stored as a
single JSONB value, which does not preserve key order. Read them by name, not by position.

#### 3. Update

Send only what changes. Attributes you omit are left alone; sending `null` removes an optional
one.

```curl
curl -X PUT http://127.0.0.1:7599/Mobius/flx1 \
  -H 'X-M2M-Origin: SM' -H 'X-M2M-RI: 12345' -H 'X-M2M-RVI: 3' \
  -H 'Content-Type: application/json' \
  -d '{ "sc:parkingBlock": { "availableSpotNumber": 7 } }'
```

**`stateTag` behaves differently here than on a `<container>`.** TS-0001:9.6.35 scopes the
increment to custom attribute changes, so updating `availableSpotNumber` bumps `st` and
recomputes `cs`, while updating only `lbl` or `acpi` leaves both untouched. If you are polling
`st` to detect new data, that is the distinction you are relying on.

`cnd` is write-once — including it in an UPDATE is rejected, even with the same value.

#### 4. Retrieve, delete, and discover

RETRIEVE and DELETE need no special handling:

```curl
curl http://127.0.0.1:7599/Mobius/flx1 -H 'X-M2M-Origin: SM' -H 'X-M2M-RI: 12345' -H 'X-M2M-RVI: 3'
curl -X DELETE http://127.0.0.1:7599/Mobius/flx1 -H 'X-M2M-Origin: SM' -H 'X-M2M-RI: 12345' -H 'X-M2M-RVI: 3'
```

Discovery accepts `cnd` as a filter criterion, which is the practical way to find every
resource of one specialization across the tree:

```curl
curl 'http://127.0.0.1:7599/Mobius?fu=1&cnd=http://developers.iotocean.org/schema/parkingBlock.xsd' \
  -H 'X-M2M-Origin: SM' -H 'X-M2M-RI: 12345' -H 'X-M2M-RVI: 3'
```

```json
{ "m2m:uril": ["Mobius/flx1", "Mobius/lot_KETI/blockA", "Mobius/lot_KETI/blockB"] }
```

Because `cnd` only exists on `<flexContainer>`, this filter implicitly restricts the search to
`ty=28`; other resource types are never returned. Pass several values separated by spaces to
match any of them. `?fu=1&ty=28` returns every flexContainer regardless of specialization.

#### 5. What gets rejected, and why

| Situation | RSC | HTTP |
| :--- | :--- | :--- |
| `cnd` missing on CREATE | 4000 | 400 |
| `cnd` not in `specializations` | 4125 `SPECIALIZATION_SCHEMA_NOT_FOUND` | 501 |
| Envelope key is not `prefix:typeName` from the entry | 4000 | 400 |
| Custom attribute not declared in `attributes` | 4000 | 400 |
| Declared custom attribute with the wrong type | 4000 | 400 |
| `cnd` included in an UPDATE | 4000 | 400 |
| Parent is not one of the allowed types | 4108 | 403 |
| `mni`, `mbs` or `mia` with a non-zero value | 5001 `NOT_IMPLEMENTED` | 501 |

A 4125 almost always means a typo in `cnd`, or an entry that was added to configuration without
restarting the CSE.

The last row is a deliberate limitation rather than a validation rule. Those three attributes
drive the creation of `<flexContainerInstance>` children — the timestamped history of a
flexContainer — and TS-0004:7.4.37.2.1 makes a non-zero value the trigger for creating them.
Mobius4 does not implement `<flexContainerInstance>` yet, so it rejects the attributes instead
of storing them, which would report success for a retention policy that never runs. For the
same reason the `<latest>` and `<oldest>` virtual resources are not available under a
`<flexContainer>`; use `<container>` and `<contentInstance>` if you need history today.


## Changes from previous version of Mobius

### Subscription/Notification

For the MQTT notifications, the previous Mobius interpreted the MQTT URL in the `nu` attribute into the MQTT topic as follows. Note that `Mobius2` is the CSE-ID of the previous Mobius.

| notificationURI (nu) | notification topic | 
| :--- | :--- |
| mqtt://localhost:1883/SAE1?ct=json | /oneM2M/req/Mobius2/SAE1/json |


As explained above for [subscription/notification feature](#subscriptionnotification), following the latest version of the oneM2M spec, Mobius4 works as below.

| notificationURI (nu) | notification topic | 
| :--- | :--- |
| mqtt://localhost:1883/noti?ct=json | noti/json |
| mqtt://localhost:1883/noti/temp?ct=json | noti/temp/json |