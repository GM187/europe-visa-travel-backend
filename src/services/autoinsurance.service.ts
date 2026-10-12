import {
  toCreateAutoInsuranceLead,
  type ListAutoInsuranceLeadsQuery,
  type AutoInsuranceLead,
  type AutoInsuranceLeadDetail,
  type AutoInsuranceLeadStats,
  type AutoInsuranceWebhook,
} from "@/domain/autoinsurance.schema";
import { parseUniversalLeadId } from "@/domain/shared";
import { AppError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  autoInsuranceLeadRepository,
  type AutoInsuranceLeadRepository,
} from "@/repositories/autoinsurance.repository";

/**
 * Business logic for AutoInsurance leads.
 *
 * The repository is injected so every rule here is unit-testable against a fake
 * with no database in the test run, exactly as the enquiry, Road Cover, Final
 * Expense, Senior Health and AffordablePlan services are.
 */
export function createAutoInsuranceService(
  repository: AutoInsuranceLeadRepository = autoInsuranceLeadRepository,
) {
  return {
    /**
     * Record a submission from the Explore Auto Insurance site.
     *
     * Returns `duplicate: true` when the dedupe key was already present, which
     * the route turns into a 200 rather than a 201. The site shows the visitor
     * an error on any non-2xx and invites a retry, so a repeated submission must
     * succeed quietly instead of erroring -- a retry cannot fix a duplicate, it
     * can only create another one.
     *
     * `rawBody` is the untouched request body, stored verbatim. It is passed
     * separately from `payload` because `payload` is the *parsed* value, which
     * has already dropped unknown keys and truncated over-long audit strings.
     */
    async record(
      payload: AutoInsuranceWebhook,
      rawBody: unknown,
    ): Promise<{ lead: AutoInsuranceLead; duplicate: boolean }> {
      const input = toCreateAutoInsuranceLead(payload, rawBody);

      /* Never a reason to refuse the lead: it is stored without the token. The
         value itself is not logged; the verbatim copy is in raw_payload. */
      const leadId = parseUniversalLeadId(payload.universalLeadId);
      if (leadId.status !== "valid") {
        logger.warn(
          { submissionId: payload.submissionId, source: payload.source, universalLeadIdStatus: leadId.status },
          "Auto Insurance lead has no usable Jornaya LeadiD",
        );
      }

      try {
        const { lead, duplicate } = await repository.create(input);

        /* Identifiers and non-personal context only. This payload carries a
           name, a phone number, an email address and a consent record; none of
           it belongs in a retained log store or a third-party error tracker.
           The state is the one answer included, because routing a lead to a
           licensed agent is the thing most likely to need debugging from logs
           alone. */
        logger.info(
          {
            leadId: lead.id,
            duplicate,
            source: payload.source,
            state: lead.state,
            consentVersion: payload.consent.version,
          },
          duplicate ? "AutoInsurance lead already recorded" : "AutoInsurance lead stored",
        );

        return { lead, duplicate };
      } catch (error) {
        throw new AppError("Could not save the lead.", {
          status: 503,
          code: "storage_unavailable",
          cause: error,
        });
      }
    },

    async getById(id: number): Promise<AutoInsuranceLeadDetail> {
      const lead = await repository.findById(id);
      if (!lead) throw new NotFoundError(`No lead with id ${id}.`);
      return lead;
    },

    async list(params: ListAutoInsuranceLeadsQuery) {
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

    async stats(): Promise<AutoInsuranceLeadStats> {
      return repository.stats();
    },
  };
}

export type AutoInsuranceService = ReturnType<typeof createAutoInsuranceService>;
