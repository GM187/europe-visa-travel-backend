import { Router } from "express";

import { apiKeyAuth } from "@/api/middleware/apiKeyAuth";
import { asyncHandler } from "@/api/middleware/asyncHandler";
import { voxenriseIntakeLimiter } from "@/api/middleware/rateLimit";
import { validate } from "@/api/middleware/validate";
import { voxenriseApiKeyAuth } from "@/api/middleware/webhookAuth";
import {
  listVoxenriseLeadsSchema,
  voxenriseLeadSchema,
  type ListVoxenriseLeadsQuery,
  type VoxenriseLead,
  type VoxenriseLeadPayload,
} from "@/domain/voxenrise.schema";
import { createVoxenriseService, type VoxenriseService } from "@/services/voxenrise.service";

/**
 * VoxEnrise lead intake and the operator-facing reads.
 *
 * The two halves carry different credentials on purpose. The intake is called
 * by the client's server and authenticates with `x-voxenrise-api-key`;
 * everything below it is called by our own dashboard and authenticates with
 * `x-api-key`. The client can post numbers and cannot read the list — which
 * matters more here than for our own sites, because the list contains numbers
 * from feeds that are none of this client's business.
 */

/**
 * The list representation. Explicit, so a new column is never published by
 * accident — `raw_payload` in particular is stored for audit and is not for
 * the dashboard.
 */
function present(lead: VoxenriseLead) {
  return {
    id: lead.id,
    phoneRaw: lead.phoneRaw,
    phoneE164: lead.phoneE164,
    isRepeat: lead.isRepeat,
    createdAt: lead.createdAt.toISOString(),
  };
}

export function voxenriseRouter(service: VoxenriseService = createVoxenriseService()): Router {
  const router = Router();

  /**
   * POST /api/v1/voxenriseleads — intake from the VoxEnrise client.
   *
   * Status codes carry the meaning the client acts on, and the integration
   * guide documents them as the contract:
   *   201 — stored. Body: { data: { id, createdAt, duplicate } }
   *   401 — the API key is missing or wrong. Retrying will not help.
   *   422 — the body failed validation. Retrying will not help.
   *   429 — too fast; retry after a pause.
   *   503 — ours. Nothing was written, and a retry is worth making.
   *
   * A number already seen is NOT an error. It comes back 201 with
   * `duplicate: true`, because the same person enquiring twice is a real
   * event and the client has no way to act on being told it is a conflict.
   */
  router.post(
    "/",
    voxenriseIntakeLimiter,
    voxenriseApiKeyAuth,
    /* The raw body is captured before `validate` replaces `req.body` with the
       parsed value. `raw_payload` must be the original: unknown keys are
       exactly what it exists to preserve, and they are the first sign the
       client has started sending something new. */
    (req, _res, next) => {
      (req as { rawLeadBody?: unknown }).rawLeadBody = req.body;
      next();
    },
    validate(voxenriseLeadSchema),
    asyncHandler(async (req, res) => {
      const rawBody = (req as { rawLeadBody?: unknown }).rawLeadBody;
      const lead = await service.record(req.body as VoxenriseLeadPayload, rawBody);

      res
        .status(201)
        .location(`/api/v1/voxenriseleads/${lead.id}`)
        .json({
          data: {
            id: lead.id,
            createdAt: lead.createdAt.toISOString(),
            duplicate: lead.isRepeat,
          },
        });
    }),
  );

  /*
   * Everything below reads personal data.
   *
   * Same shared API key as the other producers' reads, and correct for the
   * same reason: no human holds it. The dashboard is server-rendered,
   * authenticates the operator against its own session first, and only then
   * calls this API from the server. The key is not the authorisation model;
   * the session in front of it is.
   */

  /** Registered before any `/:id` route — Express matches in declaration
   *  order, so the other way round "stats" is captured as an id. */
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
    validate(listVoxenriseLeadsSchema, "query"),
    asyncHandler(async (req, res) => {
      const { items, pagination } = await service.list(
        req.query as unknown as ListVoxenriseLeadsQuery,
      );
      res.json({ data: items.map(present), pagination });
    }),
  );

  return router;
}
