-- =====================================================================
-- 02_security_rpc.sql
-- Electronic Dental Record (EDR) - Capa de Seguridad y RPCs
-- Motor: Supabase PostgreSQL 15+
-- Autor: Arquitectura full-stack clínica odontológica
--
-- Descripción:
--   Capa transversal sobre 01_init_schema.sql que aporta:
--     (a) Modelo organizacional mínimo (clinics + membresías) requerido
--         por las políticas RLS de tenancy clínica.
--     (b) Funciones STABLE/SECURITY DEFINER que resuelven el contexto
--         del operador autenticado (rol, clínicas, acceso a paciente)
--         sin recursión a través de RLS.
--     (c) Activación de Row Level Security en todas las tablas
--         clínicas y políticas SELECT/INSERT/UPDATE específicas por rol.
--         La eliminación física (DELETE) queda bloqueada — el sistema
--         opera bajo soft-delete (deleted_at) auditado.
--     (d) Funciones RPC transaccionales que el frontend invoca para
--         operaciones compuestas: registro de hallazgos, transición de
--         estados clínicos, versionado de odontograma, cierre clínico
--         y soft-delete controlado. Todas serializan accesos críticos
--         con bloqueos de fila y consolidan auditoría dentro de la
--         misma transacción.
--
-- Convenciones:
--   * Todas las funciones SECURITY DEFINER fijan search_path explícito
--     para mitigar ataques de search_path hijack.
--   * Todas las RPC validan el operador autenticado vía fn_auth_operator_id().
--   * Las RPC retornan JSONB con shape estable {ok, data, error}.
--   * Concurrencia: SELECT ... FOR UPDATE sobre el agregado (odontograma
--     o diente) que actúa como "raíz de invariantes" del comando.
-- =====================================================================

SET search_path = edr, public;

-- =====================================================================
-- 1. Modelo organizacional (clinics + membresías + patient.clinic_id)
-- =====================================================================

