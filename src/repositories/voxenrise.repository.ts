import { query } from "@/db/pool";
import type {
  CreateVoxenriseLead,
  ListVoxenriseLeadsQuery,
  VoxenriseLead,
  VoxenriseLeadStats,
} from "@/domain/voxenrise.schema";

/**
 * Data access for VoxEnrise leads. SQL lives here and nowhere else.
 *
 * A single table and a single-statement write — there is no consent row to
 * keep in step, so unlike the other producers' repositories nothing here needs
 * a transaction.
 */

interface LeadRow {
  id: string; // BIGSERIAL arrives as a string; pg will not silently lose precision.
  phone_raw: string;
  phone_e164: string;
  created_at: Date;
  is_repeat: boolean;
}

/**
 * The lead columns plus the repeat flag.
 *
 * `earlier.id < l.id` rather than a count: the question is "have we seen this
 * number before THIS row", so the first arrival is never flagged and every
 * later one is. Ordering on id, not created_at, because two rows written in
 * the same transaction can share a timestamp.
 */
const LEAD_COLUMNS = `
  l.id, l.phone_raw, l.phone_e164, l.created_at,
  EXISTS (
    SELECT 1 FROM voxenrise_leads earlier
     WHERE earlier.id < l.id
       AND earlier.phone_e164 = l.phone_e164
  ) AS is_repeat
`;

function toLead(row: LeadRow): VoxenriseLead {
  return {
    id: Number(row.id),
    phoneRaw: row.phone_raw,
    phoneE164: row.phone_e164,
    isRepeat: row.is_repeat,
    createdAt: row.created_at,
  };
}

export function createVoxenriseLeadRepository() {
  return {
    async create(input: CreateVoxenriseLead): Promise<VoxenriseLead> {
      /* The repeat test is a CTE rather than a subquery inside RETURNING.
         Every arm of a WITH sees the same snapshot, taken before the statement
         ran, so `prior` cannot observe the row `inserted` is writing — which
         is the whole question here, and it is answered by the shape of the
         statement rather than by how RETURNING happens to be evaluated. */
      const { rows } = await query<LeadRow>(
        `WITH prior AS (
           SELECT EXISTS (
             SELECT 1 FROM voxenrise_leads WHERE phone_e164 = $2
           ) AS is_repeat
         ), inserted AS (
           INSERT INTO voxenrise_leads (phone_raw, phone_e164, raw_payload)
                VALUES ($1, $2, $3::jsonb)
             RETURNING id, phone_raw, phone_e164, created_at
         )
         SELECT inserted.id, inserted.phone_raw, inserted.phone_e164,
                inserted.created_at, prior.is_repeat
           FROM inserted CROSS JOIN prior`,
        [input.phoneRaw, input.phoneE164, JSON.stringify(input.rawPayload ?? null)],
      );

      return toLead(rows[0]!);
    },

    async list({ q, limit, offset }: ListVoxenriseLeadsQuery) {
      const { rows } = await query<LeadRow & { total_count: string }>(
        `SELECT ${LEAD_COLUMNS}, COUNT(*) OVER () AS total_count
           FROM voxenrise_leads l
          /* POSITION, not ILIKE: a LIKE pattern would need the operator's term
             escaped first. Digits are stripped from both sides so a search for
             "4155550199" finds a number stored as "(415) 555-0199". */
          WHERE ($1::text IS NULL OR (
                  POSITION($1 IN REGEXP_REPLACE(l.phone_raw, '\\D', '', 'g')) > 0
               OR POSITION($1 IN REGEXP_REPLACE(l.phone_e164, '\\D', '', 'g')) > 0))
          ORDER BY l.created_at DESC, l.id DESC
          LIMIT $2 OFFSET $3`,
        [q ? q.replace(/\D/g, "") || null : null, limit, offset],
      );

      return {
        items: rows.map(toLead),
        total: rows.length > 0 ? Number(rows[0]!.total_count) : 0,
      };
    },

    async stats(): Promise<VoxenriseLeadStats> {
      const { rows } = await query<{ total: string; last24h: string; unique_numbers: string }>(
        `SELECT COUNT(*)                                             AS total,
                COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS last24h,
                COUNT(DISTINCT phone_e164)                           AS unique_numbers
           FROM voxenrise_leads`,
      );

      const row = rows[0]!;
      return {
        total: Number(row.total),
        last24h: Number(row.last24h),
        uniqueNumbers: Number(row.unique_numbers),
      };
    },
  };
}

export type VoxenriseLeadRepository = ReturnType<typeof createVoxenriseLeadRepository>;

export const voxenriseLeadRepository = createVoxenriseLeadRepository();
