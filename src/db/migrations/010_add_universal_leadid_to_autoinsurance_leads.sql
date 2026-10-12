-- Jornaya LeadiD for Explore Auto Insurance leads.
--
-- The LeadiD is the 36-character token Jornaya's script writes into the quote
-- form's hidden `#leadid_token` input in the visitor's browser. Jornaya holds the
-- recording of what the visitor saw and did; this column is the key that ties
-- that recording, and so the TCPA consent proof, to the lead.
--
-- Nullable, and not constrained beyond its length: tracking must never cost us a
-- lead. A visitor with an ad blocker sends no token, and a malformed one is
-- stored as NULL by the API. Leads that pre-date this column are NULL too.
--
-- Same shape as migration 005 for final_expense_leads, so the two producers that
-- collect a LeadiD store it the same way.
ALTER TABLE auto_insurance_leads
    ADD COLUMN IF NOT EXISTS universal_leadid VARCHAR(36);

-- Support asks "which lead is this LeadiD?" when Jornaya flags one. Partial: most
-- historic rows are NULL, and NULLs are never looked up.
CREATE INDEX IF NOT EXISTS auto_insurance_leads_universal_leadid_idx
    ON auto_insurance_leads (universal_leadid)
    WHERE universal_leadid IS NOT NULL;
