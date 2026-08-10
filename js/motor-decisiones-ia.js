// js/motor-decisiones-ia.js

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Validar sesión
    const userId = localStorage.getItem('midental_user_id');
    if (!userId) {
        window.location.href = 'index.html';
        return;
    }

    // 2. Iniciar UI de carga
    iniciarAuditoriaVisual();

    try {
        // ==========================================
        // CAPA 1: KNOWLEDGE (Recolección de Hechos)
        // ==========================================
        const clinicaData = await recolectarConocimientoClinico(userId);
        
        // ==========================================
        // CAPA 2: REASONING (Motor de Decisiones)
        // ==========================================
        const prioridades = motorDeDecisiones(clinicaData);

        // Actualizar la Interfaz con los datos reales
        renderizarDashboard(clinicaData, prioridades);

    } catch (error) {
        console.error("Error en el Centro de Inteligencia:", error);
        alert("Hubo un error al sincronizar los datos de la clínica.");
    }
});

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

    // 2. Obtener citas del mes (Ajusta la columna de fecha según tu base de datos)
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
        doctor: perfil?.nombre_completo || "Dr.",
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

    // REGLA 1: Si hay mucha inasistencia (> 10%), la prioridad 1 es Educación/Compromiso
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

    // Devolvemos solo las 3 mejores reglas ordenadas por importancia
    return prioridades.slice(0, 3);
}

// ----------------------------------------------------
// FUNCIONES DE UI (Actualizar el DOM)
// ----------------------------------------------------
function renderizarDashboard(clinicaData, prioridades) {
    // Aquí actualizamos los campos estáticos que dejamos en el HTML
    // NOTA: Para no hacer este script inmenso, asumimos que inyectas los 
    // valores en las tarjetas correspondientes (como hiciste en tu código original).
    
    // Configurar botones de "Explorar Estrategia"
    const botones = document.querySelectorAll('.btn-ejecutar-plan');
    botones.forEach((btn, index) => {
        btn.onclick = () => invocarEjecucionIA(prioridades[index], clinicaData);
    });

    // Botón Manual
    document.getElementById('btn-estrategia-manual').onclick = () => {
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

function iniciarAuditoriaVisual() {
    // Mismo código de simulación visual que ya te di en el HTML anterior
    // para ir mostrando los "check" verdes.
}
// ----------------------------------------------------
// CAPA DE EJECUCIÓN (Llamada a Edge Function con Gemini)
// ----------------------------------------------------
async function invocarEjecucionIA(estrategia, clinicaData) {
    // 1. Cambio de Pantallas (Mostrar Laboratorio Cargando)
    document.getElementById('pantalla-comite').style.display = 'none';
    document.getElementById('pantalla-estudio').style.display = 'block';
    document.getElementById('diseño-loading').style.display = 'block';
    document.getElementById('canvasPreview').style.display = 'none';
    
    // Actualizar labels del laboratorio
    document.getElementById('lab-objetivo').innerText = estrategia.titulo;
    document.getElementById('lab-enfoque').innerText = estrategia.enfoque;

    // 2. PREPARAR EL CONTEXTO PARA GEMINI
    const payloadPrompt = {
        doctor: clinicaData.doctor,
        objetivo_estrategico: estrategia.promptObjetivo,
        tono_marca: "Profesional, cercano y enfocado en evidencia clínica",
        restricciones: "Lenguaje apto para pacientes, sin tecnicismos complejos."
    };

    try {
        // 3. LLAMAR A LA EDGE FUNCTION DE SUPABASE
        const { data, error } = await window.midental.functions.invoke('director-generativo-ia', {
            body: payloadPrompt
        });

        if (error) throw error;

        // 4. INYECTAR LA RESPUESTA DE GEMINI EN EL LABORATORIO
        document.getElementById('diseño-loading').style.display = 'none';
        
        // Llenar los copies generados
        document.querySelector('#copy-instagram textarea').value = data.instagram_copy;
        document.querySelector('#copy-whatsapp textarea').value = data.whatsapp_copy;

        // Dibujar el Canvas (Reutilizando tu lógica de dibujo)
        dibujarCanvasConIA(data.sugerencia_visual, clinicaData);

    } catch (error) {
        console.error("Error al generar contenido con Gemini:", error);
        alert("Ocurrió un error al contactar al motor de IA.");
    }
}