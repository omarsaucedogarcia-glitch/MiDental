// ==========================================
// js/mapa.js - Motor Dinámico del Paciente (Versión Producción)
// ==========================================

let todasLasSedes = [];
let slotSeleccionadoGlobal = null;
let dentistaIdSeleccionado = null;
let telefonoDentistaSeleccionado = "";
let esUrgenciaActiva = false;

document.addEventListener('DOMContentLoaded', () => {
    console.log("📍 Motor del Mapa Paciente Iniciado.");
    
    window.cargarDirectorioDoctores();
    window.cargarOfertasFlashLaterales();
    configurarFiltrosChips();
});

// --- 1. CARGA DE DOCTORES Y SEDES (DATOS REALES) ---
window.cargarDirectorioDoctores = async function() {
    const listaContainer = document.getElementById('listaDoctoresContenedor') || document.getElementById('listaDoctores');
    if (!listaContainer) return;

    try {
        const { data: sedes, error } = await window.midental
            .from('sedes_dentistas')
            .select('*, perfiles_dentistas(id, nombre_completo, prefijo, especialidad, avatar_url, telefono, valor_consulta)');

        if (error) throw error;

        todasLasSedes = sedes || [];
        window.renderizarDirectorio(todasLasSedes);

    } catch (err) {
        console.error("Error cargando directorio:", err.message);
    }
}

window.renderizarDirectorio = function(sedes) {
    const contenedor = document.getElementById('listaDoctoresContenedor') || document.getElementById('listaDoctores');
    const contador = document.getElementById('contadorResultados') || document.getElementById('contadorDentistas');
    
    contenedor.innerHTML = "";
    if (contador) contador.innerText = `${sedes.length} especialistas disponibles`;

    if (sedes.length === 0) {
        contenedor.innerHTML = `<div style="grid-column: 1/-1; padding: 40px; text-align: center; color: #888;">No se encontraron especialistas en esta zona.</div>`;
        return;
    }

    sedes.forEach(sede => {
        const drInfo = sede.perfiles_dentistas || {};
        const drName = `${drInfo.prefijo || 'Dr.'} ${drInfo.nombre_completo || 'Dentista'}`;
        const avatar = drInfo.avatar_url || 'assets/avatar-default-doctor.png';
        const precio = drInfo.valor_consulta ? drInfo.valor_consulta.toLocaleString('es-CL') : '20.000';
        const qtyHoras = sede.horarios_json ? sede.horarios_json.length : 0;

        const drInfoStr = encodeURIComponent(JSON.stringify(drInfo));
        const sedeInfoStr = encodeURIComponent(JSON.stringify(sede));

        // NUEVA TARJETA UNIFICADA CON BASE VERDE
        contenedor.innerHTML += `
            <div class="doctor-card" onclick="window.abrirPerfilDoctor('${drInfoStr}', '${sedeInfoStr}')" style="background: white; border-radius: 22px; box-shadow: 0 10px 25px rgba(0,0,0,0.06); overflow: hidden; border: 1px solid #e2e8f0; margin-bottom: 25px; cursor: pointer; transition: transform 0.2s; display: flex; flex-direction: column;">
                <div style="padding: 20px;">
                    <div style="display:flex; gap:15px; align-items: center;">
                        <img src="${avatar}" style="width:75px; height:75px; border-radius:50%; object-fit:cover; border: 3px solid #f8fafc; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                        <div class="doc-info">
                            <h3 style="margin:0; color:var(--blue-elegant); font-size: 1.15rem;">${drName}</h3>
                            <p style="margin:2px 0 0 0; font-size:0.85rem; color:var(--pixar-cyan); font-weight: bold;">${drInfo.especialidad || 'Odontología General'}</p>
                            <span style="background:#f1f5f9; padding:4px 10px; border-radius:12px; font-size:0.75rem; margin-top:8px; display:inline-flex; align-items: center; gap: 4px; color: #64748b;">
                                <span class="material-symbols-outlined" style="font-size: 1rem;">location_on</span> ${sede.comuna}
                            </span>
                        </div>
                    </div>
                </div>
                <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 14px 20px; display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size:0.9rem; color:white; font-weight: 500;">Desde $${precio}</span>
                    <strong style="color:white; font-size:0.9rem;">${qtyHoras} horas disp. &rarr;</strong>
                </div>
            </div>
        `;
    });
}

