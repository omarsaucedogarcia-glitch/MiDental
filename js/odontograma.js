/* ==========================================================================
   odontograma.js
   MiDental — Motor Clínico Semántico del Odontograma
   --------------------------------------------------------------------------
   Sin dependencias externas. Renderiza SVG nativo, gestiona el modelo de
   "hallazgo activo" (Patología / Estado existente / Planificación) y
   mantiene un historial textual bidireccional con el panel derecho.
   --------------------------------------------------------------------------
   Modelo del pincel activo (engine.activeFinding):
     {
       code:  'caries-dentinaria',
       label: 'Caries dentinaria',
       state: 'active' | 'completed' | 'planned' | 'historic' | 'existing',
       scope: 'surface' | 'whole-tooth'
     }

   Reglas de scope:
     - scope='surface'     → el click afecta sólo el polígono tocado
     - scope='whole-tooth' → el click pinta los 5 polígonos de la pieza
                             y emite UN único evento agregado.
   ========================================================================== */

(function () {
    'use strict';

    /* ----------------------------------------------------------------------
       1. Constantes geométricas y de notación
       ---------------------------------------------------------------------- */
    const SVG_NS         = 'http://www.w3.org/2000/svg';
    const TOOTH_W        = 56;
    const TOOTH_H        = 86;
    const TOOTH_GAP      = 4;
    const MIDLINE_GAP    = 22;
    const MARGIN_X       = 12;
    const ROW_UPPER_Y    = 90;
    const ROW_LOWER_Y    = 326;
    const LABEL_UPPER_Y  = 80;
    const LABEL_LOWER_Y  = 432;

    // Rectángulo interno (superficie oclusal/incisal).
    const IX1 = 15;
    const IY1 = 22;
    const IX2 = 41;
    const IY2 = 64;

    const SURFACE_LABEL = {
        V: 'Vestibular',
        P: 'Palatina',
        L: 'Lingual',
        M: 'Mesial',
        D: 'Distal',
        O: 'Oclusal',
        I: 'Incisal'
    };

    // Estado clínico de color → etiqueta amistosa para el timeline.
    const STATE_LABEL = {
        'existing':   'Existente (sin hallazgo)',
        'active':     'Patología activa',
        'planned':    'Tratamiento planificado',
        'completed':  'Estado existente',
        'control-ok': 'Control exitoso',
        'review':     'Revisión indicada',
        'historic':   'Pieza ausente / archivado'
    };

    // Clases CSS que el motor puede aplicar a una superficie.
    const ALL_SURFACE_STATES = ['active', 'planned', 'completed', 'control-ok', 'review', 'historic'];

    // Pincel inicial — coincide con el primer botón activo del panel
    // (Caries superficial). Se sobrescribe al hacer clic en cualquier
    // .odn-finding-btn.
    const DEFAULT_FINDING = {
        code:  'caries-superficial',
        label: 'Caries superficial',
        state: 'active',
        scope: 'surface'
    };

    /* ----------------------------------------------------------------------
       2. Catálogo de piezas (FDI permanente)
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
       3. Geometría y mapeo de superficies
       ---------------------------------------------------------------------- */
    function isAnterior(position) {
        return position >= 1 && position <= 3;   // incisivo central, lateral y canino
    }

    function colToX(col) {
        let x = MARGIN_X + col * (TOOTH_W + TOOTH_GAP);
        if (col >= 8) x += MIDLINE_GAP;
        return x;
    }
    function rowToY(row) { return row === 0 ? ROW_UPPER_Y : ROW_LOWER_Y; }

    function surfaceMap(quadrant, position) {
        const isUpper       = (quadrant === 1 || quadrant === 2);
        const mesialOnRight = (quadrant === 1 || quadrant === 4);
        return {
            top:    isUpper       ? 'V' : 'L',
            bottom: isUpper       ? 'P' : 'V',
            right:  mesialOnRight ? 'M' : 'D',
            left:   mesialOnRight ? 'D' : 'M',
            center: isAnterior(position) ? 'I' : 'O'
        };
    }

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
    const engine = {
        rendered:        false,
        teeth:           buildToothCatalog(),
        activeFinding:   Object.assign({}, DEFAULT_FINDING),
        selectedFDI:     null,
        timelineFilter:  'all',
        events:          [],
        surfaceLatest:   new Map(),
        toothLatest:     new Map(),
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

            const surfaceDefs = [
                { zone: 'top',    points: polys.top,    code: sm.top    },
                { zone: 'right',  points: polys.right,  code: sm.right  },
                { zone: 'bottom', points: polys.bottom, code: sm.bottom },
                { zone: 'left',   points: polys.left,   code: sm.left   },
                { zone: 'center', points: polys.center, code: sm.center }
            ];

            surfaceDefs.forEach(def => {
                const poly = svgEl('polygon', {
                    'class':        'odn-surface',
                    'points':       def.points,
                    'data-surface': def.code,
                    'data-zone':    def.zone,
                    'data-fdi':     tooth.fdi
                });
                // Sólo escuchamos click — el hover lo maneja CSS.
                poly.addEventListener('click', onSurfaceClick);
                g.appendChild(poly);
            });

            // Rótulo FDI fuera del cuerpo dental. Sin pointer events
            // (CSS impone `pointer-events: none`), no roba foco al cursor.
            const labelY = (tooth.row === 0) ? (LABEL_UPPER_Y - y) : (LABEL_LOWER_Y - y);
            const label  = svgEl('text', {
                'class': 'odn-tooth__label',
                'x':     TOOTH_W / 2,
                'y':     labelY,
                'aria-hidden': 'true'
            });
            label.textContent = `${tooth.quadrant}.${tooth.position}`;
            g.appendChild(label);

            layerA.appendChild(g);
        });

        if (placeholder) placeholder.classList.add('odn-hidden');
        updateLayerCount('anatomical', engine.teeth.length);
        engine.rendered = true;
    }

    /* ----------------------------------------------------------------------
       7. Click sobre superficie — bifurcado por scope del hallazgo activo
       ---------------------------------------------------------------------- */
    function onSurfaceClick(e) {
        e.stopPropagation();
        const poly    = e.currentTarget;
        const fdi     = poly.getAttribute('data-fdi');
        const surface = poly.getAttribute('data-surface');
        const finding = engine.activeFinding || DEFAULT_FINDING;

        if (finding.scope === 'whole-tooth') {
            applyFindingToWholeTooth(fdi, finding);
            registerEvent({
                fdi,
                scope:        'whole-tooth',
                surface:      null,
                state:        finding.state,
                findingCode:  finding.code,
                findingLabel: finding.label
            });
        } else {
            applyFindingToSurface(poly, finding);
            bringSurfaceToFront(poly);
            registerEvent({
                fdi,
                scope:        'surface',
                surface,
                state:        finding.state,
                findingCode:  finding.code,
                findingLabel: finding.label
            });
        }

        selectTooth(fdi);
    }

    /**
     * Aplica el estado clínico a un polígono individual.
     * Si state === 'existing' equivale a "borrador" — limpia todas las clases.
     */
    function applyFindingToSurface(poly, finding) {
        ALL_SURFACE_STATES.forEach(s => poly.classList.remove('odn-' + s));
        if (finding.state && finding.state !== 'existing') {
            poly.classList.add('odn-' + finding.state);
        }
        poly.setAttribute('data-finding-code',  finding.code  || '');
        poly.setAttribute('data-finding-label', finding.label || '');

        const toothG = poly.parentNode;
        if (toothG && toothG.classList.contains('odn-tooth')) {
            toothG.setAttribute('data-state', dominantToothState(toothG));
        }
    }

    /**
     * Aplica el hallazgo a las 5 superficies de la pieza. Usado para
     * hallazgos cuyo scope es 'whole-tooth' (Implante, Pieza Ausente,
     * Endodoncia, PFU, Pilar PPR, Intermediario PFP, Comp. pulpar, etc.).
     */
    function applyFindingToWholeTooth(fdi, finding) {
        const toothG = document.querySelector(`g.odn-tooth[data-fdi="${fdi}"]`);
        if (!toothG) return;
        toothG.querySelectorAll('polygon.odn-surface').forEach(poly => {
            applyFindingToSurface(poly, finding);
            bringSurfaceToFront(poly);
        });
        toothG.setAttribute('data-finding-code',  finding.code  || '');
        toothG.setAttribute('data-finding-label', finding.label || '');
        engine.toothLatest.set(fdi, {
            code:  finding.code,
            label: finding.label,
            state: finding.state,
            at:    new Date()
        });
    }

    /**
     * Reordena el polígono al final de su <g> padre (justo antes del
     * <text> de rótulo) para que su scale(1.12) no quede tapado por
     * superficies vecinas. SVG no respeta z-index — sólo el orden DOM.
     */
    function bringSurfaceToFront(poly) {
        const g = poly.parentNode;
        if (!g) return;
        const label = g.querySelector('text.odn-tooth__label');
        if (label) g.insertBefore(poly, label);
        else       g.appendChild(poly);
    }

    /**
     * Estado dominante de la pieza para data-state agregado.
     * Prioridad: active > planned > review > completed > control-ok > historic.
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
       8. Registro de eventos clínicos con AGRUPACIÓN multi-superficie
       --------------------------------------------------------------------
       Regla clínica: dos o más caras de una misma pieza marcadas con el
       MISMO hallazgo se fusionan en UN solo evento (ej. resina compuesta
       en O+M+D → un único evento "Pieza 1.4 OMD"). Aplicar un hallazgo
       distinto a una cara existente la "muda" automáticamente. El borrador
       (state='existing') simplemente extrae esa cara del evento.
       ---------------------------------------------------------------------- */
    function registerEvent(input) {
        const now    = new Date();
        const fdi    = input.fdi;
        const scope  = input.scope || 'surface';
        const state  = input.state || 'existing';
        const code   = input.findingCode  || null;
        const label  = input.findingLabel || STATE_LABEL[state] || 'Hallazgo';

        let resultEvt = null;

        // 1) Borrador sobre una cara → quitar esa cara de cualquier evento previo.
        if (state === 'existing' && scope === 'surface') {
            engine.events = engine.events.filter(e => {
                if (e.fdi !== fdi) return true;
                if (e.scope === 'whole-tooth') return false; // se rompe la uniformidad
                if (!e.surfaces) return true;
                const idx = e.surfaces.indexOf(input.surface);
                if (idx >= 0) e.surfaces.splice(idx, 1);
                if (e.surfaces.length === 0) return false;
                e.label     = buildEventLabel(e);
                e.narrative = buildEventNarrative(e);
                return true;
            });
            engine.surfaceLatest.delete(`${fdi}|${input.surface}`);
            renderTimeline();
            document.dispatchEvent(new CustomEvent('odontograma:event-registered', {
                detail: { fdi, scope, state, surface: input.surface, removed: true }
            }));
            return;
        }

        // 2) Hallazgo en pieza completa → reemplaza todo lo existente de la pieza.
        if (scope === 'whole-tooth') {
            engine.events = engine.events.filter(e => e.fdi !== fdi);
            // Limpiamos el índice de superficies sueltas para esta pieza.
            for (const k of Array.from(engine.surfaceLatest.keys())) {
                if (k.startsWith(`${fdi}|`)) engine.surfaceLatest.delete(k);
            }
            resultEvt = {
                id:           engine.autoIncrement++,
                timestamp:    now,
                fdi:          fdi,
                scope:        'whole-tooth',
                surfaces:     [],
                surface:      null,
                state:        state,
                findingCode:  code,
                findingLabel: label
            };
            resultEvt.label     = buildEventLabel(resultEvt);
            resultEvt.narrative = buildEventNarrative(resultEvt);
            engine.events.unshift(resultEvt);
            engine.surfaceLatest.set(`${fdi}|TOOTH`, resultEvt);
            renderTimeline();
            document.dispatchEvent(new CustomEvent('odontograma:event-registered', { detail: resultEvt }));
            return;
        }

        // 3) Cara individual con hallazgo activo.
        //    a) Quitar cualquier evento whole-tooth previo en esta pieza.
        //    b) De los eventos por-cara: si el código coincide → se mantendrá
        //       para append. Si no coincide → se le quita ESTA cara.
        engine.events = engine.events.filter(e => {
            if (e.fdi !== fdi) return true;
            if (e.scope === 'whole-tooth') return false;
            if (e.findingCode === code) return true;
            if (!e.surfaces) return true;
            const idx = e.surfaces.indexOf(input.surface);
            if (idx >= 0) e.surfaces.splice(idx, 1);
            if (e.surfaces.length === 0) return false;
            e.label     = buildEventLabel(e);
            e.narrative = buildEventNarrative(e);
            return true;
        });

        //    c) Find or create event for (fdi, code).
        let evt = engine.events.find(e =>
            e.fdi === fdi && e.scope === 'surface' && e.findingCode === code
        );

        if (evt) {
            if (!evt.surfaces) evt.surfaces = [];
            if (!evt.surfaces.includes(input.surface)) evt.surfaces.push(input.surface);
            evt.surface   = input.surface;
            evt.timestamp = now;
            evt.label     = buildEventLabel(evt);
            evt.narrative = buildEventNarrative(evt);
            // Mover al inicio (más reciente primero).
            engine.events = [evt, ...engine.events.filter(e => e !== evt)];
        } else {
            evt = {
                id:           engine.autoIncrement++,
                timestamp:    now,
                fdi:          fdi,
                scope:        'surface',
                surfaces:     [input.surface],
                surface:      input.surface,
                state:        state,
                findingCode:  code,
                findingLabel: label
            };
            evt.label     = buildEventLabel(evt);
            evt.narrative = buildEventNarrative(evt);
            engine.events.unshift(evt);
        }

        engine.surfaceLatest.set(`${fdi}|${input.surface}`, evt);
        renderTimeline();
        document.dispatchEvent(new CustomEvent('odontograma:event-registered', { detail: evt }));
    }

    function formatPieza(fdi) { return `${fdi.charAt(0)}.${fdi.charAt(1)}`; }

    function buildEventLabel(evt) {
        const pieza = formatPieza(evt.fdi);
        if (evt.scope === 'whole-tooth') {
            return `Pieza ${pieza} completa — ${evt.findingLabel}`;
        }
        const surfaces = evt.surfaces || (evt.surface ? [evt.surface] : []);
        if (surfaces.length === 0) {
            return `Pieza ${pieza} — ${evt.findingLabel}`;
        }
        if (surfaces.length === 1) {
            const s = surfaces[0];
            return `Pieza ${pieza}, Superficie ${SURFACE_LABEL[s] || s} (${s}) — ${evt.findingLabel}`;
        }
        // Multi-superficie: agrupa como "OMD" (códigos concatenados, orden de marcado).
        return `Pieza ${pieza}, Superficies ${surfaces.join('')} — ${evt.findingLabel}`;
    }

    function buildEventNarrative(evt) {
        if (evt.state === 'existing') return 'Marcado removido (borrador clínico).';
        if (evt.scope === 'whole-tooth') {
            return `Hallazgo registrado sobre toda la pieza: ${evt.findingLabel}.`;
        }
        const surfaces = evt.surfaces || (evt.surface ? [evt.surface] : []);
        if (surfaces.length > 1) {
            const names = surfaces.map(s => SURFACE_LABEL[s] || s).join(', ');
            return `${evt.findingLabel} aplicado a ${surfaces.length} superficies (${names}).`;
        }
        if (surfaces.length === 1) {
            return `${evt.findingLabel} en superficie ${SURFACE_LABEL[surfaces[0]] || surfaces[0]}.`;
        }
        return `${evt.findingLabel}.`;
    }

    function renderTimeline() {
        const rail  = document.getElementById('odontogramaTimelineRail');
        const chip  = document.getElementById('odnTimelineChip');
        if (!rail) return;

        const fdiFilter   = engine.selectedFDI;
        const stateFilter = engine.timelineFilter;

        const events = engine.events.filter(e => {
            if (fdiFilter && e.fdi !== fdiFilter) return false;
            if (stateFilter && stateFilter !== 'all' && e.state !== stateFilter) return false;
            return true;
        });

        if (chip) {
            if (fdiFilter) {
                chip.textContent = `Pieza ${formatPieza(fdiFilter)}`;
                chip.setAttribute('data-empty', 'false');
            } else {
                chip.textContent = `${engine.events.length} evento(s)`;
                chip.setAttribute('data-empty', engine.events.length === 0 ? 'true' : 'false');
            }
        }

        rail.innerHTML = '';

        if (events.length === 0) {
            const e = htmlEl('div', 'odn-timeline__empty');
            const icon = htmlEl('span', 'material-symbols-outlined', fdiFilter ? 'check_circle' : 'touch_app');
            icon.setAttribute('aria-hidden', 'true');
            e.appendChild(icon);
            e.appendChild(document.createTextNode(
                fdiFilter
                    ? `Sin registros para la pieza ${formatPieza(fdiFilter)} todavía.`
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

        const head  = htmlEl('div', 'odn-event__head');
        const pieza = formatPieza(evt.fdi);
        head.appendChild(htmlEl('span', 'odn-event__piece', `Pieza ${pieza}`));
        head.appendChild(htmlEl('span', 'odn-event__date',  formatTime(evt.timestamp)));
        card.appendChild(head);

        // Título adaptado a multi-superficie agrupada.
        let title;
        if (evt.scope === 'whole-tooth') {
            title = `Pieza completa — ${evt.findingLabel}`;
        } else {
            const surfaces = evt.surfaces || (evt.surface ? [evt.surface] : []);
            if (surfaces.length > 1) {
                title = `Superficies ${surfaces.join('')} — ${evt.findingLabel}`;
            } else if (surfaces.length === 1) {
                title = `${SURFACE_LABEL[surfaces[0]] || surfaces[0]} (${surfaces[0]}) — ${evt.findingLabel}`;
            } else {
                title = evt.findingLabel;
            }
        }
        card.appendChild(htmlEl('p', 'odn-event__title', title));

        const meta = htmlEl('div', 'odn-event__meta');
        const surfCount = (evt.surfaces && evt.surfaces.length) || (evt.surface ? 1 : 0);
        const tagText = evt.scope === 'whole-tooth'
            ? 'Pieza completa'
            : (surfCount > 1 ? `${surfCount} superficies agrupadas` : 'Superficie');
        const tag = htmlEl('span', 'odn-event__tag', tagText);
        meta.appendChild(tag);
        meta.appendChild(document.createTextNode(' ' + evt.narrative));
        card.appendChild(meta);

        card.addEventListener('click', () => {
            selectTooth(evt.fdi);
            const surfaces = evt.surfaces && evt.surfaces.length
                ? evt.surfaces
                : (evt.surface ? [evt.surface] : []);
            surfaces.forEach((s, i) => setTimeout(() => flashSurface(evt.fdi, s), i * 80));
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
       9. Selección de pieza
       ---------------------------------------------------------------------- */
    function selectTooth(fdi) {
        engine.selectedFDI = fdi;
        document.querySelectorAll('g.odn-tooth').forEach(g => {
            g.classList.toggle('odn-selected', g.getAttribute('data-fdi') === fdi);
        });
        renderTimeline();
        document.dispatchEvent(new CustomEvent('odontograma:tooth-selected', { detail: { fdi } }));
    }

    /* ----------------------------------------------------------------------
       10. Contadores de capa
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
       11. Acciones agregadas (panel "Pieza seleccionada")
       ---------------------------------------------------------------------- */
    function bulkApplyToSelectedTooth() {
        if (!engine.selectedFDI) return toast('Selecciona primero una pieza dental.');
        const finding = engine.activeFinding || DEFAULT_FINDING;
        if (finding.scope === 'whole-tooth') {
            applyFindingToWholeTooth(engine.selectedFDI, finding);
            registerEvent({
                fdi:          engine.selectedFDI,
                scope:        'whole-tooth',
                surface:      null,
                state:        finding.state,
                findingCode:  finding.code,
                findingLabel: finding.label
            });
        } else {
            // Surface scope: aplicamos a las 5 superficies en bloque + un evento por superficie.
            const polys = document.querySelectorAll(`g.odn-tooth[data-fdi="${engine.selectedFDI}"] polygon.odn-surface`);
            polys.forEach(poly => {
                applyFindingToSurface(poly, finding);
                bringSurfaceToFront(poly);
                registerEvent({
                    fdi:          engine.selectedFDI,
                    scope:        'surface',
                    surface:      poly.getAttribute('data-surface'),
                    state:        finding.state,
                    findingCode:  finding.code,
                    findingLabel: finding.label
                });
            });
        }
    }

    function planSelectedTooth() {
        if (!engine.selectedFDI) return toast('Selecciona primero una pieza dental.');
        const planFinding = {
            code:  'plan-generico',
            label: 'Tratamiento planificado',
            state: 'planned',
            scope: 'whole-tooth'
        };
        applyFindingToWholeTooth(engine.selectedFDI, planFinding);
        registerEvent({
            fdi:          engine.selectedFDI,
            scope:        'whole-tooth',
            surface:      null,
            state:        'planned',
            findingCode:  planFinding.code,
            findingLabel: planFinding.label
        });
    }

    function resolveActiveFindings() {
        if (!engine.selectedFDI) return toast('Selecciona primero una pieza dental.');
        const polys = document.querySelectorAll(
            `g.odn-tooth[data-fdi="${engine.selectedFDI}"] polygon.odn-surface.odn-active`
        );
        if (polys.length === 0) return toast('La pieza seleccionada no tiene patologías activas que resolver.');

        const resolved = {
            code:  'resolucion',
            label: 'Resuelto / archivado',
            state: 'historic',
            scope: 'surface'
        };
        polys.forEach(poly => {
            applyFindingToSurface(poly, resolved);
            bringSurfaceToFront(poly);
            registerEvent({
                fdi:          engine.selectedFDI,
                scope:        'surface',
                surface:      poly.getAttribute('data-surface'),
                state:        'historic',
                findingCode:  resolved.code,
                findingLabel: resolved.label
            });
        });
    }

    /* ----------------------------------------------------------------------
       12. Toast no bloqueante
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
       13. Cableado con el panel clínico (.odn-finding-btn, acordeón, etc.)
       ---------------------------------------------------------------------- */
    function setActiveFindingFromButton(btn) {
        document.querySelectorAll('.odn-finding-btn').forEach(b => b.classList.remove('odn-active'));
        btn.classList.add('odn-active');

        engine.activeFinding = {
            code:  btn.dataset.code  || 'sin-codigo',
            label: btn.dataset.label || btn.textContent.trim(),
            state: btn.dataset.state || 'existing',
            scope: btn.dataset.scope || 'surface'
        };

        document.dispatchEvent(new CustomEvent('odontograma:finding-change', {
            detail: Object.assign({}, engine.activeFinding)
        }));
    }

    function bindToUI() {
        // 13.1 Wiring de botones de hallazgo (Patología, Estado, Planificación, Borrador)
        document.querySelectorAll('.odn-finding-btn').forEach(btn => {
            btn.addEventListener('click', () => setActiveFindingFromButton(btn));
        });

        // 13.2 Acordeón: colapsar/expandir cada grupo clínico
        document.querySelectorAll('.odn-finding-group__head').forEach(head => {
            head.addEventListener('click', () => {
                const group = head.closest('.odn-finding-group');
                if (!group) return;
                const collapsed = group.getAttribute('data-collapsed') === 'true';
                group.setAttribute('data-collapsed', collapsed ? 'false' : 'true');
                head.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
            });
        });

        // 13.3 Filtros del timeline
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
        bind('odnBtnRegistrarHallazgo', bulkApplyToSelectedTooth);
        bind('odnBtnAgregarPlan',       planSelectedTooth);
        bind('odnBtnResolverHallazgo',  resolveActiveFindings);

        // 13.6 Acciones del header del modal — Export delega al PDF de la ficha
        bind('odnBtnExport', () => {
            document.dispatchEvent(new CustomEvent('odontograma:export-pdf', {
                detail: { events: engine.events.slice() }
            }));
        });
        bind('odnBtnSave', () => {
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
                const tag = (e.target.tagName || '').toLowerCase();
                if (tag === 'svg' || e.target.id === 'odontogramaStage') {
                    engine.selectedFDI = null;
                    document.querySelectorAll('g.odn-tooth.odn-selected')
                        .forEach(g => g.classList.remove('odn-selected'));
                    renderTimeline();
                }
            });
        }

        // 13.8 Filtros del timeline (botones-pill superiores del panel derecho)
        document.querySelectorAll('.odn-timeline__filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.odn-timeline__filter-btn')
                    .forEach(b => b.classList.remove('odn-active'));
                btn.classList.add('odn-active');
                engine.timelineFilter = btn.dataset.filter || 'all';
                renderTimeline();
            });
        });

        // 13.9 Controles de zoom y pantalla completa
        let zoomScale = 1;
        const applyZoom = () => {
            const svg = document.getElementById('odontogramaSVG');
            if (svg) svg.style.transform = `scale(${zoomScale})`;
        };
        bind('odnZoomIn',    () => { zoomScale = Math.min(2.5, zoomScale + 0.15); applyZoom(); });
        bind('odnZoomOut',   () => { zoomScale = Math.max(0.5, zoomScale - 0.15); applyZoom(); });
        bind('odnZoomReset', () => { zoomScale = 1; applyZoom(); });
        bind('odnFullscreen', () => {
            const shell = document.querySelector('#odontogramaModal .odn-shell');
            if (!shell) return;
            if (document.fullscreenElement) document.exitFullscreen();
            else if (shell.requestFullscreen) shell.requestFullscreen();
        });
    }

    /* ----------------------------------------------------------------------
       14. API pública
       ---------------------------------------------------------------------- */
    const api = {
        render:           renderOdontogram,
        selectTooth:      selectTooth,
        getEvents:        () => engine.events.slice(),
        getActiveFinding: () => Object.assign({}, engine.activeFinding),
        getState:         () => ({
            activeFinding: Object.assign({}, engine.activeFinding),
            selectedFDI:   engine.selectedFDI,
            eventCount:    engine.events.length
        }),
        registerExternal: (entry) => registerEvent(entry),
        reset: () => {
            engine.events.length = 0;
            engine.surfaceLatest.clear();
            engine.toothLatest.clear();
            engine.selectedFDI = null;
            engine.autoIncrement = 1;
            document.querySelectorAll('polygon.odn-surface').forEach(p => {
                ALL_SURFACE_STATES.forEach(s => p.classList.remove('odn-' + s));
                p.removeAttribute('data-finding-code');
                p.removeAttribute('data-finding-label');
            });
            document.querySelectorAll('g.odn-tooth').forEach(g => {
                g.setAttribute('data-state', 'existing');
                g.classList.remove('odn-selected');
                g.removeAttribute('data-finding-code');
                g.removeAttribute('data-finding-label');
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
        if (document.getElementById('odontogramaSVG')) renderOdontogram();
        window.MiDentalOdontograma = api;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

})();
