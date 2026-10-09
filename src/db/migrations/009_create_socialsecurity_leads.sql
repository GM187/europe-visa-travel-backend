-- Disability Benefit Helps lead intake (disabilitybenefithelps.com, the
-- `social-security` site): free case review requests for help with SSDI or
-- SSI disability benefits.
--
-- Its own tables for the same reasons every other producer has them: its own
-- answers, its own credential, and its own retention rules. The answers happen
-- to match Auto Insurance's field for field (name, phone, email, ZIP, state),
-- but sharing that table would tie two unrelated businesses' retention and
-- deletion to one another, and one site gaining a question would force a
-- migration on the other.
--
-- This producer collects an email address as well as a phone number, so "has
-- this person contacted us before?" is answered on EITHER the phone number OR
-- the normalised email.
--
-- Nothing here is a "client" or a "case" yet -- these are people who asked for
-- a free review. The form never collects a Social Security number or medical
-- details, and nothing in this table should ever hold them.

-- ---------------------------------------------------------------------------
-- social_security_leads -- one row per submission
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS social_security_leads (
    id                BIGSERIAL     PRIMARY KEY,

    -- sha256 of the source and the submission id generated in the visitor's
    -- browser. Re-sent on a retry after a network error that may or may not
    -- have reached us, which is what turns that retry into the original lead
    -- rather than a second one.
    dedupe_key        CHAR(64)      NOT NULL UNIQUE,

    -- The producer's receipt time, not ours. created_at is when this row was
    -- written; the two differ by the network and by any retry.
    submitted_at      TIMESTAMPTZ   NOT NULL,

    -- Which site and form sent it ("disabilitybenefithelps.com/#free-review" or
    -- ".../contact.html#free-review"). The site has the same form on two pages.
    source            VARCHAR(100)  NOT NULL,

    first_name        VARCHAR(50)   NOT NULL,
    last_name         VARCHAR(50)   NOT NULL,

    -- Stored as received AND normalised. The raw form is what the person typed
    -- and what the consent record refers to; the E.164 form is what a dialler
    -- uses. A NULL e164 means the number could not be normalised, not that it
    -- is absent.
    phone_raw         VARCHAR(30)   NOT NULL,
    phone_e164        VARCHAR(16),

    -- Stored as received AND normalised (lower-cased, trimmed). The normalised
    -- form is what repeat detection matches on and what search covers.
    email             VARCHAR(254)  NOT NULL,
    email_normalised  VARCHAR(254)  NOT NULL,

    zip               VARCHAR(10)   NOT NULL,
    -- The two-letter USPS code the visitor selected, upper-cased on the way in.
    state             CHAR(2)       NOT NULL,

    -- The complete original body, unmodified. Every column above is a
    -- projection of it.
    raw_payload       JSONB         NOT NULL,

    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT social_security_leads_zip_shape_check CHECK (zip ~ '^[0-9]{5}(-[0-9]{4})?$'),
    CONSTRAINT social_security_leads_state_shape_check CHECK (state ~ '^[A-Z]{2}$')
);

-- The dashboard's default view: newest first.
CREATE INDEX IF NOT EXISTS social_security_leads_created_at_idx
    ON social_security_leads (created_at DESC);

-- Repeat-submission detection, looked up per row in the list query.
CREATE INDEX IF NOT EXISTS social_security_leads_phone_e164_idx
    ON social_security_leads (phone_e164);

CREATE INDEX IF NOT EXISTS social_security_leads_email_normalised_idx
    ON social_security_leads (email_normalised);

-- ---------------------------------------------------------------------------
-- social_security_lead_consents -- TCPA evidence. APPEND-ONLY.
-- ---------------------------------------------------------------------------
-- The site's review form asks the visitor to tick a box agreeing to calls
-- and texts, including by automated means. This row is the proof: the exact
-- text they saw, its version, when, and the IP and user agent it came from.
--
-- consent_text is the full string, NOT a foreign key to a template table: when
-- the live wording changes, what this row says the person agreed to must not.
--
-- There is no updated_at, and nothing in this codebase issues an UPDATE or a
-- DELETE against this table. Where the deployment can, revoke both at the
-- database-role level for the application user.
--
-- ON DELETE RESTRICT, not CASCADE: consent evidence must outlive the lead it
-- belongs to. Honouring a deletion request means redacting the personal columns
-- on social_security_leads in place, not dropping the row.
CREATE TABLE IF NOT EXISTS social_security_lead_consents (
    id                BIGSERIAL     PRIMARY KEY,
    lead_id           BIGINT        NOT NULL UNIQUE
                                    REFERENCES social_security_leads(id) ON DELETE RESTRICT,

    consent_text      TEXT          NOT NULL,
    consent_version   VARCHAR(80)   NOT NULL,
    consented_at      TIMESTAMPTZ   NOT NULL,

    -- VARCHAR rather than INET: the value is whatever the function read out of
    -- a proxy header, and a malformed one must not fail the insert and lose the
    -- lead. 45 characters fits IPv6.
    ip_address        VARCHAR(45),
    user_agent        TEXT,

    created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT social_security_lead_consents_text_present_check CHECK (char_length(consent_text) > 0)
);
