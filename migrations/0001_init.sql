-- =========================================================
-- RB Mentors – Intake System
-- Initial D1 schema (FINAL)
-- =========================================================

-- =======================
-- CLIENT (PERSON)
-- =======================
CREATE TABLE clients
(
    id TEXT PRIMARY KEY,
    -- uuid

    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL,
    mobile TEXT,
    occupation TEXT,

    locale TEXT NOT NULL DEFAULT 'es' CHECK (locale IN ('es','en')),

    ssn_last4 TEXT NOT NULL DEFAULT '0000',
    -- updated after intake submit

    -- Google Drive (client root folder)
    drive_client_folder_id TEXT,
    drive_client_folder_name TEXT,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_clients_email ON clients(email);
CREATE INDEX idx_clients_name ON clients(last_name, first_name);

-- =======================
-- TAX RETURN (PER YEAR)
-- =======================
CREATE TABLE tax_returns
(
    id TEXT PRIMARY KEY,
    -- uuid
    client_id TEXT NOT NULL,
    tax_year INTEGER NOT NULL,
    -- 2024, 2025, etc.

    status TEXT NOT NULL DEFAULT 'invited'
        CHECK (status IN ('invited','in_progress','submitted','archived')),

    submitted_at TEXT,

    -- Google Drive folders (inside client folder)
    drive_year_folder_id TEXT,
    -- /Client/2025
    drive_data_folder_id TEXT,
    -- /2025/Data
    drive_uploads_folder_id TEXT,
    -- /2025/Uploads
    drive_intake_folder_id TEXT,
    -- /2025/Intake

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    UNIQUE (client_id, tax_year)
);

CREATE INDEX idx_tax_returns_client_year ON tax_returns(client_id, tax_year);

-- =======================
-- INTAKE TOKEN (ONE-TIME)
-- =======================
CREATE TABLE intake_tokens
(
    id TEXT PRIMARY KEY,
    -- uuid
    tax_return_id TEXT NOT NULL,

    token_hash TEXT NOT NULL UNIQUE,
    -- sha256(token + secret pepper)
    expires_at TEXT NOT NULL,
    one_time INTEGER NOT NULL DEFAULT 1,
    -- 1 = one-time
    used_at TEXT,
    revoked_at TEXT,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (tax_return_id) REFERENCES tax_returns(id) ON DELETE CASCADE
);

CREATE INDEX idx_tokens_tax_return ON intake_tokens(tax_return_id);
CREATE INDEX idx_tokens_expiration ON intake_tokens(expires_at);

-- =======================
-- INTAKE DATA (MAIN FORM)
-- =======================
CREATE TABLE intakes
(
    id TEXT PRIMARY KEY,
    -- uuid
    tax_return_id TEXT NOT NULL UNIQUE,

    -- Filing status (only one allowed)
    filing_status TEXT NOT NULL CHECK (
    filing_status IN (
      'single',
      'married_joint',
      'married_separate',
      'head_of_household',
      'qualifying_widow'
    )
  ),

    -- Taxpayer personal info
    taxpayer_first_name TEXT NOT NULL,
    taxpayer_last_name TEXT NOT NULL,
    taxpayer_ssn TEXT NOT NULL,
    taxpayer_dob TEXT NOT NULL,
    -- YYYY-MM-DD
    taxpayer_occupation TEXT,
    taxpayer_email TEXT NOT NULL,
    taxpayer_mobile TEXT,

    -- Address
    address_line1 TEXT NOT NULL,
    address_line2 TEXT,
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    zip TEXT NOT NULL,

    -- Health insurance
    had_health_insurance INTEGER NOT NULL DEFAULT 0,
    -- boolean

    -- Digital assets
    digital_assets INTEGER NOT NULL DEFAULT 0,
    -- boolean

    -- Bank information
    bank_name TEXT,
    bank_routing TEXT,
    bank_account TEXT,
    bank_account_type TEXT CHECK (bank_account_type IN ('checking','savings')),

    -- Referral
    was_referred INTEGER NOT NULL DEFAULT 0,
    -- boolean
    referrer_first_name TEXT,
    referrer_last_name TEXT,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (tax_return_id) REFERENCES tax_returns(id) ON DELETE CASCADE
);

-- =======================
-- SPOUSE (ONLY IF MARRIED)
-- =======================
CREATE TABLE spouses
(
    id TEXT PRIMARY KEY,
    -- uuid
    tax_return_id TEXT NOT NULL UNIQUE,

    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    ssn TEXT NOT NULL,
    dob TEXT NOT NULL,
    occupation TEXT,
    email TEXT,
    mobile TEXT,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (tax_return_id) REFERENCES tax_returns(id) ON DELETE CASCADE
);

-- =======================
-- DEPENDENTS (0..N)
-- =======================
CREATE TABLE dependents
(
    id TEXT PRIMARY KEY,
    -- uuid
    tax_return_id TEXT NOT NULL,

    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    ssn TEXT,
    dob TEXT NOT NULL,
    relationship TEXT NOT NULL,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (tax_return_id) REFERENCES tax_returns(id) ON DELETE CASCADE
);

CREATE INDEX idx_dependents_tax_return ON dependents(tax_return_id);

-- =======================
-- UPLOADS (ID + DOCUMENTS)
-- =======================
CREATE TABLE uploads
(
    id TEXT PRIMARY KEY,
    -- uuid
    tax_return_id TEXT NOT NULL,

    category TEXT NOT NULL,
    -- id | tax_doc | other
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,

    r2_key TEXT NOT NULL UNIQUE,
    -- R2 object key
    sha256 TEXT,

    drive_file_id TEXT,
    drive_parent_folder_id TEXT,
    status TEXT NOT NULL DEFAULT 'staged'
        CHECK (status IN ('staged','copied','failed','deleted')),

    created_at TEXT NOT NULL DEFAULT (datetime('now')),

    FOREIGN KEY (tax_return_id) REFERENCES tax_returns(id) ON DELETE CASCADE
);

CREATE INDEX idx_uploads_tax_return ON uploads(tax_return_id);

-- =======================
-- APPLICATION CONFIG
-- =======================
CREATE TABLE app_config
(
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
);

-- =======================
-- AUDIT LOG
-- =======================
CREATE TABLE audit_log
(
    id TEXT PRIMARY KEY,
    -- uuid
    tax_return_id TEXT,
    event TEXT NOT NULL,
    -- intake_submitted, drive_created, etc.
    ip TEXT,
    user_agent TEXT,
    details_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_tax_return ON audit_log(tax_return_id);

