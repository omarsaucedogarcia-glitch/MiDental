// ========================================================================
// js/motor-decisiones-ia.js
// CEREBRO DEL CENTRO DE INTELIGENCIA DE MIDENTAL
// ========================================================================

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Validar sesión
    const userId = localStorage.getItem('midental_user_id');
    if (!userId) {
        window.location.href = 'index.html';
        return;
    }

    // 2. Iniciar UI de carga
    iniciarAuditoriaVisual();

    // Datos de respaldo: si la consulta a Supabase falla, seguimos con esto.
    // Antes, un fallo aquí abortaba renderizarDashboard() y los botones
    // "Explorar Estrategia" quedaban SIN handler (clic = nada pasaba).
    let clinicaData = {
        doctor: "Doctor",
        telefono: "",
        metricas: { agendados: 0, atendidos: 0, noShow: 0, tasaNoShow: 0, servicioEstrella: "Evaluación General" }
    };

    try {
        // ==========================================
        // CAPA 1: KNOWLEDGE (Recolección de Hechos)
        // ==========================================
        clinicaData = await recolectarConocimientoClinico(userId);
    } catch (error) {
        console.error("Error al sincronizar los datos de la clínica:", error);
    }

    try {
        // ==========================================
        // CAPA 2: REASONING (Motor de Decisiones)
        // ==========================================
        const prioridades = motorDeDecisiones(clinicaData);

        // Actualizar la Interfaz con los datos reales
        renderizarDashboard(clinicaData, prioridades);
    } catch (error) {
        console.error("Error al renderizar el Centro de Inteligencia:", error);
        document.getElementById('pantalla-sincronizacion').style.display = 'none';
        document.getElementById('pantalla-comite').style.display = 'block';
    }
});

// ----------------------------------------------------
// UTILIDADES DE DIAGNÓSTICO
// ----------------------------------------------------

// getElementById que falla ruidosamente. Evita el clásico
// "Cannot set properties of null" sin pista de qué id faltó.
function porId(id) {
    const nodo = document.getElementById(id);
    if (!nodo) throw new Error(`Falta el elemento #${id} en el HTML.`);
    return nodo;
}

// supabase-js NO expone el mensaje del servidor en error.message: para un
// status no-2xx devuelve un FunctionsHttpError genérico
// ("Edge Function returned a non-2xx status code") y guarda la Response real
// en error.context. Sin esto es imposible distinguir un 401 de auth, un 400
// de payload o un 502 de Gemini.
async function describirErrorEdgeFunction(error) {
    const generico = error?.message || 'Error desconocido al invocar la Edge Function.';
    const respuesta = error?.context;

    if (!respuesta || typeof respuesta.text !== 'function') {
        return { mensaje: generico, status: null, stage: null };
    }

    const status = respuesta.status ?? null;
    let cuerpo = '';
    try {
        // clone(): el body de un Response se consume una sola vez. Sin esto,
        // cualquier segunda lectura del mismo error se queda sin detalle.
        cuerpo = await (typeof respuesta.clone === 'function' ? respuesta.clone() : respuesta).text();
    } catch (_) {
        return { mensaje: `${generico} (HTTP ${status})`, status, stage: null };
    }

    let detalle = cuerpo;
    let stage = null;
    try {
        const json = JSON.parse(cuerpo);
        detalle = json.error || json.message || cuerpo;
        stage = json.stage || null;
        if (Array.isArray(json.intentos)) detalle += ` [${json.intentos.join(' | ')}]`;
    } catch (_) {
        // Cuerpo no-JSON (p. ej. HTML del gateway en un 401/546): se usa tal cual.
    }

    if (status === 401 || status === 403) {
        detalle = `Autorización rechazada por Supabase (HTTP ${status}). Revisa que la función tenga verify_jwt = false o que la sesión esté activa. ${detalle}`;
    }

    return { mensaje: detalle || generico, status, stage };
}

