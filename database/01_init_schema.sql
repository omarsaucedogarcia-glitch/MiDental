-- =====================================================================
-- 01_init_schema.sql
-- Electronic Dental Record (EDR) - Núcleo Clínico
-- Motor: Supabase PostgreSQL 15+
-- Autor: Arquitectura full-stack clínica odontológica
-- Descripción:
--   DDL inicial del núcleo clínico del EDR. Cubre identidad clínica
--   (operadores, pacientes), modelo ontológico (diccionario clínico
--   con SNOMED CT, ICD-10, ICDAS, FDI), odontograma multicapa
--   (dentición permanente, temporal, supernumeraria, implantes),
--   hallazgos codificados por diente y por superficie, eventos
--   clínicos temporales con máquina de estados, planes de tratamiento
--   y auditoría inmutable.
--
--   Diseño normalizado a 3NF. Soft-delete con cascada restrictiva.
--   Triggers para updated_at y para versionado inmutable de
--   audit_logs (registro append-only).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Extensiones
-- ---------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";        -- emails case-insensitive
CREATE EXTENSION IF NOT EXISTS "btree_gist";    -- exclusion constraints temporales
CREATE EXTENSION IF NOT EXISTS "pg_trgm";       -- búsqueda fuzzy clínica

-- ---------------------------------------------------------------------
-- 1. Schema dedicado
-- ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS edr;
SET search_path = edr, public;

COMMENT ON SCHEMA edr IS 'Núcleo del Electronic Dental Record (EDR).';

-- ---------------------------------------------------------------------
-- 2. Tipos enumerados clínicos
-- ---------------------------------------------------------------------

-- Sexo biológico (HL7 administrative gender simplificado)
CREATE TYPE edr.sex_enum AS ENUM (
    'male',
    'female',
    'intersex',
    'unknown'
);

-- Identidad de género autoreportada (independiente de sex_enum)
CREATE TYPE edr.gender_identity_enum AS ENUM (
    'man',
    'woman',
    'non_binary',
    'other',
    'undisclosed'
);

-- Rol del operador clínico
CREATE TYPE edr.operator_role_enum AS ENUM (
    'dentist',
    'specialist',
    'hygienist',
    'assistant',
    'admin',
    'receptionist',
    'auditor'
);

-- Tipo de dentición a nivel de odontograma
CREATE TYPE edr.dentition_type_enum AS ENUM (
    'permanent',
    'temporary',
    'mixed'
);

-- Capa del diente dentro del odontograma multicapa
CREATE TYPE edr.tooth_layer_enum AS ENUM (
    'permanent',         -- diente permanente fisiológico
    'temporary',         -- diente temporal (deciduo)
    'supernumerary',     -- diente supernumerario
    'implant',           -- implante osteointegrado
    'pontic',            -- póntico de prótesis fija
    'prosthetic'         -- corona/prótesis sobre raíz natural
);

-- Estado físico macro del diente (independiente de hallazgos finos)
CREATE TYPE edr.tooth_status_enum AS ENUM (
    'present',
    'absent_congenital',
    'absent_extracted',
    'unerupted',
    'erupting',
    'impacted',
    'retained_root',
    'replaced_by_implant',
    'replaced_by_prosthesis'
);

-- Códigos FDI de superficie dental
CREATE TYPE edr.surface_code_enum AS ENUM (
    'M',   -- Mesial
    'D',   -- Distal
    'O',   -- Oclusal
    'I',   -- Incisal
    'V',   -- Vestibular / Bucal
    'L',   -- Lingual
    'P',   -- Palatino
    'C',   -- Cervical
    'R'    -- Radicular (raíz, no superficie coronal stricto sensu)
);

-- Severidad genérica de hallazgo
CREATE TYPE edr.finding_severity_enum AS ENUM (
    'none',
    'mild',
    'moderate',
    'severe',
    'critical'
);

-- Acción auditada
CREATE TYPE edr.audit_action_enum AS ENUM (
    'INSERT',
    'UPDATE',
    'DELETE',
    'SOFT_DELETE',
    'RESTORE'
);

-- ---------------------------------------------------------------------
-- 3. Funciones utilitarias compartidas
-- ---------------------------------------------------------------------

-- 3.1 Trigger genérico de updated_at
CREATE OR REPLACE FUNCTION edr.fn_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION edr.fn_set_updated_at()
    IS 'Trigger genérico: refresca updated_at en cada UPDATE.';

-- 3.2 Resolver operator_id desde auth.uid() de Supabase
CREATE OR REPLACE FUNCTION edr.fn_current_operator_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_op_id UUID;
BEGIN
    -- En contexto Supabase auth.uid() devuelve el UUID del usuario autenticado
    BEGIN
        SELECT id INTO v_op_id
        FROM edr.operators
        WHERE auth_user_id = auth.uid()
          AND deleted_at IS NULL
        LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        v_op_id := NULL;
    END;
    RETURN v_op_id;
END;
$$;

