-- Jornaya LeadiD for Senior Health Benefits Medicare leads.
--
-- The LeadiD is the 36-character token Jornaya's script writes into the quote
-- form's hidden `#leadid_token` input in the visitor's browser (campaign
-- "seniorhealthbenefits"). Jornaya holds the recording of what the visitor saw
-- and did; this column is the key that ties that recording, and so the TCPA
-- consent proof, to the lead.
--
-- It matters more on this producer than on the others: the form collects no
-- email address, so a call or a text is the only way these people are ever
-- contacted, and the consent record is the only thing that permits it.
--
-- Nullable, and not constrained beyond its length: tracking must never cost us a
-- lead. A visitor with an ad blocker sends no token, and a malformed one is
-- stored as NULL by the API. Leads that pre-date this column are NULL too.
--
-- Same shape as migrations 005 and 010, so every producer that collects a
-- LeadiD stores it the same way.
ALTER TABLE senior_health_leads
    ADD COLUMN IF NOT EXISTS universal_leadid VARCHAR(36);

-- Support asks "which lead is this LeadiD?" when Jornaya flags one. Partial: most
-- historic rows are NULL, and NULLs are never looked up.
CREATE INDEX IF NOT EXISTS senior_health_leads_universal_leadid_idx
    ON senior_health_leads (universal_leadid)
    WHERE universal_leadid IS NOT NULL;
