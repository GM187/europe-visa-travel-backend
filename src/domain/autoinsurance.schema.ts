import { createHash } from "node:crypto";
import { z } from "zod";

import {
  cappedText,
  isoDate,
  normaliseEmail,
  normalisePhone,
  parseUniversalLeadId,
} from "@/domain/shared";

/**
 * The contract for an Explore Auto Insurance lead (exploreautoinsurance.com).
 *
 * The site validates every answer in the browser and again in its own
 * serverless function (`api/lead.js` in that repo) before it posts here. This re-validates all of it anyway: this API is a
 * separate trust boundary, and it must be correct when called by a replayed
 * request, a second producer, or curl.
 *
 * The same two rules as the other producer schemas shape this one, and they pull
 * in opposite directions:
 *
 *   - The *answers* are rejected when invalid. They are the lead; a lead with a
 *     malformed phone number or email is not worth having, and here those are the
 *     only ways to reach the person.
 *   - The *audit* strings are truncated when too long, never rejected. A long
 *     user agent is not a reason to lose a real lead. The untruncated value
 *     survives verbatim in `raw_payload` regardless.
 *
 * The consent text is the exception to both: it is evidence, so it is stored
 * exactly as sent, and an implausibly long one is rejected outright rather than
 * silently shortened. A truncated consent record is worse than none.
 */

/* ------------------------------------------------------------------ states */

/**
 * The 50 states plus DC, as USPS two-letter codes.
 *
 * An explicit set rather than a two-letter regex: "XX" matches a regex and is
 * not a place, and an agent is licensed per state, so a lead routed to a state
 * that does not exist is a lead nobody can work. Territories (PR, GU, VI) are
 * deliberately absent -- the agency is not licensed there, and admitting them
 * here would imply a product this site does not sell. Alaska and Hawaii are
 * accepted even though the agency does not write policies there today: the
 * form offers them, and an operator can tell that person so, which is better
 * than a 422 the visitor can only retry.
 */
export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL",
  "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
  "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH",
  "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
] as const;

const US_STATE_SET = new Set<string>(US_STATES);

/* ------------------------------------------------------------------ answers */

export const autoInsuranceAnswersSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required.").max(50),
  lastName: z.string().trim().min(1, "Last name is required.").max(50),

  /* Arrives pre-masked as "(555) 555-5555". Validated on the ten digits inside
     it rather than on the mask, so a differently formatted but valid number is
     still accepted. */
  phone: z
    .string()
    .trim()
    .min(1, "A phone number is required.")
    .max(30)
    .refine((value) => normalisePhone(value) !== null, "Expected a ten-digit US phone number."),

  /* Lower-cased and trimmed by normaliseEmail, validated by basic structure check. */
  email: z
    .string()
    .trim()
    .min(1, "An email address is required.")
    .max(254)
    .refine(
      (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
      "Expected a valid email address.",
    ),

  /* ZIP+4 is accepted although the site's input only takes five digits: it is a
     valid ZIP, and refusing it would cost a lead over formatting. */
  zip: z
    .string()
    .trim()
    .regex(/^\d{5}(-\d{4})?$/, "Expected a five-digit ZIP code."),

  /* Upper-cased before the membership test so a producer sending "fl" is
     accepted rather than 422'd over case. */
  state: z
    .string()
    .trim()
    .toUpperCase()
    .refine((value) => US_STATE_SET.has(value), "Expected a two-letter US state code."),
});

export type AutoInsuranceAnswers = z.infer<typeof autoInsuranceAnswersSchema>;

/* ----------------------------------------------------------------- envelope */

export const autoInsuranceWebhookSchema = z.object({
  /* Generated in the visitor's browser and re-sent on a retry. Required: it is
     the whole dedupe key. A submission without one cannot be deduplicated, and
     defaulting it would make every such submission collide with every other. */
  submissionId: z
    .string()
    .trim()
    .min(8, "A submission id is required.")
    .max(100, "The submission id is too long."),

  /* The producer's own receipt time. */
  receivedAt: isoDate,

  /* Which site and form sent it, e.g. "exploreautoinsurance.com/#get-quote".
     Shown to operators as-is. */
  source: z.string().trim().min(1, "A source is required.").max(100),

  answers: autoInsuranceAnswersSchema,

  /* Jornaya LeadiD, written into the form's hidden `#leadid_token` input by
     Jornaya's script. `unknown` on purpose: the shape is checked by
     `parseUniversalLeadId`, which stores null rather than rejecting the lead --
     an ad blocker that stops the script must never cost a lead. */
  universalLeadId: z.unknown().optional(),

  consent: z.object({
    /* Capped far above the ~600 characters the current wording runs to, and
       NOT truncated with `cappedText` -- see the note at the top of the file. */
    text: z.string().min(1, "The consent text is required.").max(20_000),
    version: z.string().trim().min(1, "The consent version is required.").max(80),
    timestamp: isoDate,
  }),

  /* Optional as a whole: the visitor's IP and browser are context, and a
     producer that could not read them should still be able to post the lead. */
  audit: z
    .object({
      ipAddress: cappedText(45),
      userAgent: cappedText(1_000),
    })
    .default({}),
});

