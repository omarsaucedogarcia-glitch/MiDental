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
    
    // Verificamos si el paciente llegó buscando urgencias (por la URL)
    const params = new URLSearchParams(window.location.search);
    esUrgenciaActiva = params.get('urgencia') === 'true';
    
    if(esUrgenciaActiva) {
        document.getElementById('contadorResultados').innerText = "Buscando especialistas para urgencias...";
        document.getElementById('contadorResultados').style.color = "#ef4444"; // Rojo
    }

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
            .select('*, perfiles_dentistas(id, nombre_completo, prefijo, especialidad, avatar_url, telefono, valor_consulta, acepta_urgencias)');
            // ASUME QUE AGREGASTE LA COLUMNA 'acepta_urgencias' BOOLEAN EN perfiles_dentistas

        if (error) throw error;

        todasLasSedes = sedes || [];
        window.renderizarDirectorio(todasLasSedes);

    } catch (err) {
        console.error("Error cargando directorio:", err.message);
        listaContainer.innerHTML = `<div style="padding: 40px; text-align: center; color: red;">Error al cargar la red de dentistas.</div>`;
    }
}

window.renderizarDirectorio = function(sedes) {
    const contenedor = document.getElementById('listaDoctoresContenedor') || document.getElementById('listaDoctores');
    const contador = document.getElementById('contadorResultados') || document.getElementById('contadorDentistas');
    
    contenedor.innerHTML = "";

    // Filtramos las sedes si el paciente está buscando urgencias
    let sedesAMostrar = sedes;
    if (esUrgenciaActiva) {
        sedesAMostrar = sedes.filter(sede => sede.perfiles_dentistas && sede.perfiles_dentistas.acepta_urgencias === true);
    }

    if (contador) {
        contador.innerText = esUrgenciaActiva 
            ? `${sedesAMostrar.length} especialistas disponibles para urgencias`
            : `${sedesAMostrar.length} especialistas disponibles`;
    }

    if (sedesAMostrar.length === 0) {
        contenedor.innerHTML = `<div style="grid-column: 1/-1; padding: 40px; text-align: center; color: #888;">No se encontraron especialistas ${esUrgenciaActiva ? 'para urgencias ' : ''}en esta zona.</div>`;
        return;
    }

    sedesAMostrar.forEach(sede => {
        const drInfo = sede.perfiles_dentistas || {};
        const drName = `${drInfo.prefijo || 'Dr.'} ${drInfo.nombre_completo || 'Dentista'}`;
        const avatar = drInfo.avatar_url || 'assets/avatar-default-doctor.png';
        const precio = drInfo.valor_consulta ? drInfo.valor_consulta.toLocaleString('es-CL') : '20.000';
        const qtyHoras = sede.horarios_json ? sede.horarios_json.length : 0;

        const drInfoStr = encodeURIComponent(JSON.stringify(drInfo));
        const sedeInfoStr = encodeURIComponent(JSON.stringify(sede));

        // Lógica de Urgencias Visual
        const esDoctorUrgencia = esUrgenciaActiva && drInfo.acepta_urgencias;
        
        // Estilos dinámicos para la barra inferior
        const colorBarra = esDoctorUrgencia 
            ? 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)' // Rojo Urgencia
            : 'linear-gradient(135deg, #10b981 0%, #059669 100%)'; // Verde Normal
        
        const textoDerecho = esDoctorUrgencia
            ? `<strong style="color:white; font-size:0.9rem;">Disponible Inmediato &rarr;</strong>`
            : `<strong style="color:white; font-size:0.9rem;">${qtyHoras} horas disp. &rarr;</strong>`;

        // Si es urgencia, el click va directo a WhatsApp, si no, abre el modal de calendario
        const funcionClick = esDoctorUrgencia
            ? `window.solicitarUrgenciaDirecta('${drInfoStr}')`
            : `window.abrirPerfilDoctor('${drInfoStr}', '${sedeInfoStr}')`;

        // NUEVA TARJETA UNIFICADA
        contenedor.innerHTML += `
            <div class="doctor-card" onclick="${funcionClick}" style="background: white; border-radius: 22px; box-shadow: 0 10px 25px rgba(0,0,0,0.06); overflow: hidden; border: 1px solid #e2e8f0; margin-bottom: 25px; cursor: pointer; transition: transform 0.2s; display: flex; flex-direction: column;">
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
                <div style="background: ${colorBarra}; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size:0.9rem; color:white; font-weight: 500;">Desde $${precio}</span>
                    ${textoDerecho}
                </div>
            </div>
        `;
    });
}

