-- =====================================================================
-- 06_perfiles_pacientes_riesgo.sql
-- Columnas de Perfil de Riesgo Clínico en public.perfiles_pacientes
-- ---------------------------------------------------------------------
-- Motivación:
--   Hasta ahora el motor del odontograma persistía el riesgo integral
--   en `fichas_clinicas.historial_json.riesgo_integral` (legacy) y
--   eventualmente en `perfiles_pacientes.metadata` (clobbering JSON).
--   Eso obliga al portal del paciente a leer la ÚLTIMA ficha por
--   created_at, lo que genera un bug: si el dentista firma una ficha
--   nueva sin riesgo después de cerrar el odontograma, el paciente ve
--   "evaluación pendiente" aunque el cálculo exista.
--
--   Este script materializa el riesgo en columnas DISCRETAS sobre el
--   perfil del paciente, fuente de verdad para citas-paciente.html y
--   cualquier vista del portal:
--     - nivel_riesgo            ('alto' | 'medio' | 'bajo')
--     - control_meses           periodicidad sugerida en meses
--     - proximo_control_fecha   DATE precalculada del próximo control
--     - riesgo_integral         JSONB con el snapshot completo
--     - riesgo_calculado_en     TIMESTAMPTZ de la última inferencia
--
-- Idempotente: ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
-- =====================================================================

SET search_path = public, pg_catalog;

-- ---------------------------------------------------------------------
-- 1. Columnas de riesgo (todas opcionales; existen sólo si fueron
--    calculadas para el paciente).
-- ---------------------------------------------------------------------
ALTER TABLE public.perfiles_pacientes
    ADD COLUMN IF NOT EXISTS nivel_riesgo           TEXT,
    ADD COLUMN IF NOT EXISTS control_meses          SMALLINT,
    ADD COLUMN IF NOT EXISTS proximo_control_fecha  DATE,
    ADD COLUMN IF NOT EXISTS riesgo_integral        JSONB,
    ADD COLUMN IF NOT EXISTS riesgo_calculado_en    TIMESTAMPTZ;

-- ---------------------------------------------------------------------
-- 2. Constraint declarativo sobre los niveles permitidos.
--    Se aplica sólo si la columna no tenía ya la check (idempotente).
-- ---------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_schema = 'public'
           AND table_name   = 'perfiles_pacientes'
           AND constraint_name = 'perfiles_pacientes_nivel_riesgo_chk'
    ) THEN
        ALTER TABLE public.perfiles_pacientes
            ADD CONSTRAINT perfiles_pacientes_nivel_riesgo_chk
            CHECK (nivel_riesgo IS NULL OR nivel_riesgo IN ('alto', 'medio', 'bajo'));
    END IF;
END $$;

-- ---------------------------------------------------------------------
-- 3. Índice para listar/segmentar pacientes por nivel de riesgo
--    (útil para dashboards del dentista: "pacientes ALTO sin control").
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_perfiles_pacientes_nivel_riesgo
    ON public.perfiles_pacientes (nivel_riesgo)
 WHERE nivel_riesgo IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_perfiles_pacientes_proximo_control
    ON public.perfiles_pacientes (proximo_control_fecha)
 WHERE proximo_control_fecha IS NOT NULL;

COMMENT ON COLUMN public.perfiles_pacientes.nivel_riesgo
    IS 'Nivel de riesgo integral calculado por el odontograma: alto | medio | bajo.';
COMMENT ON COLUMN public.perfiles_pacientes.proximo_control_fecha
    IS 'Fecha sugerida para el próximo control clínico (alto=3m, medio=6m, bajo=12m).';
COMMENT ON COLUMN public.perfiles_pacientes.riesgo_integral
    IS 'Snapshot completo del perfil de riesgo (incluye desglose caries / perio).';
COMMENT ON COLUMN public.perfiles_pacientes.riesgo_calculado_en
    IS 'Timestamp del último cálculo del riesgo integral.';

-- =====================================================================
-- Fin de 06_perfiles_pacientes_riesgo.sql
-- =====================================================================
