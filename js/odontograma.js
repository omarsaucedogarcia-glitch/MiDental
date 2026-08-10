/* ==========================================================================
   odontograma.js
   MiDental — Motor Clínico Semántico del Odontograma
   --------------------------------------------------------------------------
   Sin dependencias externas. Renderiza SVG nativo, gestiona estado del
   pincel clínico activo (panel izquierdo) y mantiene un historial textual
   bidireccional con el panel derecho de Historial Clínico.
   --------------------------------------------------------------------------
   Nomenclatura usada:
     - Notación FDI (ISO 3950): 11..18, 21..28, 31..38, 41..48.
     - 5 superficies por pieza: V (Vestibular), P (Palatina) o L (Lingual),
       M (Mesial), D (Distal), O (Oclusal) o I (Incisal).
     - Antrales/anteriores (posiciones 1-3) usan Incisal; posteriores (4-8)
       usan Oclusal.
   ========================================================================== */

(function () {
    'use strict';

    /* ----------------------------------------------------------------------
       1. Constantes geométricas y de notación
       ---------------------------------------------------------------------- */
    const SVG_NS         = 'http://www.w3.org/2000/svg';
    const TOOTH_W        = 56;   // ancho de cada pieza en unidades de viewBox
    const TOOTH_H        = 86;   // alto de cada pieza
    const TOOTH_GAP      = 4;    // separación horizontal entre piezas
    const MIDLINE_GAP    = 22;   // separación extra a la altura de la línea media
    const MARGIN_X       = 12;
    const ROW_UPPER_Y    = 90;   // Y del borde superior de la fila maxilar
    const ROW_LOWER_Y    = 326;  // Y del borde superior de la fila mandibular
    const LABEL_UPPER_Y  = 80;   // Y de los rótulos FDI fila maxilar
    const LABEL_LOWER_Y  = 432;  // Y de los rótulos FDI fila mandibular

    // Coordenadas del rectángulo interno (superficie oclusal/incisal).
    // Ratios elegidos para que los 4 trapecios externos tengan masas similares.
    const IX1 = 15;   // x interno izquierdo
    const IY1 = 22;   // y interno superior
    const IX2 = 41;   // x interno derecho
    const IY2 = 64;   // y interno inferior

    const SURFACE_LABEL = {
        V: 'Vestibular',
        P: 'Palatina',
        L: 'Lingual',
        M: 'Mesial',
        D: 'Distal',
        O: 'Oclusal',
        I: 'Incisal'
    };

    // Etiquetas de estado clínico mostradas en el timeline.
    const STATE_LABEL = {
        'existing':   'Existente (sin hallazgo)',
        'active':     'Caries / Patología activa',
        'planned':    'Tratamiento planificado',
        'completed':  'Tratamiento completado',
        'finalized':  'Tratamiento finalizado',
        'control-ok': 'Control exitoso',
        'review':     'Revisión indicada',
        'historic':   'Registro histórico'
    };

    // Acción narrativa: cómo se redacta el registro en el historial.
    const STATE_NARRATIVE = {
        'existing':   'Superficie marcada como existente sin hallazgo.',
        'active':     'Patología activa detectada.',
        'planned':    'Procedimiento planificado.',
        'completed':  'Procedimiento ejecutado y verificado.',
        'finalized':  'Tratamiento finalizado clínicamente.',
        'control-ok': 'Superficie estable en control de mantención.',
        'review':     'Requiere revisión clínica.',
        'historic':   'Movido a registro histórico.'
    };

    const SEVERITY_LABEL = {
        'none':     'sin gradación',
        'mild':     'leve',
        'moderate': 'moderada',
        'severe':   'severa',
        'critical': 'crítica'
    };

    /* ----------------------------------------------------------------------
       2. Construcción del catálogo de piezas (FDI) — permanente y temporal
          Permanente (8 por cuadrante):
              [18 17 16 15 14 13 12 11 | 21 22 23 24 25 26 27 28]   ← maxilar
              [48 47 46 45 44 43 42 41 | 31 32 33 34 35 36 37 38]   ← mandibular
          Temporal (5 por cuadrante):
              [55 54 53 52 51 | 61 62 63 64 65]   ← maxilar
              [85 84 83 82 81 | 71 72 73 74 75]   ← mandibular
       ---------------------------------------------------------------------- */
    function buildToothCatalog(dentition) {
        const list = [];
        if (dentition === 'primary') {
            const Q5 = ['55', '54', '53', '52', '51'];
            const Q6 = ['61', '62', '63', '64', '65'];
            const Q8 = ['85', '84', '83', '82', '81'];
            const Q7 = ['71', '72', '73', '74', '75'];
            Q5.forEach((fdi, i) => list.push({ fdi, quadrant: 5, position: 5 - i, row: 0, col: i }));
            Q6.forEach((fdi, i) => list.push({ fdi, quadrant: 6, position: i + 1, row: 0, col: i + 5 }));
            Q8.forEach((fdi, i) => list.push({ fdi, quadrant: 8, position: 5 - i, row: 1, col: i }));
            Q7.forEach((fdi, i) => list.push({ fdi, quadrant: 7, position: i + 1, row: 1, col: i + 5 }));
            return list;
        }
        // Permanente (default)
        const Q1 = ['18', '17', '16', '15', '14', '13', '12', '11'];
        const Q2 = ['21', '22', '23', '24', '25', '26', '27', '28'];
        const Q4 = ['48', '47', '46', '45', '44', '43', '42', '41'];
        const Q3 = ['31', '32', '33', '34', '35', '36', '37', '38'];
        Q1.forEach((fdi, i) => list.push({ fdi, quadrant: 1, position: 8 - i, row: 0, col: i }));
        Q2.forEach((fdi, i) => list.push({ fdi, quadrant: 2, position: i + 1, row: 0, col: i + 8 }));
        Q4.forEach((fdi, i) => list.push({ fdi, quadrant: 4, position: 8 - i, row: 1, col: i }));
        Q3.forEach((fdi, i) => list.push({ fdi, quadrant: 3, position: i + 1, row: 1, col: i + 8 }));
        return list;
    }

    // Columna a partir de la cual se aplica el MIDLINE_GAP (depende de
    // la dentición: 8 para permanente, 5 para temporal).
    function midlineColFor(dentition) {
        return dentition === 'primary' ? 5 : 8;
    }

    /* ----------------------------------------------------------------------
       3. Helpers de geometría
       ---------------------------------------------------------------------- */
    function isAnterior(position) {
        return position >= 1 && position <= 3;   // incisivos central, lateral y canino
    }

    function colToX(col, midlineCol) {
        let x = MARGIN_X + col * (TOOTH_W + TOOTH_GAP);
        const mc = (typeof midlineCol === 'number') ? midlineCol : 8;
        if (col >= mc) x += MIDLINE_GAP;     // espacio extra al cruzar la línea media
        return x;
    }

    function rowToY(row) {
        return row === 0 ? ROW_UPPER_Y : ROW_LOWER_Y;
    }

    /**
     * Mapea las 5 zonas físicas (top/right/bottom/left/center) del diente al
     * código de superficie semántico según el cuadrante y la posición.
     *  - Maxilar:    top=V, bottom=P
     *  - Mandibular: top=L, bottom=V
     *  - Mesial apunta hacia la línea media: Q1/Q4 → derecha; Q2/Q3 → izquierda.
     *  - Centro: Anteriores=I, Posteriores=O.
     */
    function surfaceMap(quadrant, position) {
        // Maxilar: cuadrantes 1, 2 (permanente) + 5, 6 (temporal)
        const isUpper = (quadrant === 1 || quadrant === 2 || quadrant === 5 || quadrant === 6);
        // Mesial a la derecha: cuadrantes 1, 4 (perm) + 5, 8 (temp)
        const mesialOnRight = (quadrant === 1 || quadrant === 4 || quadrant === 5 || quadrant === 8);
        return {
            top:    isUpper        ? 'V' : 'L',
            bottom: isUpper        ? 'P' : 'V',
            right:  mesialOnRight  ? 'M' : 'D',
            left:   mesialOnRight  ? 'D' : 'M',
            center: isAnterior(position) ? 'I' : 'O'
        };
    }

    /**
     * Coordenadas (en sistema local del diente, 0..56 × 0..86) de los
     * 5 polígonos. Tilan toda la superficie sin solapamiento ni huecos.
     */
    function toothPolygons() {
        const w = TOOTH_W, h = TOOTH_H;
        return {
            top:    `0,0 ${w},0 ${IX2},${IY1} ${IX1},${IY1}`,
            right:  `${w},0 ${w},${h} ${IX2},${IY2} ${IX2},${IY1}`,
            bottom: `${w},${h} 0,${h} ${IX1},${IY2} ${IX2},${IY2}`,
            left:   `0,${h} 0,0 ${IX1},${IY1} ${IX1},${IY2}`,
            center: `${IX1},${IY1} ${IX2},${IY1} ${IX2},${IY2} ${IX1},${IY2}`
        };
    }

    /* ----------------------------------------------------------------------
       4. Helpers DOM
       ---------------------------------------------------------------------- */
    function svgEl(tag, attrs) {
        const el = document.createElementNS(SVG_NS, tag);
        if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
        return el;
    }

    function htmlEl(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text != null) el.textContent = text;
        return el;
    }

    /* ----------------------------------------------------------------------
       5. Estado del motor
       ---------------------------------------------------------------------- */
    const ALL_SURFACE_STATES = ['active', 'planned', 'completed', 'finalized', 'control-ok', 'review', 'historic'];

    const engine = {
        rendered:        false,
        dentition:       'permanent',   // 'permanent' | 'primary'
        teeth:           buildToothCatalog('permanent'),
        activeState:     'existing',    // pincel clínico activo
        activeSeverity:  'none',
        activeCode:      '',             // data-code del pincel izquierdo (ej. iccms_5, cal_severa)
        activeLabel:     '',             // data-label legible (ej. "Caries Dentinaria")
        activeTxCode:    '',             // data-tx del panel derecho cuando se aplica un tratamiento
        activeTxLabel:   '',             // texto del botón de tratamiento (ej. "Restauración resina Simple (1 cara)")
        selectedFDI:     null,           // pieza actualmente seleccionada
        timelineFilter:  'all',
        historialFilter: 'all',          // all | pendiente | planificado | finalizado
        events:          [],             // log inmutable de hallazgos en sesión
        // índice rápido: fdi+surface → último evento aplicado (para deshacer / mostrar)
        surfaceLatest:   new Map(),
        autoIncrement:   1
    };

    /* ----------------------------------------------------------------------
       6. Renderizado del odontograma
       ---------------------------------------------------------------------- */
    function renderOdontogram() {
        const svg     = document.getElementById('odontogramaSVG');
        const layerA  = document.getElementById('odnLayerAnatomical');
        const placeholder = document.getElementById('odnPlaceholder');
        if (!svg || !layerA) return;

        // Limpieza previa (incluye marcadores custom como X de extracción)
        while (layerA.firstChild) layerA.removeChild(layerA.firstChild);

        // Re-construimos catálogo según dentición vigente (permite alternar)
        engine.teeth = buildToothCatalog(engine.dentition);
        const midlineCol = midlineColFor(engine.dentition);

        const polys = toothPolygons();

        engine.teeth.forEach(tooth => {
            const x  = colToX(tooth.col, midlineCol);
            const y  = rowToY(tooth.row);
            const sm = surfaceMap(tooth.quadrant, tooth.position);

            const g = svgEl('g', {
                'class':         'odn-tooth',
                'data-fdi':      tooth.fdi,
                'data-quadrant': tooth.quadrant,
                'data-position': tooth.position,
                'data-state':    'existing',
                'transform':     `translate(${x},${y})`
            });

            // Construcción de las 5 superficies como polígonos clicables
            const surfaceDefs = [
                { zone: 'top',    points: polys.top,    code: sm.top    },
                { zone: 'right',  points: polys.right,  code: sm.right  },
                { zone: 'bottom', points: polys.bottom, code: sm.bottom },
                { zone: 'left',   points: polys.left,   code: sm.left   },
                { zone: 'center', points: polys.center, code: sm.center }
            ];

            surfaceDefs.forEach(def => {
                const poly = svgEl('polygon', {
                    'class':            'odn-surface',
                    'points':           def.points,
                    'data-surface':     def.code,
                    'data-zone':        def.zone,
                    'data-fdi':         tooth.fdi
                });
                poly.addEventListener('click', onSurfaceClick);
                g.appendChild(poly);
            });

            // Rótulo FDI (formato cuadrante.posición — ej. 1.4)
            const labelY = (tooth.row === 0) ? (LABEL_UPPER_Y - y) : (LABEL_LOWER_Y - y);
            const label  = svgEl('text', {
                'class':       'odn-tooth__label',
                'x':           TOOTH_W / 2,
                'y':           labelY
            });
            label.textContent = `${tooth.quadrant}.${tooth.position}`;
            g.appendChild(label);

            // Click sobre el rótulo: seleccionar pieza sin pintar.
            label.style.cursor = 'pointer';
            label.addEventListener('click', (e) => {
                e.stopPropagation();
                selectTooth(tooth.fdi);
            });

            layerA.appendChild(g);
        });

        // Ocultar placeholder cuando ya hay piezas
        if (placeholder) placeholder.classList.add('odn-hidden');

        // Conteo en capa anatómica
        updateLayerCount('anatomical', engine.teeth.length);
        engine.rendered = true;
    }

    /* ----------------------------------------------------------------------
       7. Interactividad: click sobre superficies
       ---------------------------------------------------------------------- */
    function onSurfaceClick(e) {
        const poly      = e.currentTarget;
        const fdi       = poly.getAttribute('data-fdi');
        const surface   = poly.getAttribute('data-surface');

        // Determinar scope del botón activo en panel izquierdo
        const activeFinding = document.querySelector('.odn-finding-btn.odn-active');
        const activeTreatment = document.querySelector('.odn-treatment-btn.odn-active');
        const scope = activeFinding ? (activeFinding.getAttribute('data-scope') || 'surface') : 'surface';
        const code = activeFinding ? (activeFinding.getAttribute('data-code') || '') : '';

        const state     = engine.activeState;
        const severity  = engine.activeSeverity;
        const meta = {
            code:     code || engine.activeCode || '',
            display:  engine.activeLabel || (activeFinding ? activeFinding.getAttribute('data-label') : '') || '',
            txCode:   activeTreatment ? (activeTreatment.getAttribute('data-tx') || '') : '',
            txLabel:  activeTreatment ? (activeTreatment.textContent.trim()) : ''
        };

        if (scope === 'whole-tooth') {
            // Aplicar a todas las superficies
            const polys = document.querySelectorAll(`polygon.odn-surface[data-fdi="${fdi}"]`);
            polys.forEach(p => {
                applyStateToSurface(p, state);
                registerEvent({
                    fdi,
                    surface: p.getAttribute('data-surface'),
                    state, severity, surfaceEl: p, ...meta
                });
            });
            if (code === 'extraccion') {
                drawExtractionMarker(fdi);
            } else if (code === 'ausente') {
                polys.forEach(p => p.style.fill = '#0f172a'); // Negro
            }
        } else {
            applyStateToSurface(poly, state);
            registerEvent({ fdi, surface, state, severity, surfaceEl: poly, ...meta });
        }
        selectTooth(fdi);
    }

    /**
     * Aplica el estado clínico a un <polygon> de superficie y actualiza la
     * pieza completa con un data-state agregado para reglas CSS.
     */

    /**
     * Dibuja una 'X' roja de indicación de extracción sobre la pieza.
     */
    function drawExtractionMarker(fdi) {
        const g = document.querySelector(`g.odn-tooth[data-fdi="${fdi}"]`);
        if (!g) return;
        g.querySelectorAll('.odn-custom-marker').forEach(el => el.remove());
        const markerGroup = svgEl('g', { 'class': 'odn-custom-marker' });
        const line1 = svgEl('line', {
            'x1': 5, 'y1': 10, 'x2': TOOTH_W - 5, 'y2': TOOTH_H - 10,
            'stroke': '#dc2626', 'stroke-width': '4', 'stroke-linecap': 'round'
        });
        const line2 = svgEl('line', {
            'x1': TOOTH_W - 5, 'y1': 10, 'x2': 5, 'y2': TOOTH_H - 10,
            'stroke': '#dc2626', 'stroke-width': '4', 'stroke-linecap': 'round'
        });
        markerGroup.appendChild(line1);
        markerGroup.appendChild(line2);
        g.appendChild(markerGroup);
    }

    function applyStateToSurface(poly, state) {
        // Borramos todas las clases de estado posibles, dejamos sólo la nueva.
        ALL_SURFACE_STATES.forEach(s => poly.classList.remove('odn-' + s));
        if (state && state !== 'existing') {
            poly.classList.add('odn-' + state);
        }

        // Colores FDI estrictos
        if (state === 'active' || state === 'review') {
            poly.style.fill = '#dc2626'; // Rojo  - Patología activa
        } else if (state === 'completed' || state === 'control-ok') {
            poly.style.fill = '#1e3a8a'; // Azul  - Preexistente / restauración previa
        } else if (state === 'finalized') {
            poly.style.fill = '#16a34a'; // Verde - Tratamiento finalizado en esta sesión
        } else if (state === 'planned') {
            poly.style.fill = '#eab308'; // Ámbar - Planificado
        } else if (state === 'historic') {
            poly.style.fill = '#0f172a'; // Negro - Ausente / histórico
        } else {
            poly.style.fill = '';
        }

        // Actualizamos el data-state del diente padre con el estado dominante.
        const toothG = poly.parentNode;
        if (toothG && toothG.classList.contains('odn-tooth')) {
            toothG.setAttribute('data-state', dominantToothState(toothG));
        }
    }

    /**
     * Calcula el estado dominante de la pieza en función de las superficies.
     * Prioridad: active > planned > review > completed > control-ok > historic > existing.
     */
    function dominantToothState(toothG) {
        const priority = ['active', 'planned', 'review', 'finalized', 'completed', 'control-ok', 'historic'];
        const present = new Set();
        toothG.querySelectorAll('.odn-surface').forEach(s => {
            ALL_SURFACE_STATES.forEach(st => {
                if (s.classList.contains('odn-' + st)) present.add(st);
            });
        });
        for (const p of priority) if (present.has(p)) return p;
        return 'existing';
    }

    /* ----------------------------------------------------------------------
       8. Registro inmutable de eventos clínicos + timeline
       ---------------------------------------------------------------------- */
    function registerEvent({ fdi, surface, state, severity, surfaceEl, code, display, txCode, txLabel }) {
        const now = new Date();
        const evt = {
            id:        engine.autoIncrement++,
            timestamp: now,
            fdi,
            surface,
            state,
            severity,
            code:      code    || '',
            display:   display || '',
            txCode:    txCode  || '',
            txLabel:   txLabel || '',
            label:     buildEventLabel(fdi, surface, state, severity, display, txLabel),
            narrative: STATE_NARRATIVE[state] || STATE_NARRATIVE.existing
        };
        engine.events.unshift(evt);   // los más recientes primero

        // índice por superficie
        engine.surfaceLatest.set(`${fdi}|${surface}`, evt);

        // Actualizamos contadores de capa por estado
        recomputeLayerCounters();

        // Refrescamos el timeline en el panel derecho
        renderTimeline();

        // Actualizamos el historial agrupado por pieza
        renderGroupedHistorial();

        // Notificamos al resto del sistema (otras capas del front pueden engancharse).
        document.dispatchEvent(new CustomEvent('odontograma:event-registered', { detail: evt }));
    }

    /* ----------------------------------------------------------------------
       8.b Motor de agrupación inteligente por pieza
       ----------------------------------------------------------------------
       Reduce el log lineal de eventos a una vista consolidada por diente:
         - una condición primaria  (la última active/review registrada)
         - un  manejo  terapéutico (el último planned/completed registrado)
         - un set de superficies tocadas → notación compuesta (ej. MOD)
         - un nombre de prestación inferido (resina simple ↔ compleja)
       ---------------------------------------------------------------------- */

    // Códigos clínicos que califican como "caries restaurable por superficie"
    const CARIES_CODES = new Set(['iccms_3', 'iccms_5', 'iccms_6']);
    // Orden canónico de superficies en la notación restauradora
    const SURFACE_ORDER = ['M', 'O', 'I', 'D', 'V', 'P', 'L'];
    // Tratamientos de boca completa: se inyectan globalmente sin requerir
    // clic sobre una pieza específica.
    const GLOBAL_TREATMENTS = new Set(['destartraje', 'pulido_radicular', 'reevaluacion']);
    // Sentinel FDI usado para representar la "boca completa" en el log.
    const GENERAL_FDI = 'GENERAL';

    function concatSurfaces(surfaceSet) {
        return SURFACE_ORDER.filter(s => surfaceSet.has(s)).join('');
    }

    /**
     * Dado un grupo de eventos por pieza, infiere la prestación canónica.
     * Si hay tratamiento explícito (data-tx), se respeta — pero el nombre se
     * compone con las caras de las caries observadas en la misma pieza.
     */
    function inferirPrestacion(group) {
        const carieSurfaces = new Set();
        group.conditions.forEach(c => {
            if (CARIES_CODES.has(c.code) && c.surface) carieSurfaces.add(c.surface);
        });
        const compositeFaces = concatSurfaces(carieSurfaces);

        // Sin tratamiento marcado y con caries → sugerencia automática
        if (!group.treatment) {
            if (compositeFaces.length >= 2) {
                return { nombre: `Restauración en resina compuesta compleja ${compositeFaces}`, caras: compositeFaces };
            }
            if (compositeFaces.length === 1) {
                return { nombre: `Restauración en resina compuesta simple (${compositeFaces})`, caras: compositeFaces };
            }
            return null;
        }

        const tx = group.treatment;
        // Resina simple → compleja cuando el dentista marcó múltiples caras de caries
        if (tx.txCode === 'resina_simple' || tx.txCode === 'resina_compleja') {
            if (compositeFaces.length >= 2) {
                return { nombre: `Restauración en resina compuesta compleja ${compositeFaces}`, caras: compositeFaces };
            }
            if (compositeFaces.length === 1) {
                return { nombre: `Restauración en resina compuesta simple (${compositeFaces})`, caras: compositeFaces };
            }
            return { nombre: tx.txLabel, caras: '' };
        }
        // Otros tratamientos (endo, prótesis, etc.) se respetan tal cual.
        return { nombre: tx.txLabel, caras: compositeFaces };
    }

    /**
     * Inserta una fila en la tabla de presupuesto del paciente (#tbodyPresupuesto).
     * Si la primera fila está vacía, la rellena; si no, agrega una nueva.
     */
    function enviarFilaAPresupuesto(piezaFmt, diagnostico, prestacion, btnEl) {
        const tbody = document.getElementById('tbodyPresupuesto');
        if (!tbody) {
            toast('La tabla de presupuesto no está disponible en esta vista.');
            return;
        }
        const filas = tbody.querySelectorAll('tr');
        let insertada = false;
        if (filas.length === 1) {
            const r = filas[0];
            const di = r.querySelector('.input-diente');
            const dg = r.querySelector('.input-diag');
            const tr = r.querySelector('.input-tratamiento');
            if (di && dg && tr && !di.value && !dg.value && !tr.value) {
                di.value = piezaFmt;
                dg.value = diagnostico;
                tr.value = prestacion;
                insertada = true;
            }
        }
        if (!insertada) {
            const safe = (s) => String(s == null ? '' : s).replace(/"/g, '&quot;');
            tbody.insertAdjacentHTML('beforeend', `
                <tr>
                    <td><input type="text" class="input-diente" value="${safe(piezaFmt)}" placeholder="Ej: 1.4"></td>
                    <td><input type="text" class="input-diag" value="${safe(diagnostico)}" placeholder="Diagnóstico"></td>
                    <td><input type="text" class="input-tratamiento" value="${safe(prestacion)}" placeholder="Prestación"></td>
                    <td><input type="number" class="input-ref" placeholder="0" oninput="calcularFila(this)"></td>
                    <td><input type="number" class="input-desc" placeholder="0" oninput="calcularFila(this)"></td>
                    <td><input type="text" class="ref-val input-total input-readonly" placeholder="0" readonly></td>
                </tr>
            `);
        }
        if (btnEl) {
            btnEl.disabled = true;
            btnEl.textContent = '✓ En presupuesto';
            btnEl.style.background = '#10b981';
            btnEl.style.color = 'white';
            btnEl.style.borderColor = '#10b981';
        }
        toast(`Pieza ${piezaFmt} agregada al presupuesto.`);
    }

    /**
     * Marca como "finalizado" todos los eventos de una pieza y repinta sus
     * superficies en verde clínico. Crea además un evento marcador del cierre.
     */
    function finalizarTratamientoPieza(fdi) {
        if (!fdi) return;
        let count = 0;
        engine.events.forEach(e => {
            if (e.fdi === fdi && (e.state === 'planned' || e.state === 'active' || e.state === 'review')) {
                e.state = 'finalized';
                count++;
            }
        });
        if (count === 0) {
            toast(`Pieza ${fdi}: no hay eventos activos/planificados para finalizar.`);
            return;
        }
        // Repintar superficies en verde
        if (fdi !== GENERAL_FDI) {
            const polys = document.querySelectorAll(`polygon.odn-surface[data-fdi="${fdi}"]`);
            polys.forEach(p => {
                // Sólo repintar caras que estuvieron involucradas (rojo/ámbar)
                if (p.classList.contains('odn-active') || p.classList.contains('odn-planned')
                    || p.classList.contains('odn-review')) {
                    applyStateToSurface(p, 'finalized');
                }
            });
        }
        recomputeLayerCounters();
        renderTimeline();
        renderGroupedHistorial();
        toast(`Pieza ${fdi}: ${count} evento(s) marcado(s) como finalizado(s).`);
    }

    /**
     * Determina si un grupo de pieza pasa el filtro activo del historial.
     * Mapeo:
     *   - all         : todos
     *   - pendiente   : tiene condición pero no tratamiento
     *   - planificado : tiene tratamiento, no finalizado
     *   - finalizado  : tiene al menos un evento en state='finalized'
     */
    function grupoPasaFiltro(g, filter) {
        if (!filter || filter === 'all') return true;
        const tieneFinalizado = g.rawEvents.some(e => e.state === 'finalized');
        if (filter === 'finalizado')  return tieneFinalizado;
        if (filter === 'planificado') return !!g.treatment && !tieneFinalizado;
        if (filter === 'pendiente')   return !!g.primaryCondition && !g.treatment && !tieneFinalizado;
        return true;
    }

    /**
     * Agrupación visual en memoria y renderizado de hallazgos consolidados por pieza.
     * Una sola fila por diente con: caras tocadas (notación compuesta), condición
     * primaria, manejo terapéutico y botón "Llevar a presupuesto".
     */
    function renderGroupedHistorial() {
        const list = document.getElementById('odnPlanList');
        const chip = document.getElementById('odnHistorialChip');
        if (!list) return;

        if (engine.events.length === 0) {
            list.innerHTML = `
                <div class="odn-plan-empty" id="odnPlanEmpty">
                    <span class="material-symbols-outlined" aria-hidden="true" style="vertical-align:middle;">touch_app</span>
                    Aún no hay hallazgos registrados. Selecciona una condición y marca una superficie dental.
                </div>
            `;
            list.setAttribute('data-empty', 'true');
            if (chip) chip.textContent = '0 hallazgos';
            return;
        }

        // events viene ordenado newest-first; recorremos en reversa para que el
        // "último" registrado quede como condición/tratamiento PRIMARIO.
        const grouped = {};
        for (let i = engine.events.length - 1; i >= 0; i--) {
            const evt = engine.events[i];
            if (!grouped[evt.fdi]) {
                grouped[evt.fdi] = {
                    fdi: evt.fdi,
                    surfaces: new Set(),     // todas las caras tocadas
                    conditions: [],          // {code, display, surface}
                    treatment: null,         // {txCode, txLabel} primario
                    primaryCondition: null,  // {code, display} primaria
                    rawEvents: []            // log lineal de eventos de esta pieza
                };
            }
            const g = grouped[evt.fdi];
            g.rawEvents.push(evt);
            if (evt.surface) g.surfaces.add(evt.surface);

            if (evt.state === 'active' || evt.state === 'review') {
                const cond = { code: evt.code, display: evt.display || STATE_LABEL[evt.state], surface: evt.surface };
                g.conditions.push(cond);
                g.primaryCondition = cond;   // el último gana
            } else if ((evt.state === 'planned' || evt.state === 'completed' || evt.state === 'finalized') && evt.txCode) {
                g.treatment = { txCode: evt.txCode, txLabel: evt.txLabel };
            }
        }

        list.innerHTML = '';
        list.setAttribute('data-empty', 'false');
        if (chip) chip.textContent = `${Object.keys(grouped).length} pieza(s) con registros`;

        // Filtro activo del historial (configurable desde los botones del header).
        const filtroHistorial = engine.historialFilter || 'all';
        const ordered = Object.values(grouped)
            .filter(g => grupoPasaFiltro(g, filtroHistorial))
            .sort((a, b) => {
                // GENERAL siempre primero (más visible).
                if (a.fdi === GENERAL_FDI) return -1;
                if (b.fdi === GENERAL_FDI) return 1;
                return a.fdi.localeCompare(b.fdi);
            });

        if (ordered.length === 0) {
            list.innerHTML = `<div class="odn-plan-empty" style="padding:16px;text-align:center;color:#64748b;font-size:0.85rem;">Sin registros para el filtro seleccionado.</div>`;
            return;
        }

        ordered.forEach(g => {
            const isGeneral = g.fdi === GENERAL_FDI;
            const piezaFmt = isGeneral ? 'Boca completa' : `${g.fdi.charAt(0)}.${g.fdi.charAt(1)}`;
            const surfStr  = (!isGeneral && g.surfaces.size > 0) ? concatSurfaces(g.surfaces) : '';
            const inferida = inferirPrestacion(g);
            const diagText = g.primaryCondition ? g.primaryCondition.display : (isGeneral ? 'Tratamiento periodontal general' : 'Sin diagnóstico primario');
            const trtText  = inferida ? inferida.nombre : 'Sin manejo terapéutico';
            const accent   = isGeneral ? '#0d9488' : 'var(--odn-accent-deep)';

            const row = document.createElement('div');
            row.className = 'odn-grouped-row' + (isGeneral ? ' odn-grouped-row--general' : '');
            row.setAttribute('data-fdi', g.fdi);
            row.style.cssText = `padding:10px 14px;background:white;border-bottom:1px solid var(--odn-border);display:flex;justify-content:space-between;align-items:center;gap:12px;border-left:4px solid ${accent};margin-bottom:4px;border-radius:var(--odn-radius-sm);`;

            const left = document.createElement('div');
            left.style.fontSize = '0.9rem';
            left.style.flex = '1';
            const headLabel = isGeneral ? piezaFmt : `Pieza ${piezaFmt}${surfStr ? ' ('+surfStr+')' : ''}`;
            left.innerHTML =
                `<strong style="color:${accent};">${headLabel}:</strong> ` +
                `<span style="color:#ef4444;font-weight:600;">${diagText}</span> ` +
                `<span style="color:#64748b;">→</span> ` +
                `<span style="color:#f59e0b;font-weight:600;">${trtText}</span>`;

            const actions = document.createElement('div');
            actions.style.cssText = 'display:flex;gap:6px;align-items:center;';

            const yaFinalizado = g.rawEvents.some(e => e.state === 'finalized');

            const btnPres = document.createElement('button');
            btnPres.type = 'button';
            btnPres.className = 'odn-budget-btn';
            btnPres.textContent = '+ Presupuesto';
            btnPres.disabled = !inferida;
            btnPres.style.cssText = 'padding:6px 12px;border:1px solid var(--odn-border);border-radius:var(--odn-radius-sm);background:#f8fafc;color:var(--odn-text);font-size:0.8rem;font-weight:600;cursor:pointer;white-space:nowrap;';
            btnPres.addEventListener('click', () => {
                if (!inferida) return;
                enviarFilaAPresupuesto(piezaFmt, diagText, inferida.nombre, btnPres);
            });

            const btnFin = document.createElement('button');
            btnFin.type = 'button';
            btnFin.className = 'odn-finalize-btn';
            btnFin.textContent = yaFinalizado ? '✓ Finalizado' : '✓ Finalizar';
            btnFin.disabled = yaFinalizado;
            const bgFin = yaFinalizado ? '#16a34a' : '#dcfce7';
            const fgFin = yaFinalizado ? 'white' : '#166534';
            btnFin.style.cssText = `padding:6px 12px;border:1px solid #16a34a;border-radius:var(--odn-radius-sm);background:${bgFin};color:${fgFin};font-size:0.8rem;font-weight:700;cursor:pointer;white-space:nowrap;`;
            btnFin.addEventListener('click', () => {
                if (yaFinalizado) return;
                finalizarTratamientoPieza(g.fdi);
            });

            actions.appendChild(btnPres);
            actions.appendChild(btnFin);
            row.appendChild(left);
            row.appendChild(actions);
            list.appendChild(row);
        });
    }

    /**
     * Construye la descripción canónica del evento.
     * Ej.: "Pieza 1.4, Superficie Oclusal (O): Caries / Patología activa — severidad moderada."
     */
    function buildEventLabel(fdi, surface, state, severity, display, txLabel) {
        const piezaFmt    = `${fdi.charAt(0)}.${fdi.charAt(1)}`;
        const surfaceFull = SURFACE_LABEL[surface] || surface;
        const severityStr = (severity && severity !== 'none')
            ? ` — severidad ${SEVERITY_LABEL[severity] || severity}.`
            : '.';
        // Cuando se aplica un tratamiento explícito desde el panel derecho, lo destacamos.
        if (txLabel) {
            return `Pieza ${piezaFmt}, Superficie ${surfaceFull} (${surface}): ${txLabel}${severityStr}`;
        }
        // Cuando hay un código clínico marcado en el panel izquierdo, usamos su label legible.
        if (display) {
            return `Pieza ${piezaFmt}, Superficie ${surfaceFull} (${surface}): ${display}${severityStr}`;
        }
        const stateFull = STATE_LABEL[state] || state;
        return `Pieza ${piezaFmt}, Superficie ${surfaceFull} (${surface}): ${stateFull}${severityStr}`;
    }

    function renderTimeline() {
        const rail  = document.getElementById('odontogramaTimelineRail');
        const empty = document.getElementById('odnTimelineEmpty');
        const chip  = document.getElementById('odnTimelineChip');
        if (!rail) return;

        // Filtros aplicados:
        const fdiFilter   = engine.selectedFDI;       // si hay pieza seleccionada, sólo esa
        const stateFilter = engine.timelineFilter;    // 'all' | 'active' | 'planned' | 'completed' | 'historic'

        const events = engine.events.filter(e => {
            if (fdiFilter && e.fdi !== fdiFilter) return false;
            if (stateFilter && stateFilter !== 'all' && e.state !== stateFilter) return false;
            return true;
        });

        // Chip lateral
        if (chip) {
            if (fdiFilter) {
                chip.textContent = `Pieza ${fdiFilter.charAt(0)}.${fdiFilter.charAt(1)}`;
                chip.setAttribute('data-empty', 'false');
            } else {
                chip.textContent = `${engine.events.length} evento(s)`;
                chip.setAttribute('data-empty', engine.events.length === 0 ? 'true' : 'false');
            }
        }

        // Limpieza dejando el placeholder
        rail.innerHTML = '';

        if (events.length === 0) {
            const e = htmlEl('div', 'odn-timeline__empty');
            const icon = htmlEl('span', 'material-symbols-outlined', fdiFilter ? 'check_circle' : 'touch_app');
            icon.setAttribute('aria-hidden', 'true');
            e.appendChild(icon);
            e.appendChild(document.createTextNode(
                fdiFilter
                    ? `Sin registros clínicos para la pieza ${fdiFilter.charAt(0)}.${fdiFilter.charAt(1)} aún.`
                    : 'Selecciona una pieza dental en el lienzo para ver su historial clínico completo.'
            ));
            rail.appendChild(e);
            return;
        }

        events.forEach(evt => rail.appendChild(buildEventCard(evt)));
    }

    function buildEventCard(evt) {
        const card = htmlEl('div', 'odn-event');
        card.setAttribute('data-state', evt.state);
        card.setAttribute('data-fdi',   evt.fdi);
        card.setAttribute('data-id',    String(evt.id));

        // Cabecera
        const head = htmlEl('div', 'odn-event__head');
        const piezaFmt = `${evt.fdi.charAt(0)}.${evt.fdi.charAt(1)}`;
        head.appendChild(htmlEl('span', 'odn-event__piece', `Pieza ${piezaFmt}`));
        head.appendChild(htmlEl('span', 'odn-event__date',  formatTime(evt.timestamp)));
        card.appendChild(head);

        // Título
        card.appendChild(htmlEl('p', 'odn-event__title',
            `${SURFACE_LABEL[evt.surface] || evt.surface} (${evt.surface}) — ${STATE_LABEL[evt.state]}`));

        // Meta: severidad + narrativa
        const meta = htmlEl('div', 'odn-event__meta');
        if (evt.severity && evt.severity !== 'none') {
            meta.appendChild(htmlEl('span', 'odn-event__tag', `Severidad ${SEVERITY_LABEL[evt.severity]}`));
        }
        meta.appendChild(document.createTextNode(' ' + evt.narrative));
        card.appendChild(meta);

        // Click: enfocar la pieza/superficie correspondiente
        card.addEventListener('click', () => {
            selectTooth(evt.fdi);
            flashSurface(evt.fdi, evt.surface);
        });

        return card;
    }

    function formatTime(d) {
        const pad = n => String(n).padStart(2, '0');
        return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function flashSurface(fdi, surface) {
        const poly = document.querySelector(`polygon.odn-surface[data-fdi="${fdi}"][data-surface="${surface}"]`);
        if (!poly) return;
        poly.style.transition = 'filter 200ms ease';
        poly.style.filter = 'drop-shadow(0 0 0 3px #00A8FF) drop-shadow(0 0 12px rgba(0,168,255,0.65))';
        setTimeout(() => { poly.style.filter = ''; }, 900);
    }

    /* ----------------------------------------------------------------------
       9. Selección de pieza dentaria
       ---------------------------------------------------------------------- */
    function selectTooth(fdi) {
        engine.selectedFDI = fdi;

        // Marca visual exclusiva en el SVG
        document.querySelectorAll('g.odn-tooth').forEach(g => {
            g.classList.toggle('odn-selected', g.getAttribute('data-fdi') === fdi);
        });

        // Re-render timeline filtrado
        renderTimeline();

        document.dispatchEvent(new CustomEvent('odontograma:tooth-selected', {
            detail: { fdi: fdi }
        }));
    }

    /* ----------------------------------------------------------------------
       10. Contadores de capa (panel izquierdo)
       ---------------------------------------------------------------------- */
    function updateLayerCount(layerName, n) {
        const id = 'odnCount' + layerName.charAt(0).toUpperCase() + layerName.slice(1);
        const el = document.getElementById(id);
        if (el) el.textContent = String(n);
    }

    function recomputeLayerCounters() {
        let diagnostic = 0, therapeutic = 0, historic = 0;
        engine.events.forEach(e => {
            if (e.state === 'active' || e.state === 'review') diagnostic++;
            else if (e.state === 'planned' || e.state === 'completed' || e.state === 'control-ok') therapeutic++;
            else if (e.state === 'historic') historic++;
        });
        updateLayerCount('diagnostic',  diagnostic);
        updateLayerCount('therapeutic', therapeutic);
        updateLayerCount('historic',    historic);
    }

    /* ----------------------------------------------------------------------
       11. Acciones de pieza seleccionada (botones del panel)
       ---------------------------------------------------------------------- */
    function bulkApplyToSelectedTooth(state) {
        if (!engine.selectedFDI) {
            toast('Selecciona primero una pieza dental.');
            return;
        }
        const polys = document.querySelectorAll(`g.odn-tooth[data-fdi="${engine.selectedFDI}"] polygon.odn-surface`);
        polys.forEach(poly => {
            const surface = poly.getAttribute('data-surface');
            applyStateToSurface(poly, state);
            registerEvent({
                fdi:       engine.selectedFDI,
                surface:   surface,
                state:     state,
                severity:  engine.activeSeverity,
                surfaceEl: poly
            });
        });
    }

    function resolveActiveFindings() {
        if (!engine.selectedFDI) {
            toast('Selecciona primero una pieza dental.');
            return;
        }
        const polys = document.querySelectorAll(
            `g.odn-tooth[data-fdi="${engine.selectedFDI}"] polygon.odn-surface.odn-active`
        );
        if (polys.length === 0) {
            toast('La pieza seleccionada no tiene patologías activas que resolver.');
            return;
        }
        polys.forEach(poly => {
            const surface = poly.getAttribute('data-surface');
            applyStateToSurface(poly, 'historic');
            registerEvent({
                fdi:       engine.selectedFDI,
                surface:   surface,
                state:     'historic',
                severity:  'none',
                surfaceEl: poly
            });
        });
    }

    /* ----------------------------------------------------------------------
       12. Toast efímero (feedback no bloqueante)
       ---------------------------------------------------------------------- */
    let toastTimer = null;
    function toast(msg) {
        let t = document.getElementById('odnToast');
        if (!t) {
            t = htmlEl('div', '', '');
            t.id = 'odnToast';
            t.style.cssText = `
                position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
                background: rgba(15, 23, 42, 0.94); color: white;
                padding: 10px 18px; border-radius: 10px;
                font-size: 0.88rem; font-weight: 600;
                box-shadow: 0 10px 30px rgba(0,0,0,0.35);
                z-index: 9500; opacity: 0; transition: opacity 180ms ease;
                pointer-events: none;
            `;
            document.body.appendChild(t);
        }
        t.textContent = msg;
        t.style.opacity = '1';
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 2200);
    }

    /**
     * Retorna sólo los eventos que representan condiciones/patologías activas
     * (no incluye tratamientos, ni piezas existentes/históricas).
     */
    /**
     * Restaura el estado visual y la memoria del odontograma desde un JSON.
     */
    function setEvents(savedEvents) {
        if (!savedEvents || !Array.isArray(savedEvents) || savedEvents.length === 0) return;

        // 1. Limpiar lienzo y memoria
        engine.events = [];
        engine.surfaceLatest.clear();
        document.querySelectorAll('polygon.odn-surface').forEach(p => {
            ALL_SURFACE_STATES.forEach(s => p.classList.remove('odn-' + s));
            p.style.fill = '';
        });
        document.querySelectorAll('g.odn-tooth .odn-custom-marker').forEach(el => el.remove());

        // 2. Repintar eventos guardados
        const piezasExtraidas = new Set();
        const piezasAusentes = new Set();

        savedEvents.forEach(evt => {
            // Recuperar el objeto Date
            evt.timestamp = new Date(evt.timestamp);
            engine.events.push(evt);

            if (evt.surface) {
                engine.surfaceLatest.set(`${evt.fdi}|${evt.surface}`, evt);
                const poly = document.querySelector(`polygon.odn-surface[data-fdi="${evt.fdi}"][data-surface="${evt.surface}"]`);
                if (poly) applyStateToSurface(poly, evt.state);
            } else if (evt.fdi && evt.fdi !== 'GENERAL') {
                const polys = document.querySelectorAll(`polygon.odn-surface[data-fdi="${evt.fdi}"]`);
                polys.forEach(p => applyStateToSurface(p, evt.state));
                
                if (evt.code === 'exodoncia_simple' || evt.code === 'exodoncia_compleja' || evt.code === 'extraccion' || evt.code === 'fractura_existente') {
                    piezasExtraidas.add(evt.fdi);
                } else if (evt.code === 'ausente') {
                    piezasAusentes.add(evt.fdi);
                }
            }
        });

        piezasExtraidas.forEach(fdi => drawExtractionMarker(fdi));
        piezasAusentes.forEach(fdi => {
             document.querySelectorAll(`polygon.odn-surface[data-fdi="${fdi}"]`).forEach(p => p.style.fill = '#0f172a');
        });

        recomputeLayerCounters();
        renderTimeline();
        renderGroupedHistorial();
    }
    function getHallazgos() {
        return engine.events.filter(e => e.state === 'active' || e.state === 'review');
    }

    /**
     * Snapshot del estado periodontal global: toggles UI + códigos clínicos
     * presentes en el log de eventos.
     */
    function getPerio() {
        const cb = (k) => {
            const el = document.querySelector(`input[data-perio="${k}"]`);
            return !!(el && el.checked);
        };
        const hallazgos = getHallazgos();
        return {
            placa:      cb('placa'),
            bop:        cb('bop'),
            fumador:    cb('fumador'),
            cal_leve:   hallazgos.some(h => h.code === 'cal_leve'),
            cal_severa: hallazgos.some(h => h.code === 'cal_severa')
        };
    }

    /**
     * Calcula el Perfil de Riesgo Integral combinando hallazgos estructurados
     * (códigos ICCMS, CAL) con modificadores conductuales (placa, BOP, fumador).
     * No toca el DOM; devuelve además un `desglose` por área que el consumidor
     * pinta en su propia UI (ej. analizarPerfilClinicoPaciente en ficha-paciente.html).
     */
    function calcularRiesgoIntegral(hallazgosInput) {
        const hallazgos = Array.isArray(hallazgosInput) ? hallazgosInput : getHallazgos();
        const perio = getPerio();

        // ---- Caries -----------------------------------------------------
        let totalCaries = 0;
        let cariesProfunda = false;
        hallazgos.forEach(h => {
            if (h.code === 'iccms_3' || h.code === 'iccms_5' || h.code === 'iccms_6') totalCaries++;
            if (h.code === 'iccms_6') cariesProfunda = true;
        });

        let cariesNivel = 'bajo';
        let cariesReco  = 'Sin caries activas registradas. Mantener higiene de rutina.';
        if (cariesProfunda || totalCaries >= 3) {
            cariesNivel = 'alto';
            cariesReco  = 'Carga cariogénica alta. Indicar pasta dental 5.000 ppm de flúor y barniz cada 3 meses.';
        } else if (totalCaries >= 1) {
            cariesNivel = 'medio';
            cariesReco  = 'Lesiones cariogénicas activas. Reforzar fluoración tópica y control en 6 meses.';
        }

        // ---- Periodontal -----------------------------------------------
        // Estadios I-IV inferidos cruzando CAL + signos inflamatorios + modificadores.
        //   I    : Gingivitis / sin CAL clínico, sólo signos reversibles.
        //   II   : Periodontitis incipiente (CAL leve, BOP, placa).
        //   III  : Periodontitis moderada-severa (CAL severa OR CAL leve + fumador/movilidad).
        //   IV   : Periodontitis avanzada con compromiso funcional (CAL severa + movilidad o múltiples piezas).
        const piezasConMovilidad = hallazgos.filter(h => h.code === 'movilidad').length;
        const piezasConCalSevera = hallazgos.filter(h => h.code === 'cal_severa').length;

        let perioEtapa = 0;            // 0 = sin compromiso
        let perioNivel = 'bajo';
        let perioReco  = 'Periodonto dentro de parámetros saludables.';

        if (perio.cal_severa && (piezasConMovilidad >= 1 || piezasConCalSevera >= 3)) {
            perioEtapa = 4;            // Estadio IV
            perioNivel = 'alto';
            perioReco  = 'Estadio IV: periodontitis avanzada con compromiso funcional. Derivar a periodoncista; planificar pulido radicular y mantención cada 3 meses.';
        } else if (perio.cal_severa || (perio.cal_leve && perio.fumador)) {
            perioEtapa = 3;            // Estadio III
            perioNivel = 'alto';
            perioReco  = 'Estadio III: periodontitis moderada-severa. Planificar pulido radicular, reevaluación a 6 semanas y refuerzo de higiene.';
        } else if (perio.cal_leve || (perio.bop && (perio.placa || perio.fumador))) {
            perioEtapa = 2;            // Estadio II
            perioNivel = 'medio';
            perioReco  = 'Estadio II: periodontitis incipiente. Destartraje supragingival, técnicas de higiene avanzadas y reevaluación en 3 meses.';
        } else if (perio.bop || perio.placa) {
            perioEtapa = 1;            // Estadio I (gingivitis reversible)
            perioNivel = 'medio';
            perioReco  = 'Estadio I: gingivitis reversible. Reforzar higiene oral y control en 6 meses.';
        }

        // ---- Riesgo Integral -------------------------------------------
        const rank = { bajo: 1, medio: 2, alto: 3 };
        const nivelInt = rank[cariesNivel] >= rank[perioNivel] ? cariesNivel : perioNivel;
        const control_meses = nivelInt === 'alto' ? 3 : (nivelInt === 'medio' ? 6 : 12);

        let recomendaciones;
        if (nivelInt === 'alto') {
            recomendaciones = 'Perfil de Alto Riesgo. Control trimestral, pasta 5.000 ppm flúor y destartraje periódico hasta estabilizar.';
        } else if (nivelInt === 'medio') {
            recomendaciones = 'Perfil de Riesgo Moderado. Reforzar higiene, indicar seda dental y control clínico en 6 meses.';
        } else {
            recomendaciones = 'Perfil de Bajo Riesgo. Mantener cepillado diario y control anual de mantención.';
        }

        return {
            nivel:           nivelInt,
            control_meses:   control_meses,
            recomendaciones: recomendaciones,
            desglose: {
                caries: { nivel: cariesNivel, recomendacion: cariesReco, conteo: totalCaries },
                perio:  { nivel: perioNivel,  recomendacion: perioReco,  flags: perio, etapa: perioEtapa }
            },
            fecha_calculo:   new Date().toISOString()
        };
    }

    /**
     * Variante legacy: calcula el riesgo y además lo inyecta en el DOM
     * antiguo (#aiNivelRiesgo, #aiRecomendacion, #aiMesesControl, #aiFechaControl).
     * Mantenida porque `bindToUI` la dispara desde el listener de toggles perio.
     */
    function calcularPerfilRiesgo() {
        const riesgo_integral = calcularRiesgoIntegral();
        try {
            const card    = document.getElementById('tarjetaInteligenciaClinica');
            const badge   = document.getElementById('aiNivelRiesgo');
            const recoEl  = document.getElementById('aiRecomendacion');
            const mesesEl = document.getElementById('aiMesesControl');
            const fechaEl = document.getElementById('aiFechaControl');
            const nivel   = riesgo_integral.nivel;

            if (badge) {
                badge.innerText = nivel.toUpperCase() + ' RIESGO';
                badge.style.background = nivel === 'alto' ? '#ef4444' : (nivel === 'medio' ? '#f59e0b' : '#10b981');
            }
            if (recoEl)  recoEl.innerText  = riesgo_integral.recomendaciones;
            if (mesesEl) mesesEl.innerText = riesgo_integral.control_meses;
            if (fechaEl) {
                const f = new Date();
                f.setMonth(f.getMonth() + riesgo_integral.control_meses);
                fechaEl.innerText = f.toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' });
            }
            if (card) card.style.display = 'block';
        } catch (err) {
            console.error('Error actualizando DOM de perfil de riesgo:', err);
        }
        return riesgo_integral;
    }

    /**
     * Infiere el Perfil de Riesgo y lo persiste en `perfiles_pacientes`
     * usando columnas discretas (ver migración 06_perfiles_pacientes_riesgo.sql).
     *
     * Diseño:
     *   - Fuente de verdad: las 4 columnas (nivel_riesgo, control_meses,
     *     proximo_control_fecha, riesgo_integral) en perfiles_pacientes.
     *   - Para compatibilidad con instalaciones sin la migración aplicada,
     *     caemos al INSERT en fichas_clinicas.historial_json sólo si el
     *     UPDATE de perfiles_pacientes falla por columnas inexistentes.
     *   - NO insertamos un ficha nueva por cada cálculo (eso polucionaba
     *     la timeline del paciente con un "auto-evento" por cada save).
     */
    async function calcularYPersistirRiesgo(perfilPacienteId) {
        if (!perfilPacienteId || !window.midental) return null;

        const riesgo_integral = calcularPerfilRiesgo();
        // proximo_control_fecha: fecha ISO YYYY-MM-DD para casteo DATE en PostgreSQL.
        const proxFecha = new Date();
        proxFecha.setMonth(proxFecha.getMonth() + (riesgo_integral.control_meses || 6));
        const proxFechaIso = proxFecha.toISOString().slice(0, 10);

        try {
            const { error: updateErr } = await window.midental
                .from('perfiles_pacientes')
                .update({
                    nivel_riesgo:          riesgo_integral.nivel,
                    control_meses:         riesgo_integral.control_meses,
                    proximo_control_fecha: proxFechaIso,
                    riesgo_integral:       riesgo_integral,
                    riesgo_calculado_en:   new Date().toISOString()
                })
                .eq('id', perfilPacienteId);

            if (updateErr) {
                // Compatibilidad: si la migración 06 aún no se aplicó (columnas
                // no existen), caemos al fallback histórico en fichas_clinicas.
                const msg = (updateErr.message || '').toLowerCase();
                if (msg.includes('column') && msg.includes('does not exist')) {
                    console.warn('Migración 06 no aplicada — usando fallback fichas_clinicas:', updateErr.message);
                    await window.midental.from('fichas_clinicas').insert([{
                        paciente_id:     perfilPacienteId,
                        motivo_consulta: 'Cálculo automatizado de Perfil de Riesgo',
                        accion_realizada:'Análisis odontograma',
                        presupuesto_total: 0,
                        historial_json:  { riesgo_integral: riesgo_integral }
                    }]);
                } else {
                    throw updateErr;
                }
            }

            toast(`✓ Perfil de Riesgo ${riesgo_integral.nivel.toUpperCase()} actualizado.`);
            return riesgo_integral;
        } catch (err) {
            console.error('Error persistiendo riesgo:', err);
            toast(`Perfil de riesgo NO persistido: ${err.message || err}`);
            return null;
        }
    }

    /* ------------------------------------------------------------------
       Persistencia EDR (Supabase): bridge perfil→edr.patients, lookup
       ontológico cacheado, agrupación por pieza y RPC transaccional.
       ------------------------------------------------------------------ */

    // Caché del catálogo ontológico { code: ontology_id } por sesión.
    let _ontologyMapPromise = null;
    function loadOntologyMap() {
        if (_ontologyMapPromise) return _ontologyMapPromise;
        _ontologyMapPromise = (async () => {
            const { data, error } = await window.midental
                .schema('edr')
                .from('v_ontology_catalog')
                .select('id, code, code_system, category, metadata');
            if (error) throw new Error(`Catálogo ontológico no disponible: ${error.message}`);
            const map = new Map();
            (data || []).forEach(row => {
                // Indexamos por code y también por (system|code) para resolver duplicados.
                if (!map.has(row.code)) map.set(row.code, row);
                map.set(`${row.code_system}|${row.code}`, row);
            });
            return map;
        })();
        return _ontologyMapPromise;
    }

    // Resuelve {id, severity, tooth_status} sugeridos para un código del frontend.
    function resolveOntologyForCode(map, code) {
        if (!code) return null;
        const row = map.get(code) || map.get(`LOCAL|${code}`) || map.get(`ICDAS|${code}`);
        if (!row) return null;
        const meta = row.metadata || {};
        return {
            ontology_id:  row.id,
            severity:     meta.severity      || 'none',
            tooth_status: meta.tooth_status  || null,
            icdas_score:  meta.icdas_score   != null ? meta.icdas_score : null,
            category:     row.category
        };
    }

    // Agrupa engine.events por FDI replicando la lógica de renderGroupedHistorial,
    // pero retornando además los eventos crudos por pieza para persistencia granular.
    function agruparEventosParaPersistencia() {
        const grouped = {};
        for (let i = engine.events.length - 1; i >= 0; i--) {
            const evt = engine.events[i];
            if (!grouped[evt.fdi]) {
                grouped[evt.fdi] = {
                    fdi: evt.fdi,
                    surfaces: new Set(),
                    conditions: [],
                    treatment: null,
                    primaryCondition: null,
                    rawEvents: []
                };
            }
            const g = grouped[evt.fdi];
            g.rawEvents.push(evt);
            if (evt.surface) g.surfaces.add(evt.surface);
            if (evt.state === 'active' || evt.state === 'review') {
                const cond = { code: evt.code, display: evt.display, surface: evt.surface };
                g.conditions.push(cond);
                g.primaryCondition = cond;
            } else if ((evt.state === 'planned' || evt.state === 'completed') && evt.txCode) {
                g.treatment = { txCode: evt.txCode, txLabel: evt.txLabel };
            }
        }
        return Object.values(grouped);
    }

    /**
     * Persistencia relacional del odontograma.
     * 1) Bridge perfiles_pacientes.id → edr.patients.id (auto-provisión).
     * 2) Localiza/crea el odontograma vigente del paciente.
     * 3) Resuelve toothId por FDI (lazy + insert si falta).
     * 4) Por pieza: registra (a) un finding por superficie afectada con
     *    el código ontológico mapeado, y (b) un finding al nivel pieza
     *    con la prestación inferida (Restauración compleja MOD, etc.)
     *    cuando hay tratamiento.
     * 5) Propaga p_new_tooth_status para extracciones/ausentes.
     *
     * Errores se propagan al toast con su mensaje real — nada de
     * "sincronización fallida" genérica.
     */
    async function guardarOdontogramaEnNube(perfilPacienteId) {
        if (!perfilPacienteId) {
            toast('Falta el id del paciente para sincronizar.');
            return { ok: false, reason: 'missing_patient' };
        }
        if (!window.midental) {
            toast('Cliente Supabase no inicializado.');
            return { ok: false, reason: 'no_client' };
        }
        if (engine.events.length === 0) {
            toast('No hay hallazgos para persistir.');
            return { ok: false, reason: 'empty' };
        }

        toast('Persistiendo hallazgos en la nube...');

        try {
            // 1. Catálogo ontológico ----------------------------------
            const ontologyMap = await loadOntologyMap();

            // 2. Bridge: resolver/crear edr.patients ------------------
            const { data: bridgeResp, error: bridgeErr } = await window.midental
                .schema('edr')
                .rpc('rpc_resolve_or_create_edr_patient', { p_perfil_paciente_id: perfilPacienteId });
            if (bridgeErr) throw new Error(`Bridge paciente: ${bridgeErr.message}`);
            const edrPatientId = bridgeResp && bridgeResp.data && bridgeResp.data.patient_id;
            if (!edrPatientId) throw new Error('Bridge no retornó patient_id.');

            // 3. Odontograma vigente o nuevo --------------------------
            let odontogramId;
            const { data: odns, error: odnsErr } = await window.midental
                .schema('edr').from('odontograms')
                .select('id, is_locked, version')
                .eq('patient_id', edrPatientId)
                .is('deleted_at', null)
                .order('version', { ascending: false })
                .limit(1);
            if (odnsErr) throw new Error(`Lectura de odontogramas: ${odnsErr.message}`);

            if (odns && odns.length > 0 && !odns[0].is_locked) {
                odontogramId = odns[0].id;
            } else {
                const { data: createResp, error: createErr } = await window.midental
                    .schema('edr')
                    .rpc('rpc_create_odontogram_version', {
                        p_patient_id: edrPatientId,
                        p_dentition_type: 'permanent'
                    });
                if (createErr) throw new Error(`Creación de odontograma: ${createErr.message}`);
                odontogramId = createResp && createResp.data && createResp.data.odontogram_id;
                if (!odontogramId) throw new Error('RPC create_odontogram_version no retornó id.');
            }

            // 4. Resolver toothId por FDI (lazy, una pasada) ----------
            const grupos = agruparEventosParaPersistencia();
            // FDI reales (excluimos el sentinel GENERAL de boca completa)
            const fdisReales = grupos.map(g => g.fdi).filter(f => f !== GENERAL_FDI);
            const toothByFdi = new Map();

            if (fdisReales.length > 0) {
                const { data: existingTeeth, error: teethErr } = await window.midental
                    .schema('edr').from('teeth')
                    .select('id, fdi_code')
                    .eq('odontogram_id', odontogramId)
                    .in('fdi_code', fdisReales);
                if (teethErr) throw new Error(`Lectura de dientes: ${teethErr.message}`);
                (existingTeeth || []).forEach(t => toothByFdi.set(t.fdi_code, t.id));

                const missing = fdisReales.filter(f => !toothByFdi.has(f));
                if (missing.length > 0) {
                    const rows = missing.map(fdi => ({
                        odontogram_id: odontogramId,
                        fdi_code:      fdi,
                        quadrant:      parseInt(fdi.charAt(0), 10),
                        position:      parseInt(fdi.charAt(1), 10)
                    }));
                    const { data: insertedTeeth, error: insertErr } = await window.midental
                        .schema('edr').from('teeth')
                        .insert(rows).select('id, fdi_code');
                    if (insertErr) throw new Error(`Inserción de dientes: ${insertErr.message}`);
                    (insertedTeeth || []).forEach(t => toothByFdi.set(t.fdi_code, t.id));
                }
            }

            // 5. Persistencia por pieza -------------------------------
            const errores = [];
            let okCount = 0;

            for (const grupo of grupos) {
                const isGeneral = grupo.fdi === GENERAL_FDI;
                const toothId = isGeneral ? null : toothByFdi.get(grupo.fdi);
                if (!isGeneral && !toothId) {
                    errores.push(`Pieza ${grupo.fdi}: tooth_id no resuelto.`);
                    continue;
                }

                // Caras únicas con condición activa (un finding por superficie)
                const condBySurface = new Map();
                grupo.conditions.forEach(c => {
                    if (!c.code) return;
                    const onto = resolveOntologyForCode(ontologyMap, c.code);
                    if (!onto) { errores.push(`Pieza ${grupo.fdi}: código "${c.code}" no existe en ontology_dictionary.`); return; }
                    condBySurface.set(c.surface || '__tooth__', { cond: c, onto });
                });

                for (const [surfKey, { cond, onto }] of condBySurface) {
                    const params = {
                        p_odontogram_id: odontogramId,
                        p_tooth_id:      toothId,
                        p_surface_code:  surfKey === '__tooth__' ? null : surfKey,
                        p_ontology_id:   onto.ontology_id,
                        p_severity:      onto.severity || 'none',
                        p_icdas_score:   onto.icdas_score,
                        p_description:   cond.display || cond.code,
                        p_metadata:      { source: 'odontograma_ui', code: cond.code }
                    };
                    if (onto.tooth_status) params.p_new_tooth_status = onto.tooth_status;

                    const { data: r, error: rErr } = await window.midental
                        .schema('edr').rpc('rpc_register_clinical_finding', params);
                    if (rErr) { errores.push(`Pieza ${grupo.fdi}/${surfKey}: ${rErr.message}`); continue; }
                    if (r && r.ok === false) { errores.push(`Pieza ${grupo.fdi}/${surfKey}: ${JSON.stringify(r)}`); continue; }
                    okCount++;
                }

                // Tratamiento inferido (uno por pieza) — usa nomenclatura compuesta MOD.
                if (grupo.treatment) {
                    const inferida = inferirPrestacion(grupo);
                    const txCode = grupo.treatment.txCode ? `tx_${grupo.treatment.txCode}` : null;
                    const onto = txCode ? resolveOntologyForCode(ontologyMap, txCode) : null;
                    if (!onto) {
                        errores.push(`Pieza ${grupo.fdi}: tratamiento "${grupo.treatment.txCode}" no mapeado (¿falta tx_${grupo.treatment.txCode} en ontology_dictionary?).`);
                    } else {
                        const txParams = {
                            p_odontogram_id: odontogramId,
                            p_tooth_id:      toothId,
                            p_surface_code:  null,
                            p_ontology_id:   onto.ontology_id,
                            p_severity:      onto.severity || 'none',
                            p_description:   inferida ? inferida.nombre : grupo.treatment.txLabel,
                            p_metadata:      {
                                source:       'odontograma_ui_tx',
                                tx_code:      grupo.treatment.txCode,
                                surfaces:     inferida ? inferida.caras : '',
                                composed:     inferida ? inferida.nombre : null
                            }
                        };
                        // Tratamientos terminales (exodoncia, implante, prótesis) propagan tooth_status.
                        if (onto.tooth_status) txParams.p_new_tooth_status = onto.tooth_status;

                        const { data: rt, error: rtErr } = await window.midental
                            .schema('edr').rpc('rpc_register_clinical_finding', txParams);
                        if (rtErr)        errores.push(`Pieza ${grupo.fdi} TX: ${rtErr.message}`);
                        else if (rt && rt.ok === false) errores.push(`Pieza ${grupo.fdi} TX: ${JSON.stringify(rt)}`);
                        else okCount++;
                    }
                }
            }

            // 6. Riesgo integral (mantiene persistencia legacy en public.fichas_clinicas)
            await calcularYPersistirRiesgo(perfilPacienteId);

            if (errores.length === 0) {
                toast(`✓ ${okCount} hallazgo(s) sincronizado(s) con Supabase.`);
                return { ok: true, count: okCount };
            }
            console.warn('Errores parciales en persistencia EDR:', errores);
            toast(`Sincronización parcial: ${okCount} OK, ${errores.length} con errores (ver consola).`);
            return { ok: false, count: okCount, errors: errores };
        } catch (err) {
            console.error('Error guardando odontograma:', err);
            toast(`Sincronización fallida: ${err.message || err}`);
            return { ok: false, error: String(err && err.message || err) };
        }
    }

    /**
     * Mapea un finding del EDR (vía v_active_findings_by_perfil) al
     * `state` del frontend según la categoría ontológica y el estado
     * macro del diente. Centralizado para mantener consistencia.
     */
    function inferirStateDesdeFinding(f) {
        const isProcedure = f.ontology_category === 'procedure';
        const toothStatus = f.tooth_status || 'present';

        if (toothStatus === 'absent_extracted' || toothStatus === 'replaced_by_implant'
            || toothStatus === 'replaced_by_prosthesis' || toothStatus === 'absent_congenital') {
            return 'historic';
        }
        if (isProcedure) {
            // Si el procedimiento ya está registrado en el EDR, lo consideramos completado;
            // un planificado puro vivirá sólo en sesión hasta que se ejecute.
            return 'completed';
        }
        return 'active';
    }

    /**
     * Inicialización: lee hallazgos vigentes del paciente (filtrados por
     * el perfiles_pacientes.id que viene en la URL) y repinta el SVG +
     * historial agrupado con los estados, códigos y marcas correctas.
     */
    async function inicializarDesdeBaseDeDatos(perfilPacienteId) {
        if (!perfilPacienteId || !window.midental) return;
        try {
            const { data: findings, error } = await window.midental
                .schema('edr')
                .from('v_active_findings_by_perfil')
                .select('*')
                .eq('perfil_paciente_id', perfilPacienteId)
                .order('created_at', { ascending: true });
            if (error) {
                // Si la vista aún no fue creada en la BD, fallback silencioso.
                console.warn('v_active_findings_by_perfil no disponible:', error.message);
                return;
            }
            if (!findings || findings.length === 0) return;

            // Reset de sesión antes de hidratar
            engine.events = [];
            engine.surfaceLatest.clear();

            // Reset visual del SVG existente para evitar pinturas residuales
            document.querySelectorAll('polygon.odn-surface').forEach(p => {
                ALL_SURFACE_STATES.forEach(s => p.classList.remove('odn-' + s));
                p.style.fill = '';
            });
            document.querySelectorAll('g.odn-tooth .odn-custom-marker').forEach(el => el.remove());

            const piezasExtraidas = new Set();

            findings.forEach(f => {
                const state    = inferirStateDesdeFinding(f);
                const isProc   = f.ontology_category === 'procedure';
                const code     = isProc ? null : f.finding_code;
                const txCode   = isProc && f.finding_code.startsWith('tx_')
                    ? f.finding_code.substring(3)
                    : null;
                const display  = f.finding_label || f.description || f.finding_code;

                const evt = {
                    id:        f.finding_id,
                    timestamp: new Date(f.created_at || Date.now()),
                    fdi:       f.fdi_code,
                    surface:   f.surface_code,
                    state:     state,
                    severity:  f.severity || 'none',
                    code:      code || '',
                    display:   display,
                    txCode:    txCode || '',
                    txLabel:   isProc ? display : '',
                    label:     buildEventLabel(f.fdi_code, f.surface_code, state, f.severity, display, isProc ? display : null),
                    narrative: f.description || 'Cargado desde el EDR.'
                };
                engine.events.push(evt);

                if (f.surface_code) {
                    engine.surfaceLatest.set(`${f.fdi_code}|${f.surface_code}`, evt);
                    const poly = document.querySelector(
                        `polygon.odn-surface[data-fdi="${f.fdi_code}"][data-surface="${f.surface_code}"]`
                    );
                    if (poly) applyStateToSurface(poly, state);
                } else if (f.fdi_code) {
                    const polys = document.querySelectorAll(`polygon.odn-surface[data-fdi="${f.fdi_code}"]`);
                    polys.forEach(p => applyStateToSurface(p, state));
                }

                if (f.tooth_status === 'absent_extracted' && f.fdi_code) {
                    piezasExtraidas.add(f.fdi_code);
                }
            });

            // Repintar marca de extracción en piezas marcadas como ausentes/extraídas
            piezasExtraidas.forEach(fdi => drawExtractionMarker(fdi));

            // engine.events viene ordenado más-antiguo-primero; invertimos para
            // mantener el contrato del resto del motor (newest-first).
            engine.events.reverse();

            recomputeLayerCounters();
            renderTimeline();
            renderGroupedHistorial();
            toast(`Cargados ${findings.length} hallazgo(s) desde el EDR.`);
        } catch (err) {
            console.error('Error inicializando desde la BD:', err);
            toast(`Error cargando historial: ${err.message || err}`);
        }
    }

    /* ----------------------------------------------------------------------
       13. Cableado con la UI (eventos disparados por ficha-paciente.html)
       ---------------------------------------------------------------------- */
    function bindToUI() {
        // Wire left-side selector buttons (Condiciones y Patologías)
        document.querySelectorAll('.odn-finding-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.odn-finding-btn, .odn-treatment-btn').forEach(b => {
                    b.classList.remove('odn-active');
                    b.classList.remove('active');
                });
                btn.classList.add('odn-active');
                btn.classList.add('active');

                engine.activeState    = btn.getAttribute('data-state')    || 'existing';
                engine.activeSeverity = btn.getAttribute('data-severity') || 'none';
                engine.activeCode     = btn.getAttribute('data-code')     || '';
                engine.activeLabel    = btn.getAttribute('data-label')    || btn.textContent.trim();
                engine.activeTxCode   = '';
                engine.activeTxLabel  = '';

                toast(`Pincel activo: ${engine.activeLabel}`);
            });
        });

        // Wire right-side treatment buttons (Planificación / Tratamiento)
        document.querySelectorAll('.odn-treatment-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.odn-finding-btn, .odn-treatment-btn').forEach(b => {
                    b.classList.remove('odn-active');
                    b.classList.remove('active');
                });
                btn.classList.add('odn-active');
                btn.classList.add('active');

                engine.activeState    = 'planned';
                engine.activeSeverity = 'none';
                engine.activeCode     = '';
                engine.activeLabel    = '';
                engine.activeTxCode   = btn.getAttribute('data-tx') || '';
                engine.activeTxLabel  = btn.textContent.trim();

                // Tratamientos de boca completa: se registran globalmente
                // sin necesidad de clic sobre una pieza.
                if (GLOBAL_TREATMENTS.has(engine.activeTxCode)) {
                    registerEvent({
                        fdi:      GENERAL_FDI,
                        surface:  null,
                        state:    'planned',
                        severity: 'none',
                        code:     '',
                        display:  '',
                        txCode:   engine.activeTxCode,
                        txLabel:  engine.activeTxLabel
                    });
                    toast(`Tratamiento general registrado: ${engine.activeTxLabel}`);
                } else {
                    toast(`Tratamiento activo: ${engine.activeTxLabel}`);
                }
            });
        });

        // Wire periodontal switches to recalculate risk automatically
        document.querySelectorAll('input[data-perio]').forEach(input => {
            input.addEventListener('change', () => {
                calcularPerfilRiesgo();
            });
        });

        // Wire filter buttons of the historial (Todos / Pendiente / Planificado / Finalizado)
        document.querySelectorAll('.odn-timeline__filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.odn-timeline__filter-btn').forEach(b => b.classList.remove('odn-active'));
                btn.classList.add('odn-active');
                engine.historialFilter = btn.getAttribute('data-filter') || 'all';
                renderGroupedHistorial();
            });
        });

        // Wire dentition toggle (permanente / temporal)
        document.querySelectorAll('[data-dentition]').forEach(btn => {
            btn.addEventListener('click', () => {
                setDentition(btn.getAttribute('data-dentition'));
            });
        });

        // 13.1 Cambio de pincel clínico (estado activo)
        document.addEventListener('odontograma:state-change', (e) => {
            const newState = (e.detail && e.detail.state) || 'existing';
            engine.activeState = newState;
        });

        // 13.2 Cambio de severidad
        document.addEventListener('odontograma:severity-change', (e) => {
            engine.activeSeverity = (e.detail && e.detail.severity) || 'none';
        });

        // 13.3 Filtro del timeline
        document.addEventListener('odontograma:timeline-filter', (e) => {
            engine.timelineFilter = (e.detail && e.detail.filter) || 'all';
            renderTimeline();
        });

        // 13.4 Apertura del modal → renderizar si aún no se ha hecho + inicializar datos
        document.addEventListener('odontograma:open', (e) => {
            if (!engine.rendered) renderOdontogram();
            
            // Forzamos la lectura del JSON inyectado desde el HTML
            const estadoPrevio = e.detail && e.detail.estadoPrevio;
            
            if (estadoPrevio && Array.isArray(estadoPrevio) && estadoPrevio.length > 0) {
                // Si la columna odontograma_estado tiene datos, usamos NUESTRA función setEvents
                // Ignoramos por completo inicializarDesdeBaseDeDatos para que no limpie el lienzo
                if (typeof setEvents === 'function') {
                    setEvents(estadoPrevio);
                } else if (typeof api.setEvents === 'function') {
                    api.setEvents(estadoPrevio);
                }
            } else {
                // Fallback original: solo si la columna JSON está vacía, intenta buscar en el esquema edr
                renderTimeline();
                const pId = (e.detail && e.detail.pacienteId) || null;
                if (pId && engine.events.length === 0) {
                    inicializarDesdeBaseDeDatos(pId);
                }
            }
        });

        // 13.5 Botones del panel "Pieza seleccionada"
        const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
        bind('odnBtnRegistrarHallazgo', () => bulkApplyToSelectedTooth(engine.activeState));
        bind('odnBtnAgregarPlan',       () => bulkApplyToSelectedTooth('planned'));
        bind('odnBtnResolverHallazgo',  resolveActiveFindings);

        // 13.6 Acciones del header del modal
        bind('odnBtnExport', () => {
            // Export naive: copiar el log al portapapeles como JSON estructurado.
            const payload = JSON.stringify(engine.events, null, 2);
            navigator.clipboard?.writeText(payload).then(
                () => toast('Historial clínico copiado al portapapeles (JSON).'),
                () => toast('No se pudo copiar al portapapeles.')
            );
        });
        bind('odnBtnSave', () => {
            const urlParams = new URLSearchParams(window.location.search);
            const pId = urlParams.get('paciente');
            if (pId) {
                guardarOdontogramaEnNube(pId);
            } else {
                toast(`Guardado local: ${engine.events.length} evento(s) en sesión.`);
            }
        });
        bind('odnBtnLock', () => {
            document.dispatchEvent(new CustomEvent('odontograma:lock-requested', {
                detail: { events: engine.events.slice() }
            }));
            toast('Solicitud de firma/lock emitida.');
        });

        // 13.7 Click sobre fondo del stage → deseleccionar pieza
        const stage = document.getElementById('odontogramaStage');
        if (stage) {
            stage.addEventListener('click', (e) => {
                if (e.target.tagName === 'svg' || e.target.id === 'odontogramaStage') {
                    engine.selectedFDI = null;
                    document.querySelectorAll('g.odn-tooth.odn-selected')
                        .forEach(g => g.classList.remove('odn-selected'));
                    renderTimeline();
                }
            });
        }

        // 13.8 Atajo: Backspace para volver al estado 'existing' (borrador clínico)
        document.addEventListener('keydown', (e) => {
            const modal = document.getElementById('odontogramaModal');
            if (!modal || !modal.classList.contains('odn-active')) return;
            if (e.key === 'Backspace' && document.activeElement === document.body) {
                engine.activeState = 'existing';
                document.querySelectorAll('#odnEstadoGrid .odn-tool-btn').forEach(b => {
                    b.classList.toggle('odn-active', b.dataset.state === 'existing');
                });
                toast('Pincel: Existente (borrador).');
            }
        });
    }


    /* ----------------------------------------------------------------------
       14. API pública (en window.MiDentalOdontograma)
       ---------------------------------------------------------------------- */
    /**
     * Cambia entre dentición permanente y temporal. Limpia la sesión
     * (events, surfaces marcadas, selección) para evitar mezclar FDIs
     * inconsistentes en pantalla.
     */
    function setDentition(d) {
        if (d !== 'permanent' && d !== 'primary') return;
        if (engine.dentition === d) return;
        engine.dentition = d;
        engine.events = [];
        engine.surfaceLatest.clear();
        engine.selectedFDI = null;
        engine.autoIncrement = 1;
        engine.rendered = false;
        renderOdontogram();
        recomputeLayerCounters();
        renderTimeline();
        renderGroupedHistorial();
        // Actualizar el toggle UI si está presente
        document.querySelectorAll('[data-dentition]').forEach(b => {
            b.classList.toggle('odn-active', b.getAttribute('data-dentition') === d);
        });
        toast(`Dentición ${d === 'primary' ? 'temporal' : 'permanente'} activa.`);
    }

    const api = {
        render:                   renderOdontogram,
        setDentition:             setDentition,
        getDentition:             () => engine.dentition,
        selectTooth:              selectTooth,
        getEvents:                () => engine.events.map(e => {
            const { surfaceEl, ...eventoSeguro } = e; // Extrae el polígono problemático
            return eventoSeguro; // Retorna solo el texto plano
        }),
        setEvents:                setEvents, 
        getHallazgos:             getHallazgos,
        getPerio:                 getPerio,
        calcularRiesgoIntegral:   calcularRiesgoIntegral,
        getState:         () => ({
            activeState:    engine.activeState,
            activeSeverity: engine.activeSeverity,
            selectedFDI:    engine.selectedFDI,
            eventCount:     engine.events.length
        }),
        registerExternal: (entry) => registerEvent(entry),
        reset: () => {
            engine.events.length = 0;
            engine.surfaceLatest.clear();
            engine.selectedFDI = null;
            engine.autoIncrement = 1;
            document.querySelectorAll('polygon.odn-surface').forEach(p => {
                ALL_SURFACE_STATES.forEach(s => p.classList.remove('odn-' + s));
            });
            document.querySelectorAll('g.odn-tooth').forEach(g => {
                g.setAttribute('data-state', 'existing');
                g.classList.remove('odn-selected');
            });
            recomputeLayerCounters();
            renderTimeline();
        }
    };

    /* ----------------------------------------------------------------------
       15. Bootstrap
       ---------------------------------------------------------------------- */
    function boot() {
        bindToUI();
        // Pre-renderizamos en caliente para que la primera apertura sea instantánea.
        // Si el SVG aún no está en el DOM (carga diferida), renderOdontogram falla
        // silenciosamente y se renderiza al evento 'odontograma:open'.
        if (document.getElementById('odontogramaSVG')) {
            renderOdontogram();
        }
        window.MiDentalOdontograma = api;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

})();
