import type express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

import { createApp } from "@/api/app";
import {
  createSocialSecurityService,
  type SocialSecurityService,
} from "@/services/socialsecurity.service";
import {
  socialSecurityAnswersWith,
  createFakeSocialSecurityRepository,
  validSocialSecurityPayload,
} from "../helpers/fakeSocialSecurityRepository";

const API_KEY = process.env.API_KEY as string;
const DBH_SECRET = process.env.SOCIALSECURITY_WEBHOOK_SECRET as string;
const SHB_SECRET = process.env.SENIORHEALTH_WEBHOOK_SECRET as string;

const INTAKE = "/api/v1/socialsecurity/leads";

/**
 * Full HTTP tests through the real app -- real middleware, real routing, real
 * error handler -- with only the repository faked.
 */
describe("POST /api/v1/socialsecurity/leads", () => {
  let repository: ReturnType<typeof createFakeSocialSecurityRepository>;
  let service: SocialSecurityService;
  let app: express.Express;

  beforeEach(() => {
    repository = createFakeSocialSecurityRepository();
    service = createSocialSecurityService(repository);
    app = createApp({ socialSecurityService: service });
  });

  const post = (body: unknown) =>
    request(app).post(INTAKE).set("x-socialsecurity-signature", DBH_SECRET).send(body as object);

  it("records a valid lead and returns 201 with its id", async () => {
    const response = await post(validSocialSecurityPayload());

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: { id: 1, duplicate: false } });
    expect(response.headers.location).toBe(`${INTAKE}/1`);
    expect(repository.rows).toHaveLength(1);
  });

  it("normalises the phone and email, and upper-cases the state", async () => {
    await post(
      validSocialSecurityPayload({
        answers: socialSecurityAnswersWith({ phone: "619-555-0142", state: "wy" }),
      }),
    );

    const lead = repository.rows[0]!;
    expect(lead.phoneE164).toBe("+16195550142");
    // The raw forms are kept as typed: the consent record refers to them.
    expect(lead.phoneRaw).toBe("619-555-0142");
    expect(lead.email).toBe("Maria.Garcia@Example.com");
    expect(lead.emailNormalised).toBe("maria.garcia@example.com");
    expect(lead.state).toBe("WY");
  });

  it("stores the consent record verbatim", async () => {
    const payload = validSocialSecurityPayload();
    await post(payload);

    const consent = repository.rows[0]!.consent;
    const sent = (payload as { consent: { text: string; version: string } }).consent;
    expect(consent.text).toBe(sent.text);
    expect(consent.version).toBe(sent.version);
    expect(consent.ipAddress).toBe("198.51.100.42");
  });

  it("keeps the original body in raw_payload, including unknown keys", async () => {
    await post(validSocialSecurityPayload({ utmCampaign: "fall-2026" }));

    expect(repository.rows[0]!.rawPayload).toMatchObject({ utmCampaign: "fall-2026" });
  });

  it("answers a retry of the same submission with 200 and writes nothing new", async () => {
    const payload = validSocialSecurityPayload();
    await post(payload);
    const second = await post(payload);

    expect(second.status).toBe(200);
    expect(second.body).toEqual({ data: { id: 1, duplicate: true } });
    expect(repository.rows).toHaveLength(1);
  });

  it("treats the same submission id from the other page's form as a different lead", async () => {
    await post(validSocialSecurityPayload());
    const other = await post(
      validSocialSecurityPayload({ source: "disabilitybenefithelps.com/contact.html#free-review" }),
    );

    expect(other.status).toBe(201);
    expect(repository.rows).toHaveLength(2);
  });

  it("flags a repeat on a matching phone number", async () => {
    await post(validSocialSecurityPayload());
    await post(
      validSocialSecurityPayload({
        submissionId: "a2c4e6f8-1b3d-4f5a-8c7e-9d0b2a4c6e81",
        answers: socialSecurityAnswersWith({ email: "someone.else@example.com" }),
      }),
    );

    expect(repository.rows[1]!.isRepeat).toBe(true);
  });

  it("flags a repeat on a matching email, whatever its case", async () => {
    await post(validSocialSecurityPayload());
    await post(
      validSocialSecurityPayload({
        submissionId: "b7d9f1a3-5c2e-4b6d-9e8f-0a1c3e5b7d92",
        answers: socialSecurityAnswersWith({ phone: "(305) 555-0188", email: "MARIA.GARCIA@example.com" }),
      }),
    );

    expect(repository.rows[1]!.isRepeat).toBe(true);
  });

  it.each([
    ["a missing first name", { firstName: "" }],
    ["a missing last name", { lastName: "" }],
    ["a phone number that is not ten digits", { phone: "(619) 555-014" }],
    ["an email with no domain", { email: "maria@" }],
    ["a ZIP that is not five digits", { zip: "826" }],
    ["a state that is not a real code", { state: "XX" }],
  ])("rejects %s with 422", async (_label, change) => {
    const response = await post(
      validSocialSecurityPayload({ answers: socialSecurityAnswersWith(change) }),
    );

    expect(response.status).toBe(422);
    expect(repository.rows).toHaveLength(0);
  });

  it.each([
    ["a territory (Puerto Rico)", { state: "pr" }, "PR"],
    ["a territory (Guam)", { state: "GU" }, "GU"],
  ])("accepts %s, which the site's form offers", async (_label, change, stored) => {
    const response = await post(
      validSocialSecurityPayload({ answers: socialSecurityAnswersWith(change) }),
    );

    expect(response.status).toBe(201);
    expect(repository.rows[0]!.state).toBe(stored);
  });

  it("accepts a ZIP+4", async () => {
    const response = await post(
      validSocialSecurityPayload({ answers: socialSecurityAnswersWith({ zip: "82601-1234" }) }),
    );

    expect(response.status).toBe(201);
    expect(repository.rows[0]!.zip).toBe("82601-1234");
  });

  it("rejects a submission with no consent text", async () => {
    const response = await post(
      validSocialSecurityPayload({
        consent: { text: "", version: "dbh-tcpa-2026-10-09", timestamp: "2026-10-07T14:05:10.000Z" },
      }),
    );

    expect(response.status).toBe(422);
    expect(repository.rows).toHaveLength(0);
  });

  it("answers 503, not 500, when the lead could not be stored", async () => {
    repository.failNext = new Error("connection terminated");

    const response = await post(validSocialSecurityPayload());

    // The site retries on a 5xx; a 503 says the retry is worth making.
    expect(response.status).toBe(503);
  });

  it("rejects intake with a missing or wrong signature", async () => {
    const missing = await request(app).post(INTAKE).send(validSocialSecurityPayload());
    expect(missing.status).toBe(401);

    // Another producer's secret must not open this intake.
    const wrong = await request(app)
      .post(INTAKE)
      .set("x-socialsecurity-signature", SHB_SECRET)
      .send(validSocialSecurityPayload());
    expect(wrong.status).toBe(401);

    expect(repository.rows).toHaveLength(0);
  });

  it("does not accept the admin API key in place of the webhook secret", async () => {
    const response = await request(app)
      .post(INTAKE)
      .set("x-api-key", API_KEY)
      .send(validSocialSecurityPayload());

    expect(response.status).toBe(401);
  });
});

