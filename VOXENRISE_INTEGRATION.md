# VoxEnrise Lead API — Integration Guide

Post a phone number, get a confirmation. That is the whole API.

- **Base URL:** `https://europe-visa-travel-backend-production-54a2.up.railway.app`
- **Endpoint:** `POST /api/v1/voxenriseleads`
- **Auth:** `x-voxenrise-api-key` header
- **Body:** JSON, one field

---

## 1. Authentication

Send the API key you were issued in the `x-voxenrise-api-key` header on every
request:

```
x-voxenrise-api-key: YOUR_API_KEY
```

The key identifies you and nobody else. Two things follow from that:

- **Keep it server-side.** Never put it in a web page, a mobile app, or
  anything else a user can read. Anyone holding it can post leads as you.
- **Tell us if it leaks** and we will issue a new one. Rotation is quick; a key
  quietly circulating is not.

The key is not `Authorization` and not `x-api-key`. Those headers are ignored
here, and a request without `x-voxenrise-api-key` gets a `401`.

---

## 2. The request

`Content-Type: application/json`, with exactly one field:

```json
{
  "phone_number": "+14155550199"
}
```

### phone_number

**Required.** A US phone number. Format it however is convenient — these are
all accepted and all stored as the same number:

| You send | We store |
| --- | --- |
| `+14155550199` | `+14155550199` |
| `4155550199` | `+14155550199` |
| `(415) 555-0199` | `+14155550199` |
| `415-555-0199` | `+14155550199` |
| `1 415 555 0199` | `+14155550199` |

We keep your original string too, exactly as sent.

**Not accepted** (these return `422`): an empty value, fewer or more than 10
digits, letters, and non-US numbers. If you need to send non-US numbers, talk
to us first — it is a change at our end, not something to work around by
reformatting.

### Other fields

There are none. You may include extra keys and the request will still succeed —
we record them but act on none of them. If you want us to *use* something
beyond the phone number, that is a conversation, not an extra key.

---

## 3. The response

### Success — `201 Created`

```json
{
  "data": {
    "id": 1042,
    "createdAt": "2026-10-17T09:14:22.113Z",
    "duplicate": false
  }
}
```

| Field | Meaning |
| --- | --- |
| `id` | Our identifier for this submission. Worth logging — quote it if you ever ask us about a specific lead. |
| `createdAt` | When we stored it (UTC, ISO 8601). |
| `duplicate` | `true` if we have seen this number before, from you or otherwise. |

**`duplicate: true` is not an error.** The lead was stored, it has its own `id`,
and you do not need to do anything about it. The same person enquiring twice is
a real event and we would rather have both records. Treat any `201` as success.

### Failures

| Status | What it means | What to do |
| --- | --- | --- |
| `401` | API key missing or wrong | Fix the key. **Do not retry** — it will keep failing. |
| `422` | The body failed validation | Fix the payload. **Do not retry** — see below for the error shape. |
| `429` | You are sending too fast | Back off and retry. See [Rate limits](#5-rate-limits). |
| `503` | Our storage is unavailable | **Nothing was saved. Please retry.** |
| `500`/`502`/`504` | Something broke at our end | Retry. |

A `422` names the field:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "The request body failed validation.",
    "requestId": "b66f309f-dc4a-4ebc-8872-6c58dae760ab",
    "details": {
      "fieldErrors": {
        "phone_number": "Expected a US phone number, e.g. +14155550199, 4155550199 or (415) 555-0199."
      }
    }
  }
}
```

Log `fieldErrors` when one comes back. It tells you exactly what to fix, and it
is the difference between a five-minute correction and a day of guessing.

Every error response also carries a `requestId`. **Quote it when you contact
us** — it finds your exact request in our logs immediately.

---

## 4. Retry policy

The rule is simple: **retry `429` and `5xx`, never `401` or `422`.**

A `4xx` other than `429` means the request itself is wrong. Retrying an
unchanged bad request just produces the same failure, and a retry loop on a
`401` looks indistinguishable from an attack from our side.

For `5xx` and `429`, use exponential backoff — something like 1s, 2s, 4s, 8s,
up to five attempts. Do not retry in a tight loop.

A `503` guarantees nothing was written, so retrying it cannot create a
duplicate. If a request times out with **no response at all**, you cannot know
whether it landed. Retry it: a duplicate comes back as `201` with
`duplicate: true` and costs nothing, which is much better than a lost lead.

---

## 5. Rate limits

**120 requests per minute.**

Over that you get `429` with standard `RateLimit-*` headers telling you when
the window resets. If 120/minute is too low for your volume, tell us — it is a
configuration change, not a hard limit.

Send leads as they happen rather than in one nightly burst where you can. A
steady trickle never approaches the limit; 5,000 numbers at midnight does.

---

## 6. Examples

Replace `YOUR_API_KEY` with the key you were issued.

### cURL

```bash
curl -X POST \
  "https://europe-visa-travel-backend-production-54a2.up.railway.app/api/v1/voxenriseleads" \
  -H "x-voxenrise-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"phone_number": "+14155550199"}'
