import type {
  SocialSecurityLead,
  SocialSecurityLeadDetail,
  SocialSecurityWebhookInput,
  CreateSocialSecurityLead,
} from "@/domain/socialsecurity.schema";
import type {
  SocialSecurityLeadRepository,
  CreateSocialSecurityLeadResult,
} from "@/repositories/socialsecurity.repository";

/**
 * In-memory Social Security repository with the same contract as the Postgres
 * one, including its idempotency on `dedupe_key` and its phone-OR-email repeat
 * detection.
 */

interface StoredLead extends SocialSecurityLead {
  dedupeKey: string;
  rawPayload: unknown;
  consent: CreateSocialSecurityLead["consent"];
}

/** Mirrors the SQL: either key matches, and a null phone never matches anything. */
function samePerson(a: { phoneE164: string | null; emailNormalised: string }, b: typeof a): boolean {
  return (
    (a.phoneE164 !== null && a.phoneE164 === b.phoneE164) || a.emailNormalised === b.emailNormalised
  );
}

export function createFakeSocialSecurityRepository(): SocialSecurityLeadRepository & {
  rows: StoredLead[];
  failNext?: Error;
} {
  const rows: StoredLead[] = [];
  let nextId = 1;

  const fake: SocialSecurityLeadRepository & { rows: StoredLead[]; failNext?: Error } = {
    rows,

    async create(input: CreateSocialSecurityLead): Promise<CreateSocialSecurityLeadResult> {
      if (fake.failNext) {
        const error = fake.failNext;
        fake.failNext = undefined;
        throw error;
      }

      const existing = rows.find((r) => r.dedupeKey === input.dedupeKey);
      if (existing) return { lead: existing, duplicate: true };

      const lead: StoredLead = {
        id: nextId++,
        dedupeKey: input.dedupeKey,
        submittedAt: input.submittedAt,
        source: input.source,
        firstName: input.firstName,
        lastName: input.lastName,
        phoneRaw: input.phoneRaw,
        phoneE164: input.phoneE164,
        email: input.email,
        emailNormalised: input.emailNormalised,
        zip: input.zip,
        state: input.state,
        createdAt: new Date(),
        isRepeat: rows.some((r) => samePerson(r, input)),
        rawPayload: input.rawPayload,
        consent: input.consent,
      };

      rows.push(lead);
      return { lead, duplicate: false };
    },

    async findById(id: number): Promise<SocialSecurityLeadDetail | null> {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      return {
        ...row,
        relatedLeadIds: rows.filter((r) => r.id !== row.id && samePerson(r, row)).map((r) => r.id),
        consent: { ...row.consent },
      };
    },

    async list(params) {
      let items = [...rows].reverse();

      if (params.q) {
        const needle = params.q.toLowerCase();
        const digits = params.q.replace(/\D/g, "");
        items = items.filter(
          (r) =>
            `${r.firstName} ${r.lastName}`.toLowerCase().includes(needle) ||
            r.zip.includes(needle) ||
            r.state.toLowerCase().includes(needle) ||
            r.emailNormalised.includes(needle) ||
            (digits !== "" && r.phoneRaw.replace(/\D/g, "").includes(digits)),
        );
      }

      if (params.state) items = items.filter((r) => r.state === params.state);

      return {
        items: items.slice(params.offset, params.offset + params.limit),
        total: items.length,
      };
    },

    async stats() {
      return {
        total: rows.length,
        today: rows.length,
        last7Days: rows.length,
        last30Days: rows.length,
      };
    },
  };

  return fake;
}

/**
 * A complete, valid request body, shaped exactly as the site's `api/lead.js`
 * function sends it.
 *
 * `overrides` are merged at the top level only; nested objects take a full
 * replacement, which keeps the helper honest about what a test is changing.
 */
export function validSocialSecurityPayload(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  const payload: SocialSecurityWebhookInput = {
    submissionId: "3f6b8d21-9c4e-4a7b-b1d2-6e0f5a9c7d34",
    receivedAt: "2026-10-07T14:05:12.000Z",
    source: "disabilitybenefithelps.com/#free-review",
    answers: {
      firstName: "Maria",
      lastName: "Garcia",
      phone: "(619) 555-0142",
      email: "Maria.Garcia@Example.com",
      zip: "82601",
      state: "WY",
    },
    consent: {
      text: "I agree that Disability Benefit Helps may call or text me at the number above about my case review, including by automated means. Consent isn’t required to get help; you can always call us instead. Message and data rates may apply. Reply STOP to opt out. See our privacy policy.",
      version: "dbh-tcpa-2026-10-09",
      timestamp: "2026-10-07T14:05:10.000Z",
    },
    audit: {
      ipAddress: "198.51.100.42",
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    },
  };

  return { ...(payload as unknown as Record<string, unknown>), ...overrides };
}

/** The `answers` object of the valid payload, with some fields replaced. */
export function socialSecurityAnswersWith(changes: Record<string, unknown>): Record<string, unknown> {
  return { ...(validSocialSecurityPayload().answers as object), ...changes };
}
