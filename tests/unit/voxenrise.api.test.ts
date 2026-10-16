import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/api/app";
import { createVoxenriseService } from "@/services/voxenrise.service";
import { createFakeVoxenriseRepository } from "../helpers/fakeVoxenriseRepository";

const API_KEY = process.env.API_KEY as string;
const CLIENT_KEY = process.env.VOXENRISE_API_KEY as string;
const PATH = "/api/v1/voxenriseleads";

let repository: ReturnType<typeof createFakeVoxenriseRepository>;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  repository = createFakeVoxenriseRepository();
  app = createApp({ voxenriseService: createVoxenriseService(repository) });
});

/** Intake, as the client calls it. */
const post = (body: unknown, key: string | null = CLIENT_KEY) => {
  const req = request(app).post(PATH);
  if (key !== null) req.set("x-voxenrise-api-key", key);
  return req.send(body as object);
};

/** The dashboard reads, as our own server calls them. */
const get = (path = PATH, key: string | null = API_KEY) => {
  const req = request(app).get(path);
  if (key !== null) req.set("x-api-key", key);
  return req;
};

describe("POST /api/v1/voxenriseleads", () => {
  it("stores a phone number and returns its id", async () => {
    const response = await post({ phone_number: "+14155550199" });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ id: expect.any(Number), duplicate: false });
    expect(response.headers.location).toBe(`${PATH}/${response.body.data.id}`);

    expect(repository.rows).toHaveLength(1);
    expect(repository.rows[0]).toMatchObject({
      phoneRaw: "+14155550199",
      phoneE164: "+14155550199",
    });
  });

  it("normalises however the client formats the number", async () => {
    const formats = ["(415) 555-0199", "415-555-0199", "4155550199", "1 415 555 0199"];

    for (const value of formats) {
      const response = await post({ phone_number: value });
      expect(response.status).toBe(201);
    }

    // Every format lands on one E.164 value, while the raw string is kept.
    expect(repository.rows.map((row) => row.phoneE164)).toEqual(Array(4).fill("+14155550199"));
    expect(repository.rows.map((row) => row.phoneRaw)).toEqual(formats);
  });

  it("stores the original body, not the parsed one", async () => {
    await post({ phone_number: "  +14155550199  ", campaign: "spring", note: "from IVR" });

    // Unknown keys are dropped from the payload but kept in the audit copy —
    // they are the first sign the client has started sending something new.
    expect(repository.rows[0]!.rawPayload).toEqual({
      phone_number: "  +14155550199  ",
      campaign: "spring",
      note: "from IVR",
    });
    expect(repository.rows[0]!.phoneRaw).toBe("+14155550199");
  });

  it("accepts a number it has seen before and flags it as a duplicate", async () => {
    const first = await post({ phone_number: "+14155550199" });
    const second = await post({ phone_number: "(415) 555-0199" });

    expect(first.body.data.duplicate).toBe(false);
    /* 201, not 409: the same person enquiring twice is a real event, and the
       client has no way to act on being told it is a conflict. */
    expect(second.status).toBe(201);
    expect(second.body.data.duplicate).toBe(true);
    expect(repository.rows).toHaveLength(2);
  });

  it("returns 422 and stores nothing when the number cannot be dialled", async () => {
    const bad = ["", "   ", "12345", "not-a-number", "+44 20 7946 0958", "0155550199"];

    for (const value of bad) {
      const response = await post({ phone_number: value });
      expect(response.status, `expected 422 for ${JSON.stringify(value)}`).toBe(422);
      expect(response.body.error.details.fieldErrors).toHaveProperty("phone_number");
    }

    expect(repository.rows).toHaveLength(0);
  });

  it("returns 422 when phone_number is absent or not a string", async () => {
    for (const body of [{}, { phone_number: null }, { phone_number: 4155550199 }]) {
      const response = await post(body);
      expect(response.status).toBe(422);
      expect(response.body.error.details.fieldErrors).toHaveProperty("phone_number");
    }

    expect(repository.rows).toHaveLength(0);
  });

  it("rejects a request with no API key, and stores nothing", async () => {
    const response = await post({ phone_number: "+14155550199" }, null);

    expect(response.status).toBe(401);
    expect(repository.rows).toHaveLength(0);
  });

  it("rejects the wrong API key", async () => {
    expect((await post({ phone_number: "+14155550199" }, "nope-wrong-key-0123456789")).status).toBe(
      401,
    );
  });

  it("does not accept the operator's key on intake", async () => {
    /* The two credentials open different halves of this router. If the
       operator key worked here, a leak of it would let anyone write into the
       feed as well as read it. */
    expect((await post({ phone_number: "+14155550199" }, API_KEY)).status).toBe(401);
  });

  it("returns 503 without claiming the lead was stored when the database is down", async () => {
    repository.failNext = new Error("connection terminated");

    const response = await post({ phone_number: "+14155550199" });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("storage_unavailable");
  });
});