```

### Node.js

```javascript
const BASE_URL = "https://europe-visa-travel-backend-production-54a2.up.railway.app";

async function sendLead(phoneNumber) {
  const response = await fetch(`${BASE_URL}/api/v1/voxenriseleads`, {
    method: "POST",
    headers: {
      "x-voxenrise-api-key": process.env.VOXENRISE_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ phone_number: phoneNumber }),
  });

  const body = await response.json();

  if (response.status === 201) {
    return body.data; // { id, createdAt, duplicate }
  }

  // 401 and 422 are our mistake to fix; everything else is worth retrying.
  const retryable = response.status === 429 || response.status >= 500;
  throw Object.assign(new Error(body.error?.message ?? "Lead submission failed"), {
    status: response.status,
    requestId: body.error?.requestId,
    retryable,
  });
}
```

### Python

```python
import os
import requests

BASE_URL = "https://europe-visa-travel-backend-production-54a2.up.railway.app"

def send_lead(phone_number: str) -> dict:
    response = requests.post(
        f"{BASE_URL}/api/v1/voxenriseleads",
        headers={
            "x-voxenrise-api-key": os.environ["VOXENRISE_API_KEY"],
            "Content-Type": "application/json",
        },
        json={"phone_number": phone_number},
        timeout=10,
    )

    if response.status_code == 201:
        return response.json()["data"]

    error = response.json().get("error", {})
    raise RuntimeError(
        f"{response.status_code}: {error.get('message')} "
        f"(requestId {error.get('requestId')})"
    )
```

### PHP

```php
<?php
$baseUrl = 'https://europe-visa-travel-backend-production-54a2.up.railway.app';

$ch = curl_init("$baseUrl/api/v1/voxenriseleads");
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 10,
    CURLOPT_HTTPHEADER     => [
        'x-voxenrise-api-key: ' . getenv('VOXENRISE_API_KEY'),
        'Content-Type: application/json',
    ],
    CURLOPT_POSTFIELDS     => json_encode(['phone_number' => '+14155550199']),
]);

$response = curl_exec($ch);
$status   = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

$body = json_decode($response, true);

if ($status === 201) {
    $lead = $body['data'];   // id, createdAt, duplicate
} else {
    error_log("Lead failed ($status): " . ($body['error']['message'] ?? 'unknown')
              . ' requestId=' . ($body['error']['requestId'] ?? '-'));
}
```

---

## 7. Checklist before going live

- [ ] The API key is in an environment variable or a secrets manager — not in
      source control, not in a client-side bundle.
- [ ] You send one test lead and get a `201`.
- [ ] You send a deliberately bad number (`"12345"`) and get a `422` your code
      handles without crashing.
- [ ] `401` and `422` are logged and **not** retried.
- [ ] `429` and `5xx` are retried with backoff.
- [ ] You log the returned `id` on success and the `requestId` on failure.
- [ ] Requests have a timeout set (10 seconds is plenty).

---

## 8. Getting help

Include these and the answer comes back much faster:

- The `requestId` from the error response
- The HTTP status you received
- Roughly when it happened, with a timezone
- The request body you sent, with the phone number redacted if you prefer

---

## 9. A note on consent

We store what you send and nothing more. This API carries no record of how
each number was collected or what the person agreed to.

Consent evidence for these numbers stays with you, and the agreement covering
this feed is what permits anyone to call them. Please make sure you only send
numbers you are entitled to share.