-- 1.1 Clinics: unidad de tenancy clínica.
CREATE TABLE IF NOT EXISTS edr.clinics (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code                 VARCHAR(32)  NOT NULL,
    legal_name           VARCHAR(255) NOT NULL,
    trade_name           VARCHAR(255),
    tax_id               VARCHAR(32),
    country_iso2         CHAR(2),
    timezone             VARCHAR(64)  NOT NULL DEFAULT 'America/Santiago',
    contact_email        CITEXT,
    contact_phone        VARCHAR(32),
    address_line1        VARCHAR(255),
    address_line2        VARCHAR(255),
    city                 VARCHAR(120),
    region               VARCHAR(120),
    postal_code          VARCHAR(20),
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    metadata             JSONB   NOT NULL DEFAULT '{}'::JSONB,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at           TIMESTAMPTZ,
    CONSTRAINT clinics_code_uk         UNIQUE (code),
    CONSTRAINT clinics_country_iso2_chk CHECK (country_iso2 IS NULL OR country_iso2 ~ '^[A-Z]{2}$'),
    CONSTRAINT clinics_email_chk       CHECK (contact_email IS NULL OR contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

COMMENT ON TABLE edr.clinics IS 'Clínicas / unidades organizacionales (tenant lógico).';

CREATE INDEX IF NOT EXISTS idx_clinics_active ON edr.clinics (is_active) WHERE deleted_at IS NULL;

-- 1.2 Membresía operador<->clínica (N:M).
CREATE TABLE IF NOT EXISTS edr.operator_clinic_memberships (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operator_id          UUID NOT NULL,
    clinic_id            UUID NOT NULL,
    role_in_clinic       edr.operator_role_enum NOT NULL,
    is_primary           BOOLEAN NOT NULL DEFAULT FALSE,    -- clínica primaria del operador
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    joined_at            DATE    NOT NULL DEFAULT CURRENT_DATE,
    left_at              DATE,
    metadata             JSONB   NOT NULL DEFAULT '{}'::JSONB,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at           TIMESTAMPTZ,
    CONSTRAINT ocm_operator_fk
        FOREIGN KEY (operator_id) REFERENCES edr.operators(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT ocm_clinic_fk
        FOREIGN KEY (clinic_id) REFERENCES edr.clinics(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT ocm_unique_active_uk UNIQUE (operator_id, clinic_id),
    CONSTRAINT ocm_dates_chk CHECK (left_at IS NULL OR left_at >= joined_at)
);

COMMENT ON TABLE edr.operator_clinic_memberships
    IS 'Membresía operador<->clínica. Define el tenancy efectivo del operador.';

CREATE INDEX IF NOT EXISTS idx_ocm_operator   ON edr.operator_clinic_memberships (operator_id) WHERE deleted_at IS NULL AND is_active;
CREATE INDEX IF NOT EXISTS idx_ocm_clinic     ON edr.operator_clinic_memberships (clinic_id)   WHERE deleted_at IS NULL AND is_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ocm_primary_per_operator
    ON edr.operator_clinic_memberships (operator_id)
    WHERE is_primary = TRUE AND deleted_at IS NULL AND is_active = TRUE;

-- 1.3 Anclaje del paciente a una clínica (denormalizado para RLS eficiente).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'edr' AND table_name = 'patients' AND column_name = 'clinic_id'
    ) THEN
        ALTER TABLE edr.patients
            ADD COLUMN clinic_id UUID,
            ADD CONSTRAINT patients_clinic_fk
                FOREIGN KEY (clinic_id) REFERENCES edr.clinics(id)
                ON UPDATE CASCADE ON DELETE RESTRICT;
        CREATE INDEX IF NOT EXISTS idx_patients_clinic ON edr.patients (clinic_id) WHERE deleted_at IS NULL;
    END IF;
END $$;

-- 1.4 Triggers updated_at + audit para las tablas nuevas.
CREATE TRIGGER trg_clinics_updated_at
    BEFORE UPDATE ON edr.clinics
    FOR EACH ROW EXECUTE FUNCTION edr.fn_set_updated_at();
CREATE TRIGGER trg_clinics_audit
    AFTER INSERT OR UPDATE OR DELETE ON edr.clinics
    FOR EACH ROW EXECUTE FUNCTION edr.fn_audit_row();

CREATE TRIGGER trg_ocm_updated_at
    BEFORE UPDATE ON edr.operator_clinic_memberships
    FOR EACH ROW EXECUTE FUNCTION edr.fn_set_updated_at();
CREATE TRIGGER trg_ocm_audit
    AFTER INSERT OR UPDATE OR DELETE ON edr.operator_clinic_memberships
    FOR EACH ROW EXECUTE FUNCTION edr.fn_audit_row();

-- =====================================================================
-- 2. Funciones de contexto de seguridad
--    Todas SECURITY DEFINER + search_path fijo para que las llamadas
--    desde políticas RLS no recursionen sobre las propias políticas.
-- =====================================================================

-- 2.1 Resuelve operator_id del usuario auth.uid() bypass-RLS.
CREATE OR REPLACE FUNCTION edr.fn_auth_operator_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = edr, pg_catalog
AS $$
DECLARE
    v_uid    UUID;
    v_op_id  UUID;
BEGIN
    BEGIN
        v_uid := auth.uid();
    EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
    END;

    IF v_uid IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT id INTO v_op_id
      FROM edr.operators
     WHERE auth_user_id = v_uid
       AND deleted_at IS NULL
       AND is_active   = TRUE
     LIMIT 1;

    RETURN v_op_id;
END;
$$;

COMMENT ON FUNCTION edr.fn_auth_operator_id()
    IS 'Operator_id activo asociado al auth.uid() actual (bypass-RLS para evitar recursión).';

-- 2.2 Rol clínico del operador autenticado.
CREATE OR REPLACE FUNCTION edr.fn_auth_operator_role()
RETURNS edr.operator_role_enum
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = edr, pg_catalog
AS $$
DECLARE
    v_role edr.operator_role_enum;
BEGIN
    SELECT o.role INTO v_role
      FROM edr.operators o
     WHERE o.id = edr.fn_auth_operator_id()
       AND o.deleted_at IS NULL
       AND o.is_active   = TRUE
     LIMIT 1;
    RETURN v_role;
END;
$$;

COMMENT ON FUNCTION edr.fn_auth_operator_role()
    IS 'Rol clínico del operador autenticado.';

-- 2.3 Clínicas activas a las que pertenece el operador autenticado.
CREATE OR REPLACE FUNCTION edr.fn_auth_operator_clinic_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = edr, pg_catalog
AS $$
    SELECT m.clinic_id
      FROM edr.operator_clinic_memberships m
     WHERE m.operator_id = edr.fn_auth_operator_id()
       AND m.is_active   = TRUE
       AND m.deleted_at  IS NULL;
$$;

COMMENT ON FUNCTION edr.fn_auth_operator_clinic_ids()
    IS 'IDs de clínicas activas asociadas al operador autenticado.';

-- 2.4 ¿El operador autenticado tiene alguno de los roles indicados?
CREATE OR REPLACE FUNCTION edr.fn_auth_operator_has_role(VARIADIC p_roles edr.operator_role_enum[])
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = edr, pg_catalog
AS $$
    SELECT edr.fn_auth_operator_role() = ANY(p_roles);
$$;

COMMENT ON FUNCTION edr.fn_auth_operator_has_role(edr.operator_role_enum[])
    IS 'TRUE si el rol del operador autenticado está dentro del conjunto provisto.';

-- 2.5 ¿Puede el operador autenticado leer un paciente concreto?
--     Reglas: admin y auditor ven toda su tenancy; el resto sólo si
--     comparten clínica o si el paciente le está asignado como primary_dentist.
CREATE OR REPLACE FUNCTION edr.fn_auth_can_read_patient(p_patient_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = edr, pg_catalog
AS $$
DECLARE
    v_op_id     UUID := edr.fn_auth_operator_id();
    v_role      edr.operator_role_enum;
    v_clinic_id UUID;
    v_primary   UUID;
BEGIN
    IF v_op_id IS NULL OR p_patient_id IS NULL THEN
        RETURN FALSE;
    END IF;

    SELECT p.clinic_id, p.primary_dentist_id
      INTO v_clinic_id, v_primary
      FROM edr.patients p
     WHERE p.id = p_patient_id
       AND p.deleted_at IS NULL;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- Asignación directa siempre prima.
    IF v_primary = v_op_id THEN
        RETURN TRUE;
    END IF;

    -- Misma clínica.
    IF v_clinic_id IS NOT NULL
       AND v_clinic_id IN (SELECT edr.fn_auth_operator_clinic_ids())
    THEN
        RETURN TRUE;
    END IF;

    RETURN FALSE;
END;
$$;

COMMENT ON FUNCTION edr.fn_auth_can_read_patient(UUID)
    IS 'TRUE si el operador autenticado puede leer al paciente (mismo tenant o asignación directa).';

-- 2.6 ¿Puede el operador autenticado escribir clínicamente sobre un paciente?
--     Más restrictivo que lectura: receptionist no escribe clínica;
--     auditor nunca escribe; assistant escribe administrativo, no clínico.
CREATE OR REPLACE FUNCTION edr.fn_auth_can_write_clinical(p_patient_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = edr, pg_catalog
AS $$
DECLARE
    v_role edr.operator_role_enum := edr.fn_auth_operator_role();
BEGIN
    IF v_role IS NULL THEN
        RETURN FALSE;
    END IF;

    IF v_role NOT IN ('dentist', 'specialist', 'hygienist', 'admin') THEN
        RETURN FALSE;
    END IF;

    RETURN edr.fn_auth_can_read_patient(p_patient_id);
END;
$$;

COMMENT ON FUNCTION edr.fn_auth_can_write_clinical(UUID)
    IS 'TRUE si el operador puede mutar datos clínicos del paciente (lectura + rol clínico).';

-- 2.7 Aborta con error si el operador no puede escribir clínicamente.
CREATE OR REPLACE FUNCTION edr.fn_assert_can_write_clinical(p_patient_id UUID)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = edr, pg_catalog
AS $$
BEGIN
    IF NOT edr.fn_auth_can_write_clinical(p_patient_id) THEN
        RAISE EXCEPTION 'Permiso denegado: el operador % no puede escribir sobre el paciente %',
                        edr.fn_auth_operator_id(), p_patient_id
              USING ERRCODE = 'insufficient_privilege';
    END IF;
END;
$$;

-- =====================================================================
-- 3. Activación de Row Level Security
-- =====================================================================

ALTER TABLE edr.operators                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE edr.patients                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE edr.ontology_dictionary          ENABLE ROW LEVEL SECURITY;
ALTER TABLE edr.event_statuses               ENABLE ROW LEVEL SECURITY;
ALTER TABLE edr.odontograms                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE edr.teeth                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE edr.surfaces                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE edr.clinical_findings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE edr.treatment_plans              ENABLE ROW LEVEL SECURITY;
ALTER TABLE edr.clinical_events              ENABLE ROW LEVEL SECURITY;
ALTER TABLE edr.audit_logs                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE edr.clinics                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE edr.operator_clinic_memberships  ENABLE ROW LEVEL SECURITY;

-- Refuerzo: incluso el dueño debe pasar por RLS (excepto BYPASSRLS).
ALTER TABLE edr.operators                    FORCE ROW LEVEL SECURITY;
ALTER TABLE edr.patients                     FORCE ROW LEVEL SECURITY;
ALTER TABLE edr.odontograms                  FORCE ROW LEVEL SECURITY;
ALTER TABLE edr.teeth                        FORCE ROW LEVEL SECURITY;
ALTER TABLE edr.surfaces                     FORCE ROW LEVEL SECURITY;
ALTER TABLE edr.clinical_findings            FORCE ROW LEVEL SECURITY;
ALTER TABLE edr.treatment_plans              FORCE ROW LEVEL SECURITY;
ALTER TABLE edr.clinical_events              FORCE ROW LEVEL SECURITY;
ALTER TABLE edr.audit_logs                   FORCE ROW LEVEL SECURITY;
ALTER TABLE edr.clinics                      FORCE ROW LEVEL SECURITY;
ALTER TABLE edr.operator_clinic_memberships  FORCE ROW LEVEL SECURITY;

-- =====================================================================
-- 4. Políticas RLS
--    Estrategia general:
--      - Rol Postgres `service_role` (Supabase) tiene BYPASSRLS por
--        defecto; no requiere policies.
--      - Rol Postgres `authenticated` queda sujeto a las policies
--        que siguen.
--      - DELETE: ninguna policy lo permite => denegado por defecto.
--        Se complementa con REVOKE DELETE explícito.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 4.1 clinics
-- ---------------------------------------------------------------------
CREATE POLICY clinics_select_member ON edr.clinics
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL
        AND (
            edr.fn_auth_operator_has_role('admin', 'auditor')
            OR id IN (SELECT edr.fn_auth_operator_clinic_ids())
        )
    );

CREATE POLICY clinics_insert_admin ON edr.clinics
    FOR INSERT TO authenticated
    WITH CHECK (edr.fn_auth_operator_has_role('admin'));

CREATE POLICY clinics_update_admin ON edr.clinics
    FOR UPDATE TO authenticated
    USING (edr.fn_auth_operator_has_role('admin'))
    WITH CHECK (edr.fn_auth_operator_has_role('admin'));

-- ---------------------------------------------------------------------
-- 4.2 operator_clinic_memberships
-- ---------------------------------------------------------------------
CREATE POLICY ocm_select_same_tenant ON edr.operator_clinic_memberships
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL
        AND (
            operator_id = edr.fn_auth_operator_id()
            OR edr.fn_auth_operator_has_role('admin', 'auditor')
            OR clinic_id IN (SELECT edr.fn_auth_operator_clinic_ids())
        )
    );

CREATE POLICY ocm_insert_admin ON edr.operator_clinic_memberships
    FOR INSERT TO authenticated
    WITH CHECK (
        edr.fn_auth_operator_has_role('admin')
        AND clinic_id IN (SELECT edr.fn_auth_operator_clinic_ids())
    );

CREATE POLICY ocm_update_admin ON edr.operator_clinic_memberships
    FOR UPDATE TO authenticated
    USING (
        edr.fn_auth_operator_has_role('admin')
        AND clinic_id IN (SELECT edr.fn_auth_operator_clinic_ids())
    )
    WITH CHECK (
        edr.fn_auth_operator_has_role('admin')
        AND clinic_id IN (SELECT edr.fn_auth_operator_clinic_ids())
    );

-- ---------------------------------------------------------------------
-- 4.3 operators
--     Reglas:
--       - Cada operador se ve a sí mismo.
--       - Admin/auditor ven todo su tenancy.
--       - Los demás ven a sus compañeros de clínica activa.
--       - Inserción/promoción/baja: sólo admin del mismo tenancy.
-- ---------------------------------------------------------------------
CREATE POLICY operators_select_visible ON edr.operators
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL
        AND (
            id = edr.fn_auth_operator_id()
            OR edr.fn_auth_operator_has_role('admin', 'auditor')
            OR EXISTS (
                SELECT 1
                  FROM edr.operator_clinic_memberships m
                 WHERE m.operator_id = edr.operators.id
                   AND m.is_active   = TRUE
                   AND m.deleted_at  IS NULL
                   AND m.clinic_id IN (SELECT edr.fn_auth_operator_clinic_ids())
            )
        )
    );

CREATE POLICY operators_insert_admin ON edr.operators
    FOR INSERT TO authenticated
    WITH CHECK (edr.fn_auth_operator_has_role('admin'));

CREATE POLICY operators_update_self_or_admin ON edr.operators
    FOR UPDATE TO authenticated
    USING (
        id = edr.fn_auth_operator_id()
        OR edr.fn_auth_operator_has_role('admin')
    )
    WITH CHECK (
        id = edr.fn_auth_operator_id()
        OR edr.fn_auth_operator_has_role('admin')
    );

-- ---------------------------------------------------------------------
-- 4.4 patients
--     Lectura: pacientes propios (primary_dentist_id = self) o de la
--     misma clínica. Admin/auditor ven toda su tenancy.
-- ---------------------------------------------------------------------
CREATE POLICY patients_select_owned_or_clinic ON edr.patients
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL
        AND (
            primary_dentist_id = edr.fn_auth_operator_id()
            OR (clinic_id IS NOT NULL
                AND clinic_id IN (SELECT edr.fn_auth_operator_clinic_ids()))
            OR edr.fn_auth_operator_has_role('admin', 'auditor')
        )
    );

CREATE POLICY patients_insert_authorized ON edr.patients
    FOR INSERT TO authenticated
    WITH CHECK (
        edr.fn_auth_operator_has_role(
            'admin', 'dentist', 'specialist', 'receptionist'
        )
        AND (
            clinic_id IS NULL
            OR clinic_id IN (SELECT edr.fn_auth_operator_clinic_ids())
        )
    );

CREATE POLICY patients_update_authorized ON edr.patients
    FOR UPDATE TO authenticated
    USING (
        edr.fn_auth_operator_has_role(
            'admin', 'dentist', 'specialist', 'receptionist'
        )
        AND (
            primary_dentist_id = edr.fn_auth_operator_id()
            OR (clinic_id IS NOT NULL
                AND clinic_id IN (SELECT edr.fn_auth_operator_clinic_ids()))
            OR edr.fn_auth_operator_has_role('admin')
        )
    )
    WITH CHECK (
        -- No se permite saltar al paciente a un tenant ajeno.
        clinic_id IS NULL
        OR clinic_id IN (SELECT edr.fn_auth_operator_clinic_ids())
        OR edr.fn_auth_operator_has_role('admin')
    );

-- ---------------------------------------------------------------------
-- 4.5 ontology_dictionary
--     Tabla de catálogo: lectura para todos los autenticados,
--     escritura sólo para admin.
-- ---------------------------------------------------------------------
CREATE POLICY ontology_select_all ON edr.ontology_dictionary
    FOR SELECT TO authenticated
    USING (deleted_at IS NULL);

CREATE POLICY ontology_insert_admin ON edr.ontology_dictionary
    FOR INSERT TO authenticated
    WITH CHECK (edr.fn_auth_operator_has_role('admin'));

CREATE POLICY ontology_update_admin ON edr.ontology_dictionary
    FOR UPDATE TO authenticated
    USING (edr.fn_auth_operator_has_role('admin'))
    WITH CHECK (edr.fn_auth_operator_has_role('admin'));

-- ---------------------------------------------------------------------
-- 4.6 event_statuses (mismo patrón de catálogo)
-- ---------------------------------------------------------------------
CREATE POLICY event_statuses_select_all ON edr.event_statuses
    FOR SELECT TO authenticated
    USING (deleted_at IS NULL);

CREATE POLICY event_statuses_insert_admin ON edr.event_statuses
    FOR INSERT TO authenticated
    WITH CHECK (edr.fn_auth_operator_has_role('admin'));

CREATE POLICY event_statuses_update_admin ON edr.event_statuses
    FOR UPDATE TO authenticated
    USING (edr.fn_auth_operator_has_role('admin'))
    WITH CHECK (edr.fn_auth_operator_has_role('admin'));

-- ---------------------------------------------------------------------
-- 4.7 odontograms
-- ---------------------------------------------------------------------
CREATE POLICY odontograms_select_via_patient ON edr.odontograms
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL
        AND edr.fn_auth_can_read_patient(patient_id)
    );

