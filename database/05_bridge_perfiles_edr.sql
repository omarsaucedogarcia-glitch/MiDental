-- =====================================================================
-- 05_bridge_perfiles_edr.sql
-- Bridge entre public.perfiles_pacientes / perfiles_dentistas y edr.*
-- ---------------------------------------------------------------------
-- Motivación:
--   El frontend MiDental opera con `public.perfiles_pacientes` y
--   `public.perfiles_dentistas` (id == auth.users.id, RUT, nombre).
--   La capa formal EDR (schema `edr`) usa `edr.patients` y
--   `edr.operators` con tenancy por clínica.
--
--   Este archivo define funciones SECURITY DEFINER que:
--     (a) Garantizan la existencia de una clínica por defecto.
--     (b) Auto-provisionan un edr.operators a partir del dentista
--         autenticado (auth.uid -> perfiles_dentistas) la primera
--         vez que se persiste un odontograma.
--     (c) Auto-provisionan un edr.patients a partir del perfil de
--         paciente (perfiles_pacientes.id) la primera vez que se
--         persiste un odontograma para él.
--     (d) Resuelven IDs idempotentemente: si ya existe, retornan;
--         si no, crean con datos mínimos coherentes.
--
-- Idempotente: se puede correr varias veces; las funciones existen
-- como CREATE OR REPLACE y los datos por defecto usan ON CONFLICT.
-- =====================================================================

SET search_path = edr, public, pg_catalog;

-- ---------------------------------------------------------------------
-- 0. Pre-requisito de esquema: columna metadata en edr.patients.
--    El init original (01_init_schema.sql) usa columnas JSONB
--    discretas (allergies, medical_history, insurance) y NO tiene
--    metadata. Este bridge la necesita para enlazar perfiles_pacientes
--    con edr.patients sin tocar las columnas clínicas.
--    Idempotente: si ya existe se ignora.
-- ---------------------------------------------------------------------
ALTER TABLE edr.patients
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::JSONB;

-- Índice GIN para que el lookup `metadata @> {perfil_id: ...}` sea barato.
CREATE INDEX IF NOT EXISTS idx_patients_metadata_gin
    ON edr.patients USING GIN (metadata jsonb_path_ops);

-- ---------------------------------------------------------------------
-- 1. Clínica MiDental por defecto (tenant raíz).
--    Se crea una sola vez con code='MIDENTAL_DEFAULT'.
-- ---------------------------------------------------------------------
INSERT INTO edr.clinics
    (code, legal_name, trade_name, country_iso2, timezone, is_active)
VALUES
    ('MIDENTAL_DEFAULT', 'MiDental Red de Salud Digital', 'MiDental',
     'CL', 'America/Santiago', TRUE)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. fn_default_clinic_id: lookup helper.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION edr.fn_default_clinic_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = edr, pg_catalog
AS $$
    SELECT id FROM edr.clinics
     WHERE code = 'MIDENTAL_DEFAULT'
       AND deleted_at IS NULL
     LIMIT 1;
$$;

COMMENT ON FUNCTION edr.fn_default_clinic_id()
    IS 'Devuelve el UUID de la clínica MiDental por defecto.';

-- ---------------------------------------------------------------------
-- 3. rpc_resolve_or_create_edr_operator
--    Idempotente: busca un edr.operators por auth.uid() actual.
--    Si no existe, lo crea a partir de public.perfiles_dentistas y
--    le asegura una membresía a la clínica default.
--
--    Llamado por el cliente JS antes de cualquier RPC EDR que
--    requiera fn_auth_operator_id() != NULL.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION edr.rpc_resolve_or_create_edr_operator()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = edr, public, pg_catalog
AS $$
DECLARE
    v_auth_uid    UUID := auth.uid();
    v_op_id       UUID;
    v_clinic_id   UUID := edr.fn_default_clinic_id();
    v_perfil      RECORD;
    v_was_created BOOLEAN := FALSE;