// ----------------------------------------------------
// FUNCIONES DE KNOWLEDGE LAYER (Datos desde Supabase)
// ----------------------------------------------------
async function recolectarConocimientoClinico(userId) {
    const hoy = new Date();
    const mesActual = hoy.getMonth() + 1;
    const yearActual = hoy.getFullYear();

    // 1. Obtener perfil
    const { data: perfil } = await window.midental
        .from('perfiles_dentistas')
        .select('nombre_completo, telefono')
        .eq('id', userId)
        .single();

    // 2. Obtener citas del mes
    const { data: citas } = await window.midental
        .from('citas_agenda')
        .select('estado, motivo, created_at')
        .eq('dentista_id', userId);

    let agendados = 0, atendidos = 0, noShow = 0;
    const motivosConteo = {};

    if (citas) {
        const citasMes = citas.filter(cita => {
            if(!cita.created_at) return false;
            const fechaCita = new Date(cita.created_at);
            return fechaCita.getMonth() + 1 === mesActual && fechaCita.getFullYear() === yearActual;
        });

        agendados = citasMes.length;

        citasMes.forEach(cita => {
            const estado = (cita.estado || '').toLowerCase();
            if (estado === 'completada' || estado === 'en_atencion') {
                atendidos++;
                const motivo = cita.motivo || 'Consulta General';
                motivosConteo[motivo] = (motivosConteo[motivo] || 0) + 1;
            } else if (estado === 'no_asiste') {
                noShow++;
            }
        });
    }

    // Calcular servicio estrella
    let servicioEstrella = "Evaluación General";
    if (Object.keys(motivosConteo).length > 0) {
        servicioEstrella = Object.entries(motivosConteo).sort((a, b) => b[1] - a[1])[0][0];
    }

    return {
        doctor: perfil?.nombre_completo || "Dr. Omar Saucedo García",
        telefono: perfil?.telefono || "",
        metricas: {
            agendados,
            atendidos,
            noShow,
            tasaNoShow: agendados > 0 ? Math.round((noShow / agendados) * 100) : 0,
            servicioEstrella
        }
    };
}

// ----------------------------------------------------
// FUNCIONES DE REASONING LAYER (El "Decision Engine")
// ----------------------------------------------------
function motorDeDecisiones(clinicaData) {
    const metricas = clinicaData.metricas;
    let prioridades = [];

    // REGLA 1: Si hay mucha inasistencia (> 10%)
    if (metricas.tasaNoShow > 10) {
        prioridades.push({
            id: 'educacion_noshow',
            titulo: 'Reducir Inasistencias',
            enfoque: 'Educación y Compromiso',
            impacto: 'ALTO',
            confianza: 92,
            explicacion: `Tu tasa de No-Show es del ${metricas.tasaNoShow}%. Una campaña concientizando sobre la importancia de asistir o cancelar a tiempo liberará horas perdidas.`,
            promptObjetivo: "Educar a los pacientes sobre la importancia de asistir a sus citas odontológicas y el impacto de cancelar a última hora."
        });
    }

    // REGLA 2: Potenciar lo que ya funciona (Servicio Estrella)
    prioridades.push({
        id: 'potenciar_estrella',
        titulo: `Promover ${metricas.servicioEstrella}`,
        enfoque: metricas.servicioEstrella,
        impacto: metricas.tasaNoShow > 10 ? 'MODERADO' : 'ALTO',
        confianza: 85,
        explicacion: `Es tu servicio más demandado este mes. Promocionarlo con casos de "Antes y Después" atraerá a pacientes similares.`,
        promptObjetivo: `Generar interés y captar pacientes para el tratamiento de ${metricas.servicioEstrella} mostrando autoridad clínica.`
    });

    // REGLA 3: Reactivación estándar
    prioridades.push({
        id: 'reactivacion_general',
        titulo: 'Reactivar Pacientes Antiguos',
        enfoque: 'Control Preventivo',
        impacto: 'MODERADO',
        confianza: 75,
        explicacion: 'Ideal para rellenar espacios vacíos en la agenda con pacientes que ya confían en la clínica pero no han venido en 6 meses.',
        promptObjetivo: "Motivar a pacientes antiguos a agendar su control preventivo semestral destacando la prevención."
    });

    // Devolvemos solo las 3 mejores reglas
    return prioridades.slice(0, 3);
}