CREATE POLICY odontograms_insert_clinical ON edr.odontograms
    FOR INSERT TO authenticated
    WITH CHECK (edr.fn_auth_can_write_clinical(patient_id));

CREATE POLICY odontograms_update_clinical ON edr.odontograms
    FOR UPDATE TO authenticated
    USING (
        edr.fn_auth_can_write_clinical(patient_id)
        AND (is_locked = FALSE OR edr.fn_auth_operator_has_role('admin'))
    )
    WITH CHECK (edr.fn_auth_can_write_clinical(patient_id));

-- ---------------------------------------------------------------------
-- 4.8 teeth (acceso heredado vía odontogram->patient)
-- ---------------------------------------------------------------------
CREATE POLICY teeth_select_inherited ON edr.teeth
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL
        AND EXISTS (
            SELECT 1 FROM edr.odontograms o
             WHERE o.id = teeth.odontogram_id
               AND o.deleted_at IS NULL
               AND edr.fn_auth_can_read_patient(o.patient_id)
        )
    );

CREATE POLICY teeth_insert_inherited ON edr.teeth
    FOR INSERT TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM edr.odontograms o
             WHERE o.id = teeth.odontogram_id
               AND o.deleted_at IS NULL
               AND o.is_locked = FALSE
               AND edr.fn_auth_can_write_clinical(o.patient_id)
        )
    );