BEGIN
    IF v_auth_uid IS NULL THEN
        RAISE EXCEPTION 'No hay sesión autenticada (auth.uid() es NULL).'
              USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_clinic_id IS NULL THEN
        RAISE EXCEPTION 'Clínica MIDENTAL_DEFAULT no existe; correr 05_bridge_perfiles_edr.sql primero.'
              USING ERRCODE = 'no_data_found';
    END IF;

    -- ¿Ya existe operator?
    SELECT id INTO v_op_id
      FROM edr.operators
     WHERE auth_user_id = v_auth_uid
       AND deleted_at IS NULL
     LIMIT 1;

    IF v_op_id IS NULL THEN
        -- Tomar datos desde perfiles_dentistas
        SELECT id, rut, nombre_completo, email, telefono
          INTO v_perfil
          FROM public.perfiles_dentistas
         WHERE id = v_auth_uid
         LIMIT 1;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'No existe perfiles_dentistas para auth.uid()=%; el usuario actual no es un dentista registrado.', v_auth_uid
                  USING ERRCODE = 'no_data_found';
        END IF;

        INSERT INTO edr.operators
            (auth_user_id, national_id, first_name, last_name,
             email, phone, role, is_active, metadata)
        VALUES
            (v_auth_uid,
             v_perfil.rut,
             COALESCE(split_part(v_perfil.nombre_completo, ' ', 1), 'Dr.'),
             COALESCE(NULLIF(trim(substring(v_perfil.nombre_completo from position(' ' in v_perfil.nombre_completo) + 1)), ''),
                      'MiDental'),
             v_perfil.email,
             v_perfil.telefono,
             'dentist',
             TRUE,
             jsonb_build_object('source','perfiles_dentistas','perfil_id', v_perfil.id))
        RETURNING id INTO v_op_id;
        v_was_created := TRUE;
    END IF;

    -- Garantizar membresía a la clínica default
    INSERT INTO edr.operator_clinic_memberships
        (operator_id, clinic_id, role_in_clinic, is_primary, is_active)
    VALUES
        (v_op_id, v_clinic_id, 'dentist', TRUE, TRUE)
    ON CONFLICT (operator_id, clinic_id) DO NOTHING;

    RETURN jsonb_build_object(
        'ok',   TRUE,
        'data', jsonb_build_object(
            'operator_id', v_op_id,
            'clinic_id',   v_clinic_id,
            'created',     v_was_created
        )
    );
END;
$$;

COMMENT ON FUNCTION edr.rpc_resolve_or_create_edr_operator()
    IS 'Resuelve o auto-provisiona edr.operators para el dentista autenticado y le garantiza membresía a la clínica default.';

GRANT EXECUTE ON FUNCTION edr.rpc_resolve_or_create_edr_operator()
    TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. rpc_resolve_or_create_edr_patient
--    Idempotente: dado un perfiles_pacientes.id, busca el edr.patients
--    correspondiente (por national_id o por metadata->>'perfil_id').
--    Si no existe, lo crea con los datos mínimos del perfil y lo asigna
--    al operador autenticado como primary_dentist.
--
--    Devuelve { ok, data: { patient_id, created } }.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION edr.rpc_resolve_or_create_edr_patient(
    p_perfil_paciente_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = edr, public, pg_catalog
AS $$
DECLARE
    v_op_id        UUID;
    v_clinic_id    UUID := edr.fn_default_clinic_id();
    v_patient_id   UUID;
    v_perfil       RECORD;
    v_mrn          VARCHAR(32);
    v_first_name   VARCHAR(120);
    v_last_name    VARCHAR(120);
    v_was_created  BOOLEAN := FALSE;
BEGIN
    IF p_perfil_paciente_id IS NULL THEN
        RAISE EXCEPTION 'p_perfil_paciente_id no puede ser NULL.'
              USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Garantizar operator + clinic existentes antes de cualquier escritura clínica.
    PERFORM edr.rpc_resolve_or_create_edr_operator();
    v_op_id := edr.fn_auth_operator_id();
    IF v_op_id IS NULL THEN
        RAISE EXCEPTION 'No fue posible resolver operator_id para auth.uid()=%', auth.uid()
              USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Buscar paciente existente por metadata->>'perfil_id'
    SELECT id INTO v_patient_id
      FROM edr.patients
     WHERE metadata @> jsonb_build_object('perfil_id', p_perfil_paciente_id::TEXT)
       AND deleted_at IS NULL
     LIMIT 1;

    IF v_patient_id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'ok',   TRUE,
            'data', jsonb_build_object('patient_id', v_patient_id, 'created', FALSE)
        );
    END IF;

    -- Cargar el perfil del paciente
    SELECT pp.id, pp.rut, pp.nombre_completo, pp.telefono, pp.email
      INTO v_perfil
      FROM public.perfiles_pacientes pp
     WHERE pp.id = p_perfil_paciente_id
     LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'No existe perfiles_pacientes con id %', p_perfil_paciente_id
              USING ERRCODE = 'no_data_found';
    END IF;

    -- Fallback secundario: matchear por national_id (RUT) si ya existía un edr.patients legado.
    IF v_perfil.rut IS NOT NULL THEN
        SELECT id INTO v_patient_id
          FROM edr.patients
         WHERE national_id = v_perfil.rut
           AND deleted_at IS NULL
         LIMIT 1;

        IF v_patient_id IS NOT NULL THEN
            UPDATE edr.patients
               SET metadata = metadata
                   || jsonb_build_object('perfil_id', p_perfil_paciente_id::TEXT)
             WHERE id = v_patient_id;

            RETURN jsonb_build_object(
                'ok',   TRUE,
                'data', jsonb_build_object('patient_id', v_patient_id, 'created', FALSE)
            );
        END IF;
    END IF;

    -- Calcular nombre y apellido a partir de nombre_completo
    v_first_name := COALESCE(NULLIF(split_part(v_perfil.nombre_completo, ' ', 1), ''), 'Paciente');
    v_last_name  := COALESCE(
        NULLIF(trim(substring(v_perfil.nombre_completo from position(' ' in v_perfil.nombre_completo) + 1)), ''),
        'MiDental'
    );

    -- MRN único derivado del UUID del perfil
    v_mrn := 'MD-' || replace(p_perfil_paciente_id::TEXT, '-', '');

    INSERT INTO edr.patients (
        mrn, national_id, first_name, last_name,
        birth_date, sex, email, phone_primary,
        primary_dentist_id, clinic_id, metadata
    ) VALUES (
        v_mrn,
        NULLIF(v_perfil.rut, ''),
        v_first_name,
        v_last_name,
        DATE '1900-01-01',        -- placeholder; la app permitirá editar después
        'unknown',
        v_perfil.email,
        v_perfil.telefono,
        v_op_id,
        v_clinic_id,
        jsonb_build_object(
            'source',    'perfiles_pacientes',
            'perfil_id', p_perfil_paciente_id::TEXT,
            'birth_date_placeholder', TRUE
        )
    )
    RETURNING id INTO v_patient_id;
    v_was_created := TRUE;

    RETURN jsonb_build_object(
        'ok',   TRUE,
        'data', jsonb_build_object('patient_id', v_patient_id, 'created', v_was_created)
    );