// ----------------------------------------------------
// FUNCIONES DE UI (Actualizar el DOM)
// ----------------------------------------------------
// Los textos vienen de la BD (p. ej. cita.motivo, que escribe el dentista),
// así que se escapan antes de inyectarlos como HTML.
function escaparHtml(valor) {
    return String(valor ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Traduce la confianza numérica del motor de decisiones a la barra de 5 segmentos.
function construirBarraConfianza(confianza) {
    const pct = Math.max(0, Math.min(100, Number(confianza) || 0));
    const llenos = Math.round(pct / 20);
    const clase = pct >= 80 ? 'high' : (pct >= 50 ? 'medium' : '');
    const estiloBajo = (!clase) ? ' style="background: #94a3b8;"' : '';

    let segmentos = '';
    for (let i = 0; i < 5; i++) {
        segmentos += (i < llenos)
            ? `<div class="confidence-segment ${clase}"${estiloBajo}></div>`
            : '<div class="confidence-segment"></div>';
    }

    const etiqueta = pct >= 80 ? 'ALTO' : (pct >= 50 ? 'MODERADO' : 'BAJO');
    return { segmentos, etiqueta, pct };
}

function construirTarjetaPrioridad(prio, index) {
    const esTop = index === 0;
    const { segmentos, etiqueta, pct } = construirBarraConfianza(prio.confianza);

    const card = document.createElement('div');
    card.className = `card-prioridad ${esTop ? 'top-priority' : 'normal-priority'}`;

    card.innerHTML = `
        <span class="badge-priority">PRIORIDAD #${index + 1}</span>

        <h3 style="margin: 15px 0 5px 0; color: ${esTop ? '#0369a1' : 'var(--blue-elegant)'}; font-size: ${esTop ? '1.3rem' : '1.2rem'};">${escaparHtml(prio.titulo)}</h3>
        <p style="margin: 0 0 15px 0; font-size: 0.85rem; color: ${esTop ? '#475569' : '#64748b'};">Foco en ${escaparHtml(prio.enfoque)}</p>

        <div style="margin-bottom: 20px;">
            <span style="display: flex; justify-content: space-between; font-size: 0.8rem; color: #64748b; margin-bottom: 4px; font-weight: bold;">
                <span>Nivel de Confianza: ${etiqueta}</span>
                <span>${pct}%</span>
            </span>
            <div class="confidence-bar">${segmentos}</div>
        </div>

        <div class="memory-box" style="flex: 1;">
            <strong style="color: #0284c7; display: flex; align-items: center; gap: 5px; margin-bottom: 8px;">
                <span class="material-symbols-outlined" style="font-size: 1.1rem;">insights</span> Por qué lo recomiendo:
            </strong>
            ${escaparHtml(prio.explicacion)}
            <div style="margin-top: 10px; color: #334155; font-weight: 600;">Impacto estimado: ${escaparHtml(prio.impacto)}</div>
        </div>

        <button type="button" class="btn-ejecutar-plan ${esTop ? 'btn-action-primary' : ''}"
            style="width: 100%; padding: 12px; ${esTop
                ? 'justify-content: center; font-size: 1rem;'
                : 'background: white; border: 1px solid #cbd5e1; border-radius: 8px; font-weight: bold; color: #475569; cursor: pointer; transition: 0.2s;'}">
            Explorar Estrategia
        </button>
    `;

    return card;
}

// "Dr. Omar Saucedo García" -> "Dr. Omar" (no "Dr.", que era lo que salía al
// tomar solo el primer token).
function nombreCorto(nombreCompleto) {
    const tokens = String(nombreCompleto || '').trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return 'Doctor';
    if (/^(dr|dra|drs|doc|doctor|doctora)\.?$/i.test(tokens[0]) && tokens[1]) {
        return `${tokens[0]} ${tokens[1]}`;
    }
    return tokens[0];
}

function renderizarDashboard(clinicaData, prioridades) {
    const metricas = clinicaData.metricas;
    const primerNombre = nombreCorto(clinicaData.doctor);

    // Topbar y Saludo
    const hrs = new Date().getHours();
    let saludo = "Buenos días";
    if (hrs >= 12 && hrs < 20) saludo = "Buenas tardes";
    if (hrs >= 20 || hrs < 5) saludo = "Buenas noches";
    const greetingEl = document.getElementById('dashGreeting');
    if(greetingEl) greetingEl.textContent = `${saludo}, ${primerNombre}`;

    // Encabezado del Comité (antes decía "Buenos días, Dr. Omar." fijo)
    const comiteSaludo = document.getElementById('comite-saludo');
    if(comiteSaludo) comiteSaludo.textContent = `${saludo}, ${primerNombre}.`;

    const comiteResumen = document.getElementById('comite-resumen');
    if(comiteResumen) {
        comiteResumen.textContent = metricas.agendados > 0
            ? `He analizado tu actividad de este mes: ${metricas.agendados} citas agendadas, ${metricas.atendidos} atendidas y ${metricas.noShow} inasistencias (${metricas.tasaNoShow}%). Tu servicio más demandado es ${metricas.servicioEstrella}. Estas son mis recomendaciones prioritarias:`
            : `Todavía no hay citas registradas este mes, así que estas recomendaciones parten de una estrategia base de captación. A medida que registres actividad, las ajustaré a tus números reales:`;
    }

    // Tarjetas Clínicas
    if(document.getElementById('statAgendados')) document.getElementById('statAgendados').textContent = metricas.agendados;
    if(document.getElementById('statAtendidos')) document.getElementById('statAtendidos').textContent = metricas.atendidos;
    if(document.getElementById('statNoShow')) document.getElementById('statNoShow').textContent = metricas.noShow;
    if(document.getElementById('statServicio')) document.getElementById('statServicio').textContent = metricas.servicioEstrella;

    // Tarjetas de prioridad: se generan desde `prioridades`, no desde HTML fijo.
    // Antes las tarjetas eran mock ("Reactivar Pacientes", 87%...) y el onclick
    // disparaba una estrategia distinta a la que mostraba la tarjeta.
    const grid = document.getElementById('prioridades-grid');
    if (grid) {
        grid.innerHTML = '';
        prioridades.forEach((prio, index) => {
            const card = construirTarjetaPrioridad(prio, index);
            card.querySelector('.btn-ejecutar-plan').onclick = () => invocarEjecucionIA(prio, clinicaData);
            grid.appendChild(card);
        });

        // El grid es de 3 columnas fijas: si el motor devuelve menos reglas,
        // se ajusta para que no queden huecos.
        grid.style.gridTemplateColumns = `repeat(${Math.max(1, Math.min(3, prioridades.length))}, 1fr)`;
    }

    // Configurar el Botón Manual
    const btnManual = document.getElementById('btn-estrategia-manual');
    if(btnManual) {
        btnManual.onclick = () => {
            const instruccion = document.getElementById('input-instruccion-manual').value;
            if(!instruccion) return alert("Escribe una instrucción.");
            
            const prioridadManual = {
                titulo: "Instrucción Directa",
                enfoque: "Estrategia Personalizada",
                promptObjetivo: instruccion
            };
            invocarEjecucionIA(prioridadManual, clinicaData);
        };
    }

    // Botón Volver del Laboratorio
    const btnVolver = document.getElementById('btn-volver-comite');
    if(btnVolver) {
        btnVolver.onclick = () => {
            document.getElementById('pantalla-estudio').style.display = 'none';
            document.getElementById('pantalla-comite').style.display = 'block';
        };
    }
}

function iniciarAuditoriaVisual() {
    const pasos = [
        { id: 'sync-1', delay: 400 },
        { id: 'sync-2', delay: 1200 },
        { id: 'sync-3', delay: 1800 },
        { id: 'sync-4', delay: 2400 },
        { id: 'sync-5', delay: 3000 }
    ];

    pasos.forEach(paso => {
        setTimeout(() => {
            const el = document.getElementById(paso.id);
            if(el) {
                el.classList.add('active');
                const icon = el.querySelector('.material-symbols-outlined');
                if (!icon) return;
                setTimeout(() => {
                    icon.classList.remove('spin-icon');
                    icon.textContent = 'check_circle';
                    icon.style.color = 'var(--green-success)';
                }, 500);
            }
        }, paso.delay);
    });

    setTimeout(() => {
        document.getElementById('pantalla-sincronizacion').style.display = 'none';
        document.getElementById('pantalla-comite').style.display = 'block';
    }, 4500);
}

// ----------------------------------------------------
// CAPA DE EJECUCIÓN (Llamada a Edge Function con Gemini)
// ----------------------------------------------------
// Se guarda el HTML original del loader la primera vez. Antes se sobreescribía
// con el bloque de error y quedaba destruido para los intentos siguientes.
let loaderHtmlOriginal = null;

async function invocarEjecucionIA(estrategia, clinicaData) {
    let loader;

    // 1. Mostrar Laboratorio Cargando (dentro de try: si falta un id, queremos
    //    el mensaje real y no un TypeError silencioso fuera de todo catch).
    try {
        porId('pantalla-comite').style.display = 'none';
        porId('pantalla-estudio').style.display = 'block';

        loader = porId('diseño-loading');
        if (loaderHtmlOriginal === null) loaderHtmlOriginal = loader.innerHTML;
        loader.innerHTML = loaderHtmlOriginal;
        loader.style.display = 'block';

        porId('canvasPreview').style.display = 'none';
        const canvasControls = document.getElementById('controles-canvas');
        if (canvasControls) canvasControls.style.display = 'none';

        // Labels visuales
        porId('lab-objetivo').textContent = estrategia.titulo || 'Campaña';
        porId('lab-enfoque').textContent = estrategia.enfoque || 'General';
    } catch (errUI) {
        console.error("Falla al preparar el Estudio Creativo:", errUI);
        alert(`Error de interfaz: ${errUI.message}`);
        return;
    }

    // 2. PAYLOAD PARA LA IA
    //    Las claves deben coincidir 1:1 con lo que destructura la Edge Function:
    //    doctor, objetivo_estrategico, tono_marca, restricciones.
    const payloadPrompt = {
        doctor: clinicaData?.doctor || 'Doctor',
        objetivo_estrategico: estrategia.promptObjetivo || estrategia.titulo || '',
        tono_marca: "Profesional, cercano y enfocado en evidencia clínica",
        restricciones: "Lenguaje apto para pacientes, sin tecnicismos complejos.",
        contexto_clinico: clinicaData?.metricas || null
    };

    try {
        if (!payloadPrompt.objetivo_estrategico) {
            throw new Error("No hay un objetivo estratégico definido para esta tarjeta.");
        }

        // Si el CDN de supabase-js no cargó, window.midental no existe y el
        // error sería "Cannot read properties of undefined (reading 'functions')".
        if (!window.midental || !window.midental.functions) {
            throw new Error("El cliente de Supabase no está inicializado. Verifica que supabase-js y js/supabase-config.js hayan cargado.");
        }

        // 3. LLAMAR A LA EDGE FUNCTION
        //    invoke() adjunta automáticamente Authorization: Bearer <token de
        //    sesión o publishable key> y Content-Type: application/json.
        const { data, error } = await window.midental.functions.invoke('director-generativo-ia', {
            body: payloadPrompt
        });

        if (error) {
            const detalle = await describirErrorEdgeFunction(error);
            console.error("Edge Function devolvió error:", detalle, error);
            const err = new Error(detalle.mensaje);
            err.status = detalle.status;
            err.stage = detalle.stage;
            throw err;
        }

        // La Edge Function puede responder 200 con { error: ... } si algo
        // degradó; y si el Content-Type no fuese JSON, data llega como string.
        let plan = data;
        if (typeof plan === 'string') {
            try {
                plan = JSON.parse(plan);
            } catch (_) {
                throw new Error(`La IA devolvió una respuesta no válida: ${plan.slice(0, 200)}`);
            }
        }
        if (!plan) throw new Error("La IA no devolvió datos.");
        if (plan.error) throw new Error(plan.error);

        // 4. INYECTAR LA RESPUESTA DE GEMINI (PLAN MAESTRO) EN EL LABORATORIO
        loader.style.display = 'none';

        let planDeAccionHtml = "";
        if (Array.isArray(plan.plan_de_accion)) {
            plan.plan_de_accion.forEach((paso, index) => {
                planDeAccionHtml += `${index + 1}. ${paso}\n`;
            });
        }

        const guiaCompleta = `🎯 ANÁLISIS ESTRATÉGICO:
${plan.analisis_estrategico || ''}

👥 PÚBLICO OBJETIVO:
${plan.publico_objetivo || ''}

📋 PLAN DE EJECUCIÓN:
${planDeAccionHtml}
💡 TEXTO BASE / GUION SUGERIDO:
${plan.texto_sugerido_base || ''}

🤖 PROMPT MAESTRO (Para herramientas externas):
${plan.prompt_para_ia_externa || ''}`;

        // Inyectar en los Textareas
        const taInstagram = document.querySelector('#copy-instagram textarea');
        const taWhatsapp = document.querySelector('#copy-whatsapp textarea');
        if (taInstagram) taInstagram.value = guiaCompleta;
        if (taWhatsapp) taWhatsapp.value = plan.texto_sugerido_base || 'Sin sugerencia de texto.';

        // El público objetivo ya no queda hardcodeado en el HTML
        const labAudiencia = document.getElementById('lab-audiencia');
        if (labAudiencia && plan.publico_objetivo) labAudiencia.textContent = plan.publico_objetivo;

        // 5. DIBUJAR EL CANVAS
        dibujarCanvasConIA(plan.sugerencia_visual, clinicaData?.doctor || 'MiDental');

    } catch (err) {
        console.error("Falla en la IA:", err);
        mostrarErrorEnLaboratorio(loader, err, () => invocarEjecucionIA(estrategia, clinicaData));
    }
}

// Muestra el error REAL del servidor (no un texto genérico) y permite reintentar.
function mostrarErrorEnLaboratorio(loader, err, onReintentar) {
    if (!loader) return;

    const etiquetaStage = {
        payload: 'Payload inválido',
        config: 'Configuración del servidor',
        gemini: 'Motor de IA (Gemini)',
        parse: 'Respuesta de la IA'
    }[err?.stage] || 'Conexión con la IA';

    loader.style.display = 'block';
    loader.innerHTML = `
        <span class="material-symbols-outlined" style="font-size: 4rem; color: #ef4444; margin-bottom: 15px;">error</span>
        <h3 style="margin: 0 0 5px 0; color: #b91c1c;">Error: ${etiquetaStage}</h3>
        <p style="margin: 0 0 15px 0; font-size: 0.85rem; color: #ef4444; max-width: 420px; line-height: 1.5; word-break: break-word;">
            ${(err?.message || 'Error desconocido').replace(/</g, '&lt;')}
            ${err?.status ? `<br><small style="color:#94a3b8;">HTTP ${err.status}</small>` : ''}
        </p>
        <button type="button" id="btn-reintentar-ia" style="background: white; border: 1px solid #cbd5e1; color: #475569; padding: 8px 18px; border-radius: 8px; cursor: pointer; font-weight: bold;">
            Reintentar
        </button>
    `;

    const btn = document.getElementById('btn-reintentar-ia');
    if (btn && typeof onReintentar === 'function') btn.onclick = onReintentar;
}

// Lógica Visual del Canvas aislada
function dibujarCanvasConIA(sugerenciaVisual, nombreDoctor) {
    const canvas = document.getElementById('canvasPreview');
    if(!canvas) return;

    canvas.style.display = 'block';
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        console.warn("El canvas no expone contexto 2d; se omite el dibujo.");
        return;
    }
    canvas.width = 1080;
    canvas.height = 1080;
    
    // Fondo
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Círculo decorativo
    ctx.fillStyle = '#e0f2fe';
    ctx.beginPath();
    ctx.arc(canvas.width, 0, 400, 0, 2 * Math.PI);
    ctx.fill();
    
    // Textos
    ctx.fillStyle = '#334155';
    ctx.font = 'bold 45px Arial';
    ctx.textAlign = 'center';
    
    const visualText = sugerenciaVisual || 'Diseño de Campaña';
    ctx.fillText('Idea de Diseño:', canvas.width/2, canvas.height/2 - 120);

    // La sugerencia de Gemini puede ser larga: se reparte en varias líneas
    // para que no se salga del lienzo de 1080px.
    ctx.fillStyle = '#0284c7';
    ctx.font = '35px Arial';
    const maxAncho = canvas.width - 200;
    const lineas = [];
    let lineaActual = '';
    `"${visualText}"`.split(' ').forEach(palabra => {
        const prueba = lineaActual ? `${lineaActual} ${palabra}` : palabra;
        if (ctx.measureText(prueba).width > maxAncho && lineaActual) {
            lineas.push(lineaActual);
            lineaActual = palabra;
        } else {
            lineaActual = prueba;
        }
    });
    if (lineaActual) lineas.push(lineaActual);
    // Tope de 5 líneas para no chocar con la firma del pie del lienzo.
    const visibles = lineas.slice(0, 5);
    if (lineas.length > 5) visibles[4] = visibles[4].replace(/["\s]+$/, '') + '..."';
    visibles.forEach((linea, i) => {
        ctx.fillText(linea, canvas.width/2, canvas.height/2 - 40 + (i * 48));
    });


    ctx.fillStyle = '#64748b';
    ctx.font = 'bold 30px Arial';
    ctx.fillText(nombreDoctor, canvas.width/2, canvas.height - 100);

    // Controles
    const controles = document.getElementById('controles-canvas');
    if(controles) {
        controles.style.display = 'block';
        document.getElementById('inputFirma').value = nombreDoctor;
        document.getElementById('inputSede').value = "MiDental";
    }
}

// Función global requerida por el HTML para las Pestañas Multicanal
window.cambiarCanal = function(elemento, canal) {
    document.querySelectorAll('.channel-tab').forEach(t => t.classList.remove('active'));
    elemento.classList.add('active');
    
    document.getElementById('copy-instagram').style.display = 'none';
    document.getElementById('copy-whatsapp').style.display = 'none';
    
    document.getElementById(`copy-${canal}`).style.display = 'flex';
};