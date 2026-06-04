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
       2. Construcción del catálogo de piezas (FDI)
          Layout (vista clínico, midline al centro):
              [18 17 16 15 14 13 12 11 | 21 22 23 24 25 26 27 28]   ← maxilar
              [48 47 46 45 44 43 42 41 | 31 32 33 34 35 36 37 38]   ← mandibular
       ---------------------------------------------------------------------- */
    function buildToothCatalog() {
        const Q1 = ['18', '17', '16', '15', '14', '13', '12', '11'];
        const Q2 = ['21', '22', '23', '24', '25', '26', '27', '28'];
        const Q4 = ['48', '47', '46', '45', '44', '43', '42', '41'];
        const Q3 = ['31', '32', '33', '34', '35', '36', '37', '38'];

        const list = [];
        Q1.forEach((fdi, i) => list.push({ fdi, quadrant: 1, position: 8 - i, row: 0, col: i }));
        Q2.forEach((fdi, i) => list.push({ fdi, quadrant: 2, position: i + 1, row: 0, col: i + 8 }));
        Q4.forEach((fdi, i) => list.push({ fdi, quadrant: 4, position: 8 - i, row: 1, col: i }));
        Q3.forEach((fdi, i) => list.push({ fdi, quadrant: 3, position: i + 1, row: 1, col: i + 8 }));
        return list;
    }

    /* ----------------------------------------------------------------------
       3. Helpers de geometría
       ---------------------------------------------------------------------- */
    function isAnterior(position) {
        return position >= 1 && position <= 3;   // incisivos central, lateral y canino
    }

    function colToX(col) {
        let x = MARGIN_X + col * (TOOTH_W + TOOTH_GAP);
        if (col >= 8) x += MIDLINE_GAP;      // espacio extra al cruzar la línea media
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
        const isUpper = (quadrant === 1 || quadrant === 2);
        const mesialOnRight = (quadrant === 1 || quadrant === 4);
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
    const ALL_SURFACE_STATES = ['active', 'planned', 'completed', 'control-ok', 'review', 'historic'];

    const engine = {
        rendered:        false,
        teeth:           buildToothCatalog(),
        activeState:     'existing',    // pincel clínico activo
        activeSeverity:  'none',
        selectedFDI:     null,           // pieza actualmente seleccionada
        timelineFilter:  'all',
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

        // Limpieza previa
        while (layerA.firstChild) layerA.removeChild(layerA.firstChild);

        const polys = toothPolygons();

        engine.teeth.forEach(tooth => {
            const x  = colToX(tooth.col);
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
        const state     = engine.activeState;
        const severity  = engine.activeSeverity;

        applyStateToSurface(poly, state);
        registerEvent({ fdi, surface, state, severity, surfaceEl: poly });
        selectTooth(fdi);
    }

    /**
     * Aplica el estado clínico a un <polygon> de superficie y actualiza la
     * pieza completa con un data-state agregado para reglas CSS.
     */
    function applyStateToSurface(poly, state) {
        // Borramos todas las clases de estado posibles, dejamos sólo la nueva.
        ALL_SURFACE_STATES.forEach(s => poly.classList.remove('odn-' + s));
        if (state && state !== 'existing') {
            poly.classList.add('odn-' + state);
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
        const priority = ['active', 'planned', 'review', 'completed', 'control-ok', 'historic'];
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
    function registerEvent({ fdi, surface, state, severity, surfaceEl }) {
        const now = new Date();
        const evt = {
            id:        engine.autoIncrement++,
            timestamp: now,
            fdi,
            surface,
            state,
            severity,
            label:     buildEventLabel(fdi, surface, state, severity),
            narrative: STATE_NARRATIVE[state] || STATE_NARRATIVE.existing
        };
        engine.events.unshift(evt);   // los más recientes primero

        // índice por superficie
        engine.surfaceLatest.set(`${fdi}|${surface}`, evt);

        // Actualizamos contadores de capa por estado
        recomputeLayerCounters();

        // Refrescamos el timeline en el panel derecho
        renderTimeline();

        // Notificamos al resto del sistema (otras capas del front pueden engancharse).
        document.dispatchEvent(new CustomEvent('odontograma:event-registered', { detail: evt }));
    }

    /**
     * Construye la descripción canónica del evento.
     * Ej.: "Pieza 1.4, Superficie Oclusal (O): Caries / Patología activa — severidad moderada."
     */
    function buildEventLabel(fdi, surface, state, severity) {
        const piezaFmt    = `${fdi.charAt(0)}.${fdi.charAt(1)}`;
        const surfaceFull = SURFACE_LABEL[surface] || surface;
        const stateFull   = STATE_LABEL[state] || state;
        const severityStr = (severity && severity !== 'none')
            ? ` — severidad ${SEVERITY_LABEL[severity] || severity}.`
            : '.';
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

    /* ----------------------------------------------------------------------
       13. Cableado con la UI (eventos disparados por ficha-paciente.html)
       ---------------------------------------------------------------------- */
    function bindToUI() {
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

        // 13.4 Apertura del modal → renderizar si aún no se ha hecho
        document.addEventListener('odontograma:open', () => {
            if (!engine.rendered) renderOdontogram();
            renderTimeline();
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
            // Hook para persistencia: emite el snapshot completo.
            document.dispatchEvent(new CustomEvent('odontograma:save-requested', {
                detail: { events: engine.events.slice(), selectedFDI: engine.selectedFDI }
            }));
            toast(`Guardado local: ${engine.events.length} evento(s) en sesión.`);
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
    const api = {
        render:           renderOdontogram,
        selectTooth:      selectTooth,
        getEvents:        () => engine.events.slice(),
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
