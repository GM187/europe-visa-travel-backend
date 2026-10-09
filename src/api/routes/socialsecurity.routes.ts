import { Router } from "express";

import { apiKeyAuth } from "@/api/middleware/apiKeyAuth";
import { asyncHandler } from "@/api/middleware/asyncHandler";
import { socialSecurityIntakeLimiter } from "@/api/middleware/rateLimit";
import { validate } from "@/api/middleware/validate";
import { socialSecurityWebhookAuth } from "@/api/middleware/webhookAuth";
import {
  listSocialSecurityLeadsSchema,
  socialSecurityLeadIdSchema,
  socialSecurityWebhookSchema,
  type ListSocialSecurityLeadsQuery,
  type SocialSecurityLead,
  type SocialSecurityLeadDetail,
  type SocialSecurityWebhook,
} from "@/domain/socialsecurity.schema";
import {
  createSocialSecurityService,
  type SocialSecurityService,
} from "@/services/socialsecurity.service";

/**
 * Social Security lead intake and the operator-facing reads.
 *
 * The two halves carry different credentials on purpose. The intake is called
 * by the Disability Benefit Helps site's serverless function and authenticates with
 * `x-socialsecurity-signature`; everything below it is called by our own admin
 * console and authenticates with `x-api-key`. A caller who can post a lead
 * cannot read the inbox.
 */

/**
 * The list representation. Explicit, so a new column is never published by
 * accident.
 */
function present(lead: SocialSecurityLead) {
  return {
    id: lead.id,
    submittedAt: lead.submittedAt.toISOString(),
    source: lead.source,
    firstName: lead.firstName,
    lastName: lead.lastName,
    phoneRaw: lead.phoneRaw,
    phoneE164: lead.phoneE164,
    email: lead.email,
    emailNormalised: lead.emailNormalised,
    zip: lead.zip,
    state: lead.state,
    isRepeat: lead.isRepeat,
    createdAt: lead.createdAt.toISOString(),
  };
}

/** The detail representation: the list fields plus the consent and raw body. */
function presentDetail(lead: SocialSecurityLeadDetail) {
  return {
    ...present(lead),
    relatedLeadIds: lead.relatedLeadIds,
    rawPayload: lead.rawPayload,
    consent: {
      // Verbatim. Never truncated for display -- the whole value is the record.
      text: lead.consent.text,
      version: lead.consent.version,
      consentedAt: lead.consent.consentedAt.toISOString(),
      ipAddress: lead.consent.ipAddress,
      userAgent: lead.consent.userAgent,
    },
  };
}

export function socialSecurityRouter(
  service: SocialSecurityService = createSocialSecurityService(),
): Router {
  const router = Router();

  /**
   * POST /api/v1/socialsecurity/leads -- intake from disabilitybenefithelps.com.
   *
   * Status codes carry the meaning the producer acts on:
   *   201 -- recorded.
   *   200 -- already recorded (a retry). Same id, nothing written.
   *   401/422 -- the caller's problem; retrying will not help.
   *   503 -- ours; the row was not written and a retry is worth making.
   *
   * Never 5xx for bad input: the site shows the visitor a retry on any non-2xx,
   * and a retry of a malformed body only produces a second one.
   */
  router.post(
    "/",
    socialSecurityIntakeLimiter,
    socialSecurityWebhookAuth,
    /* The raw body is captured before `validate` replaces `req.body` with the
       parsed value. `raw_payload` must be the original: unknown keys and
       untruncated audit strings are exactly what it exists to preserve. */
    (req, _res, next) => {
      (req as { rawLeadBody?: unknown }).rawLeadBody = req.body;
      next();
    },
    validate(socialSecurityWebhookSchema),
    asyncHandler(async (req, res) => {
      const rawBody = (req as { rawLeadBody?: unknown }).rawLeadBody;
      const { lead, duplicate } = await service.record(req.body as SocialSecurityWebhook, rawBody);

      res
        .status(duplicate ? 200 : 201)
        .location(`/api/v1/socialsecurity/leads/${lead.id}`)
        .json({ data: { id: lead.id, duplicate } });
    }),
  );

  /*
   * Everything below reads personal data and consent records.
   *
   * Same shared API key as the other producers' reads, and correct for the same
   * reason: no human holds it. The admin console is server-rendered by Next.js,
   * which authenticates the operator against its own session cookie first and
   * only then calls this API from the server. The key is not the authorisation
   * model; the session in front of it is.
   */

  /** Registered before `/:id` -- Express matches in declaration order, so the
   *  other way round "stats" is captured as an id and 422s. */
  router.get(
    "/stats",
    apiKeyAuth,
    asyncHandler(async (_req, res) => {
      res.json({ data: await service.stats() });
    }),
  );

  router.get(
    "/",
    apiKeyAuth,
    validate(listSocialSecurityLeadsSchema, "query"),
    asyncHandler(async (req, res) => {
      const { items, pagination } = await service.list(
        req.query as unknown as ListSocialSecurityLeadsQuery,
      );
      res.json({ data: items.map(present), pagination });
    }),
  );

  router.get(
    "/:id",
    apiKeyAuth,
    validate(socialSecurityLeadIdSchema, "params"),
    asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as { id: number };
      res.json({ data: presentDetail(await service.getById(id)) });
    }),
  );

  return router;
}