CREATE POLICY teeth_update_inherited ON edr.teeth
    FOR UPDATE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM edr.odontograms o
             WHERE o.id = teeth.odontogram_id
               AND o.deleted_at IS NULL
               AND o.is_locked = FALSE
               AND edr.fn_auth_can_write_clinical(o.patient_id)
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM edr.odontograms o
             WHERE o.id = teeth.odontogram_id
               AND o.deleted_at IS NULL
               AND o.is_locked = FALSE
               AND edr.fn_auth_can_write_clinical(o.patient_id)
        )
    );

-- ---------------------------------------------------------------------
-- 4.9 surfaces
-- ---------------------------------------------------------------------
CREATE POLICY surfaces_select_inherited ON edr.surfaces
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL
        AND EXISTS (
            SELECT 1
              FROM edr.teeth t
              JOIN edr.odontograms o ON o.id = t.odontogram_id
             WHERE t.id = surfaces.tooth_id
               AND t.deleted_at IS NULL
               AND o.deleted_at IS NULL
               AND edr.fn_auth_can_read_patient(o.patient_id)
        )
    );

CREATE POLICY surfaces_insert_inherited ON edr.surfaces
    FOR INSERT TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1
              FROM edr.teeth t
              JOIN edr.odontograms o ON o.id = t.odontogram_id
             WHERE t.id = surfaces.tooth_id
               AND t.deleted_at IS NULL
               AND o.deleted_at IS NULL
               AND o.is_locked = FALSE
               AND edr.fn_auth_can_write_clinical(o.patient_id)
        )
    );

CREATE POLICY surfaces_update_inherited ON edr.surfaces
    FOR UPDATE TO authenticated
    USING (
        EXISTS (
            SELECT 1
              FROM edr.teeth t
              JOIN edr.odontograms o ON o.id = t.odontogram_id
             WHERE t.id = surfaces.tooth_id
               AND t.deleted_at IS NULL
               AND o.deleted_at IS NULL
               AND o.is_locked = FALSE
               AND edr.fn_auth_can_write_clinical(o.patient_id)
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
              FROM edr.teeth t
              JOIN edr.odontograms o ON o.id = t.odontogram_id
             WHERE t.id = surfaces.tooth_id
               AND t.deleted_at IS NULL
               AND o.deleted_at IS NULL
               AND o.is_locked = FALSE
               AND edr.fn_auth_can_write_clinical(o.patient_id)
        )
    );

-- ---------------------------------------------------------------------
-- 4.10 clinical_findings
-- ---------------------------------------------------------------------
CREATE POLICY findings_select_inherited ON edr.clinical_findings
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL
        AND EXISTS (
            SELECT 1 FROM edr.odontograms o
             WHERE o.id = clinical_findings.odontogram_id
               AND o.deleted_at IS NULL
               AND edr.fn_auth_can_read_patient(o.patient_id)
        )
    );

CREATE POLICY findings_insert_inherited ON edr.clinical_findings
    FOR INSERT TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM edr.odontograms o
             WHERE o.id = clinical_findings.odontogram_id
               AND o.deleted_at IS NULL
               AND o.is_locked = FALSE
               AND edr.fn_auth_can_write_clinical(o.patient_id)
        )
    );

CREATE POLICY findings_update_inherited ON edr.clinical_findings
    FOR UPDATE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM edr.odontograms o
             WHERE o.id = clinical_findings.odontogram_id
               AND o.deleted_at IS NULL
               AND o.is_locked = FALSE
               AND edr.fn_auth_can_write_clinical(o.patient_id)
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM edr.odontograms o
             WHERE o.id = clinical_findings.odontogram_id
               AND o.deleted_at IS NULL
               AND o.is_locked = FALSE
               AND edr.fn_auth_can_write_clinical(o.patient_id)
        )
    );

-- ---------------------------------------------------------------------
-- 4.11 treatment_plans
-- ---------------------------------------------------------------------
CREATE POLICY plans_select_via_patient ON edr.treatment_plans
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL
        AND edr.fn_auth_can_read_patient(patient_id)
    );

CREATE POLICY plans_insert_clinical ON edr.treatment_plans
    FOR INSERT TO authenticated
    WITH CHECK (edr.fn_auth_can_write_clinical(patient_id));

CREATE POLICY plans_update_clinical ON edr.treatment_plans
    FOR UPDATE TO authenticated
    USING (edr.fn_auth_can_write_clinical(patient_id))
    WITH CHECK (edr.fn_auth_can_write_clinical(patient_id));

-- ---------------------------------------------------------------------
-- 4.12 clinical_events
-- ---------------------------------------------------------------------
CREATE POLICY events_select_via_patient ON edr.clinical_events
    FOR SELECT TO authenticated
    USING (
        deleted_at IS NULL
        AND edr.fn_auth_can_read_patient(patient_id)
    );

CREATE POLICY events_insert_clinical ON edr.clinical_events
    FOR INSERT TO authenticated
    WITH CHECK (edr.fn_auth_can_write_clinical(patient_id));

CREATE POLICY events_update_clinical ON edr.clinical_events
    FOR UPDATE TO authenticated
    USING (edr.fn_auth_can_write_clinical(patient_id))
    WITH CHECK (edr.fn_auth_can_write_clinical(patient_id));

-- ---------------------------------------------------------------------
-- 4.13 audit_logs
--     Append-only desde el motor (triggers en 01) + RLS de lectura
--     restringida a admin/auditor.
-- ---------------------------------------------------------------------
CREATE POLICY audit_select_admin_auditor ON edr.audit_logs
    FOR SELECT TO authenticated
    USING (edr.fn_auth_operator_has_role('admin', 'auditor'));

-- No hay policy de INSERT/UPDATE/DELETE para authenticated: el INSERT
-- lo realiza el trigger SECURITY DEFINER (definido en 01). UPDATE y
-- DELETE están además bloqueados por los triggers de inmutabilidad.

-- =====================================================================
-- 5. Refuerzo de soft-delete (REVOKE explícito)
-- =====================================================================

REVOKE DELETE ON ALL TABLES IN SCHEMA edr FROM authenticated;
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA edr FROM authenticated;

GRANT SELECT, INSERT, UPDATE ON edr.clinics                      TO authenticated;
GRANT SELECT, INSERT, UPDATE ON edr.operator_clinic_memberships  TO authenticated;

