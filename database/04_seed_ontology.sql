-- =====================================================================
-- 04_seed_ontology.sql
-- Seed idempotente del diccionario clínico (edr.ontology_dictionary)
-- ---------------------------------------------------------------------
-- Pobla los códigos LOCAL/ICDAS que el frontend del odontograma
-- (ficha-paciente.html + js/odontograma.js) utiliza tanto para
-- hallazgos (panel izquierdo: data-code) como para procedimientos
-- (panel derecho: data-tx, prefijados con tx_).
--
-- Convenciones:
--   * code_system = 'LOCAL'   → catálogo propio MiDental
--   * code_system = 'ICDAS'   → códigos ICDAS para cariología
--   * category    = 'finding'   para diagnósticos / patologías
--   * category    = 'procedure' para tratamientos / prestaciones
--   * category    = 'status'    para estados macro (sano, ausente)
--
-- Idempotente: ON CONFLICT (code_system, code) DO UPDATE.
-- =====================================================================

SET search_path = edr, public;

-- ---------------------------------------------------------------------
-- A. Hallazgos cariológicos (ICDAS)
-- ---------------------------------------------------------------------
INSERT INTO edr.ontology_dictionary
    (code_system, code, display, display_es, category, is_billable, metadata)
VALUES
    ('ICDAS', 'iccms_1', 'Initial Distinct Visual Change in Enamel',
        'Mancha Blanca (ICCMS 1)', 'finding', FALSE,
        jsonb_build_object('group','cariologia','icdas_score',1,'severity','mild')),
    ('ICDAS', 'iccms_3', 'Localized Enamel Breakdown',
        'Caries Superficial (ICCMS 3)', 'finding', FALSE,
        jsonb_build_object('group','cariologia','icdas_score',3,'severity','moderate')),
    ('ICDAS', 'iccms_5', 'Distinct Cavity with Visible Dentine',
        'Caries Dentinaria (ICCMS 5)', 'finding', FALSE,
        jsonb_build_object('group','cariologia','icdas_score',5,'severity','severe')),
    ('ICDAS', 'iccms_6', 'Extensive Distinct Cavity with Visible Dentine',
        'Caries Profunda (ICCMS 6)', 'finding', FALSE,
        jsonb_build_object('group','cariologia','icdas_score',6,'severity','critical'))
ON CONFLICT (code_system, code) DO UPDATE
    SET display    = EXCLUDED.display,
        display_es = EXCLUDED.display_es,
        category   = EXCLUDED.category,
        metadata   = EXCLUDED.metadata,
        updated_at = NOW();

-- ---------------------------------------------------------------------
-- B. Estados macro / preventivos / aparatología
-- ---------------------------------------------------------------------
INSERT INTO edr.ontology_dictionary
    (code_system, code, display, display_es, category, is_billable, metadata)
VALUES
    ('LOCAL', 'sano', 'Healthy preventive baseline',
        'Sano / Preventivo', 'status', FALSE,
        jsonb_build_object('group','preventivo')),
    ('LOCAL', 'ausente', 'Tooth absent',
        'Pieza Ausente', 'status', FALSE,
        jsonb_build_object('group','status','tooth_status','absent_extracted')),
    ('LOCAL', 'extraccion', 'Tooth extraction indicated',
        'Indicación de Extracción', 'finding', TRUE,
        jsonb_build_object('group','planificacion','tooth_status','absent_extracted')),
    ('LOCAL', 'restauracion', 'Pre-existing restoration',
        'Restauración Existente', 'finding', FALSE,
        jsonb_build_object('group','preexistente')),
    ('LOCAL', 'rehabilitacion', 'Prosthetic rehabilitation in place',
        'Rehabilitación Protésica', 'finding', FALSE,
        jsonb_build_object('group','preexistente')),
    ('LOCAL', 'aparato_removible', 'Removable prosthesis carrier',
        'Portador Prótesis Removible', 'finding', FALSE,
        jsonb_build_object('group','aparatologia')),
    ('LOCAL', 'aparato_ortodoncia', 'Orthodontic appliance carrier',
        'Portador Aparato Ortodóntico', 'finding', FALSE,
        jsonb_build_object('group','aparatologia')),
    ('LOCAL', 'aparato_contensor', 'Post-orthodontic retainer carrier',
        'Portador Contensor Post-Orto', 'finding', FALSE,
        jsonb_build_object('group','aparatologia'))
ON CONFLICT (code_system, code) DO UPDATE
    SET display    = EXCLUDED.display,
        display_es = EXCLUDED.display_es,
        category   = EXCLUDED.category,
        metadata   = EXCLUDED.metadata,
        updated_at = NOW();

-- ---------------------------------------------------------------------
-- C. Condiciones periodontales (CAL) y biomecánicas
-- ---------------------------------------------------------------------
INSERT INTO edr.ontology_dictionary
    (code_system, code, display, display_es, category, is_billable, metadata)