END;
$$;

COMMENT ON FUNCTION edr.rpc_resolve_or_create_edr_patient(UUID)
    IS 'Idempotente: garantiza un edr.patients vinculado a perfiles_pacientes; auto-provisiona si falta.';

GRANT EXECUTE ON FUNCTION edr.rpc_resolve_or_create_edr_patient(UUID)
    TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. fn_state_to_tooth_status: mapeo desde el estado del frontend
--    (active/planned/completed/historic) y un código de hallazgo, al
--    tooth_status_enum de edr.teeth. Centralizado para que tanto JS
--    como SQL (RPCs futuros) usen la misma tabla.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION edr.fn_state_to_tooth_status(
    p_state TEXT,
    p_code  TEXT
)
RETURNS edr.tooth_status_enum
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_code = 'ausente'                            THEN 'absent_extracted'::edr.tooth_status_enum
        WHEN p_code = 'extraccion' AND p_state = 'historic' THEN 'absent_extracted'::edr.tooth_status_enum
        WHEN p_code = 'rehabilitacion'                     THEN 'replaced_by_prosthesis'::edr.tooth_status_enum
        WHEN p_code = 'implante'                           THEN 'replaced_by_implant'::edr.tooth_status_enum
        ELSE 'present'::edr.tooth_status_enum
    END;
$$;

COMMENT ON FUNCTION edr.fn_state_to_tooth_status(TEXT, TEXT)
    IS 'Mapea (state, code) del frontend a edr.tooth_status_enum.';

-- ---------------------------------------------------------------------
-- 6. Vista enriquecida: hallazgos activos del paciente del frontend.
--    Adapta v_active_findings para que pueda consumirse con el
--    perfiles_pacientes.id como filtro (vía bridge).
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW edr.v_active_findings_by_perfil AS
SELECT
    vf.id            AS finding_id,
    vf.patient_id    AS edr_patient_id,
    (p.metadata->>'perfil_id')::UUID AS perfil_paciente_id,
    vf.code_system,
    vf.finding_code,
    vf.finding_label,
    vf.fdi_code,
    vf.surface_code,
    vf.severity,
    vf.icdas_score,
    vf.description,
    vf.created_at,
    vf.tooth_id,
    vf.surface_id,
    vf.odontogram_id,
    t.status         AS tooth_status,
    od.category      AS ontology_category,
    od.metadata      AS ontology_metadata
  FROM edr.v_active_findings    vf
  JOIN edr.patients             p  ON p.id = vf.patient_id
  LEFT JOIN edr.teeth           t  ON t.id = vf.tooth_id
  LEFT JOIN edr.ontology_dictionary od ON od.id = vf.ontology_id;

COMMENT ON VIEW edr.v_active_findings_by_perfil
    IS 'Hallazgos activos enlazados al perfiles_pacientes.id vía metadata->>perfil_id.';

GRANT SELECT ON edr.v_active_findings_by_perfil TO authenticated, service_role;

-- =====================================================================
-- Fin de 05_bridge_perfiles_edr.sql
-- =====================================================================
