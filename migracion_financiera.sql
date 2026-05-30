-- =====================================================================
-- MIGRACIÓN FINANCIERA · MÓDULO "SALDO CORRIENTE" · MiDental
-- =====================================================================
-- Ejecutar en el SQL Editor de Supabase.
-- Crea la infraestructura para registrar pagos de pacientes, gastos
-- operativos del dentista (laboratorio) y convenios con centros médicos.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) TABLA PRINCIPAL DE PAGOS DE PACIENTES
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pagos (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cita_id      BIGINT NULL,
    paciente_id  UUID NOT NULL REFERENCES perfiles_pacientes(id) ON DELETE CASCADE,
    dentista_id  UUID NOT NULL REFERENCES perfiles_dentistas(id) ON DELETE CASCADE,
    monto        NUMERIC(12,2) NOT NULL CHECK (monto >= 0),
    medio_pago   VARCHAR(30)   NOT NULL,
    notas        TEXT,
    fecha_pago   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pagos_paciente_id ON pagos(paciente_id);
CREATE INDEX IF NOT EXISTS idx_pagos_dentista_id ON pagos(dentista_id);
CREATE INDEX IF NOT EXISTS idx_pagos_fecha_pago  ON pagos(fecha_pago);

-- ---------------------------------------------------------------------
-- 2) PRESUPUESTO INTEGRAL DEL PACIENTE
-- ---------------------------------------------------------------------
ALTER TABLE perfiles_pacientes
    ADD COLUMN IF NOT EXISTS presupuesto_integral NUMERIC(12,2) DEFAULT 0;

-- ---------------------------------------------------------------------
-- 3) VISTA · BALANCE FINANCIERO POR PACIENTE
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW vista_balance_paciente AS
SELECT
    pa.id                              AS paciente_id,
    COALESCE(pa.presupuesto_integral, 0) AS presupuesto_integral,
    COALESCE(SUM(p.monto), 0)            AS total_pagado,
    (COALESCE(pa.presupuesto_integral, 0) - COALESCE(SUM(p.monto), 0)) AS saldo_restante
FROM perfiles_pacientes pa
LEFT JOIN pagos p ON p.paciente_id = pa.id
GROUP BY pa.id, pa.presupuesto_integral;

-- ---------------------------------------------------------------------
-- 4) GASTOS DE LABORATORIO (DEDUCCIÓN MENSUAL DEL DENTISTA)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pagos_laboratorio (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dentista_id  UUID NOT NULL REFERENCES perfiles_dentistas(id) ON DELETE CASCADE,
    descripcion  VARCHAR(255) NOT NULL,
    monto        NUMERIC(12,2) NOT NULL CHECK (monto >= 0),
    fecha_gasto  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pagos_lab_dentista_id ON pagos_laboratorio(dentista_id);
CREATE INDEX IF NOT EXISTS idx_pagos_lab_fecha       ON pagos_laboratorio(fecha_gasto);

-- ---------------------------------------------------------------------
-- 5) CONVENIOS CON CENTROS MÉDICOS (PORCENTAJE DE HONORARIOS)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS convenios_centros_medicos (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dentista_id   UUID NOT NULL REFERENCES perfiles_dentistas(id) ON DELETE CASCADE,
    nombre_centro VARCHAR(150) NOT NULL,
    porcentaje    NUMERIC(5,2) NOT NULL CHECK (porcentaje >= 0 AND porcentaje <= 100),
    activo        BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_convenios_dentista_id ON convenios_centros_medicos(dentista_id);