describe("GET /api/v1/socialsecurity/leads", () => {
  let repository: ReturnType<typeof createFakeSocialSecurityRepository>;
  let app: express.Express;

  beforeEach(async () => {
    repository = createFakeSocialSecurityRepository();
    app = createApp({ socialSecurityService: createSocialSecurityService(repository) });

    await request(app)
      .post(INTAKE)
      .set("x-socialsecurity-signature", DBH_SECRET)
      .send(validSocialSecurityPayload());
    await request(app)
      .post(INTAKE)
      .set("x-socialsecurity-signature", DBH_SECRET)
      .send(
        validSocialSecurityPayload({
          submissionId: "c7e2b910-44af-4c68-86d1-3b90f2a7e551",
          answers: socialSecurityAnswersWith({
            firstName: "Devon",
            lastName: "Taylor",
            phone: "(502) 555-0188",
            email: "devon.t@example.com",
            zip: "40202",
            state: "KY",
          }),
        }),
      );
  });

  const get = (path: string) => request(app).get(path).set("x-api-key", API_KEY);

  it("returns the leads newest first with pagination", async () => {
    const response = await get(INTAKE);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(2);
    expect(response.body.data[0].firstName).toBe("Devon");
    expect(response.body.data[0].email).toBe("devon.t@example.com");
    expect(response.body.pagination).toMatchObject({ total: 2, limit: 25, offset: 0 });
  });

  it("does not publish the dedupe key or the raw payload in the list", async () => {
    const response = await get(INTAKE);

    expect(response.body.data[0]).not.toHaveProperty("dedupeKey");
    expect(response.body.data[0]).not.toHaveProperty("rawPayload");
  });

  it("filters by state", async () => {
    const response = await get(`${INTAKE}?state=KY`);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].lastName).toBe("Taylor");
  });

  it("searches by name, email, and unformatted phone digits", async () => {
    expect((await get(`${INTAKE}?q=Maria`)).body.data).toHaveLength(1);
    expect((await get(`${INTAKE}?q=devon.t@`)).body.data).toHaveLength(1);
    expect((await get(`${INTAKE}?q=5025550188`)).body.data).toHaveLength(1);
  });

  it("returns the consent record and raw payload on the detail view", async () => {
    const response = await get(`${INTAKE}/1`);

    expect(response.status).toBe(200);
    expect(response.body.data.consent.version).toBe("dbh-tcpa-2026-10-09");
    expect(response.body.data).toHaveProperty("rawPayload");
  });

  it("answers 404 for a lead that does not exist", async () => {
    expect((await get(`${INTAKE}/999`)).status).toBe(404);
  });

  it("rejects reads without the API key, including with the webhook secret", async () => {
    expect((await request(app).get(INTAKE)).status).toBe(401);
    expect(
      (await request(app).get(INTAKE).set("x-socialsecurity-signature", DBH_SECRET)).status,
    ).toBe(401);
  });

  it("resolves /stats as the counters, not as a lead id", async () => {
    const response = await get(`${INTAKE}/stats`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ total: 2 });
  });
});