// --- 2. GENERADOR DE FECHAS REALES (SEMANA ACTUAL) ---
function obtenerFechasSemana() {
    const hoy = new Date();
    const lunes = new Date(hoy);
    const diaSemana = lunes.getDay() === 0 ? 7 : lunes.getDay();
    lunes.setDate(lunes.getDate() - diaSemana + 1);

    const diasAbrev = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
    const mapaFechas = {};

    for (let i = 0; i < 7; i++) {
        let f = new Date(lunes);
        f.setDate(lunes.getDate() + i);
        let dia = f.getDate().toString().padStart(2, '0');
        let mes = (f.getMonth() + 1).toString().padStart(2, '0');
        let ano = f.getFullYear();

        mapaFechas[diasAbrev[i]] = {
            corta: `${dia}/${mes}`,           // Para el calendario visual (Ej: 20/04)
            bd: `${dia}/${mes}/${ano}`        // Para cruzar con Supabase (Ej: 20/04/2026)
        };
    }
    return mapaFechas;
}

// --- 3. MODAL Y CALENDARIO REAL ---
window.abrirPerfilDoctor = function(drInfoStr, sedeInfoStr) {
    const drInfo = JSON.parse(decodeURIComponent(drInfoStr));
    const sedeInfo = JSON.parse(decodeURIComponent(sedeInfoStr));

    dentistaIdSeleccionado = drInfo.id;
    telefonoDentistaSeleccionado = drInfo.telefono || "";
    slotSeleccionadoGlobal = null;

    document.getElementById('modalDocNombre').innerText = `${drInfo.prefijo || 'Dr.'} ${drInfo.nombre_completo || 'Doctor'}`;
    document.getElementById('modalDocEspecialidad').innerText = drInfo.especialidad || 'Odontología General';
    document.getElementById('modalDocAvatar').src = drInfo.avatar_url || 'assets/avatar-default-doctor.png';
    document.getElementById('modalDocDireccion').innerText = `${sedeInfo.nombre_sede} - ${sedeInfo.direccion}, ${sedeInfo.comuna}`;

    const btn = document.getElementById('btnConfirmarCita');
    if(btn) {
        btn.disabled = true;
        btn.style.opacity = '0.5';
        btn.innerText = "Selecciona una hora para agendar";
    }

    renderizarCalendarioReal(sedeInfo.horarios_json || []);
    
    // --- ESTILOS FLOTANTES Y ELEGANTES PARA EL MODAL ---
    const modalOverlay = document.getElementById('modalFichaDoctor');
    modalOverlay.style.display = 'flex';
    modalOverlay.style.alignItems = 'center'; // Centra la ventana
    modalOverlay.style.paddingBottom = '90px'; // La separa del menú inferior
    
    const modalContent = modalOverlay.querySelector('.modal-content');
    modalContent.style.margin = '20px';
    modalContent.style.borderRadius = '30px';
    modalContent.style.boxShadow = '0 25px 50px rgba(0,0,0,0.3)';
}

function renderizarCalendarioReal(horariosArray) {
    const track = document.getElementById('modalCalendarioHoras');
    if(!track) return;
    track.innerHTML = "";

    if (horariosArray.length === 0) {
        track.innerHTML = '<p style="color:#ef4444; width:100%; text-align:center;">El doctor no tiene horas disponibles aquí.</p>';
        return;
    }

    const agendaAgrupada = {};
    horariosArray.forEach(slot => {
        const partes = slot.split('-'); // "Lun-10:00"
        if(partes.length === 2) {
            if(!agendaAgrupada[partes[0]]) agendaAgrupada[partes[0]] = [];
            agendaAgrupada[partes[0]].push(partes[1]);
        }
    });

    const ordenDias = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
    const fechasSemanales = obtenerFechasSemana(); // Calculamos el calendario real
    
    ordenDias.forEach(dia => {
        if (agendaAgrupada[dia]) {
            const fechaInfo = fechasSemanales[dia];
            
            const col = document.createElement('div');
            col.className = 'day-col';
            col.style.minWidth = '95px';
            col.style.textAlign = 'center';
            col.style.marginRight = '12px';
            
            // Inyectamos el Día (Lun) y la Fecha exacta (20/04)
            col.innerHTML = `
                <div style="font-weight:900; color:var(--blue-elegant); font-size:1.1rem;">${dia}</div>
                <div style="font-size:0.8rem; color:#64748b; margin-bottom:12px; font-weight:bold;">${fechaInfo.corta}</div>
            `;

            agendaAgrupada[dia].sort().forEach(hora => {
                const btn = document.createElement('button');
                btn.className = 'time-slot-btn';
                btn.style.width = '100%';
                btn.style.padding = '10px 5px';
                btn.style.marginBottom = '8px';
                btn.style.border = '1px solid #e2e8f0';
                btn.style.borderRadius = '8px';
                btn.style.background = 'white';
                btn.style.color = '#334155';
                btn.style.fontWeight = 'bold';
                btn.style.cursor = 'pointer';
                btn.style.transition = '0.2s';
                btn.innerText = hora;
                
                // Formateamos para Supabase (Ej: 20/04/2026-10:00) y para la vista (Lun 20/04 - 10:00)
                const slotBD = `${fechaInfo.bd}-${hora}`; 
                const textoVisual = `${dia} ${fechaInfo.corta} a las ${hora}`;
                
                btn.onclick = () => window.seleccionarSlotReserva(btn, slotBD, textoVisual);
                col.appendChild(btn);
            });
            track.appendChild(col);
        }
    });
}

