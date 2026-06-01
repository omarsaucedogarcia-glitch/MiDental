-- =====================================================================
-- 03_rpc_buscar_email_por_rut.sql
-- RPC: lookup de email por RUT para flujo de login.
--
-- Motivación:
--   El login en MiDental se hace por RUT, pero Supabase Auth requiere
--   email. El cliente (anónimo, pre-login) necesita resolver el email
--   asociado al RUT para llamar después a signInWithPassword().
--
--   Una consulta directa sobre perfiles_pacientes / perfiles_dentistas
--   choca con RLS si la tabla no permite SELECT al rol `anon`. Abrir
--   la tabla entera al rol anónimo es excesivo.
--
--   Esta función SECURITY DEFINER expone exactamente lo mínimo
--   necesario (el email) buscando por RUT exacto, con tolerancia al
--   formato (con o sin puntos), sin filtrar otros datos del perfil.
--
-- Cómo aplicarlo:
--   Ejecutar este archivo en el SQL Editor de Supabase (proyecto
--   correspondiente). Una sola vez.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.buscar_email_por_rut(
    p_rut  TEXT,
    p_tipo TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
    v_email          TEXT;
    v_rut_sin_puntos TEXT := REPLACE(COALESCE(p_rut, ''), '.', '');
BEGIN
    IF p_rut IS NULL OR LENGTH(TRIM(p_rut)) = 0 THEN
        RETURN NULL;
    END IF;

    IF p_tipo = 'paciente' THEN
        SELECT email INTO v_email
          FROM public.perfiles_pacientes
         WHERE rut = p_rut OR rut = v_rut_sin_puntos
         LIMIT 1;
    ELSIF p_tipo = 'dentista' THEN
        SELECT email INTO v_email
          FROM public.perfiles_dentistas
         WHERE rut = p_rut OR rut = v_rut_sin_puntos
         LIMIT 1;
    ELSE
        RAISE EXCEPTION 'Tipo de usuario inválido: %', p_tipo
              USING ERRCODE = 'invalid_parameter_value';
    END IF;

    RETURN v_email;
END;
$$;

COMMENT ON FUNCTION public.buscar_email_por_rut(TEXT, TEXT)
    IS 'Resuelve el email asociado a un RUT para el flujo de login (pre-autenticación).';

-- Permitir invocación desde el cliente anónimo (rol anon) y también
-- desde usuarios autenticados.
GRANT EXECUTE ON FUNCTION public.buscar_email_por_rut(TEXT, TEXT) TO anon, authenticated;

-- =====================================================================
-- Fin de 03_rpc_buscar_email_por_rut.sql
-- =====================================================================