// --- FLUJO ESPECIAL: URGENCIA DIRECTA POR WHATSAPP ---
window.solicitarUrgenciaDirecta = function(drInfoStr) {
    const drInfo = JSON.parse(decodeURIComponent(drInfoStr));
    const nombreDr = `${drInfo.prefijo || 'Dr.'} ${drInfo.nombre_completo || 'Doctor'}`;
    const telefonoDr = drInfo.telefono;

    if (!telefonoDr) {
        alert("El doctor no tiene un número de contacto público registrado para urgencias.");
        return;
    }

    const mensajeUrgencia = `Hola ${nombreDr}, Le escribo desde la plataforma MiDental porque aparece con disponibilidad inmediata para Urgencias Dentales, por favor necesito una hora urgente lo antes posible`;
    const telLimpio = telefonoDr.replace(/[^0-9]/g, '');
    
    // Abre WhatsApp directamente
    window.open(`https://wa.me/${telLimpio}?text=${encodeURIComponent(mensajeUrgencia)}`, '_blank');
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
            corta: `${dia}/${mes}`,           
            bd: `${dia}/${mes}/${ano}`        
        };
    }
    return mapaFechas;
}

// --- 3. MODAL Y CALENDARIO REAL (FLUJO NORMAL) ---
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
    
    const modalOverlay = document.getElementById('modalFichaDoctor');
    modalOverlay.style.display = 'flex';
    modalOverlay.style.alignItems = 'center'; 
    modalOverlay.style.paddingBottom = '90px'; 
    
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
        const partes = slot.split('-'); 
        if(partes.length === 2) {
            if(!agendaAgrupada[partes[0]]) agendaAgrupada[partes[0]] = [];
            agendaAgrupada[partes[0]].push(partes[1]);
        }
    });

    const ordenDias = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
    const fechasSemanales = obtenerFechasSemana(); 
    
    ordenDias.forEach(dia => {
        if (agendaAgrupada[dia]) {
            const fechaInfo = fechasSemanales[dia];
            
            const col = document.createElement('div');
            col.className = 'day-col';
            col.style.minWidth = '95px';
            col.style.textAlign = 'center';
            col.style.marginRight = '12px';
            
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
    
    slotSeleccionadoGlobal = slotIdBD;

    const btnFinal = document.getElementById('btnConfirmarCita');
    if(btnFinal) {
        btnFinal.disabled = false;
        btnFinal.style.opacity = '1';
        btnFinal.innerText = `Confirmar Cita: ${textoVisual}`;
    }
}

// --- 4. GUARDADO EN BASE DE DATOS Y WHATSAPP (FLUJO NORMAL) ---
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
            fecha_hora_formato_slot: slotSeleccionadoGlobal,
            estado: 'pendiente',
            motivo: 'Evaluación General'
        }]);

        if (error) throw error;

        alert("🎉 ¡Reserva guardada exitosamente en la plataforma!");
        document.getElementById('modalFichaDoctor').style.display = 'none';

        const nombreDr = document.getElementById('modalDocNombre').innerText;
        let mensajeP = `Hola ${nombreDr}, vi su agenda en la app MiDental y acabo de solicitar una reserva para: ${textoOriginal.replace('Confirmar Cita: ', '')}. ¿Me podría confirmar la hora?`;

        if (telefonoDentistaSeleccionado) {
            const telLimpio = telefonoDentistaSeleccionado.replace(/[^0-9]/g, '');
            window.open(`https://wa.me/${telLimpio}?text=${encodeURIComponent(mensajeP)}`, '_blank');
        } else {
            alert("Nota: El doctor no tiene WhatsApp público. Te contactará mediante la plataforma.");
        }
        
        window.location.reload();

    } catch (err) {
        alert("Error al procesar reserva: " + err.message);
        btn.disabled = false;
        btn.innerText = textoOriginal;
    }
}

function configurarFiltrosChips() {}
window.cargarOfertasFlashLaterales = async function() {}