window.seleccionarSlotReserva = function(btnHtml, slotIdBD, textoVisual) {
    document.querySelectorAll('.time-slot-btn').forEach(b => {
        b.style.background = 'white';
        b.style.color = '#334155';
        b.style.borderColor = '#e2e8f0';
    });
    
    btnHtml.style.background = 'var(--pixar-cyan)';
    btnHtml.style.color = 'white';
    btnHtml.style.borderColor = 'var(--pixar-cyan)';
    
    // Guardamos la fecha completa para la base de datos
    slotSeleccionadoGlobal = slotIdBD;

    const btnFinal = document.getElementById('btnConfirmarCita');
    if(btnFinal) {
        btnFinal.disabled = false;
        btnFinal.style.opacity = '1';
        btnFinal.innerText = `Confirmar Cita: ${textoVisual}`;
    }
}

// --- 4. GUARDADO EN BASE DE DATOS Y WHATSAPP ---
window.confirmarAgendamientoPaciente = async function() {
    const pacienteId = localStorage.getItem('midental_user_id');
    const tipoUser = localStorage.getItem('midental_user_tipo');
    
    if (!pacienteId || tipoUser !== 'paciente') {
        alert("⚠️ Debes iniciar sesión como Paciente para agendar una hora.");
        window.location.href = 'index.html';
        return;
    }

    const btn = document.getElementById('btnConfirmarCita');
    const textoOriginal = btn.innerText;
    btn.disabled = true;
    btn.innerText = "Reservando en el sistema...";

    try {
        const { error } = await window.midental.from('citas_agenda').insert([{
            paciente_id: pacienteId,
            dentista_id: dentistaIdSeleccionado,
            fecha_hora_formato_slot: slotSeleccionadoGlobal, // Ahora guarda la fecha completa 20/04/2026-10:00
            estado: 'pendiente',
            motivo: esUrgenciaActiva ? 'Atención de Urgencia' : 'Evaluación General'
        }]);

        if (error) throw error;

        alert("🎉 ¡Reserva guardada exitosamente en la plataforma!");
        document.getElementById('modalFichaDoctor').style.display = 'none';

        const nombreDr = document.getElementById('modalDocNombre').innerText;
        let mensajeP = esUrgenciaActiva 
            ? `Hola ${nombreDr}, necesito atención de URGENCIA. Acabo de solicitar la hora (${textoOriginal.replace('Confirmar Cita: ', '')}) por la app MiDental. ¿Me confirma?`
            : `Hola ${nombreDr}, vi su agenda en la app MiDental y acabo de solicitar una reserva para: ${textoOriginal.replace('Confirmar Cita: ', '')}. ¿Me podría confirmar la hora?`;

        if (telefonoDentistaSeleccionado) {
            const telLimpio = telefonoDentistaSeleccionado.replace(/[^0-9]/g, '');
            window.open(`https://wa.me/${telLimpio}?text=${encodeURIComponent(mensajeP)}`, '_blank');
        } else {
            alert("Nota: El doctor no tiene WhatsApp público. Te contactará mediante la plataforma.");
        }
        
        // Recargar página para actualizar estado visual
        window.location.reload();

    } catch (err) {
        alert("Error al procesar reserva: " + err.message);
        btn.disabled = false;
        btn.innerText = textoOriginal;
    }
}

// Filtros básicos
function configurarFiltrosChips() {
    // Si tuvieras filtros rápidos por botones (Urgencia, etc.)
}

window.cargarOfertasFlashLaterales = async function() {} // Dejado vacío si no usas sidebar aquí