describe("GET /api/v1/voxenriseleads", () => {
  const seed = async (...numbers: string[]) => {
    for (const number of numbers) await post({ phone_number: number });
  };

  it("lists the stored numbers, newest first", async () => {
    await seed("+14155550199", "+12125550143", "+13075550142");

    const response = await get();

    expect(response.status).toBe(200);
    expect(response.body.data.map((row: { phoneE164: string }) => row.phoneE164)).toEqual([
      "+13075550142",
      "+12125550143",
      "+14155550199",
    ]);
    expect(response.body.pagination).toMatchObject({ total: 3, limit: 25, offset: 0, hasMore: false });
  });

  it("publishes only the dashboard fields, never the raw payload", async () => {
    await post({ phone_number: "+14155550199", campaign: "spring" });

    const row = (await get()).body.data[0];

    expect(Object.keys(row).sort()).toEqual(
      ["createdAt", "id", "isRepeat", "phoneE164", "phoneRaw"].sort(),
    );
    expect(JSON.stringify(row)).not.toContain("spring");
  });

  it("marks the second arrival of a number as a repeat, and not the first", async () => {
    await seed("+14155550199", "+14155550199");

    const rows = (await get()).body.data;

    // Newest first, so the repeat is the one at the top.
    expect(rows[0].isRepeat).toBe(true);
    expect(rows[1].isRepeat).toBe(false);
  });

  it("searches on digits, whatever punctuation was sent", async () => {
    await seed("(415) 555-0199", "+12125550143");

    const response = await get(`${PATH}?q=4155550199`);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].phoneRaw).toBe("(415) 555-0199");
  });

  it("paginates", async () => {
    await seed("+14155550101", "+14155550102", "+14155550103");

    const first = await get(`${PATH}?limit=2`);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.pagination).toMatchObject({ total: 3, hasMore: true });

    const second = await get(`${PATH}?limit=2&offset=2`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.pagination.hasMore).toBe(false);
  });

  it("returns 422 for an out-of-range limit", async () => {
    expect((await get(`${PATH}?limit=0`)).status).toBe(422);
    expect((await get(`${PATH}?limit=500`)).status).toBe(422);
  });

  it("requires the operator key, and will not take the client's", async () => {
    expect((await get(PATH, null)).status).toBe(401);
    /* The client posts numbers; it must not be able to read the list, which
       holds numbers from feeds that are none of its business. */
    expect((await get(PATH, CLIENT_KEY)).status).toBe(401);
  });
});

describe("GET /api/v1/voxenriseleads/stats", () => {
  it("counts totals and distinct numbers", async () => {
    for (const number of ["+14155550199", "+14155550199", "+12125550143"]) {
      await post({ phone_number: number });
    }

    const response = await get(`${PATH}/stats`);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ total: 3, last24h: 3, uniqueNumbers: 2 });
  });

  it("is not reachable with the client's key", async () => {
    expect((await get(`${PATH}/stats`, CLIENT_KEY)).status).toBe(401);
    expect((await get(`${PATH}/stats`, null)).status).toBe(401);
  });
});
