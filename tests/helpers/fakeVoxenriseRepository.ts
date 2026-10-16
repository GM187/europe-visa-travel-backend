import type {
  CreateVoxenriseLead,
  ListVoxenriseLeadsQuery,
  VoxenriseLead,
  VoxenriseLeadStats,
} from "@/domain/voxenrise.schema";
import type { VoxenriseLeadRepository } from "@/repositories/voxenrise.repository";

/**
 * In-memory VoxEnrise repository with the same contract as the Postgres one,
 * including its repeat detection: a row is a repeat when an EARLIER row holds
 * the same E.164 number.
 */

interface StoredLead extends VoxenriseLead {
  rawPayload: unknown;
}

export function createFakeVoxenriseRepository(): VoxenriseLeadRepository & {
  rows: StoredLead[];
  failNext?: Error;
} {
  const rows: StoredLead[] = [];
  let nextId = 1;

  const fake: VoxenriseLeadRepository & { rows: StoredLead[]; failNext?: Error } = {
    rows,

    async create(input: CreateVoxenriseLead): Promise<VoxenriseLead> {
      if (fake.failNext) {
        const error = fake.failNext;
        fake.failNext = undefined;
        throw error;
      }

      const lead: StoredLead = {
        id: nextId++,
        phoneRaw: input.phoneRaw,
        phoneE164: input.phoneE164,
        // Evaluated against the rows that exist BEFORE this one, as the SQL is.
        isRepeat: rows.some((row) => row.phoneE164 === input.phoneE164),
        createdAt: new Date(),
        rawPayload: input.rawPayload,
      };

      rows.push(lead);
      return lead;
    },

    async list({ q, limit, offset }: ListVoxenriseLeadsQuery) {
      const digits = q ? q.replace(/\D/g, "") : "";

      const matched = rows.filter((row) => {
        if (!digits) return true;
        return (
          row.phoneRaw.replace(/\D/g, "").includes(digits) ||
          row.phoneE164.replace(/\D/g, "").includes(digits)
        );
      });

      // Newest first, as `ORDER BY created_at DESC, id DESC` gives.
      const ordered = [...matched].sort((a, b) => b.id - a.id);

      return { items: ordered.slice(offset, offset + limit), total: ordered.length };
    },

    async stats(): Promise<VoxenriseLeadStats> {
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      return {
        total: rows.length,
        last24h: rows.filter((row) => row.createdAt.getTime() >= dayAgo).length,
        uniqueNumbers: new Set(rows.map((row) => row.phoneE164)).size,
      };
    },
  };

  return fake;
}
