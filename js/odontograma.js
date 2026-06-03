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
            const removedEventIds = [];
            engine.events = engine.events.filter(e => {
                if (e.fdi !== fdi) return true;
                if (e.scope === 'whole-tooth') { removedEventIds.push(e.id); return false; }
                if (!e.surfaces) return true;
                const idx = e.surfaces.indexOf(input.surface);
                if (idx >= 0) e.surfaces.splice(idx, 1);
                if (e.surfaces.length === 0) { removedEventIds.push(e.id); return false; }
                e.label     = buildEventLabel(e);
                e.narrative = buildEventNarrative(e);
                return true;
            });
            engine.surfaceLatest.delete(`${fdi}|${input.surface}`);
            renderTimeline();
            document.dispatchEvent(new CustomEvent('odontograma:event-registered', {
                detail: { fdi, scope, state, surface: input.surface, removed: true, removedEventIds }
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

    /* ======================================================================
       16. EXTENSIONES V2 — TAREAS 2-3-4-5-6
       ----------------------------------------------------------------------
       Acá vive el nuevo flujo unificado:

         · TAREA 2 — Estado inmutable multi-pieza (engine.hallazgos).
         · TAREA 3 — Bloques "pendiente → planificado" con relleno verde.
         · TAREA 4 — Panel de Examen Periodontal (UI ya está en el HTML).
         · TAREA 5 — Motor de inferencia AAP/EFP 2017.
         · TAREA 6 — Persistencia con Supabase (window.midental).
       ====================================================================== */

    /* ----------------------------------------------------------------------
       16.1  Diccionario terapéutico — ARRAYS de opciones
       ----------------------------------------------------------------------
       Cada entrada es:
         · un array de strings con 2-3 alternativas terapéuticas viables, o
         · una función(evt) que devuelve dicho array (cuando el conteo de
           caras altera el ítem ofrecido, ej. resina 1 vs 2 caras).
       El bloque deja de auto-planificar: ahora el clínico elige.
       ---------------------------------------------------------------------- */
    const THERAPEUTIC_RX = {
        'sano': [
            'Manejo preventivo (pasta 1.450 ppm + control 6 meses)',
            'Aplicación de flúor barniz',
            'Sellante preventivo'
        ],
        'restauracion': [
            'Control radiográfico bite-wing + control 6 meses',
            'Pulido y reacondicionamiento de restauración',
            'Reemplazo de restauración'
        ],
        'ausente': [
            'Implante unitario',
            'Prótesis Parcial Removible',
            'Prótesis Fija Plural (Puente)'
        ],
        'rehabilitacion': [
            'Control trimestral de pilares',
            'Recementación de prótesis',
            'Recambio de prótesis'
        ],
        'fractura': [
            'Restauración Directa Resina',
            'Incrustación / Onlay',
            'Corona protésica (PFU)'
        ],
        'movilidad': [
            'Ferulización (composite/fibra)',
            'Ajuste oclusal selectivo',
            'Exodoncia (Movilidad Grado 3)'
        ],
        'iccms_1': [
            'Sellante de fosas y fisuras',
            'Remineralización con flúor barniz',
            'Control clínico 3 meses'
        ],
        'iccms_3': [
            'Sellante terapéutico',
            'Restauración Directa Resina (mínimamente invasiva)',
            'Remineralización + control bite-wing'
        ],
        'iccms_5': function (evt) {
            const n = caraCount(evt);
            const caras = (evt.surfaces || []).join('');
            const resina = (n >= 2)
                ? `Restauración Directa Resina ${n} caras (${caras})`
                : 'Restauración Directa Resina (1 cara)';
            return [
                resina,
                'Incrustación Estética (Cerómero/Disilicato)',
                'Amalgama (Opcional)'
            ];
        },
        'iccms_6': [
            'Recubrimiento pulpar indirecto + Restauración',
            'Derivación a Endodoncia',
            'Restauración compleja (multicaras)'
        ],
        'cp-reversible': [
            'Protección pulpar indirecta + Reevaluación 4–6 sem',
            'Restauración provisoria',
            'Restauración Directa Resina'
        ],
        'cp-irreversible-sint': [
            'Trepanación de urgencia',
            'Endodoncia convencional',
            'Endodoncia mecanizada'
        ],
        'cp-irreversible-asint': [
            'Pulpotomía cameral / parcial',
            'Endodoncia convencional',
            'Endodoncia mecanizada'
        ],
        'cp-necrosis': [
            'Trepanación + Endodoncia mecanizada',
            'Endodoncia convencional + control',
            'Derivación a Endodoncia'
        ],
        'pre-iniciado': [
            'Retomar instrumentación endodóntica',
            'Re-tratamiento endodóntico',
            'Derivación a Endodoncia'
        ],
        'perio-apical-sint': [
            'Endodoncia + control radiográfico',
            'Drenaje + Endodoncia diferida',
            'Apicectomía'
        ],
        'perio-apical-asint': [
            'Endodoncia convencional',
            'Re-tratamiento endodóntico',
            'Control radiográfico 6 meses'
        ],
        'absceso-agudo': [
            'URGENCIA · Drenaje + antibioticoterapia',
            'Trepanación de urgencia',
            'Endodoncia diferida'
        ],
        'absceso-cronico': [
            'Fistulografía + Endodoncia',
            'Endodoncia mecanizada',
            'Derivación a Cirugía'
        ],
        'osteitis': [
            'Resolver causa endodóntica',
            'Endodoncia + control 6 meses',
            'Control radiográfico'
        ],
        'removible': [
            'Control trimestral + pasta 5.000 ppm',
            'Rebase de prótesis',
            'Reemplazo de prótesis'
        ],
        'ortodoncia': [
            'Control trimestral + flúor barniz',
            'Higiene reforzada en bracket',
            'Sellantes peri-brackets'
        ],
        'contensor': [
            'Control de integridad de contensor',
            'Recementación de contensor',
            'Recambio de contensor'
        ],
        // Códigos sintéticos del módulo periodontal (no expanden — bloque fijo)
        'perio-supragingival': [ 'Destartraje Supragingival y Pulido Coronal (Boca Completa)' ],
        'perio-rar':           [ 'Raspaje y Alisado Radicular (RAR) por arcada / grupo' ]
    };

    function caraCount(evt) {
        if (!evt) return 0;
        if (evt.scope === 'whole-tooth') return 5;
        return (evt.surfaces && evt.surfaces.length) || (evt.surface ? 1 : 0);
    }

    /**
     * Devuelve el array de opciones terapéuticas para un evento.
     * Garantiza siempre un array (nunca string ni undefined).
     */
    function opcionesPara(evt) {
        const rx = THERAPEUTIC_RX[evt.findingCode];
        if (typeof rx === 'function') return rx(evt) || [];
        if (Array.isArray(rx))        return rx.slice();
        if (typeof rx === 'string')   return [rx];     // tolerancia retro
        return ['Definir plan terapéutico individualizado.'];
    }

    /* ----------------------------------------------------------------------
       16.2  Estado inmutable de hallazgos y bloques de planificación
       ----------------------------------------------------------------------
       engine.hallazgos: array de bloques. Cada bloque es:
         {
           id:           string  // estable y único — id del evento del odontograma
           pieza:        '18'    // FDI sin punto
           piezaLabel:   '1.8'   // FDI con separador
           caras:        ['O','M']   // (vacío si scope='whole-tooth')
           condicion:    'iccms_5'   // findingCode
           condicionLabel:'Caries Dentinaria'
           scope:        'surface' | 'whole-tooth'
           recomendacion:'+ Restauración Directa Resina 2 caras'
           estado:       'pendiente' | 'planificado' | 'auto-perio'
           timestamp:    ISO string
         }
       Las mutaciones siempre producen un nuevo array (spread). El
       array es la fuente única de verdad del historial. */
    engine.hallazgos = [];

    function fdiLabel(fdi) {
        return `${String(fdi).charAt(0)}.${String(fdi).charAt(1)}`;
    }

    function hallazgoFromEvent(evt) {
        const surfaces = (evt.surfaces && evt.surfaces.slice()) ||
                         (evt.surface ? [evt.surface] : []);
        const opciones = opcionesPara(evt);
        return Object.freeze({
            id:                     `evt-${evt.id}`,
            eventId:                evt.id,
            pieza:                  evt.fdi,
            piezaLabel:             fdiLabel(evt.fdi),
            caras:                  Object.freeze(surfaces),
            condicion:              evt.findingCode || 'sin-codigo',
            condicionLabel:         evt.findingLabel || 'Hallazgo',
            scope:                  evt.scope || 'surface',
            opciones:               Object.freeze(opciones.slice()),
            tratamientoSeleccionado:null,
            // Texto descriptivo: por defecto, la lista de opciones unida.
            // Cuando se elige una opción, se reemplaza por el tratamiento.
            recomendacion:          opciones.join(' · '),
            expandido:              false,
            estado:                 'pendiente',
            timestamp:              (evt.timestamp instanceof Date ? evt.timestamp : new Date()).toISOString()
        });
    }

    /**
     * Upsert inmutable: si ya existe un bloque para este eventId, lo
     * reemplaza preservando el estado (pendiente/planificado) salvo
     * que la condición haya cambiado.
     */
    function upsertHallazgo(evt) {
        const incoming = hallazgoFromEvent(evt);
        const idx = engine.hallazgos.findIndex(h => h.eventId === evt.id);
        if (idx === -1) {
            engine.hallazgos = [incoming, ...engine.hallazgos];
            return incoming;
        }
        const prev = engine.hallazgos[idx];
        // Preservar 'planificado' sólo si la condición coincide.
        const estado = (prev.condicion === incoming.condicion) ? prev.estado : 'pendiente';
        const merged = Object.freeze(Object.assign({}, incoming, { estado }));
        engine.hallazgos = [
            ...engine.hallazgos.slice(0, idx),
            merged,
            ...engine.hallazgos.slice(idx + 1)
        ];
        return merged;
    }

    function removeHallazgosByEventIds(ids) {
        if (!ids || !ids.length) return;
        const set = new Set(ids);
        engine.hallazgos = engine.hallazgos.filter(h => !set.has(h.eventId));
    }

    /* ----------------------------------------------------------------------
       16.3  Render de la lista de bloques + filtros
       ---------------------------------------------------------------------- */
    let historialFiltro = 'all';

    function renderHistorial() {
        const list  = document.getElementById('odnPlanList');
        const chip  = document.getElementById('odnHistorialChip');
        const empty = document.getElementById('odnPlanEmpty');
        if (!list) return;

        list.querySelectorAll('.odn-plan-block').forEach(el => el.remove());

        const visibles = engine.hallazgos.filter(h => {
            if (historialFiltro === 'all') return true;
            return h.estado === historialFiltro;
        });

        if (chip) chip.textContent = `${engine.hallazgos.length} hallazgo(s)`;
        if (empty) empty.style.display = visibles.length === 0 ? '' : 'none';
        list.setAttribute('data-empty', visibles.length === 0 ? 'true' : 'false');

        visibles.forEach(h => list.appendChild(buildPlanBlock(h)));
    }

    function buildPlanBlock(h) {
        const block = document.createElement('div');
        block.className = 'odn-plan-block';
        block.setAttribute('data-estado',    h.estado);
        block.setAttribute('data-id',        h.id);
        block.setAttribute('data-pieza',     h.pieza);
        block.setAttribute('data-condicion', h.condicion);
        if (h.expandido) block.setAttribute('data-expanded', 'true');
        if (h.estado === 'historico') {
            block.setAttribute('aria-readonly', 'true');
            block.setAttribute('title', 'Registro histórico — sólo lectura');
        }

        const carasTxt = (h.caras && h.caras.length) ? h.caras.join('') : (h.scope === 'whole-tooth' ? 'completa' : '—');
        const findingTitle = h.scope === 'whole-tooth'
            ? `${h.condicionLabel} — Pieza ${h.piezaLabel} (pieza completa)`
            : `${h.condicionLabel} ${carasTxt} — Pieza ${h.piezaLabel}`;

        const main = document.createElement('div');
        main.className = 'odn-plan-block__main';

        const f = document.createElement('p');
        f.className = 'odn-plan-block__finding';
        f.textContent = findingTitle;

        // Texto Rx adaptado:
        //  · historico   → muestra el tratamiento/recomendación tal como
        //                  se registró (audit-grade, inmutable).
        //  · planificado → muestra el tratamiento elegido en esta sesión.
        //  · pendiente   → invita a elegir.
        //  · auto-perio  → muestra la recomendación periodontal directa.
        const r = document.createElement('p');
        r.className = 'odn-plan-block__rx';
        if (h.estado === 'historico') {
            r.textContent = h.tratamientoSeleccionado || h.recomendacion || 'Registro clínico previo';
        } else if (h.estado === 'planificado' && h.tratamientoSeleccionado) {
            r.textContent = h.tratamientoSeleccionado;
        } else if (h.estado === 'auto-perio') {
            r.textContent = h.recomendacion;
        } else {
            r.textContent = `${h.opciones && h.opciones.length || 0} opciones terapéuticas — clic para elegir`;
            r.classList.add('odn-plan-block__rx--prompt');
        }

        const m = document.createElement('p');
        m.className = 'odn-plan-block__meta';
        // Para registros históricos preferimos la fecha ORIGINAL.
        const tsBase = (h.estado === 'historico' && h.timestampOriginal)
            ? h.timestampOriginal
            : h.timestamp;
        const fechaTxt = new Date(tsBase).toLocaleString('es-CL',
            { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
        let metaSufijo;
        if (h.estado === 'historico') {
            const orig = (h.estadoOriginal || 'previo').replace('-', ' ');
            metaSufijo = ` · 🔒 Sesión anterior (${orig}) — sólo lectura`;
        } else if (h.estado === 'planificado') {
            metaSufijo = ' · ✓ Aceptado para presupuesto';
        } else if (h.estado === 'auto-perio') {
            metaSufijo = ' · Diagnóstico periodontal inferido';
        } else {
            metaSufijo = ' · Click para desplegar opciones';
        }
        m.textContent = fechaTxt + metaSufijo;

        main.appendChild(f); main.appendChild(r); main.appendChild(m);

        const status = document.createElement('span');
        status.className = 'odn-plan-status';
        if (h.estado === 'historico')        status.textContent = 'Histórico';
        else if (h.estado === 'planificado') status.textContent = 'Planificado';
        else if (h.estado === 'auto-perio')  status.textContent = 'Periodontal';
        else                                 status.textContent = 'Pendiente';

        block.appendChild(main);
        block.appendChild(status);

        // ─── Menú desplegable de opciones terapéuticas ─────────────────
        //   · Sólo se muestra en bloques PENDIENTES de la sesión actual.
        //   · auto-perio y historico NO exponen opciones (read-only / fijo).
        const sinOpciones = h.estado === 'auto-perio' || h.estado === 'historico';
        if (!sinOpciones && h.opciones && h.opciones.length > 0) {
            const options = document.createElement('div');
            options.className = 'odn-treatment-options';
            options.setAttribute('role', 'group');
            options.setAttribute('aria-label', 'Opciones terapéuticas');

            const optTitle = document.createElement('span');
            optTitle.className = 'odn-treatment-options__title';
            optTitle.textContent = 'Selecciona el tratamiento a planificar:';
            options.appendChild(optTitle);

            h.opciones.forEach(op => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'odn-treatment-btn';
                btn.dataset.option = op;
                btn.dataset.blockId = h.id;
                if (h.tratamientoSeleccionado === op) {
                    btn.classList.add('odn-treatment-btn--selected');
                }
                btn.textContent = op;
                options.appendChild(btn);
            });

            block.appendChild(options);
        }
        return block;
    }

    /* ----------------------------------------------------------------------
       16.4  Interacción del bloque · Expand / Confirm / Revert (delegado)
       ----------------------------------------------------------------------
       Reglas:
         · Click sobre un bloque PENDIENTE → toggle del menú de opciones.
         · Click sobre una opción → CONFIRMA el tratamiento elegido:
              · estado: 'pendiente' → 'planificado'
              · tratamientoSeleccionado: opción elegida
              · paintAccepted (caras verdes #22c55e)
              · colapsa el menú
         · Click sobre un bloque PLANIFICADO → revierte a pendiente
              (desplanifica), des-pinta el verde y reabre opciones.
         · auto-perio: bloque informativo, no interactivo.
       Toda mutación produce un array NUEVO (inmutabilidad estricta).
       ---------------------------------------------------------------------- */

    function _replaceHallazgo(idx, patch) {
        const prev = engine.hallazgos[idx];
        const next = Object.freeze(Object.assign({}, prev, patch));
        engine.hallazgos = [
            ...engine.hallazgos.slice(0, idx),
            next,
            ...engine.hallazgos.slice(idx + 1)
        ];
        return next;
    }

    function toggleExpand(blockId) {
        const idx = engine.hallazgos.findIndex(h => h.id === blockId);
        if (idx === -1) return;
        const prev = engine.hallazgos[idx];
        if (prev.estado === 'auto-perio') return;
        _replaceHallazgo(idx, { expandido: !prev.expandido });
        renderHistorial();
    }

    function confirmarTratamiento(blockId, opcion) {
        const idx = engine.hallazgos.findIndex(h => h.id === blockId);
        if (idx === -1 || !opcion) return;
        const prev = engine.hallazgos[idx];
        if (prev.estado === 'auto-perio') return;

        const next = _replaceHallazgo(idx, {
            estado:                  'planificado',
            tratamientoSeleccionado: opcion,
            recomendacion:           opcion,   // refleja la elección en el JSON
            expandido:               false
        });
        paintAccepted(next, true);
        renderHistorial();
        document.dispatchEvent(new CustomEvent('odontograma:treatment-confirmed', {
            detail: { id: next.id, pieza: next.pieza, caras: next.caras.slice(), opcion }
        }));
    }

    function revertirPlanificacion(blockId) {
        const idx = engine.hallazgos.findIndex(h => h.id === blockId);
        if (idx === -1) return;
        const prev = engine.hallazgos[idx];
        if (prev.estado !== 'planificado') return;
        const opciones = prev.opciones && prev.opciones.length
            ? prev.opciones
            : Object.freeze([prev.tratamientoSeleccionado || 'Definir plan terapéutico individualizado.']);
        const next = _replaceHallazgo(idx, {
            estado:                  'pendiente',
            tratamientoSeleccionado: null,
            recomendacion:           opciones.join(' · '),
            expandido:               true
        });
        paintAccepted(prev, false);
        renderHistorial();
    }

    function paintAccepted(h, on) {
        const sel = (s) => `polygon.odn-surface[data-fdi="${h.pieza}"][data-surface="${s}"]`;
        const targets = (h.scope === 'whole-tooth')
            ? document.querySelectorAll(`g.odn-tooth[data-fdi="${h.pieza}"] polygon.odn-surface`)
            : (h.caras || []).flatMap(s => Array.from(document.querySelectorAll(sel(s))));
        targets.forEach(p => p.classList.toggle('odn-accepted', !!on));
    }

    /**
     * Pinta las caras del SVG como "Histórico heredado" — color neutro
     * (azul oscuro institucional #1e3a8a) que se distingue tajantemente
     * del verde #22c55e (planificado en sesión actual) y del rojo
     * patológico activo. Acepta tanto un hallazgo (h.pieza, h.caras)
     * como un evento del motor (e.fdi, e.surfaces).
     */
    function paintHistorico(input, on) {
        const fdi = input.pieza || input.fdi;
        if (!fdi) return;
        const surfaces = input.caras || input.surfaces ||
                         (input.surface ? [input.surface] : []);
        const sel = (s) => `polygon.odn-surface[data-fdi="${fdi}"][data-surface="${s}"]`;
        const targets = (input.scope === 'whole-tooth')
            ? document.querySelectorAll(`g.odn-tooth[data-fdi="${fdi}"] polygon.odn-surface`)
            : (surfaces || []).flatMap(s => Array.from(document.querySelectorAll(sel(s))));
        targets.forEach(p => p.classList.toggle('odn-historic-inherited', !!on));
    }

    function bindHistorialDelegation() {
        const list = document.getElementById('odnPlanList');
        if (!list) return;

        list.addEventListener('click', (e) => {
            // 1) Click sobre una opción terapéutica → confirmar.
            const optBtn = e.target.closest('.odn-treatment-btn');
            if (optBtn) {
                e.stopPropagation();
                confirmarTratamiento(optBtn.dataset.blockId, optBtn.dataset.option);
                return;
            }
            // 2) Click sobre el bloque (no en la zona de opciones).
            const block = e.target.closest('.odn-plan-block');
            if (!block) return;
            if (e.target.closest('.odn-treatment-options')) return; // ignora clicks dentro del menú vacío
            const id = block.getAttribute('data-id');
            const estadoActual = block.getAttribute('data-estado');
            // BLOQUEO LEGAL: los registros históricos son inmutables.
            if (estadoActual === 'historico' || estadoActual === 'auto-perio') return;
            if (estadoActual === 'planificado') {
                revertirPlanificacion(id);
            } else {
                toggleExpand(id);
            }
        });

        // Filtros (botones-pill del header del historial)
        document.querySelectorAll('.odn-historial__header .odn-timeline__filter-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.odn-historial__header .odn-timeline__filter-btn')
                    .forEach(b => b.classList.remove('odn-active'));
                btn.classList.add('odn-active');
                historialFiltro = btn.dataset.filter || 'all';
                renderHistorial();
            });
        });
    }

    /* ----------------------------------------------------------------------
       16.5  Listener del bus interno del odontograma
       ----------------------------------------------------------------------
       Cada vez que el motor emite `odontograma:event-registered`,
       sincronizamos la lista de bloques de planificación. */
    document.addEventListener('odontograma:event-registered', (e) => {
        const detail = e.detail || {};
        if (detail.removed) {
            // Si la lista de ids borrados vino vacía, fallback: sincronizar todo.
            if (detail.removedEventIds && detail.removedEventIds.length) {
                removeHallazgosByEventIds(detail.removedEventIds);
            } else {
                // Resync por inspección: cualquier hallazgo cuyo eventId no esté
                // ya en engine.events se elimina.
                const live = new Set(engine.events.map(ev => ev.id));
                engine.hallazgos = engine.hallazgos.filter(h => live.has(h.eventId));
            }
            renderHistorial();
            return;
        }
        if (detail.id != null) {
            upsertHallazgo(detail);
            renderHistorial();
        }
    });

    /* ======================================================================
       16.6  TAREA 4 — Examen Periodontal: cableado del panel
       ====================================================================== */
    engine.perio = {
        placa:      false,
        bop:        false,
        cal_leve:   false,
        cal_severa: false,
        fumador:    false,
        manejos:    [], // array de strings: destartraje, RAR-sup, etc.
        _lastDiag:  null // memoización del último resultado de la inferencia
    };

    function bindPerioPanel() {
        const panel = document.getElementById('odnPerioPanel');
        if (!panel) return;

        // Delegación para switches
        panel.addEventListener('change', (e) => {
            const t = e.target;
            if (t.matches('input[type="checkbox"][data-perio]')) {
                engine.perio[t.dataset.perio] = !!t.checked;
                generarDiagnosticoPeriodontal(engine.perio);
            }
        });

        // Delegación para botones de manejo (destartraje / RAR)
        panel.addEventListener('click', (e) => {
            const btn = e.target.closest('.odn-perio-btn[data-perio-rx]');
            if (!btn) return;
            const rx = btn.dataset.perioRx;
            inyectarManejoPerio(rx, btn.textContent.trim());
        });
    }

    /* ======================================================================
       16.7  TAREA 5 — Inferencia de diagnóstico periodontal AAP/EFP 2017
       ----------------------------------------------------------------------
       Matriz matemática (representación booleana del clasificador):

         Sea X = (placa, bop, cal_leve, cal_severa, fumador) ∈ {0,1}^5
         Sea S(X) = clase (estadio) definida por la MÁXIMA severidad observada:

            ┌─────────────────────────────────────────────────────────────┐
            │  S(X) =                                                     │
            │    'estadio_iii_iv'   si cal_severa = 1                     │
            │    'estadio_i_ii'     si cal_severa = 0 ∧ cal_leve = 1      │
            │    'gingivitis'       si cal_severa = 0 ∧ cal_leve = 0      │
            │                          ∧ bop = 1                          │
            │    'sano_o_inconcl.'  en cualquier otro caso                │
            └─────────────────────────────────────────────────────────────┘

         Sea G(X) = grado:
            G(X) = 'C'  si fumador = 1     (factor modificador obligatorio)
                 = 'B'  e.o.c.             (asignación por defecto)

         El manejo terapéutico M(S) se determina por la clase:
            M('gingivitis')     = "IHO + Destartraje Supragingival y Profilaxis"
            M('estadio_i_ii')   = "IHO + Raspaje y Alisado Radicular (RAR)"
            M('estadio_iii_iv') = "RAR + Reevaluación / Terapia Quirúrgica
                                   / Derivación a Especialidad"

         Importante: la presencia de placa por sí sola NO clasifica como
         enfermedad — sólo refuerza el IHO. La pérdida de inserción
         clínica (CAL) es la variable discriminante entre gingivitis
         (reversible) y periodontitis (no reversible).
       ====================================================================== */
    function generarDiagnosticoPeriodontal(datosPerio) {
        const d = datosPerio || engine.perio;
        const out = document.getElementById('odnPerioDiagOut');

        // 1) Clasificador del estadio: ramas mutuamente excluyentes en orden de severidad.
        let clase = null;
        let estadioLabel = null;
        let manejo = null;

        if (d.cal_severa) {
            clase = 'estadio_iii_iv';
            estadioLabel = 'Periodontitis Estadio III/IV';
            manejo = 'RAR + Reevaluación para potencial Terapia Quirúrgica / Derivación a Especialidad.';
        } else if (d.cal_leve) {
            clase = 'estadio_i_ii';
            estadioLabel = 'Periodontitis Estadio I/II';
            manejo = 'IHO + Raspaje y Alisado Radicular (RAR) por grupos / arcadas.';
        } else if (d.bop) {
            clase = 'gingivitis';
            estadioLabel = 'Gingivitis Inducida por Biopelícula';
            manejo = 'Instrucción de Higiene Oral (IHO) + Destartraje Supragingival y Profilaxis.';
        } else {
            // Sin BOP ni CAL → no hay diagnóstico de enfermedad.
            if (out) {
                out.setAttribute('data-diagnosticado', 'false');
                out.innerHTML = d.placa
                    ? '<em>Placa visible sin sangrado ni pérdida de inserción → reforzar Instrucción de Higiene Oral.</em>'
                    : '<em>Aún sin diagnóstico periodontal inferido.</em>';
            }
            // Si existía un bloque auto-perio anterior, retirarlo.
            engine.hallazgos = engine.hallazgos.filter(h => h.estado !== 'auto-perio');
            engine.perio._lastDiag = null;
            renderHistorial();
            return null;
        }

        // 2) Grado (modificador): fumador activo → C, en otro caso B.
        const grado = d.fumador ? 'C' : 'B';
        const diagnosticoFinal = `${estadioLabel}, Grado ${grado}`;

        // 3) Pintar resultado en el panel.
        if (out) {
            out.setAttribute('data-diagnosticado', 'true');
            out.innerHTML =
                `<strong>${diagnosticoFinal}</strong><br>` +
                `<span style="font-size:0.78rem;">Manejo sugerido: ${manejo}</span>`;
        }

        // 4) Inyectar (o reemplazar) bloque auto-perio en el historial.
        const blockId = `perio-${clase}-${grado}`;
        const ahora = new Date().toISOString();
        const bloque = Object.freeze({
            id:             blockId,
            eventId:        blockId,   // sintético, no proviene del SVG
            pieza:          '00',
            piezaLabel:     '—',
            caras:          Object.freeze([]),
            condicion:      `perio-${clase}`,
            condicionLabel: diagnosticoFinal,
            scope:          'whole-mouth',
            recomendacion:  manejo,
            estado:         'auto-perio',
            timestamp:      ahora
        });
        // Elimina los auto-perio previos (sólo se conserva el último diagnóstico).
        engine.hallazgos = engine.hallazgos.filter(h => h.estado !== 'auto-perio');
        engine.hallazgos = [bloque, ...engine.hallazgos];
        renderHistorial();

        document.dispatchEvent(new CustomEvent('odontograma:perio-diagnosed', {
            detail: { clase, grado, diagnostico: diagnosticoFinal, manejo, datos: Object.assign({}, d) }
        }));

        const result = { clase, grado, diagnostico: diagnosticoFinal, manejo };
        engine.perio._lastDiag = result;
        return result;
    }

    /* Manejo periodontal manual (botones de destartraje / RAR) — se
       inyecta como bloque "pendiente" para que el clínico decida.    */
    function inyectarManejoPerio(rxKey, rxLabel) {
        const id = `perio-rx-${rxKey}-${Date.now()}`;
        const isRAR = rxKey.startsWith('rar');
        const bloque = Object.freeze({
            id,
            eventId:        id,
            pieza:          '00',
            piezaLabel:     '—',
            caras:          Object.freeze([]),
            condicion:      isRAR ? 'perio-rar' : 'perio-supragingival',
            condicionLabel: rxLabel,
            scope:          'whole-mouth',
            recomendacion:  isRAR
                ? 'Raspaje y Alisado Radicular indicado en el área seleccionada.'
                : 'Destartraje supragingival completo + pulido coronal.',
            estado:         'pendiente',
            timestamp:      new Date().toISOString()
        });
        engine.hallazgos = [bloque, ...engine.hallazgos];
        renderHistorial();
    }

    /* ======================================================================
       16.7-bis  MOTOR DE RIESGO INTEGRAL (Cariología × Periodoncia)
       ----------------------------------------------------------------------
       Calcula un único nivel de riesgo a partir de:

          · `hallazgosCaries` (array de bloques engine.hallazgos)
          · `diagnosticoPerio` ({clase, grado, diagnostico, manejo} | null)

       Matriz de severidad (rank: alto=3, medio=2, bajo=1):

          CARIES
            alto   → ≥1 caries profunda (iccms_6) | compromiso pulpar (cp-*)
                     | ≥4 lesiones activas (iccms_3 + iccms_5)
            medio  → ≥1 activa (iccms_3 / iccms_5) | manchas blancas (iccms_1)
            bajo   → sin caries activas

          PERIODONCIA
            alto   → Estadio III/IV  ó  Grado C
            medio  → Gingivitis  ó  Estadio I/II (sin Grado C)
            bajo   → Sano / sin diagnóstico

          GLOBAL  = max(rank(caries), rank(perio))

          CONTROL_MESES
            alto  → 1
            medio → 3
            bajo  → 6

       Devuelve la estructura que se persiste en `historial_json.riesgo_integral`.
       ====================================================================== */
    function calcularRiesgoIntegral(hallazgosCaries, diagnosticoPerio) {
        const hallazgos = Array.isArray(hallazgosCaries)
            ? hallazgosCaries
            : engine.hallazgos.slice();
        const perio = diagnosticoPerio || engine.perio._lastDiag || null;

        // -------- Cariología --------
        let cariesProfundas = 0, cariesActivas = 0, manchas = 0, pulpar = 0;
        hallazgos.forEach(h => {
            const c = h && h.condicion;
            if (!c) return;
            if (c === 'iccms_6')                 cariesProfundas++;
            else if (c === 'iccms_5')            cariesActivas++;
            else if (c === 'iccms_3')            cariesActivas++;
            else if (c === 'iccms_1')            manchas++;
            else if (c.indexOf && c.indexOf('cp-') === 0) pulpar++;
        });

        let nivelCaries, recoCaries;
        if (cariesProfundas > 0 || pulpar > 0 || (cariesActivas >= 4)) {
            nivelCaries = 'alto';
            recoCaries  = 'Cariología: Terapia de choque con flúor barniz 5%, pasta 5.000 ppm, asesoramiento dietético estricto y resolución urgente de lesiones profundas.';
        } else if (cariesActivas > 0) {
            nivelCaries = 'medio';
            recoCaries  = 'Cariología: Sellantes en fosas y fisuras profundas, refuerzo de seda dental, control de azúcares entre comidas y control bite-wing 3 meses.';
        } else if (manchas > 0) {
            nivelCaries = 'medio';
            recoCaries  = 'Cariología: Remineralización con flúor barniz + reevaluación clínica/radiográfica en 3 meses.';
        } else {
            nivelCaries = 'bajo';
            recoCaries  = 'Cariología: Mantención preventiva con pasta 1.450 ppm flúor + control de placa.';
        }

        // -------- Periodoncia --------
        let nivelPerio, recoPerio, diagPerioTxt = null;
        if (!perio || !perio.clase) {
            nivelPerio   = 'bajo';
            recoPerio    = 'Periodoncia: Instrucción de Higiene Oral y control de placa.';
        } else {
            diagPerioTxt = `${perio.diagnostico}`;
            if (perio.clase === 'estadio_iii_iv' || perio.grado === 'C') {
                nivelPerio = 'alto';
                recoPerio  = `Periodoncia (${diagPerioTxt}): RAR + Reevaluación para potencial Terapia Quirúrgica / Derivación a Especialidad.`;
            } else if (perio.clase === 'estadio_i_ii') {
                nivelPerio = 'medio';
                recoPerio  = `Periodoncia (${diagPerioTxt}): IHO + Raspaje y Alisado Radicular (RAR) por grupos/arcadas.`;
            } else if (perio.clase === 'gingivitis') {
                nivelPerio = 'medio';
                recoPerio  = `Periodoncia (${diagPerioTxt}): IHO + Destartraje Supragingival y Profilaxis.`;
            } else {
                nivelPerio = 'bajo';
                recoPerio  = `Periodoncia (${diagPerioTxt}): Mantención preventiva.`;
            }
        }

        // -------- Combinación (peor escenario) --------
        const rank = { 'alto': 3, 'medio': 2, 'bajo': 1 };
        const nivel = (rank[nivelCaries] >= rank[nivelPerio]) ? nivelCaries : nivelPerio;
        const control_meses = nivel === 'alto' ? 1 : (nivel === 'medio' ? 3 : 6);

        // Mensaje combinado: cariología + periodoncia, una sola oración por área.
        const recomendaciones = `${recoCaries}  ${recoPerio}`;

        return {
            nivel:           nivel,                  // 'alto' | 'medio' | 'bajo'
            recomendaciones: recomendaciones,
            control_meses:   control_meses,
            fecha_calculo:   new Date().toISOString(),
            desglose: {
                caries: {
                    nivel:         nivelCaries,
                    recomendacion: recoCaries,
                    contadores: { profundas: cariesProfundas, activas: cariesActivas, manchas, pulpar }
                },
                perio: {
                    nivel:         nivelPerio,
                    recomendacion: recoPerio,
                    diagnostico:   diagPerioTxt,
                    clase:         perio ? (perio.clase || null) : null,
                    grado:         perio ? (perio.grado || null) : null
                }
            }
        };
    }

    /* ======================================================================
       16.8  TAREA 6 — Persistencia con Supabase
       ----------------------------------------------------------------------
       Columnas asumidas en `fichas_clinicas`:
         · odontograma_json (jsonb) → snapshot completo del SVG y hallazgos.
         · historial_json   (jsonb) → bloques del historial + estado perio
                                       + riesgo_integral (motor 16.7-bis).
       ====================================================================== */
    function snapshotEstado() {
        return {
            version:   2,
            generadoEn: new Date().toISOString(),
            hallazgos: engine.hallazgos.map(h => ({
                id:                       h.id,
                eventId:                  h.eventId,
                pieza:                    h.pieza,
                piezaLabel:               h.piezaLabel,
                caras:                    (h.caras || []).slice(),
                condicion:                h.condicion,
                condicionLabel:           h.condicionLabel,
                scope:                    h.scope,
                opciones:                 (h.opciones || []).slice(),
                tratamientoSeleccionado:  h.tratamientoSeleccionado || null,
                recomendacion:            h.recomendacion,
                estado:                   h.estado,
                estadoOriginal:           h.estadoOriginal || null,
                timestampOriginal:        h.timestampOriginal || null,
                timestamp:                h.timestamp
            })),
            eventos:   engine.events.map(e => ({
                id:           e.id,
                fdi:          e.fdi,
                scope:        e.scope,
                surfaces:     (e.surfaces || []).slice(),
                surface:      e.surface || null,
                state:        e.state,
                findingCode:  e.findingCode,
                findingLabel: e.findingLabel,
                timestamp:    (e.timestamp instanceof Date ? e.timestamp.toISOString() : e.timestamp)
            })),
            perio:     Object.assign({}, engine.perio)
        };
    }

    async function guardarOdontograma(fichaId) {
        if (!fichaId) {
            console.error('[Odontograma] guardarOdontograma: fichaId requerido.');
            return { ok: false, error: 'fichaId requerido' };
        }
        if (!window.midental) {
            console.error('[Odontograma] guardarOdontograma: SDK Supabase no inicializado.');
            return { ok: false, error: 'supabase no inicializado' };
        }
        try {
            const snap = snapshotEstado();
            const riesgoIntegral = calcularRiesgoIntegral(engine.hallazgos.slice(), engine.perio._lastDiag);
            const odontogramaJson = {
                eventos: snap.eventos,
                perio:   snap.perio,
                version: snap.version
            };
            const historialJson = {
                hallazgos:       snap.hallazgos,
                perio:           snap.perio,
                riesgo_integral: riesgoIntegral,    // ← persistencia del motor unificado
                generadoEn:      snap.generadoEn
            };

            const { data, error } = await window.midental
                .from('fichas_clinicas')
                .update({
                    odontograma_json: odontogramaJson,
                    historial_json:   historialJson
                })
                .eq('id', fichaId)
                .select()
                .maybeSingle();

            if (error) throw error;
            console.info('[Odontograma] guardado en fichas_clinicas#%s ✓', fichaId);
            document.dispatchEvent(new CustomEvent('odontograma:saved', { detail: { fichaId, data } }));
            return { ok: true, data };
        } catch (err) {
            console.error('[Odontograma] Error al guardar:', err);
            return { ok: false, error: err && err.message ? err.message : String(err) };
        }
    }

    /**
     * Carga histórica por ID de FICHA específica. Variante "auditoría" que
     * preserva los estados originales (planificado / pendiente). Útil para
     * revisar una atención antigua sin reciclar sus planes.
     * El flujo clínico estándar (herencia de sesión) usa `cargarOdontograma`
     * con `pacienteId` + RPC `get_ultimo_odontograma`.
     */
    async function cargarOdontogramaPorFicha(fichaId) {
        if (!fichaId) {
            console.error('[Odontograma] cargarOdontogramaPorFicha: fichaId requerido.');
            return { ok: false, error: 'fichaId requerido' };
        }
        if (!window.midental) {
            console.error('[Odontograma] cargarOdontogramaPorFicha: SDK Supabase no inicializado.');
            return { ok: false, error: 'supabase no inicializado' };
        }
        try {
            const { data, error } = await window.midental
                .from('fichas_clinicas')
                .select('odontograma_json, historial_json')
                .eq('id', fichaId)
                .maybeSingle();

            if (error) throw error;
            if (!data) {
                console.warn('[Odontograma] No existe ficha %s — partiendo de estado vacío.', fichaId);
                return { ok: true, data: null };
            }

            // 1) Asegurar render del SVG antes de pintar.
            if (!engine.rendered) renderOdontogram();

            // 2) Reset visual + estructural sin perder bindings.
            api.reset();
            engine.hallazgos = [];

            // 3) Re-hidratar engine.events directamente (sin volver a disparar
            //    el bus, para no sobrescribir el estado pendiente/planificado).
            const eventos = (data.odontograma_json && data.odontograma_json.eventos) || [];
            engine.events = eventos.map(e => {
                const evt = {
                    id:           e.id,
                    fdi:          e.fdi,
                    scope:        e.scope,
                    surfaces:     (e.surfaces || []).slice(),
                    surface:      e.surface || null,
                    state:        e.state,
                    findingCode:  e.findingCode,
                    findingLabel: e.findingLabel,
                    timestamp:    e.timestamp ? new Date(e.timestamp) : new Date()
                };
                evt.label     = buildEventLabel(evt);
                evt.narrative = buildEventNarrative(evt);
                return evt;
            });
            const maxId = engine.events.reduce((m, e) => Math.max(m, e.id || 0), 0);
            engine.autoIncrement = maxId + 1;

            // 4) Repintar el SVG según los eventos restaurados.
            engine.events.forEach(e => {
                const finding = {
                    code:  e.findingCode,
                    label: e.findingLabel,
                    state: e.state,
                    scope: e.scope === 'whole-tooth' ? 'whole-tooth' : 'surface'
                };
                if (e.scope === 'whole-tooth') {
                    applyFindingToWholeTooth(e.fdi, finding);
                } else {
                    (e.surfaces || (e.surface ? [e.surface] : [])).forEach(s => {
                        const poly = document.querySelector(`polygon.odn-surface[data-fdi="${e.fdi}"][data-surface="${s}"]`);
                        if (poly) applyFindingToSurface(poly, finding);
                    });
                }
            });
            renderTimeline();

            // 3) Re-hidratar hallazgos (bloques de historial) — fuente de verdad
            //    para la UI inferior. Esto preserva el estado Planificado/Pendiente.
            const hallazgosGuardados = (data.historial_json && data.historial_json.hallazgos) || [];
            engine.hallazgos = hallazgosGuardados.map(h => {
                // Backward-compat: si el JSON viene de la versión anterior
                // (sin `opciones`), regeneramos las opciones desde el
                // diccionario terapéutico actual a partir de `condicion`.
                const opciones = (Array.isArray(h.opciones) && h.opciones.length)
                    ? h.opciones.slice()
                    : opcionesPara({
                        findingCode: h.condicion,
                        scope:       h.scope,
                        surfaces:    (h.caras || []).slice()
                    });
                const tratamiento = h.tratamientoSeleccionado ||
                    (h.estado === 'planificado' ? (h.recomendacion || null) : null);
                return Object.freeze({
                    id:                       h.id,
                    eventId:                  h.eventId,
                    pieza:                    h.pieza,
                    piezaLabel:               h.piezaLabel || fdiLabel(h.pieza),
                    caras:                    Object.freeze((h.caras || []).slice()),
                    condicion:                h.condicion,
                    condicionLabel:           h.condicionLabel,
                    scope:                    h.scope,
                    opciones:                 Object.freeze(opciones),
                    tratamientoSeleccionado:  tratamiento,
                    recomendacion:            tratamiento || opciones.join(' · '),
                    expandido:                false,
                    estado:                   h.estado || 'pendiente',
                    timestamp:                h.timestamp || new Date().toISOString()
                });
            });

            // 4) Repintar caras verdes para los bloques en estado 'planificado'.
            engine.hallazgos
                .filter(h => h.estado === 'planificado')
                .forEach(h => paintAccepted(h, true));

            // 5) Periodontal — restaurar switches + relanzar inferencia.
            const perioGuardado = (data.odontograma_json && data.odontograma_json.perio) || {};
            Object.assign(engine.perio, {
                placa:      !!perioGuardado.placa,
                bop:        !!perioGuardado.bop,
                cal_leve:   !!perioGuardado.cal_leve,
                cal_severa: !!perioGuardado.cal_severa,
                fumador:    !!perioGuardado.fumador
            });
            document.querySelectorAll('#odnPerioPanel input[type="checkbox"][data-perio]').forEach(cb => {
                cb.checked = !!engine.perio[cb.dataset.perio];
            });
            generarDiagnosticoPeriodontal(engine.perio);

            renderHistorial();
            console.info('[Odontograma] cargado por ficha %s ✓ (%d eventos, %d bloques)',
                         fichaId, eventos.length, engine.hallazgos.length);
            document.dispatchEvent(new CustomEvent('odontograma:loaded', { detail: { fichaId } }));
            return { ok: true, data };
        } catch (err) {
            console.error('[Odontograma] Error al cargar por ficha:', err);
            return { ok: false, error: err && err.message ? err.message : String(err) };
        }
    }

    /* ======================================================================
       16.8-bis  HERENCIA CRONOLÓGICA · cargarOdontograma(pacienteId)
       ----------------------------------------------------------------------
       Flujo clínico estándar cuando el paciente regresa a consulta:

         1) Llama al RPC `get_ultimo_odontograma(p_paciente_id)` definido
            en Supabase (devuelve la última fila de fichas_clinicas con
            odontograma_json / historial_json para ese paciente).
         2) Marca TODO lo recuperado con estado inmutable `historico`:
              · engine.events[i].state         = 'historic'
              · engine.hallazgos[i].estado     = 'historico'
              · engine.hallazgos[i].estadoOriginal preserva el estado
                anterior (planificado / pendiente / realizado) para auditoría.
         3) Repinta el SVG con la clase visual `.odn-historic-inherited`
            (azul oscuro #1e3a8a) — claramente distinta del verde
            #22c55e (planificado en sesión actual) y del rojo patológico.
         4) Bloquea la interacción de esos bloques (delegación los ignora).
         5) Deja `engine.perio` en estado limpio: los switches periodontales
            son evaluación de HOY, no se heredan.

       Cualquier hallazgo nuevo que el clínico marque a partir de aquí se
       acumula en engine.hallazgos con estado 'pendiente'/'planificado'
       y convive con la herencia histórica. Al guardar, `guardarOdontograma`
       persiste el array consolidado en la nueva fila del día.
       ====================================================================== */
    async function cargarOdontograma(pacienteId) {
        if (!pacienteId) {
            console.error('[Odontograma] cargarOdontograma: pacienteId requerido.');
            return { ok: false, error: 'pacienteId requerido' };
        }
        if (!window.midental) {
            console.error('[Odontograma] cargarOdontograma: SDK Supabase no inicializado.');
            return { ok: false, error: 'supabase no inicializado' };
        }
        try {
            const { data, error } = await window.midental.rpc(
                'get_ultimo_odontograma',
                { p_paciente_id: pacienteId }
            );
            if (error) throw error;

            // El RPC puede devolver: null | un row | array de rows. Normalizamos.
            const row = Array.isArray(data) ? data[0] : data;
            if (!row) {
                console.info('[Odontograma] Paciente %s sin odontograma previo — sesión limpia.', pacienteId);
                document.dispatchEvent(new CustomEvent('odontograma:loaded-historic', {
                    detail: { pacienteId, row: null, found: false }
                }));
                return { ok: true, data: null };
            }

            const odontogramaJson = row.odontograma_json ||
                                    (row.json && row.json.odontograma_json) || null;
            const historialJson   = row.historial_json ||
                                    (row.json && row.json.historial_json)   || null;

            // 1) Asegurar render del SVG antes de pintar.
            if (!engine.rendered) renderOdontogram();

            // 2) Reset visual + estructural sin perder bindings.
            api.reset();
            engine.hallazgos = [];

            // 3) Re-hidratar engine.events con state = 'historic'.
            //    El motor ya conoce 'historic' como un estado pintable.
            const eventos = (odontogramaJson && odontogramaJson.eventos) || [];
            engine.events = eventos.map(e => {
                const evt = {
                    id:           e.id,
                    fdi:          e.fdi,
                    scope:        e.scope,
                    surfaces:     (e.surfaces || []).slice(),
                    surface:      e.surface || null,
                    state:        'historic',      // ← forzamos inmutabilidad
                    findingCode:  e.findingCode,
                    findingLabel: e.findingLabel,
                    timestamp:    e.timestamp ? new Date(e.timestamp) : new Date()
                };
                evt.label     = buildEventLabel(evt);
                evt.narrative = buildEventNarrative(evt);
                return evt;
            });
            const maxId = engine.events.reduce((m, e) => Math.max(m, e.id || 0), 0);
            engine.autoIncrement = maxId + 1;

            // 4) Repintar SVG: estado histórico + marca visual de herencia.
            engine.events.forEach(e => {
                const finding = {
                    code:  e.findingCode,
                    label: e.findingLabel,
                    state: 'historic',
                    scope: e.scope === 'whole-tooth' ? 'whole-tooth' : 'surface'
                };
                if (e.scope === 'whole-tooth') {
                    applyFindingToWholeTooth(e.fdi, finding);
                } else {
                    (e.surfaces || (e.surface ? [e.surface] : [])).forEach(s => {
                        const poly = document.querySelector(
                            `polygon.odn-surface[data-fdi="${e.fdi}"][data-surface="${s}"]`
                        );
                        if (poly) applyFindingToSurface(poly, finding);
                    });
                }
                paintHistorico(e, true);
            });

            // 5) Re-hidratar hallazgos como bloques inmutables 'historico'.
            const hallazgosGuardados = (historialJson && historialJson.hallazgos) || [];
            engine.hallazgos = hallazgosGuardados.map(h => {
                const opciones = (Array.isArray(h.opciones) && h.opciones.length)
                    ? h.opciones.slice()
                    : opcionesPara({
                        findingCode: h.condicion,
                        scope:       h.scope,
                        surfaces:    (h.caras || []).slice()
                    });
                const tratamiento = h.tratamientoSeleccionado ||
                    (h.estado === 'planificado' ? (h.recomendacion || null) : null);
                return Object.freeze({
                    id:                       h.id,
                    eventId:                  h.eventId,
                    pieza:                    h.pieza,
                    piezaLabel:               h.piezaLabel || fdiLabel(h.pieza),
                    caras:                    Object.freeze((h.caras || []).slice()),
                    condicion:                h.condicion,
                    condicionLabel:           h.condicionLabel,
                    scope:                    h.scope,
                    opciones:                 Object.freeze(opciones),
                    tratamientoSeleccionado:  tratamiento,
                    recomendacion:            tratamiento || h.recomendacion ||
                                              (opciones && opciones.join(' · ')) || '',
                    expandido:                false,
                    estado:                   'historico',           // ← inmutable
                    estadoOriginal:           h.estado || 'previo',  // auditoría
                    timestampOriginal:        h.timestamp || row.created_at || null,
                    timestamp:                h.timestamp || new Date().toISOString()
                });
            });

            // 6) Periodoncia: la del día es nueva. Sólo conservamos
            //    referencia al diagnóstico anterior si existía riesgo_integral.
            engine.perio.placa = false;
            engine.perio.bop = false;
            engine.perio.cal_leve = false;
            engine.perio.cal_severa = false;
            engine.perio.fumador = false;
            engine.perio._lastDiag = null;
            document.querySelectorAll('#odnPerioPanel input[type="checkbox"][data-perio]').forEach(cb => {
                cb.checked = false;
            });
            const out = document.getElementById('odnPerioDiagOut');
            if (out) {
                out.setAttribute('data-diagnosticado', 'false');
                out.innerHTML = '<em>Reevaluación periodontal pendiente para esta sesión.</em>';
            }

            renderTimeline();
            renderHistorial();
            console.info('[Odontograma] Histórico cargado vía RPC ✓ paciente=%s (%d eventos, %d bloques) — modo solo-lectura',
                         pacienteId, eventos.length, engine.hallazgos.length);
            document.dispatchEvent(new CustomEvent('odontograma:loaded-historic', {
                detail: { pacienteId, row, found: true }
            }));
            return { ok: true, data: row };
        } catch (err) {
            console.error('[Odontograma] Error al cargar histórico vía RPC:', err);
            return { ok: false, error: err && err.message ? err.message : String(err) };
        }
    }

    /* ----------------------------------------------------------------------
       16.9  Wiring final + ampliación de la API pública
       ---------------------------------------------------------------------- */
    function bootV2() {
        bindHistorialDelegation();
        bindPerioPanel();
        renderHistorial();
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootV2);
    } else {
        bootV2();
    }

    // Extiende la API pública (objeto creado en sección 14).
    api.getHallazgos               = () => engine.hallazgos.slice();
    api.getPerio                   = () => Object.assign({}, engine.perio);
    api.confirmarTratamiento       = confirmarTratamiento;
    api.revertirPlanificacion      = revertirPlanificacion;
    api.toggleExpand               = toggleExpand;
    api.generarDiagnosticoPerio    = generarDiagnosticoPeriodontal;
    api.calcularRiesgoIntegral     = calcularRiesgoIntegral;
    api.guardarOdontograma         = guardarOdontograma;
    api.cargarOdontograma          = cargarOdontograma;           // ← RPC + histórico
    api.cargarOdontogramaPorFicha  = cargarOdontogramaPorFicha;   // ← legacy directo
    api.paintHistorico             = paintHistorico;
    api.snapshot                   = snapshotEstado;

})();