COMMENT ON FUNCTION edr.fn_current_operator_id()
    IS 'Resuelve el operator_id del usuario autenticado (Supabase auth.uid()).';

-- ---------------------------------------------------------------------
-- 4. Tabla: operators
--    Staff clínico y administrativo. Cada operador puede estar enlazado
--    a un usuario auth.users de Supabase para autenticación.
-- ---------------------------------------------------------------------
CREATE TABLE edr.operators (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id         UUID UNIQUE,                      -- FK lógica a auth.users(id)
    national_id          VARCHAR(32),                      -- RUT / DNI / NIF
    license_number       VARCHAR(64),                      -- Nº colegiación profesional
    first_name           VARCHAR(120) NOT NULL,
    last_name            VARCHAR(120) NOT NULL,
    email                CITEXT NOT NULL,
    phone                VARCHAR(32),
    role                 edr.operator_role_enum NOT NULL DEFAULT 'dentist',
    specialty            VARCHAR(120),
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    hired_at             DATE,
    metadata             JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at           TIMESTAMPTZ,
    CONSTRAINT operators_email_uk        UNIQUE (email),
    CONSTRAINT operators_national_id_uk  UNIQUE (national_id),
    CONSTRAINT operators_license_uk      UNIQUE (license_number),
    CONSTRAINT operators_email_chk       CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

COMMENT ON TABLE edr.operators IS 'Profesionales y staff con acceso al EDR.';
COMMENT ON COLUMN edr.operators.auth_user_id IS 'Referencia a auth.users.id de Supabase.';

CREATE INDEX idx_operators_role_active   ON edr.operators (role) WHERE deleted_at IS NULL AND is_active;
CREATE INDEX idx_operators_last_name_trg ON edr.operators USING GIN (last_name gin_trgm_ops);
CREATE INDEX idx_operators_deleted_at    ON edr.operators (deleted_at);

-- ---------------------------------------------------------------------
-- 5. Tabla: patients
--    Información demográfica y clínica administrativa del paciente.
-- ---------------------------------------------------------------------
CREATE TABLE edr.patients (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mrn                  VARCHAR(32) NOT NULL,             -- Medical Record Number interno
    national_id          VARCHAR(32),                      -- RUT / DNI / NIF
    first_name           VARCHAR(120) NOT NULL,
    middle_name          VARCHAR(120),
    last_name            VARCHAR(120) NOT NULL,
    second_last_name     VARCHAR(120),
    birth_date           DATE NOT NULL,
    sex                  edr.sex_enum NOT NULL DEFAULT 'unknown',
    gender_identity      edr.gender_identity_enum NOT NULL DEFAULT 'undisclosed',
    email                CITEXT,
    phone_primary        VARCHAR(32),
    phone_secondary      VARCHAR(32),
    address_line1        VARCHAR(255),
    address_line2        VARCHAR(255),
    city                 VARCHAR(120),
    region               VARCHAR(120),
    postal_code          VARCHAR(20),
    country_iso2         CHAR(2),
    primary_dentist_id   UUID,
    blood_type           VARCHAR(8),                       -- A+, O-, etc.
    allergies            JSONB NOT NULL DEFAULT '[]'::JSONB,
    medical_history      JSONB NOT NULL DEFAULT '{}'::JSONB,
    insurance            JSONB NOT NULL DEFAULT '{}'::JSONB,
    consent_signed_at    TIMESTAMPTZ,
    notes                TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at           TIMESTAMPTZ,
    CONSTRAINT patients_mrn_uk            UNIQUE (mrn),
    CONSTRAINT patients_national_id_uk    UNIQUE (national_id),
    CONSTRAINT patients_birth_date_chk    CHECK (birth_date <= CURRENT_DATE),
    CONSTRAINT patients_country_iso2_chk  CHECK (country_iso2 IS NULL OR country_iso2 ~ '^[A-Z]{2}$'),
    CONSTRAINT patients_email_chk         CHECK (email IS NULL OR email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
    CONSTRAINT patients_primary_dentist_fk
        FOREIGN KEY (primary_dentist_id)
        REFERENCES edr.operators(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT
);

COMMENT ON TABLE edr.patients IS 'Pacientes registrados en el EDR.';
COMMENT ON COLUMN edr.patients.mrn IS 'Medical Record Number único interno.';

CREATE INDEX idx_patients_last_name_trg     ON edr.patients USING GIN (last_name gin_trgm_ops);
CREATE INDEX idx_patients_first_name_trg    ON edr.patients USING GIN (first_name gin_trgm_ops);
CREATE INDEX idx_patients_birth_date        ON edr.patients (birth_date);
CREATE INDEX idx_patients_primary_dentist   ON edr.patients (primary_dentist_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_patients_deleted_at        ON edr.patients (deleted_at);
CREATE INDEX idx_patients_allergies_gin     ON edr.patients USING GIN (allergies jsonb_path_ops);

-- ---------------------------------------------------------------------
-- 6. Tabla: ontology_dictionary
--    Diccionario clínico controlado. Codifica diagnósticos, hallazgos,
--    procedimientos y materiales bajo terminologías estándar
--    (SNOMED CT, ICD-10, ICDAS, FDI, CDT/ADA, propias).
-- ---------------------------------------------------------------------
CREATE TABLE edr.ontology_dictionary (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code_system          VARCHAR(32) NOT NULL,             -- 'SNOMED-CT' | 'ICD-10' | 'ICDAS' | 'FDI' | 'CDT' | 'LOCAL'
    code                 VARCHAR(64) NOT NULL,             -- código dentro del sistema
    display              VARCHAR(255) NOT NULL,            -- nombre canónico
    display_es           VARCHAR(255),                     -- traducción es-CL/es-ES
    category             VARCHAR(64) NOT NULL,             -- 'finding' | 'procedure' | 'material' | 'anatomy' | 'status'
    parent_id            UUID,                             -- jerarquía ontológica
    definition           TEXT,
    is_billable          BOOLEAN NOT NULL DEFAULT FALSE,
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    valid_from           DATE,
    valid_to             DATE,
    metadata             JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at           TIMESTAMPTZ,
    CONSTRAINT ontology_system_code_uk    UNIQUE (code_system, code),
    CONSTRAINT ontology_parent_fk
        FOREIGN KEY (parent_id)
        REFERENCES edr.ontology_dictionary(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT ontology_valid_range_chk
        CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

COMMENT ON TABLE edr.ontology_dictionary IS 'Vocabulario clínico controlado e interoperable.';
COMMENT ON COLUMN edr.ontology_dictionary.code_system IS 'Origen terminológico (SNOMED-CT, ICD-10, ICDAS, FDI, CDT, LOCAL).';

CREATE INDEX idx_ontology_category       ON edr.ontology_dictionary (category) WHERE deleted_at IS NULL AND is_active;
CREATE INDEX idx_ontology_parent         ON edr.ontology_dictionary (parent_id);
CREATE INDEX idx_ontology_display_trg    ON edr.ontology_dictionary USING GIN (display gin_trgm_ops);
CREATE INDEX idx_ontology_display_es_trg ON edr.ontology_dictionary USING GIN (display_es gin_trgm_ops);
CREATE INDEX idx_ontology_metadata_gin   ON edr.ontology_dictionary USING GIN (metadata jsonb_path_ops);

-- ---------------------------------------------------------------------
-- 7. Tabla: event_statuses
--    Catálogo de estados clínicos temporales. Permite máquina de
--    estados configurable (plan -> en curso -> completado, etc.).
-- ---------------------------------------------------------------------
CREATE TABLE edr.event_statuses (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                 VARCHAR(48) NOT NULL,
    display              VARCHAR(120) NOT NULL,
    display_es           VARCHAR(120),
    description          TEXT,
    is_terminal          BOOLEAN NOT NULL DEFAULT FALSE,   -- estado final no transicionable
    is_billable_trigger  BOOLEAN NOT NULL DEFAULT FALSE,   -- dispara facturación
    color_hex            CHAR(7),                          -- #RRGGBB para UI
    sort_order           INTEGER NOT NULL DEFAULT 0,
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at           TIMESTAMPTZ,
    CONSTRAINT event_statuses_code_uk     UNIQUE (code),
    CONSTRAINT event_statuses_color_chk
        CHECK (color_hex IS NULL OR color_hex ~ '^#[0-9A-Fa-f]{6}$')
);

COMMENT ON TABLE edr.event_statuses IS 'Catálogo configurable de estados para eventos clínicos.';

CREATE INDEX idx_event_statuses_active ON edr.event_statuses (sort_order) WHERE deleted_at IS NULL AND is_active;

-- ---------------------------------------------------------------------
-- 8. Tabla: odontograms
--    Snapshot/versión del odontograma del paciente en un momento dado.
--    Inmutable a nivel de versión: cada cambio significativo genera
--    una nueva versión vinculada al paciente.
-- ---------------------------------------------------------------------
CREATE TABLE edr.odontograms (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id           UUID NOT NULL,
    version              INTEGER NOT NULL DEFAULT 1,
    dentition_type       edr.dentition_type_enum NOT NULL DEFAULT 'permanent',
    recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    recorded_by          UUID,
    is_baseline          BOOLEAN NOT NULL DEFAULT FALSE,   -- odontograma inicial de admisión
    is_locked            BOOLEAN NOT NULL DEFAULT FALSE,   -- bloqueado tras firma clínica
    locked_at            TIMESTAMPTZ,
    locked_by            UUID,
    notes                TEXT,
    metadata             JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at           TIMESTAMPTZ,
    CONSTRAINT odontograms_patient_version_uk UNIQUE (patient_id, version),
    CONSTRAINT odontograms_patient_fk
        FOREIGN KEY (patient_id)
        REFERENCES edr.patients(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT odontograms_recorded_by_fk
        FOREIGN KEY (recorded_by)
        REFERENCES edr.operators(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT odontograms_locked_by_fk
        FOREIGN KEY (locked_by)
        REFERENCES edr.operators(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT odontograms_locked_consistency_chk
        CHECK ((is_locked = FALSE AND locked_at IS NULL AND locked_by IS NULL)
            OR (is_locked = TRUE  AND locked_at IS NOT NULL AND locked_by IS NOT NULL))
);

COMMENT ON TABLE edr.odontograms IS 'Versiones de odontograma por paciente (multicapa).';
COMMENT ON COLUMN edr.odontograms.version IS 'Versión monotónica creciente por paciente.';

CREATE INDEX idx_odontograms_patient        ON edr.odontograms (patient_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_odontograms_recorded_at    ON edr.odontograms (recorded_at DESC);
CREATE INDEX idx_odontograms_patient_latest ON edr.odontograms (patient_id, version DESC) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------
-- 9. Tabla: teeth
--    Un registro por diente dentro de un odontograma. Soporta
--    multicapa: permanente, temporal, supernumerario, implante,
--    póntico, prótesis. La notación es FDI (11-48 permanentes,
--    51-85 temporales, otros para supernumerarios).
-- ---------------------------------------------------------------------
CREATE TABLE edr.teeth (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    odontogram_id        UUID NOT NULL,
    fdi_code             VARCHAR(8) NOT NULL,              -- p.ej. '11', '85', '51S' (supernumerario)
    universal_code       VARCHAR(8),                       -- notación universal ADA (1-32, A-T)
    palmer_code          VARCHAR(8),                       -- notación Palmer
    quadrant             SMALLINT NOT NULL,                -- 1..4 permanente, 5..8 temporal
    position             SMALLINT NOT NULL,                -- 1..8 dentro de cuadrante
    layer                edr.tooth_layer_enum NOT NULL DEFAULT 'permanent',
    status               edr.tooth_status_enum NOT NULL DEFAULT 'present',
    is_primary_layer     BOOLEAN NOT NULL DEFAULT TRUE,    -- capa visible principal
    is_supernumerary     BOOLEAN NOT NULL DEFAULT FALSE,
    parent_tooth_id      UUID,                             -- ligadura supernumerario->principal
    eruption_date        DATE,
    exfoliation_date     DATE,
    mobility_grade       SMALLINT,                         -- 0..3 (Miller)
    notes                TEXT,
    metadata             JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at           TIMESTAMPTZ,
    CONSTRAINT teeth_unique_per_layer_uk
        UNIQUE (odontogram_id, fdi_code, layer),
    CONSTRAINT teeth_odontogram_fk
        FOREIGN KEY (odontogram_id)
        REFERENCES edr.odontograms(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT teeth_parent_fk
        FOREIGN KEY (parent_tooth_id)
        REFERENCES edr.teeth(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT teeth_quadrant_chk    CHECK (quadrant BETWEEN 1 AND 8),
    CONSTRAINT teeth_position_chk    CHECK (position BETWEEN 1 AND 8),
    CONSTRAINT teeth_mobility_chk    CHECK (mobility_grade IS NULL OR mobility_grade BETWEEN 0 AND 3),
    CONSTRAINT teeth_fdi_format_chk  CHECK (fdi_code ~ '^[1-8][1-8][A-Z]?$' OR fdi_code ~ '^SN[0-9]+$')
);

COMMENT ON TABLE edr.teeth IS 'Dientes en un odontograma. Soporta capas múltiples por posición FDI.';
COMMENT ON COLUMN edr.teeth.fdi_code IS 'Código FDI; supernumerarios usan prefijo SN.';

CREATE INDEX idx_teeth_odontogram      ON edr.teeth (odontogram_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_teeth_fdi             ON edr.teeth (fdi_code);
CREATE INDEX idx_teeth_status          ON edr.teeth (status) WHERE deleted_at IS NULL;
CREATE INDEX idx_teeth_layer           ON edr.teeth (layer);
CREATE INDEX idx_teeth_parent          ON edr.teeth (parent_tooth_id);

-- ---------------------------------------------------------------------
-- 10. Tabla: surfaces
--     Superficies anatómicas por diente. Una fila por superficie
--     existente en un diente. Permite hallazgos a nivel de superficie.
-- ---------------------------------------------------------------------
CREATE TABLE edr.surfaces (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tooth_id             UUID NOT NULL,
    surface_code         edr.surface_code_enum NOT NULL,
    is_present           BOOLEAN NOT NULL DEFAULT TRUE,    -- la superficie existe físicamente
    notes                TEXT,
    metadata             JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at           TIMESTAMPTZ,
    CONSTRAINT surfaces_tooth_surface_uk UNIQUE (tooth_id, surface_code),
    CONSTRAINT surfaces_tooth_fk
        FOREIGN KEY (tooth_id)
        REFERENCES edr.teeth(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT
);

COMMENT ON TABLE edr.surfaces IS 'Superficies dentales (M,D,O,I,V,L,P,C,R) por diente.';

CREATE INDEX idx_surfaces_tooth ON edr.surfaces (tooth_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------
-- 11. Tabla: clinical_findings
--     Hallazgos codificados por diente y/o superficie. Cada hallazgo
--     referencia el ontology_dictionary (ICDAS, restauración, etc.)
-- ---------------------------------------------------------------------
CREATE TABLE edr.clinical_findings (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    odontogram_id        UUID NOT NULL,
    tooth_id             UUID,
    surface_id           UUID,
    ontology_id          UUID NOT NULL,                    -- código clínico (Caries ICDAS-2, Composite, etc.)
    severity             edr.finding_severity_enum NOT NULL DEFAULT 'none',
    icdas_score          SMALLINT,                         -- 0..6 ICDAS II si aplica
    observed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    observed_by          UUID,
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,    -- todavía vigente clínicamente
    resolved_at          TIMESTAMPTZ,
    resolved_by          UUID,
    resolution_event_id  UUID,                             -- el evento clínico que lo resolvió
    description          TEXT,
    metadata             JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at           TIMESTAMPTZ,
    CONSTRAINT findings_odontogram_fk
        FOREIGN KEY (odontogram_id)
        REFERENCES edr.odontograms(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT findings_tooth_fk
        FOREIGN KEY (tooth_id)
        REFERENCES edr.teeth(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT findings_surface_fk
        FOREIGN KEY (surface_id)
        REFERENCES edr.surfaces(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT findings_ontology_fk
        FOREIGN KEY (ontology_id)
        REFERENCES edr.ontology_dictionary(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT findings_observed_by_fk
        FOREIGN KEY (observed_by)
        REFERENCES edr.operators(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT findings_resolved_by_fk
        FOREIGN KEY (resolved_by)
        REFERENCES edr.operators(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT findings_icdas_chk        CHECK (icdas_score IS NULL OR icdas_score BETWEEN 0 AND 6),
    CONSTRAINT findings_resolution_chk
        CHECK ((is_active = TRUE  AND resolved_at IS NULL AND resolved_by IS NULL)
            OR (is_active = FALSE AND resolved_at IS NOT NULL))
);

COMMENT ON TABLE edr.clinical_findings IS 'Hallazgos clínicos codificados por diente/superficie.';
COMMENT ON COLUMN edr.clinical_findings.icdas_score IS 'Score ICDAS II (0..6) cuando el hallazgo es caries.';

CREATE INDEX idx_findings_odontogram     ON edr.clinical_findings (odontogram_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_findings_tooth          ON edr.clinical_findings (tooth_id);
CREATE INDEX idx_findings_surface        ON edr.clinical_findings (surface_id);
CREATE INDEX idx_findings_ontology       ON edr.clinical_findings (ontology_id);
CREATE INDEX idx_findings_active         ON edr.clinical_findings (is_active) WHERE deleted_at IS NULL;
CREATE INDEX idx_findings_observed_at    ON edr.clinical_findings (observed_at DESC);
CREATE INDEX idx_findings_metadata_gin   ON edr.clinical_findings USING GIN (metadata jsonb_path_ops);

-- ---------------------------------------------------------------------
-- 12. Tabla: treatment_plans
--     Plan de tratamiento agregador. Agrupa múltiples clinical_events
--     bajo un plan firmado y consentido por el paciente.
-- ---------------------------------------------------------------------
CREATE TABLE edr.treatment_plans (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id           UUID NOT NULL,
    odontogram_id        UUID,                             -- odontograma base sobre el cual se planificó
    code                 VARCHAR(64) NOT NULL,             -- identificador legible (PT-2026-000123)
    title                VARCHAR(255) NOT NULL,
    description          TEXT,
    diagnosis_summary    TEXT,
    proposed_by          UUID NOT NULL,
    approved_by          UUID,
    approved_at          TIMESTAMPTZ,
    patient_signed_at    TIMESTAMPTZ,
    status_id            UUID NOT NULL,                    -- estado actual del plan (event_statuses)
    estimated_cost       NUMERIC(12,2),
    currency_iso3        CHAR(3) NOT NULL DEFAULT 'CLP',
    start_date           DATE,
    end_date             DATE,
    metadata             JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at           TIMESTAMPTZ,
    CONSTRAINT treatment_plans_code_uk UNIQUE (code),
    CONSTRAINT treatment_plans_patient_fk
        FOREIGN KEY (patient_id)
        REFERENCES edr.patients(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT treatment_plans_odontogram_fk
        FOREIGN KEY (odontogram_id)
        REFERENCES edr.odontograms(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT treatment_plans_proposed_by_fk
        FOREIGN KEY (proposed_by)
        REFERENCES edr.operators(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT treatment_plans_approved_by_fk
        FOREIGN KEY (approved_by)
        REFERENCES edr.operators(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT treatment_plans_status_fk
        FOREIGN KEY (status_id)
        REFERENCES edr.event_statuses(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT treatment_plans_currency_chk CHECK (currency_iso3 ~ '^[A-Z]{3}$'),
    CONSTRAINT treatment_plans_dates_chk    CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
    CONSTRAINT treatment_plans_cost_chk     CHECK (estimated_cost IS NULL OR estimated_cost >= 0)
);

COMMENT ON TABLE edr.treatment_plans IS 'Planes de tratamiento agregados por paciente.';

CREATE INDEX idx_treatment_plans_patient   ON edr.treatment_plans (patient_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_treatment_plans_status    ON edr.treatment_plans (status_id);
CREATE INDEX idx_treatment_plans_dates     ON edr.treatment_plans (start_date, end_date);
CREATE INDEX idx_treatment_plans_proposed  ON edr.treatment_plans (proposed_by);

-- ---------------------------------------------------------------------
-- 13. Tabla: clinical_events
--     Eventos clínicos temporales. Cada evento materializa una acción
--     diagnóstica o terapéutica (sesión, procedimiento, control)
--     vinculada (opcionalmente) a un hallazgo, un diente, una
--     superficie y un plan de tratamiento. Tiene máquina de estados
--     vía event_statuses.
-- ---------------------------------------------------------------------
CREATE TABLE edr.clinical_events (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id           UUID NOT NULL,
    treatment_plan_id    UUID,
    odontogram_id        UUID,
    tooth_id             UUID,
    surface_id           UUID,
    finding_id           UUID,
    ontology_id          UUID NOT NULL,                    -- procedimiento codificado (CDT/SNOMED/LOCAL)
    status_id            UUID NOT NULL,                    -- estado actual
    previous_status_id   UUID,                             -- último estado anterior (para auditoría rápida)
    scheduled_at         TIMESTAMPTZ,
    started_at           TIMESTAMPTZ,
    completed_at         TIMESTAMPTZ,
    performed_by         UUID,
    assisted_by          UUID,
    duration_minutes     INTEGER,
    cost                 NUMERIC(12,2),
    currency_iso3        CHAR(3) NOT NULL DEFAULT 'CLP',
    notes                TEXT,
    metadata             JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at           TIMESTAMPTZ,
    CONSTRAINT clinical_events_patient_fk
        FOREIGN KEY (patient_id)
        REFERENCES edr.patients(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT clinical_events_plan_fk
        FOREIGN KEY (treatment_plan_id)
        REFERENCES edr.treatment_plans(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT clinical_events_odontogram_fk
        FOREIGN KEY (odontogram_id)
        REFERENCES edr.odontograms(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT clinical_events_tooth_fk
        FOREIGN KEY (tooth_id)
        REFERENCES edr.teeth(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT clinical_events_surface_fk
        FOREIGN KEY (surface_id)
        REFERENCES edr.surfaces(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT clinical_events_finding_fk
        FOREIGN KEY (finding_id)
        REFERENCES edr.clinical_findings(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT clinical_events_ontology_fk
        FOREIGN KEY (ontology_id)
        REFERENCES edr.ontology_dictionary(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT clinical_events_status_fk
        FOREIGN KEY (status_id)
        REFERENCES edr.event_statuses(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT clinical_events_prev_status_fk
        FOREIGN KEY (previous_status_id)
        REFERENCES edr.event_statuses(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT clinical_events_performed_by_fk
        FOREIGN KEY (performed_by)
        REFERENCES edr.operators(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT clinical_events_assisted_by_fk
        FOREIGN KEY (assisted_by)
        REFERENCES edr.operators(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
    CONSTRAINT clinical_events_duration_chk
        CHECK (duration_minutes IS NULL OR duration_minutes >= 0),
    CONSTRAINT clinical_events_cost_chk
        CHECK (cost IS NULL OR cost >= 0),
    CONSTRAINT clinical_events_currency_chk
        CHECK (currency_iso3 ~ '^[A-Z]{3}$'),
    CONSTRAINT clinical_events_time_chk
        CHECK ((started_at IS NULL OR scheduled_at IS NULL OR started_at >= scheduled_at - INTERVAL '1 day')
           AND (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at))
);

COMMENT ON TABLE edr.clinical_events IS 'Eventos clínicos temporales con máquina de estados.';

-- FK diferida: clinical_findings.resolution_event_id -> clinical_events.id
ALTER TABLE edr.clinical_findings
    ADD CONSTRAINT findings_resolution_event_fk
    FOREIGN KEY (resolution_event_id)
    REFERENCES edr.clinical_events(id)
    ON UPDATE CASCADE
    ON DELETE RESTRICT;

CREATE INDEX idx_clinical_events_patient        ON edr.clinical_events (patient_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_clinical_events_plan           ON edr.clinical_events (treatment_plan_id);
CREATE INDEX idx_clinical_events_status         ON edr.clinical_events (status_id);
CREATE INDEX idx_clinical_events_tooth          ON edr.clinical_events (tooth_id);
CREATE INDEX idx_clinical_events_surface        ON edr.clinical_events (surface_id);
CREATE INDEX idx_clinical_events_finding        ON edr.clinical_events (finding_id);
CREATE INDEX idx_clinical_events_ontology       ON edr.clinical_events (ontology_id);
CREATE INDEX idx_clinical_events_scheduled_at   ON edr.clinical_events (scheduled_at DESC);
CREATE INDEX idx_clinical_events_completed_at   ON edr.clinical_events (completed_at DESC);
CREATE INDEX idx_clinical_events_performed_by   ON edr.clinical_events (performed_by);
CREATE INDEX idx_clinical_events_metadata_gin   ON edr.clinical_events USING GIN (metadata jsonb_path_ops);

-- ---------------------------------------------------------------------
-- 14. Tabla: audit_logs
--     Bitácora inmutable append-only. Captura todo INSERT/UPDATE/DELETE
--     sobre las tablas clínicas críticas. Conserva imágenes JSON
--     before/after y diff. Nunca debe ser modificada manualmente.
-- ---------------------------------------------------------------------
CREATE TABLE edr.audit_logs (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    log_uuid             UUID NOT NULL DEFAULT gen_random_uuid(),
    schema_name          VARCHAR(64) NOT NULL,
    table_name           VARCHAR(64) NOT NULL,
    row_pk               TEXT NOT NULL,                    -- PK serializado (UUID o BIGINT)
    action               edr.audit_action_enum NOT NULL,
    actor_operator_id    UUID,                             -- operator que ejecutó
    actor_auth_uid       UUID,                             -- auth.uid() de Supabase
    actor_role           TEXT,                             -- role Postgres
    client_ip            INET,
    user_agent           TEXT,
    request_id           UUID,                             -- correlación con request HTTP
    before_data          JSONB,
    after_data           JSONB,
    diff_data            JSONB,                            -- jsonb diff calculado
    statement_txid       BIGINT NOT NULL DEFAULT txid_current(),
    occurred_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT audit_logs_log_uuid_uk UNIQUE (log_uuid)
);

COMMENT ON TABLE edr.audit_logs IS 'Bitácora inmutable append-only de toda mutación clínica.';

CREATE INDEX idx_audit_logs_table_row    ON edr.audit_logs (schema_name, table_name, row_pk);
CREATE INDEX idx_audit_logs_actor        ON edr.audit_logs (actor_operator_id);
CREATE INDEX idx_audit_logs_occurred_at  ON edr.audit_logs (occurred_at DESC);
CREATE INDEX idx_audit_logs_action       ON edr.audit_logs (action);
CREATE INDEX idx_audit_logs_after_gin    ON edr.audit_logs USING GIN (after_data jsonb_path_ops);
CREATE INDEX idx_audit_logs_before_gin   ON edr.audit_logs USING GIN (before_data jsonb_path_ops);
CREATE INDEX idx_audit_logs_txid         ON edr.audit_logs (statement_txid);

-- ---------------------------------------------------------------------
-- 15. Función + trigger: auditoría genérica
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION edr.fn_audit_row()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_pk          TEXT;
    v_before      JSONB;
    v_after       JSONB;
    v_diff        JSONB;
    v_action      edr.audit_action_enum;
    v_operator_id UUID;
    v_auth_uid    UUID;
BEGIN
    IF (TG_OP = 'INSERT') THEN
        v_action := 'INSERT';
        v_before := NULL;
        v_after  := to_jsonb(NEW);
        v_pk     := COALESCE(v_after ->> 'id', '');
    ELSIF (TG_OP = 'UPDATE') THEN
        v_before := to_jsonb(OLD);
        v_after  := to_jsonb(NEW);
        v_pk     := COALESCE(v_after ->> 'id', v_before ->> 'id', '');
        -- soft delete vs update lógico
        IF (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) THEN
            v_action := 'SOFT_DELETE';
        ELSIF (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL) THEN
            v_action := 'RESTORE';
        ELSE
            v_action := 'UPDATE';
        END IF;
    ELSIF (TG_OP = 'DELETE') THEN
        v_action := 'DELETE';
        v_before := to_jsonb(OLD);
        v_after  := NULL;
        v_pk     := COALESCE(v_before ->> 'id', '');
    END IF;

    -- Diff básico: campos cambiados
    IF v_before IS NOT NULL AND v_after IS NOT NULL THEN
        SELECT jsonb_object_agg(key, jsonb_build_object('old', v_before -> key, 'new', v_after -> key))
          INTO v_diff
          FROM (
              SELECT key FROM jsonb_each(v_after)
              EXCEPT
              SELECT key FROM jsonb_each(v_before)
              UNION
              SELECT key FROM jsonb_each(v_before)
              EXCEPT
              SELECT key FROM jsonb_each(v_after)
              UNION
              SELECT k.key
                FROM jsonb_each(v_after) k
                JOIN jsonb_each(v_before) o ON o.key = k.key
               WHERE k.value IS DISTINCT FROM o.value
          ) AS changed_keys;
    END IF;

    BEGIN
        v_operator_id := edr.fn_current_operator_id();
    EXCEPTION WHEN OTHERS THEN
        v_operator_id := NULL;
    END;

    BEGIN
        v_auth_uid := auth.uid();
    EXCEPTION WHEN OTHERS THEN
        v_auth_uid := NULL;
    END;

    INSERT INTO edr.audit_logs (
        schema_name, table_name, row_pk, action,
        actor_operator_id, actor_auth_uid, actor_role,
        before_data, after_data, diff_data
    ) VALUES (
        TG_TABLE_SCHEMA, TG_TABLE_NAME, v_pk, v_action,
        v_operator_id, v_auth_uid, current_user,
        v_before, v_after, v_diff
    );

    IF (TG_OP = 'DELETE') THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$;

COMMENT ON FUNCTION edr.fn_audit_row()
    IS 'Captura INSERT/UPDATE/DELETE/SOFT_DELETE/RESTORE en audit_logs (append-only).';

-- ---------------------------------------------------------------------
-- 16. Función + trigger: bloqueo absoluto de mutaciones sobre audit_logs
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION edr.fn_audit_logs_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs es append-only: % no permitido', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$;

COMMENT ON FUNCTION edr.fn_audit_logs_immutable()
    IS 'Impide UPDATE/DELETE/TRUNCATE sobre audit_logs (versionado inmutable).';

CREATE TRIGGER trg_audit_logs_no_update
    BEFORE UPDATE ON edr.audit_logs
    FOR EACH ROW EXECUTE FUNCTION edr.fn_audit_logs_immutable();

CREATE TRIGGER trg_audit_logs_no_delete
    BEFORE DELETE ON edr.audit_logs
    FOR EACH ROW EXECUTE FUNCTION edr.fn_audit_logs_immutable();

CREATE TRIGGER trg_audit_logs_no_truncate
    BEFORE TRUNCATE ON edr.audit_logs
    FOR EACH STATEMENT EXECUTE FUNCTION edr.fn_audit_logs_immutable();

-- ---------------------------------------------------------------------
-- 17. Anclaje de triggers: updated_at + auditoría en cada tabla clínica
-- ---------------------------------------------------------------------
DO $$
DECLARE
    t TEXT;
    audited_tables TEXT[] := ARRAY[
        'operators',
        'patients',
        'ontology_dictionary',
        'event_statuses',
        'odontograms',
        'teeth',
        'surfaces',
        'clinical_findings',
        'treatment_plans',
        'clinical_events'
    ];
BEGIN
    FOREACH t IN ARRAY audited_tables LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_%1$s_updated_at
                BEFORE UPDATE ON edr.%1$I
                FOR EACH ROW EXECUTE FUNCTION edr.fn_set_updated_at();',
            t
        );
        EXECUTE format(
            'CREATE TRIGGER trg_%1$s_audit
                AFTER INSERT OR UPDATE OR DELETE ON edr.%1$I
                FOR EACH ROW EXECUTE FUNCTION edr.fn_audit_row();',
            t
        );
    END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 18. Vistas convenientes (no obligatorias, optimizan consulta clínica)
-- ---------------------------------------------------------------------

-- Última versión de odontograma por paciente
CREATE OR REPLACE VIEW edr.v_latest_odontogram AS
SELECT DISTINCT ON (o.patient_id)
       o.*
  FROM edr.odontograms o
 WHERE o.deleted_at IS NULL
 ORDER BY o.patient_id, o.version DESC;

COMMENT ON VIEW edr.v_latest_odontogram
    IS 'Snapshot de la versión más reciente de odontograma por paciente.';

-- Hallazgos activos por paciente
CREATE OR REPLACE VIEW edr.v_active_findings AS
SELECT f.*,
       od.code_system,
       od.code        AS finding_code,
       od.display_es  AS finding_label,
       t.fdi_code,
       s.surface_code,
       o.patient_id
  FROM edr.clinical_findings f
  JOIN edr.odontograms        o  ON o.id  = f.odontogram_id
  JOIN edr.ontology_dictionary od ON od.id = f.ontology_id
  LEFT JOIN edr.teeth    t ON t.id = f.tooth_id
  LEFT JOIN edr.surfaces s ON s.id = f.surface_id
 WHERE f.deleted_at IS NULL
   AND f.is_active  = TRUE;

COMMENT ON VIEW edr.v_active_findings
    IS 'Hallazgos clínicos vigentes con etiqueta ontológica y localización dental.';

-- ---------------------------------------------------------------------
-- 19. Permisos base (Supabase: roles authenticated y service_role)
-- ---------------------------------------------------------------------
GRANT USAGE ON SCHEMA edr TO authenticated, service_role;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES    IN SCHEMA edr TO authenticated;
GRANT SELECT                  ON edr.audit_logs            TO authenticated;
GRANT ALL                     ON ALL TABLES    IN SCHEMA edr TO service_role;
GRANT USAGE, SELECT           ON ALL SEQUENCES IN SCHEMA edr TO authenticated, service_role;

-- DELETE explícito sobre tablas clínicas se desautoriza:
-- la regla del sistema es soft-delete vía UPDATE deleted_at.
REVOKE DELETE ON ALL TABLES IN SCHEMA edr FROM authenticated;

-- ---------------------------------------------------------------------
-- Fin de 01_init_schema.sql
-- ---------------------------------------------------------------------
