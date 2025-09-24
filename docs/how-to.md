
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

_Result Content_ (`rcn`) request parameter specifies what content will be included in a response. Mobius4 supports the following `rcn` values.
- 4: attributes + child resources
- 8: child resources

`rcn=4` is used to retrieve the target and its child/decendant resources while `rcn=8` retrieves only child/decendant resources.

For better performance, it is suggested to limit the level and resource type (e.g. `lvl=1&ty=4` in HTTP query string). 

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