VALUES
    ('LOCAL', 'cal_leve', 'Clinical attachment loss mild (1-4mm)',
        'CAL leve/moderada (1-4 mm)', 'finding', FALSE,
        jsonb_build_object('group','periodontal','severity','moderate')),
    ('LOCAL', 'cal_severa', 'Clinical attachment loss severe (>=5mm)',
        'CAL severa (>= 5 mm)', 'finding', FALSE,
        jsonb_build_object('group','periodontal','severity','severe')),
    ('LOCAL', 'fractura', 'Coronal fracture',
        'Fractura Coronal', 'finding', FALSE,
        jsonb_build_object('group','biomecanica','severity','moderate')),
    ('LOCAL', 'movilidad', 'Dental mobility',
        'Movilidad Dental', 'finding', FALSE,
        jsonb_build_object('group','periodontal','severity','moderate'))
ON CONFLICT (code_system, code) DO UPDATE
    SET display    = EXCLUDED.display,
        display_es = EXCLUDED.display_es,
        category   = EXCLUDED.category,
        metadata   = EXCLUDED.metadata,
        updated_at = NOW();

-- ---------------------------------------------------------------------
-- D. Patología pulpar y periapical (AAE)
-- ---------------------------------------------------------------------
INSERT INTO edr.ontology_dictionary
    (code_system, code, display, display_es, category, is_billable, metadata)
VALUES
    ('LOCAL', 'cp-reversible',         'Reversible pulpitis',
        'Pulpitis Reversible', 'finding', FALSE,
        jsonb_build_object('group','endodoncia','severity','mild')),
    ('LOCAL', 'cp-irreversible-sint',  'Symptomatic irreversible pulpitis',
        'Pulpitis Irreversible Sintomática', 'finding', FALSE,
        jsonb_build_object('group','endodoncia','severity','severe')),
    ('LOCAL', 'cp-irreversible-asint', 'Asymptomatic irreversible pulpitis',
        'Pulpitis Irreversible Asintomática', 'finding', FALSE,
        jsonb_build_object('group','endodoncia','severity','moderate')),
    ('LOCAL', 'cp-necrosis',           'Pulp necrosis',
        'Necrosis Pulpar', 'finding', FALSE,
        jsonb_build_object('group','endodoncia','severity','severe')),
    ('LOCAL', 'pre-iniciado',          'Previously initiated endodontic therapy',
        'Endodoncia Previamente Iniciada', 'finding', FALSE,
        jsonb_build_object('group','endodoncia')),
    ('LOCAL', 'perio-apical-sint',     'Symptomatic apical periodontitis',
        'Periodontitis Apical Sintomática', 'finding', FALSE,
        jsonb_build_object('group','periapical','severity','severe')),
    ('LOCAL', 'perio-apical-asint',    'Asymptomatic apical periodontitis',
        'Periodontitis Apical Asintomática', 'finding', FALSE,
        jsonb_build_object('group','periapical','severity','moderate')),
    ('LOCAL', 'absceso-agudo',         'Acute alveolar abscess',
        'Absceso Alveolar Agudo', 'finding', FALSE,
        jsonb_build_object('group','periapical','severity','critical')),
    ('LOCAL', 'absceso-cronico',       'Chronic alveolar abscess',
        'Absceso Alveolar Crónico', 'finding', FALSE,
        jsonb_build_object('group','periapical','severity','severe')),
    ('LOCAL', 'osteitis',              'Condensing osteitis',
        'Osteítis Condensante', 'finding', FALSE,
        jsonb_build_object('group','periapical','severity','moderate'))
ON CONFLICT (code_system, code) DO UPDATE
    SET display    = EXCLUDED.display,
        display_es = EXCLUDED.display_es,
        category   = EXCLUDED.category,
        metadata   = EXCLUDED.metadata,
        updated_at = NOW();

-- ---------------------------------------------------------------------
-- E. Procedimientos / Prestaciones (data-tx en el panel derecho)
--    Prefijo `tx_` para distinguirlos de hallazgos del mismo nombre.
-- ---------------------------------------------------------------------
INSERT INTO edr.ontology_dictionary
    (code_system, code, display, display_es, category, is_billable, metadata)
