import {
  toCreateVoxenriseLead,
  type ListVoxenriseLeadsQuery,
  type VoxenriseLead,
  type VoxenriseLeadPayload,
  type VoxenriseLeadStats,
} from "@/domain/voxenrise.schema";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  voxenriseLeadRepository,
  type VoxenriseLeadRepository,
} from "@/repositories/voxenrise.repository";

/**
 * Business logic for VoxEnrise leads.
 *
 * The repository is injected so every rule here is unit-testable against a
 * fake with no database in the test run, exactly as the other lead services
 * are.
 */
export function createVoxenriseService(
  repository: VoxenriseLeadRepository = voxenriseLeadRepository,
) {
  return {
    /**
     * Record a phone number from the client.
     *
     * `rawBody` is the untouched request body, stored verbatim. It is passed
     * separately from `payload` because `payload` is the parsed value, which
     * has already trimmed the number and dropped any unknown keys.
     */
    async record(payload: VoxenriseLeadPayload, rawBody: unknown): Promise<VoxenriseLead> {
      try {
        const lead = await repository.create(toCreateVoxenriseLead(payload, rawBody));

        /* Identifiers and non-personal context only. A phone number is
           personal data and does not belong in a retained log store or a
           third-party error tracker, so the id and the repeat flag go in and
           the number itself does not. */
        logger.info(
          { leadId: lead.id, repeat: lead.isRepeat },
          lead.isRepeat ? "VoxEnrise number recorded again" : "VoxEnrise number stored",
        );

        return lead;
      } catch (error) {
        /* 503, not 500: the row was not written and a retry is worth making.
           The guide tells the client to retry on 5xx, and that only holds if
           a storage failure is reported as one. */
        throw new AppError("Could not save the lead.", {
          status: 503,
          code: "storage_unavailable",
          cause: error,
        });
      }
    },

    async list(params: ListVoxenriseLeadsQuery) {
      const { items, total } = await repository.list(params);
      return {
        items,
        pagination: {
          total,
          limit: params.limit,
          offset: params.offset,
          hasMore: params.offset + items.length < total,
        },
      };
    },

    async stats(): Promise<VoxenriseLeadStats> {
      return repository.stats();
    },
  };
}

export type VoxenriseService = ReturnType<typeof createVoxenriseService>;
