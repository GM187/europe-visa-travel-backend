-- AffordablePlan lead intake (getaffordableplan.com).
--
-- Fifth producer, and its own tables for the same reasons the others gave: a
-- different set of answers, a different credential, and its own retention
-- rules. Widening one shared `leads` table for a fourth time would leave every
-- row mostly NULL.
--
-- What makes this producer different from Senior Health is that it collects an
-- email address in addition to a phone number. That has two consequences the
-- schema must carry:
--
--   - There are email columns (raw and normalised). The normalised form is
--     lower-cased and trimmed, stored alongside the original so operators
--     search on the form the visitor typed.
--   - "Has this person contacted us before?" is answered on EITHER the phone
--     number OR the normalised email. A lead that shares either key with an
--     earlier row is a repeat, which is stricter than phone-only but correct:
--     someone who changes their number but not their email address is still the
--     same person.
--
-- AffordablePlan is a lead-generation site, not an insurer. Nothing here is a
-- "policy" or a "customer" -- these are people who asked to be contacted about
-- plan options.

-- ---------------------------------------------------------------------------
-- affordable_plan_leads -- one row per submission
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS affordable_plan_leads (
    id                BIGSERIAL     PRIMARY KEY,

    -- sha256 of the source and the submission id generated in the visitor's
    -- browser. Re-sent on a retry after a network error that may or may not
    -- have reached us, which is what turns that retry into the original lead
    -- rather than a second one.
    dedupe_key        CHAR(64)      NOT NULL UNIQUE,

    -- The producer's receipt time, not ours. created_at is when this row was
    -- written; the two differ by the network and by any retry.
    submitted_at      TIMESTAMPTZ   NOT NULL,

    -- Which site and form sent it. A column rather than an assumption baked
    -- into the table name, so a second domain needs no migration.
    source            VARCHAR(100)  NOT NULL,

    first_name        VARCHAR(50)   NOT NULL,
    last_name         VARCHAR(50)   NOT NULL,

    -- Stored as received AND normalised. The raw form is what the person typed
    -- and what the consent record refers to; the E.164 form is what a dialler
    -- uses and the only thing repeat detection can match on here. A NULL e164
    -- means the number could not be normalised, not that it is absent.
    phone_raw         VARCHAR(30)   NOT NULL,
    phone_e164        VARCHAR(16),

    -- Stored as received AND normalised (lower-cased, trimmed). The raw form
    -- is what the person typed; the normalised form is what repeat detection
    -- matches on and what the search index covers.
    email             VARCHAR(254)  NOT NULL,
    email_normalised  VARCHAR(254)  NOT NULL,

    zip               VARCHAR(10)   NOT NULL,
    -- The two-letter USPS code the visitor selected. Upper-cased on the way in
    -- so the column has one representation and the CHECK can be exact.
    state             CHAR(2)       NOT NULL,

    -- The complete original body, unmodified. When the site gains an answer
    -- this schema does not model, or someone disputes what was submitted, this
    -- is the answer -- every column above is a projection of it.
    raw_payload       JSONB         NOT NULL,

    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT affordable_plan_leads_zip_shape_check CHECK (zip ~ '^[0-9]{5}(-[0-9]{4})?$'),
    CONSTRAINT affordable_plan_leads_state_shape_check CHECK (state ~ '^[A-Z]{2}$')
);

-- The dashboard's default view: newest first.
CREATE INDEX IF NOT EXISTS affordable_plan_leads_created_at_idx
    ON affordable_plan_leads (created_at DESC);

-- Repeat-submission detection, looked up per row in the list query.
-- Phone: for dialler-side lookups.
CREATE INDEX IF NOT EXISTS affordable_plan_leads_phone_e164_idx
    ON affordable_plan_leads (phone_e164);

-- Email: for email-side repeat detection and search.
CREATE INDEX IF NOT EXISTS affordable_plan_leads_email_normalised_idx
    ON affordable_plan_leads (email_normalised);

-- ---------------------------------------------------------------------------
-- affordable_plan_lead_consents -- TCPA evidence. APPEND-ONLY.
-- ---------------------------------------------------------------------------
-- Consent to be contacted, including by autodialler and text, is proven by the
-- exact text the person saw, its version, when they agreed, and the IP and user
-- agent it came from. All of it is stored verbatim on this row.
--
-- consent_text is the full string, NOT a foreign key to a template table. That
-- is the point: when the live wording on the site changes, what this row says
-- the person agreed to must not change with it.
--
-- There is no updated_at, and nothing in this codebase issues an UPDATE or a
-- DELETE against this table. Where the deployment can, revoke both at the
-- database-role level for the application user.
--
-- ON DELETE RESTRICT, not CASCADE: consent evidence must outlive the lead it
-- belongs to. Honouring a deletion request means redacting the personal columns
-- on affordable_plan_leads in place, not dropping the row.
CREATE TABLE IF NOT EXISTS affordable_plan_lead_consents (
    id                BIGSERIAL     PRIMARY KEY,
    lead_id           BIGINT        NOT NULL UNIQUE
                                    REFERENCES affordable_plan_leads(id) ON DELETE RESTRICT,

    consent_text      TEXT          NOT NULL,
    consent_version   VARCHAR(80)   NOT NULL,
    consented_at      TIMESTAMPTZ   NOT NULL,

    -- VARCHAR rather than INET. The value is whatever the site read out of a
    -- proxy header; a malformed one must land in the evidence record as-is, not
    -- fail the insert and lose the lead. 45 characters fits IPv6.
    ip_address        VARCHAR(45),
    user_agent        TEXT,

    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT affordable_plan_lead_consents_text_present_check CHECK (char_length(consent_text) > 0)
);