-- =====================================================================
-- 6. Funciones RPC transaccionales
--    Convención de retorno: JSONB con shape estable.
--      Éxito : {"ok": true,  "data": <obj>}
--      Error : se eleva con RAISE EXCEPTION (PostgREST lo mapea a HTTP).
--    Todas SECURITY DEFINER con search_path fijo y validación temprana
--    de identidad y autorización.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 6.1 rpc_register_clinical_finding
--     Inserta un hallazgo clínico, opcionalmente actualiza el estado
--     del diente y deja audit trail en una sola transacción.
--
--     Concurrencia:
--       * Bloqueo de odontograma (FOR NO KEY UPDATE) para impedir
--         que sea bloqueado clínicamente mientras se escribe.
--       * Bloqueo de diente (FOR UPDATE) para serializar mutaciones
--         simultáneas (distintos operadores) sobre el mismo diente.
--       * Si se provee surface_code y no existe en la tabla surfaces,
--         se crea de forma idempotente con ON CONFLICT.
--
--     Parámetros nominales (Supabase RPC los acepta como JSON):
--       p_odontogram_id      odontograma vigente
--       p_tooth_id           diente afectado (puede ser NULL si el
--                            hallazgo es a nivel de odontograma)
--       p_surface_code       superficie FDI; NULL si no aplica
--       p_ontology_id        código clínico (ICDAS, restauración, etc.)
--       p_severity           severidad declarada
--       p_icdas_score        0..6 si aplica caries
--       p_description        texto libre
--       p_new_tooth_status   tooth_status_enum: si != NULL se aplica
--       p_metadata           jsonb extra (origen, dispositivo, etc.)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION edr.rpc_register_clinical_finding(
    p_odontogram_id     UUID,
    p_tooth_id          UUID,
    p_surface_code      edr.surface_code_enum,
    p_ontology_id       UUID,
    p_severity          edr.finding_severity_enum DEFAULT 'none',
    p_icdas_score       SMALLINT                  DEFAULT NULL,
    p_description       TEXT                      DEFAULT NULL,
    p_new_tooth_status  edr.tooth_status_enum     DEFAULT NULL,
    p_metadata          JSONB                     DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = edr, pg_catalog
AS $$
DECLARE
    v_op_id         UUID;
    v_patient_id    UUID;
    v_is_locked     BOOLEAN;
    v_surface_id    UUID;
    v_finding_id    UUID;
    v_old_status    edr.tooth_status_enum;
    v_tooth_changed BOOLEAN := FALSE;
BEGIN
    -- 1. Identidad y autorización clínica.
    v_op_id := edr.fn_auth_operator_id();
    IF v_op_id IS NULL THEN
        RAISE EXCEPTION 'No hay operador autenticado.'
              USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- 2. Bloqueo del odontograma (raíz de invariantes) y resolución de paciente.
    SELECT o.patient_id, o.is_locked
      INTO v_patient_id, v_is_locked
      FROM edr.odontograms o
     WHERE o.id = p_odontogram_id
       AND o.deleted_at IS NULL
     FOR NO KEY UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Odontograma % no existe o está eliminado.', p_odontogram_id
              USING ERRCODE = 'no_data_found';
    END IF;

    IF v_is_locked THEN
        RAISE EXCEPTION 'Odontograma % está bloqueado clínicamente; no admite cambios.', p_odontogram_id
              USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    PERFORM edr.fn_assert_can_write_clinical(v_patient_id);

    -- 3. Validación de ontología.
    IF NOT EXISTS (
        SELECT 1 FROM edr.ontology_dictionary
         WHERE id = p_ontology_id
           AND deleted_at IS NULL
           AND is_active   = TRUE
    ) THEN
        RAISE EXCEPTION 'Código ontológico % inválido o inactivo.', p_ontology_id
              USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- 4. Si se indicó diente: validar pertenencia al odontograma y bloquearlo.
    IF p_tooth_id IS NOT NULL THEN
        SELECT t.status
          INTO v_old_status
          FROM edr.teeth t
         WHERE t.id = p_tooth_id
           AND t.odontogram_id = p_odontogram_id
           AND t.deleted_at IS NULL
         FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Diente % no pertenece al odontograma % o está eliminado.',
                            p_tooth_id, p_odontogram_id
                  USING ERRCODE = 'foreign_key_violation';
        END IF;

        -- 5. Resolver/crear superficie idempotentemente si aplica.
        IF p_surface_code IS NOT NULL THEN
            INSERT INTO edr.surfaces (tooth_id, surface_code, is_present)
            VALUES (p_tooth_id, p_surface_code, TRUE)
            ON CONFLICT (tooth_id, surface_code) DO UPDATE
              SET is_present = TRUE
            RETURNING id INTO v_surface_id;
        END IF;
    ELSIF p_surface_code IS NOT NULL THEN
        RAISE EXCEPTION 'Se especificó superficie sin diente: combinación inválida.'
              USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- 6. Insertar el hallazgo.
    INSERT INTO edr.clinical_findings (
        odontogram_id, tooth_id, surface_id, ontology_id,
        severity, icdas_score, observed_by, description, metadata
    ) VALUES (
        p_odontogram_id, p_tooth_id, v_surface_id, p_ontology_id,
        p_severity, p_icdas_score, v_op_id, p_description,
        COALESCE(p_metadata, '{}'::JSONB)
            || jsonb_build_object(
                 'rpc',         'rpc_register_clinical_finding',
                 'rpc_actor',   v_op_id,
                 'rpc_txid',    txid_current(),
                 'rpc_ts',      to_jsonb(NOW())
               )
    )
    RETURNING id INTO v_finding_id;

    -- 7. Mutación opcional del estado macro del diente.
    IF p_tooth_id IS NOT NULL
       AND p_new_tooth_status IS NOT NULL
       AND p_new_tooth_status IS DISTINCT FROM v_old_status
    THEN
        UPDATE edr.teeth
           SET status = p_new_tooth_status
         WHERE id = p_tooth_id;
        v_tooth_changed := TRUE;
    END IF;

    -- 8. La auditoría se materializa automáticamente vía triggers
    --    edr.fn_audit_row() en INSERT del finding, eventual INSERT
    --    de surface y eventual UPDATE del diente. Todo dentro de la
    --    misma transacción => atomicidad total.

    RETURN jsonb_build_object(
        'ok',   TRUE,
        'data', jsonb_build_object(
            'finding_id',     v_finding_id,
            'surface_id',     v_surface_id,
            'tooth_status_changed', v_tooth_changed,
            'old_tooth_status',     v_old_status,
            'new_tooth_status',
                CASE WHEN v_tooth_changed THEN p_new_tooth_status ELSE v_old_status END
        )
    );
END;
$$;

COMMENT ON FUNCTION edr.rpc_register_clinical_finding(
    UUID, UUID, edr.surface_code_enum, UUID,
    edr.finding_severity_enum, SMALLINT, TEXT,
    edr.tooth_status_enum, JSONB
) IS 'Registra hallazgo clínico + (opcional) cambio de estado de diente + auditoría, atómicamente.';

-- ---------------------------------------------------------------------
-- 6.2 rpc_resolve_clinical_finding
--     Cierra un hallazgo (is_active=FALSE) vinculándolo al evento
--     clínico que lo resolvió. Bloquea el hallazgo y verifica
--     pertenencia consistente al mismo paciente.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION edr.rpc_resolve_clinical_finding(
    p_finding_id            UUID,
    p_resolution_event_id   UUID,
    p_resolution_notes      TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = edr, pg_catalog
AS $$
DECLARE
    v_op_id        UUID;
    v_patient_id   UUID;
    v_event_patient UUID;
    v_was_active   BOOLEAN;
BEGIN
    v_op_id := edr.fn_auth_operator_id();
    IF v_op_id IS NULL THEN
        RAISE EXCEPTION 'No hay operador autenticado.'
              USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT f.is_active, o.patient_id
      INTO v_was_active, v_patient_id
      FROM edr.clinical_findings f
      JOIN edr.odontograms o ON o.id = f.odontogram_id
     WHERE f.id = p_finding_id
       AND f.deleted_at IS NULL
     FOR UPDATE OF f;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Hallazgo % no existe o está eliminado.', p_finding_id
              USING ERRCODE = 'no_data_found';
    END IF;

    IF NOT v_was_active THEN
        RAISE EXCEPTION 'Hallazgo % ya está resuelto.', p_finding_id
              USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    PERFORM edr.fn_assert_can_write_clinical(v_patient_id);

    -- El evento de resolución debe existir y pertenecer al mismo paciente.
    SELECT ce.patient_id INTO v_event_patient
      FROM edr.clinical_events ce
     WHERE ce.id = p_resolution_event_id
       AND ce.deleted_at IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Evento de resolución % no existe.', p_resolution_event_id
              USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF v_event_patient <> v_patient_id THEN
        RAISE EXCEPTION 'El evento % no pertenece al paciente del hallazgo.', p_resolution_event_id
              USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    UPDATE edr.clinical_findings
       SET is_active           = FALSE,
           resolved_at         = NOW(),
           resolved_by         = v_op_id,
           resolution_event_id = p_resolution_event_id,
           description = CASE
               WHEN p_resolution_notes IS NULL THEN description
               ELSE COALESCE(description, '')
                    || E'\n[resuelto ' || NOW()::TEXT || '] ' || p_resolution_notes
           END
     WHERE id = p_finding_id;

    RETURN jsonb_build_object(
        'ok',   TRUE,
        'data', jsonb_build_object(
            'finding_id',           p_finding_id,
            'resolution_event_id',  p_resolution_event_id,
            'resolved_by',          v_op_id
        )
    );
END;
$$;

COMMENT ON FUNCTION edr.rpc_resolve_clinical_finding(UUID, UUID, TEXT)
    IS 'Cierra un hallazgo clínico vinculándolo al evento que lo resolvió.';

-- ---------------------------------------------------------------------
-- 6.3 rpc_transition_clinical_event
--     Aplica una transición de estado sobre un clinical_event,
--     validando el catálogo y guardando el estado previo.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION edr.rpc_transition_clinical_event(
    p_event_id          UUID,
    p_new_status_code   VARCHAR,
    p_notes             TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = edr, pg_catalog
AS $$
DECLARE
    v_op_id          UUID;
    v_patient_id     UUID;
    v_current_status UUID;
    v_current_term   BOOLEAN;
    v_new_status_id  UUID;
    v_new_is_term    BOOLEAN;
    v_new_is_bill    BOOLEAN;
BEGIN
    v_op_id := edr.fn_auth_operator_id();
    IF v_op_id IS NULL THEN
        RAISE EXCEPTION 'No hay operador autenticado.'
              USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Bloquear el evento.
    SELECT ce.patient_id, ce.status_id, es.is_terminal
      INTO v_patient_id, v_current_status, v_current_term
      FROM edr.clinical_events ce
      JOIN edr.event_statuses  es ON es.id = ce.status_id
     WHERE ce.id = p_event_id
       AND ce.deleted_at IS NULL
     FOR UPDATE OF ce;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Evento clínico % no existe.', p_event_id
              USING ERRCODE = 'no_data_found';
    END IF;

    PERFORM edr.fn_assert_can_write_clinical(v_patient_id);

    IF v_current_term THEN
        RAISE EXCEPTION 'Evento % ya está en un estado terminal y no puede transicionar.', p_event_id
              USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    -- Resolver el nuevo estado por código (catálogo configurable).
    SELECT id, is_terminal, is_billable_trigger
      INTO v_new_status_id, v_new_is_term, v_new_is_bill
      FROM edr.event_statuses
     WHERE code = p_new_status_code
       AND is_active   = TRUE
       AND deleted_at  IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Estado destino "%" no existe o está inactivo.', p_new_status_code
              USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF v_new_status_id = v_current_status THEN
        RAISE EXCEPTION 'El evento % ya está en el estado solicitado.', p_event_id
              USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    UPDATE edr.clinical_events
       SET previous_status_id = v_current_status,
           status_id          = v_new_status_id,
           started_at = CASE
               WHEN started_at IS NULL AND p_new_status_code IN ('in_progress','started')
                   THEN NOW()
               ELSE started_at
           END,
           completed_at = CASE
               WHEN v_new_is_term AND completed_at IS NULL THEN NOW()
               ELSE completed_at
           END,
           notes = CASE
               WHEN p_notes IS NULL THEN notes
               ELSE COALESCE(notes, '')
                    || E'\n[' || NOW()::TEXT || ' @' || v_op_id::TEXT || '] '
                    || p_notes
           END
     WHERE id = p_event_id;

    RETURN jsonb_build_object(
        'ok',   TRUE,
        'data', jsonb_build_object(
            'event_id',            p_event_id,
            'previous_status_id',  v_current_status,
            'new_status_id',       v_new_status_id,
            'is_terminal',         v_new_is_term,
            'is_billable_trigger', v_new_is_bill
        )
    );
END;
$$;

COMMENT ON FUNCTION edr.rpc_transition_clinical_event(UUID, VARCHAR, TEXT)
    IS 'Aplica una transición de estado sobre un clinical_event preservando el estado previo.';

-- ---------------------------------------------------------------------
-- 6.4 rpc_create_odontogram_version
--     Crea una nueva versión de odontograma copiando dientes y
--     superficies del odontograma fuente. Garantiza monotonicidad de
--     la versión mediante advisory lock por paciente y SELECT MAX
--     dentro de la sección crítica.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION edr.rpc_create_odontogram_version(
    p_patient_id          UUID,
    p_source_odontogram_id UUID DEFAULT NULL,    -- NULL = base limpia
    p_dentition_type      edr.dentition_type_enum DEFAULT 'permanent',
    p_is_baseline         BOOLEAN DEFAULT FALSE,
    p_notes               TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = edr, pg_catalog
AS $$
DECLARE
    v_op_id        UUID;
    v_new_id       UUID;
    v_next_version INTEGER;
    v_teeth_copied INTEGER := 0;
    v_surfaces_copied INTEGER := 0;
BEGIN
    v_op_id := edr.fn_auth_operator_id();
    IF v_op_id IS NULL THEN
        RAISE EXCEPTION 'No hay operador autenticado.'
              USING ERRCODE = 'insufficient_privilege';
    END IF;

    PERFORM edr.fn_assert_can_write_clinical(p_patient_id);

    -- Advisory lock por paciente para serializar el cálculo de versión.
    PERFORM pg_advisory_xact_lock(
        hashtextextended('edr.odontograms.version', 0),
        hashtextextended(p_patient_id::TEXT, 0)
    );

    SELECT COALESCE(MAX(version), 0) + 1
      INTO v_next_version
      FROM edr.odontograms
     WHERE patient_id = p_patient_id;

    INSERT INTO edr.odontograms (
        patient_id, version, dentition_type,
        recorded_by, is_baseline, notes
    ) VALUES (
        p_patient_id, v_next_version, p_dentition_type,
        v_op_id, p_is_baseline, p_notes
    )
    RETURNING id INTO v_new_id;

    -- Copia idempotente de dientes desde la versión fuente si se provee.
    IF p_source_odontogram_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM edr.odontograms
             WHERE id = p_source_odontogram_id
               AND patient_id = p_patient_id
               AND deleted_at IS NULL
        ) THEN
            RAISE EXCEPTION 'Odontograma fuente % no pertenece al paciente %.',
                            p_source_odontogram_id, p_patient_id
                  USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        WITH new_teeth AS (
            INSERT INTO edr.teeth (
                odontogram_id, fdi_code, universal_code, palmer_code,
                quadrant, position, layer, status,
                is_primary_layer, is_supernumerary,
                eruption_date, exfoliation_date, mobility_grade,
                notes, metadata
            )
            SELECT v_new_id, t.fdi_code, t.universal_code, t.palmer_code,
                   t.quadrant, t.position, t.layer, t.status,
                   t.is_primary_layer, t.is_supernumerary,
                   t.eruption_date, t.exfoliation_date, t.mobility_grade,
                   t.notes, t.metadata
              FROM edr.teeth t
             WHERE t.odontogram_id = p_source_odontogram_id
               AND t.deleted_at IS NULL
            RETURNING id, fdi_code
        ),
        src_surfaces AS (
            SELECT t_old.fdi_code, s.surface_code, s.is_present, s.notes, s.metadata
              FROM edr.teeth    t_old
              JOIN edr.surfaces s ON s.tooth_id = t_old.id
             WHERE t_old.odontogram_id = p_source_odontogram_id
               AND t_old.deleted_at IS NULL
               AND s.deleted_at      IS NULL
        ),
        ins_surfaces AS (
            INSERT INTO edr.surfaces (tooth_id, surface_code, is_present, notes, metadata)
            SELECT nt.id, ss.surface_code, ss.is_present, ss.notes, ss.metadata
              FROM new_teeth nt
              JOIN src_surfaces ss ON ss.fdi_code = nt.fdi_code
            RETURNING id
        )
        SELECT
            (SELECT COUNT(*) FROM new_teeth),
            (SELECT COUNT(*) FROM ins_surfaces)
          INTO v_teeth_copied, v_surfaces_copied;
    END IF;

    RETURN jsonb_build_object(
        'ok',   TRUE,
        'data', jsonb_build_object(
            'odontogram_id',     v_new_id,
            'version',           v_next_version,
            'teeth_copied',      v_teeth_copied,
            'surfaces_copied',   v_surfaces_copied
        )
    );
END;
$$;

COMMENT ON FUNCTION edr.rpc_create_odontogram_version(UUID, UUID, edr.dentition_type_enum, BOOLEAN, TEXT)
    IS 'Crea una nueva versión de odontograma, copiando opcionalmente dientes/superficies del fuente.';

-- ---------------------------------------------------------------------
-- 6.5 rpc_lock_odontogram
--     Bloquea (firma clínica) un odontograma: bloqueado e inmutable
--     desde ese momento. Verifica que esté abierto y autoriza al
--     operador.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION edr.rpc_lock_odontogram(
    p_odontogram_id UUID,
    p_notes         TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = edr, pg_catalog
AS $$
DECLARE
    v_op_id      UUID;
    v_patient_id UUID;
    v_locked     BOOLEAN;
BEGIN
    v_op_id := edr.fn_auth_operator_id();
    IF v_op_id IS NULL THEN
        RAISE EXCEPTION 'No hay operador autenticado.'
              USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT patient_id, is_locked
      INTO v_patient_id, v_locked
      FROM edr.odontograms
     WHERE id = p_odontogram_id
       AND deleted_at IS NULL
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Odontograma % no existe.', p_odontogram_id
              USING ERRCODE = 'no_data_found';
    END IF;

    IF v_locked THEN
        RAISE EXCEPTION 'Odontograma % ya está bloqueado.', p_odontogram_id
              USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    PERFORM edr.fn_assert_can_write_clinical(v_patient_id);

    -- Sólo dentist/specialist/admin pueden firmar.
    IF NOT edr.fn_auth_operator_has_role('dentist', 'specialist', 'admin') THEN
        RAISE EXCEPTION 'Rol % no autorizado para firmar odontograma.', edr.fn_auth_operator_role()
              USING ERRCODE = 'insufficient_privilege';
    END IF;

    UPDATE edr.odontograms
       SET is_locked = TRUE,
           locked_at = NOW(),
           locked_by = v_op_id,
           notes = CASE
               WHEN p_notes IS NULL THEN notes
               ELSE COALESCE(notes, '') || E'\n[lock ' || NOW()::TEXT || '] ' || p_notes
           END
     WHERE id = p_odontogram_id;

    RETURN jsonb_build_object(
        'ok',   TRUE,
        'data', jsonb_build_object(
            'odontogram_id', p_odontogram_id,
            'locked_by',     v_op_id,
            'locked_at',     NOW()
        )
    );
END;
$$;

COMMENT ON FUNCTION edr.rpc_lock_odontogram(UUID, TEXT)
    IS 'Firma clínica que bloquea un odontograma para mutaciones posteriores.';

-- ---------------------------------------------------------------------
-- 6.6 rpc_soft_delete_patient
--     Soft-delete controlado del paciente y de sus agregados clínicos.
--     Sólo admin o el primary_dentist pueden ejecutarlo. La cascada
--     soft borra odontogramas no bloqueados, planes activos y eventos
--     no terminales del paciente. Los registros bloqueados/firmados
--     permanecen visibles (legales) pero el paciente queda oculto.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION edr.rpc_soft_delete_patient(
    p_patient_id UUID,
    p_reason     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = edr, pg_catalog
AS $$
DECLARE
    v_op_id      UUID;
    v_primary    UUID;
    v_already    TIMESTAMPTZ;
    v_n_odon     INTEGER := 0;
    v_n_events   INTEGER := 0;
    v_n_plans    INTEGER := 0;
BEGIN
    IF p_reason IS NULL OR length(trim(p_reason)) < 8 THEN
        RAISE EXCEPTION 'Se requiere un motivo explícito (>=8 caracteres) para soft-delete.'
              USING ERRCODE = 'invalid_parameter_value';
    END IF;

    v_op_id := edr.fn_auth_operator_id();
    IF v_op_id IS NULL THEN
        RAISE EXCEPTION 'No hay operador autenticado.'
              USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT primary_dentist_id, deleted_at
      INTO v_primary, v_already
      FROM edr.patients
     WHERE id = p_patient_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Paciente % no existe.', p_patient_id
              USING ERRCODE = 'no_data_found';
    END IF;

    IF v_already IS NOT NULL THEN
        RAISE EXCEPTION 'Paciente % ya está eliminado.', p_patient_id
              USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF NOT (
        edr.fn_auth_operator_has_role('admin')
        OR v_primary = v_op_id
    ) THEN
        RAISE EXCEPTION 'Sólo admin o el odontólogo asignado pueden eliminar al paciente.'
              USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Cascada soft sobre agregados no firmados/no terminales.
    WITH od AS (
        UPDATE edr.odontograms
           SET deleted_at = NOW()
         WHERE patient_id = p_patient_id
           AND deleted_at IS NULL
           AND is_locked  = FALSE
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_n_odon FROM od;

    WITH ev AS (
        UPDATE edr.clinical_events ce
           SET deleted_at = NOW()
          FROM edr.event_statuses es
         WHERE ce.status_id = es.id
           AND ce.patient_id = p_patient_id
           AND ce.deleted_at IS NULL
           AND es.is_terminal = FALSE
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_n_events FROM ev;

    WITH pl AS (
        UPDATE edr.treatment_plans tp
           SET deleted_at = NOW()
          FROM edr.event_statuses es
         WHERE tp.status_id = es.id
           AND tp.patient_id = p_patient_id
           AND tp.deleted_at IS NULL
           AND es.is_terminal = FALSE
        RETURNING 1
    )
    SELECT COUNT(*) INTO v_n_plans FROM pl;

    UPDATE edr.patients
       SET deleted_at = NOW(),
           notes = COALESCE(notes, '')
                   || E'\n[soft-delete ' || NOW()::TEXT || ' @' || v_op_id::TEXT || '] ' || p_reason
     WHERE id = p_patient_id;

    RETURN jsonb_build_object(
        'ok',   TRUE,
        'data', jsonb_build_object(
            'patient_id',          p_patient_id,
            'odontograms_deleted', v_n_odon,
            'events_deleted',      v_n_events,
            'plans_deleted',       v_n_plans,
            'reason',              p_reason
        )
    );
END;
$$;

COMMENT ON FUNCTION edr.rpc_soft_delete_patient(UUID, TEXT)
    IS 'Soft-delete del paciente con cascada controlada sobre agregados no firmados.';

-- ---------------------------------------------------------------------
-- 6.7 rpc_register_patient
--     Alta de paciente con asignación de clínica y odontólogo,
--     verificando tenancy y unicidad de MRN/national_id.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION edr.rpc_register_patient(
    p_clinic_id          UUID,
    p_primary_dentist_id UUID,
    p_mrn                VARCHAR,
    p_national_id        VARCHAR,
    p_first_name         VARCHAR,
    p_last_name          VARCHAR,
    p_birth_date         DATE,
    p_sex                edr.sex_enum DEFAULT 'unknown',
    p_email              CITEXT       DEFAULT NULL,
    p_phone_primary      VARCHAR      DEFAULT NULL,
    p_extra              JSONB        DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = edr, pg_catalog
AS $$
DECLARE
    v_op_id      UUID;
    v_role       edr.operator_role_enum;
    v_patient_id UUID;
BEGIN
    v_op_id := edr.fn_auth_operator_id();
    IF v_op_id IS NULL THEN
        RAISE EXCEPTION 'No hay operador autenticado.'
              USING ERRCODE = 'insufficient_privilege';
    END IF;

    v_role := edr.fn_auth_operator_role();
    IF v_role NOT IN ('admin', 'dentist', 'specialist', 'receptionist') THEN
        RAISE EXCEPTION 'Rol % no autorizado para registrar pacientes.', v_role
              USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Tenancy: la clínica destino debe estar en las clínicas del operador.
    IF p_clinic_id NOT IN (SELECT edr.fn_auth_operator_clinic_ids())
       AND NOT edr.fn_auth_operator_has_role('admin')
    THEN
        RAISE EXCEPTION 'El operador no pertenece a la clínica destino.'
              USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- El primary_dentist debe ser un operador clínico activo de esa clínica.
    IF NOT EXISTS (
        SELECT 1
          FROM edr.operators o
          JOIN edr.operator_clinic_memberships m ON m.operator_id = o.id
         WHERE o.id = p_primary_dentist_id
           AND o.deleted_at IS NULL
           AND o.is_active  = TRUE
           AND o.role IN ('dentist', 'specialist')
           AND m.clinic_id  = p_clinic_id
           AND m.is_active  = TRUE
           AND m.deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'El odontólogo asignado no pertenece a la clínica destino o no es clínico activo.'
              USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    BEGIN
        INSERT INTO edr.patients (
            mrn, national_id, first_name, last_name,
            birth_date, sex, email, phone_primary,
            primary_dentist_id, clinic_id, metadata
        ) VALUES (
            p_mrn, NULLIF(p_national_id, ''), p_first_name, p_last_name,
            p_birth_date, p_sex, p_email, p_phone_primary,
            p_primary_dentist_id, p_clinic_id,
            COALESCE(p_extra, '{}'::JSONB)
        )
        RETURNING id INTO v_patient_id;
    EXCEPTION
        WHEN unique_violation THEN
            RAISE EXCEPTION 'MRN o national_id duplicado: %', SQLERRM
                  USING ERRCODE = 'unique_violation';
    END;

    RETURN jsonb_build_object(
        'ok',   TRUE,
        'data', jsonb_build_object(
            'patient_id', v_patient_id,
            'mrn',        p_mrn,
            'clinic_id',  p_clinic_id
        )
    );
END;
$$;

COMMENT ON FUNCTION edr.rpc_register_patient(
    UUID, UUID, VARCHAR, VARCHAR, VARCHAR, VARCHAR, DATE,
    edr.sex_enum, CITEXT, VARCHAR, JSONB
) IS 'Alta atómica de paciente con validación de tenancy y asignación clínica.';

-- =====================================================================
-- 7. GRANT EXECUTE sobre las funciones RPC
--    SECURITY DEFINER => permiso de ejecución a authenticated y service_role.
-- =====================================================================

REVOKE ALL ON FUNCTION
    edr.rpc_register_clinical_finding(
        UUID, UUID, edr.surface_code_enum, UUID,
        edr.finding_severity_enum, SMALLINT, TEXT,
        edr.tooth_status_enum, JSONB
    ),
    edr.rpc_resolve_clinical_finding(UUID, UUID, TEXT),
    edr.rpc_transition_clinical_event(UUID, VARCHAR, TEXT),
    edr.rpc_create_odontogram_version(UUID, UUID, edr.dentition_type_enum, BOOLEAN, TEXT),
    edr.rpc_lock_odontogram(UUID, TEXT),
    edr.rpc_soft_delete_patient(UUID, TEXT),
    edr.rpc_register_patient(
        UUID, UUID, VARCHAR, VARCHAR, VARCHAR, VARCHAR, DATE,
        edr.sex_enum, CITEXT, VARCHAR, JSONB
    )
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
    edr.rpc_register_clinical_finding(
        UUID, UUID, edr.surface_code_enum, UUID,
        edr.finding_severity_enum, SMALLINT, TEXT,
        edr.tooth_status_enum, JSONB
    ),
    edr.rpc_resolve_clinical_finding(UUID, UUID, TEXT),
    edr.rpc_transition_clinical_event(UUID, VARCHAR, TEXT),
    edr.rpc_create_odontogram_version(UUID, UUID, edr.dentition_type_enum, BOOLEAN, TEXT),
    edr.rpc_lock_odontogram(UUID, TEXT),
    edr.rpc_soft_delete_patient(UUID, TEXT),
    edr.rpc_register_patient(
        UUID, UUID, VARCHAR, VARCHAR, VARCHAR, VARCHAR, DATE,
        edr.sex_enum, CITEXT, VARCHAR, JSONB
    )
TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION
    edr.fn_auth_operator_id(),
    edr.fn_auth_operator_role(),
    edr.fn_auth_operator_clinic_ids(),
    edr.fn_auth_operator_has_role(edr.operator_role_enum[]),
    edr.fn_auth_can_read_patient(UUID),
    edr.fn_auth_can_write_clinical(UUID),
    edr.fn_assert_can_write_clinical(UUID)
TO authenticated, service_role;

-- =====================================================================
-- Fin de 02_security_rpc.sql
-- =====================================================================
