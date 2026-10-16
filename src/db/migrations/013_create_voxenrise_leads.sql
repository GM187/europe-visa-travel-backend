-- VoxEnrise lead intake: phone numbers posted by an external client.
--
-- Its own table for the reason every producer has one: its own credential, its
-- own retention, and its own shape. This one is deliberately the narrowest of
-- them -- a phone number and nothing else. The client sends no name, no email
-- and no consent record, so none of those columns exist here to be half-filled.
--
-- IMPORTANT: there is no consent table beside this one, unlike every other
-- producer. That is not an omission to be corrected by adding columns -- it is
-- a statement that this feed carries no TCPA evidence of its own. Whoever
-- dials these numbers is relying on the client's consent records, held by the
-- client, under whatever agreement covers this feed. Do not treat a row here
-- as permission to call.

CREATE TABLE IF NOT EXISTS voxenrise_leads (
    id            BIGSERIAL     PRIMARY KEY,

    -- As received, before any normalising. This is the string the client
    -- actually sent, and it is what a dispute about the feed is settled on.
    phone_raw     VARCHAR(30)   NOT NULL,

    -- E.164 (+1XXXXXXXXXX). The form a dialler uses, and what repeat
    -- detection matches on. NOT NULL here, unlike the other producers':
    -- intake rejects a number that will not normalise, so a stored row
    -- always has a usable number.
    phone_e164    VARCHAR(16)   NOT NULL,

    -- The complete original body, unmodified. Every column above is a
    -- projection of it, and it is where an unexpected extra key the client
    -- started sending will show up.
    raw_payload   JSONB         NOT NULL,

    created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    CONSTRAINT voxenrise_leads_phone_e164_shape_check CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$')
);

-- The dashboard's default view: newest first.
CREATE INDEX IF NOT EXISTS voxenrise_leads_created_at_idx
    ON voxenrise_leads (created_at DESC);

-- Repeat detection, evaluated per row in the list query.
--
-- Deliberately NOT a unique index. The same number arriving twice is a
-- legitimate event -- the person enquired again -- and a unique constraint
-- would turn the second enquiry into an error the client cannot act on. The
-- list marks repeats instead, leaving the operator to decide.
CREATE INDEX IF NOT EXISTS voxenrise_leads_phone_e164_idx
    ON voxenrise_leads (phone_e164);
