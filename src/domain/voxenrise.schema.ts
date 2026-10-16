import { z } from "zod";

import { normalisePhone } from "@/domain/shared";

/**
 * VoxEnrise lead intake: a phone number from an external client, and nothing
 * else.
 *
 * The narrowest payload of any producer here, and intentionally so. The client
 * agreed to send numbers; it did not agree to send names, emails or consent
 * records, and accepting fields nobody promised would mean storing personal
 * data this service has no basis for holding.
 */

/* ------------------------------------------------------------------ intake */

export const voxenriseLeadSchema = z.object({
  phone_number: z
    .string({
      required_error: "phone_number is required.",
      invalid_type_error: "phone_number must be a string.",
    })
    .trim()
    .min(1, "phone_number is required.")
    .max(30, "phone_number is limited to 30 characters.")
    /* Rejected rather than stored unnormalised, which is the opposite of how
       our own sites' intakes behave. There a lost lead is lost money, so a
       number that will not parse is kept anyway and sorted out by a human.
       Here the sender is a third party integrating against a written contract:
       a 422 naming the field is something they can fix once, where silently
       storing junk would have them discover it weeks later in our dashboard. */
    .refine(
      (value) => normalisePhone(value) !== null,
      "Expected a US phone number, e.g. +14155550199, 4155550199 or (415) 555-0199.",
    ),
});

export type VoxenriseLeadPayload = z.output<typeof voxenriseLeadSchema>;

export interface CreateVoxenriseLead {
  phoneRaw: string;
  phoneE164: string;
  rawPayload: unknown;
}

/**
 * `rawBody` is passed separately from `payload` because `payload` is the
 * parsed value — already trimmed, and with unknown keys dropped. The raw body
 * is what the client actually sent, and is the record of it.
 */
export function toCreateVoxenriseLead(
  payload: VoxenriseLeadPayload,
  rawBody: unknown,
): CreateVoxenriseLead {
  const phoneE164 = normalisePhone(payload.phone_number);

  /* Unreachable: the schema refines on exactly this. Asserted rather than
     non-null-asserted so a future loosening of the schema fails here, loudly,
     instead of writing an empty string into a NOT NULL column. */
  if (phoneE164 === null) {
    throw new Error("toCreateVoxenriseLead received a number the schema should have rejected.");
  }

  return { phoneRaw: payload.phone_number, phoneE164, rawPayload: rawBody ?? payload };
}

/* -------------------------------------------------------------------- read */

export interface VoxenriseLead {
  id: number;
  phoneRaw: string;
  phoneE164: string;
  /** True when an EARLIER row holds the same number. */
  isRepeat: boolean;
  createdAt: Date;
}

export interface VoxenriseLeadStats {
  total: number;
  last24h: number;
  uniqueNumbers: number;
}

export const listVoxenriseLeadsSchema = z.object({
  /** Free text over the phone number, in either stored form. */
  q: z
    .string()
    .trim()
    .max(30, "Search terms are limited to 30 characters.")
    .optional()
    .transform((value) => (value ? value : undefined)),

  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export type ListVoxenriseLeadsQuery = z.output<typeof listVoxenriseLeadsSchema>;
