import {
  toCreateSocialSecurityLead,
  type ListSocialSecurityLeadsQuery,
  type SocialSecurityLead,
  type SocialSecurityLeadDetail,
  type SocialSecurityLeadStats,
  type SocialSecurityWebhook,
} from "@/domain/socialsecurity.schema";
import { AppError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  socialSecurityLeadRepository,
  type SocialSecurityLeadRepository,
} from "@/repositories/socialsecurity.repository";

/**
 * Business logic for Social Security leads.
 *
 * The repository is injected so every rule here is unit-testable against a fake
 * with no database in the test run, exactly as the enquiry, Road Cover, Final
 * Expense, Senior Health and AffordablePlan services are.
 */
export function createSocialSecurityService(
  repository: SocialSecurityLeadRepository = socialSecurityLeadRepository,
) {
  return {
    /**
     * Record a free case review request from the Disability Benefit Helps site.
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
      payload: SocialSecurityWebhook,
      rawBody: unknown,
    ): Promise<{ lead: SocialSecurityLead; duplicate: boolean }> {
      const input = toCreateSocialSecurityLead(payload, rawBody);

      try {
        const { lead, duplicate } = await repository.create(input);

        /* Identifiers and non-personal context only. This payload carries a
           name, a phone number, an email address and a consent record; none of
           it belongs in a retained log store or a third-party error tracker.
           The state is the one answer included: it is not identifying on its
           own, and "where are leads coming from" is the question most likely
           to be asked of the logs alone. */
        logger.info(
          {
            leadId: lead.id,
            duplicate,
            source: payload.source,
            state: lead.state,
            consentVersion: payload.consent.version,
          },
          duplicate ? "Social Security lead already recorded" : "Social Security lead stored",
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

    async getById(id: number): Promise<SocialSecurityLeadDetail> {
      const lead = await repository.findById(id);
      if (!lead) throw new NotFoundError(`No lead with id ${id}.`);
      return lead;
    },

    async list(params: ListSocialSecurityLeadsQuery) {
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

    async stats(): Promise<SocialSecurityLeadStats> {
      return repository.stats();
    },
  };
}

export type SocialSecurityService = ReturnType<typeof createSocialSecurityService>;