/* Unknown keys are stripped from the parsed value but survive in `raw_payload`,
   which is stored unmodified. That is what makes the site gaining a new answer a
   forward-compatible change here rather than a 422 and a lost lead. */
export type AutoInsuranceWebhook = z.output<typeof autoInsuranceWebhookSchema>;
export type AutoInsuranceWebhookInput = z.input<typeof autoInsuranceWebhookSchema>;

/* -------------------------------------------------------------- persistence */

/** What the repository is asked to write. Derived, never taken from the wire. */
export interface CreateAutoInsuranceLead {
  dedupeKey: string;
  submittedAt: Date;
  source: string;
  firstName: string;
  lastName: string;
  phoneRaw: string;
  phoneE164: string | null;
  email: string;
  emailNormalised: string;
  zip: string;
  state: string;
  /** Jornaya LeadiD, or null when the browser sent none or a malformed one. */
  universalLeadId: string | null;
  rawPayload: unknown;
  consent: {
    text: string;
    version: string;
    consentedAt: Date;
    ipAddress: string | null;
    userAgent: string | null;
  };
}

/**
 * The idempotency key: sha256 of the source and the submission id.
 *
 * The source is part of it so two sites can never collide on an id, even by
 * accident -- the unique index is table-wide, and one site's UUID being another
 * site's "already recorded" would silently drop a real lead.
 */
export function deriveDedupeKey(source: string, submissionId: string): string {
  return createHash("sha256").update(`${source}\n${submissionId}`).digest("hex");
}

/**
 * Maps a validated webhook body onto the insert shape.
 *
 * Every derived value is computed here, in one place: the normalised phone,
 * normalised email, and the dedupe key. `rawPayload` is the *original* body,
 * not the parsed result -- the parsed result has already dropped unknown keys
 * and truncated long ones.
 */
export function toCreateAutoInsuranceLead(
  payload: AutoInsuranceWebhook,
  rawPayload: unknown,
): CreateAutoInsuranceLead {
  const { answers, consent, audit } = payload;

  return {
    dedupeKey: deriveDedupeKey(payload.source, payload.submissionId),
    submittedAt: payload.receivedAt,
    source: payload.source,

    firstName: answers.firstName,
    lastName: answers.lastName,
    phoneRaw: answers.phone,
    phoneE164: normalisePhone(answers.phone),
    email: answers.email,
    emailNormalised: normaliseEmail(answers.email),
    zip: answers.zip,
    state: answers.state,
    universalLeadId: parseUniversalLeadId(payload.universalLeadId).value,
    rawPayload,

    consent: {
      text: consent.text,
      version: consent.version,
      consentedAt: consent.timestamp,
      ipAddress: audit.ipAddress,
      userAgent: audit.userAgent,
    },
  };
}

/* --------------------------------------------------------------- read models */

/** A lead as the list shows it. Every answer fits, so the detail view adds
 *  context (consent, raw body, related leads) rather than more answers. */
export interface AutoInsuranceLead {
  id: number;
  submittedAt: Date;
  source: string;
  firstName: string;
  lastName: string;
  phoneRaw: string;
  phoneE164: string | null;
  email: string;
  emailNormalised: string;
  zip: string;
  state: string;
  createdAt: Date;
  /**
   * True when an earlier lead shares this one's phone number or email address.
   *
   * Computed in the list and detail queries rather than stored: it is a
   * statement about the rest of the table, so a stored copy would be wrong the
   * moment a neighbouring row changed.
   */
  isRepeat: boolean;
}

export interface AutoInsuranceLeadConsent {
  text: string;
  version: string;
  consentedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}

/** A lead with everything attached. Only the detail view needs this much. */
export interface AutoInsuranceLeadDetail extends AutoInsuranceLead {
  /** Jornaya LeadiD. Null for leads without one, including every lead from before it was collected. */
  universalLeadId: string | null;
  consent: AutoInsuranceLeadConsent;
  rawPayload: unknown;
  /** Ids of earlier leads from the same phone number or email, newest first. */
  relatedLeadIds: number[];
}

/* ------------------------------------------------------------------ queries */

export const listAutoInsuranceLeadsSchema = z.object({
  /** Free text over name, phone, ZIP, state, and email. */
  q: z
    .string()
    .trim()
    .max(100, "Search terms are limited to 100 characters.")
    .optional()
    .transform((value) => (value ? value : undefined)),

  /** Exact state filter, for an operator working one licence at a time. */
  state: z
    .string()
    .trim()
    .toUpperCase()
    .refine((value) => US_STATE_SET.has(value), "Expected a two-letter US state code.")
    .optional(),

  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export type ListAutoInsuranceLeadsQuery = z.output<typeof listAutoInsuranceLeadsSchema>;

export const autoInsuranceLeadIdSchema = z.object({
  id: z.coerce.number().int().positive("Lead id must be a positive integer."),
});

/** Counters for the overview tiles. Operations, not analytics. */
export interface AutoInsuranceLeadStats {
  total: number;
  /** Since midnight UTC. */
  today: number;
  last7Days: number;
  last30Days: number;
}
