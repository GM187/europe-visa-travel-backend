-- ActiveProspect TrustedForm certificates for Final Expense Coverage leads.
--
-- TrustedForm's script runs in the visitor's browser and records what they saw
-- and did on the page; the certificate URL stored here is the key to that
-- recording. Together with universal_leadid (migration 005) it is what turns
-- the consent row in final_expense_lead_consents from an assertion into
-- evidence: the consent text says what the person agreed to, the certificate
-- shows them agreeing to it.
--
-- TEXT rather than a capped VARCHAR. A certificate URL runs to about 75
-- characters today, but it is a third-party identifier whose format is
-- ActiveProspect's to change, and a length that no longer fits would fail the
-- insert and lose a real lead.
--
-- Nullable, and unconstrained beyond its type, for the reason migration 005
-- gives for the LeadiD: tracking must never cost us a lead. A visitor with an
-- ad blocker sends no certificate, one who submits before the script finishes
-- sends none either, and a malformed value is stored as NULL by the API. Leads
-- that pre-date this column are NULL too.
--
-- Kept on final_expense_leads rather than on the append-only consent table,
-- matching universal_leadid: it is attached at intake and never changes, but it
-- is looked up per lead. The verbatim value the browser sent survives in
-- raw_payload regardless.
ALTER TABLE final_expense_leads
    ADD COLUMN IF NOT EXISTS trusted_form_cert_url TEXT;

-- Support asks "which lead is this certificate?" when ActiveProspect or a buyer
-- flags one. Partial: historic rows are NULL, and NULLs are never looked up.
CREATE INDEX IF NOT EXISTS final_expense_leads_trusted_form_cert_url_idx
    ON final_expense_leads (trusted_form_cert_url)
    WHERE trusted_form_cert_url IS NOT NULL;