VALUES
    -- Periodontal
    ('LOCAL', 'tx_destartraje', 'Supragingival scaling and coronal polishing',
        'Destartraje Supragingival y Pulido Coronal', 'procedure', TRUE,
        jsonb_build_object('group','periodontal')),
    ('LOCAL', 'tx_pulido_radicular', 'Root planing',
        'Pulido Radicular', 'procedure', TRUE,
        jsonb_build_object('group','periodontal')),
    ('LOCAL', 'tx_reevaluacion', 'Periodontal reevaluation',
        'Reevaluación Periodontal', 'procedure', FALSE,
        jsonb_build_object('group','periodontal')),
    -- Operatoria
    ('LOCAL', 'tx_resina_simple', 'Composite resin restoration 1 surface',
        'Restauración resina simple (1 cara)', 'procedure', TRUE,
        jsonb_build_object('group','operatoria')),
    ('LOCAL', 'tx_resina_compleja', 'Composite resin restoration 2+ surfaces',
        'Restauración resina compleja (2+ caras)', 'procedure', TRUE,
        jsonb_build_object('group','operatoria')),
    ('LOCAL', 'tx_restauracion_cervical', 'Cervical restoration',
        'Restauración cervical', 'procedure', TRUE,
        jsonb_build_object('group','operatoria')),
    -- Endodoncia
    ('LOCAL', 'tx_endo_convencional', 'Conventional endodontic treatment',
        'Endodoncia convencional', 'procedure', TRUE,
        jsonb_build_object('group','endodoncia')),
    ('LOCAL', 'tx_endo_mecanizada', 'Mechanized endodontic treatment',
        'Endodoncia mecanizada', 'procedure', TRUE,
        jsonb_build_object('group','endodoncia')),
    ('LOCAL', 'tx_trepanacion', 'Pulp chamber trepanation',
        'Trepanación', 'procedure', TRUE,
        jsonb_build_object('group','endodoncia')),
    ('LOCAL', 'tx_recubrimiento_ind', 'Indirect pulp capping',
        'Recubrimiento pulpar indirecto', 'procedure', TRUE,
        jsonb_build_object('group','endodoncia')),
    ('LOCAL', 'tx_recubrimiento_dir', 'Direct pulp capping',
        'Recubrimiento pulpar directo', 'procedure', TRUE,
        jsonb_build_object('group','endodoncia')),
    -- Rehabilitadora
    ('LOCAL', 'tx_incrustacion', 'Inlay/onlay restoration',
        'Incrustación', 'procedure', TRUE,
        jsonb_build_object('group','rehabilitadora')),
    ('LOCAL', 'tx_pfu', 'Single-unit fixed prosthesis',
        'Prótesis fija unitaria', 'procedure', TRUE,
        jsonb_build_object('group','rehabilitadora')),
    ('LOCAL', 'tx_intermediario', 'Intermediate plural fixed prosthesis',
        'Intermediario de prótesis fija plural', 'procedure', TRUE,
        jsonb_build_object('group','rehabilitadora')),
    ('LOCAL', 'tx_implante', 'Dental implant',
        'Implante dental', 'procedure', TRUE,
        jsonb_build_object('group','rehabilitadora')),
    ('LOCAL', 'tx_removible', 'Removable prosthesis fabrication',
        'Prótesis removible', 'procedure', TRUE,
        jsonb_build_object('group','rehabilitadora')),
    -- Exodoncia (cambia el tooth_status macro a absent_extracted)
    ('LOCAL', 'tx_exodoncia_simple', 'Simple tooth extraction',
        'Extracción simple', 'procedure', TRUE,
        jsonb_build_object('group','exodoncia','tooth_status','absent_extracted')),
    ('LOCAL', 'tx_exodoncia_compleja', 'Complex/surgical tooth extraction',
        'Extracción compleja', 'procedure', TRUE,
        jsonb_build_object('group','exodoncia','tooth_status','absent_extracted','severity','severe'))
ON CONFLICT (code_system, code) DO UPDATE
    SET display    = EXCLUDED.display,
        display_es = EXCLUDED.display_es,
        category   = EXCLUDED.category,
        metadata   = EXCLUDED.metadata,
        updated_at = NOW();

-- ---------------------------------------------------------------------
-- F. Helper de lookup rápido por código (cacheable en cliente).
--    El frontend lo invoca una sola vez por sesión para construir
--    un mapa {code: ontology_id} y evitar N+1 al persistir hallazgos.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION edr.fn_ontology_id_by_code(
    p_code         TEXT,
    p_code_system  TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = edr, pg_catalog
AS $$
    SELECT id
      FROM edr.ontology_dictionary
     WHERE code = p_code
       AND (p_code_system IS NULL OR code_system = p_code_system)
       AND deleted_at IS NULL
       AND is_active   = TRUE
     ORDER BY (code_system = 'ICDAS') DESC,  -- prefer ICDAS si existe
              (code_system = 'LOCAL') DESC
     LIMIT 1;
$$;

COMMENT ON FUNCTION edr.fn_ontology_id_by_code(TEXT, TEXT)
    IS 'Resuelve ontology_id a partir del code (LOCAL/ICDAS). Usado por el cliente para mapear data-code/data-tx.';

GRANT EXECUTE ON FUNCTION edr.fn_ontology_id_by_code(TEXT, TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- G. Vista pública del catálogo (sin trigger gin/idx, sólo SELECT).
--    El frontend la consume al abrir el modal para hidratar el mapa.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW edr.v_ontology_catalog AS
SELECT id, code_system, code, display, display_es, category,
       is_billable, metadata
  FROM edr.ontology_dictionary
 WHERE deleted_at IS NULL
   AND is_active   = TRUE;

COMMENT ON VIEW edr.v_ontology_catalog
    IS 'Catálogo activo de ontología clínica para consumo cliente.';

GRANT SELECT ON edr.v_ontology_catalog TO authenticated, service_role;

-- =====================================================================
-- Fin de 04_seed_ontology.sql
-- =====================================================================
