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
        // Traemos las sedes y los datos del doctor asociado
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
        const avatar = drInfo.avatar_url || 'assets/avatar-default-doctor.png'; // FOTO REAL
        const precio = drInfo.valor_consulta ? drInfo.valor_consulta.toLocaleString('es-CL') : '20.000';
        const qtyHoras = sede.horarios_json ? sede.horarios_json.length : 0;

        // Convertimos los objetos a string para pasarlos en el onclick
        const drInfoStr = encodeURIComponent(JSON.stringify(drInfo));
        const sedeInfoStr = encodeURIComponent(JSON.stringify(sede));

        contenedor.innerHTML += `
            <div class="doctor-card" onclick="window.abrirPerfilDoctor('${drInfoStr}', '${sedeInfoStr}')">
                <div class="doc-card-header" style="display:flex; gap:15px; margin-bottom:15px;">
                    <img src="${avatar}" style="width:70px; height:70px; border-radius:50%; object-fit:cover;">
                    <div class="doc-info">
                        <h3 style="margin:0; color:var(--blue-elegant);">${drName}</h3>
                        <p style="margin:0; font-size:0.85rem; color:#666;">${drInfo.especialidad || 'Odontología General'}</p>
                        <span style="background:#f1f5f9; padding:4px 8px; border-radius:10px; font-size:0.8rem; margin-top:5px; display:inline-block;">📍 ${sede.comuna}</span>
                    </div>
                </div>
                <div style="border-top: 1px solid #eee; padding-top: 10px; display: flex; justify-content: space-between;">
                    <span style="font-size:0.85rem; color:var(--text-light);">Desde $${precio}</span>
                    <strong style="color:var(--pixar-cyan); font-size:0.85rem;">${qtyHoras} horas disp. &rarr;</strong>
                </div>
            </div>
        `;
    });
}

// --- 2. OFERTAS FLASH (CON IMÁGENES REALES) ---
window.cargarOfertasFlashLaterales = async function() {
    const contenedor = document.getElementById('ofertasFlashContenedor');
    if (!contenedor) return;

    try {
        const { data: ofertas, error } = await window.midental.from('ofertas_flash')
            .select('*, perfiles_dentistas(prefijo, nombre_completo)')
            .eq('activa', true)
            .gte('expira_at', new Date().toISOString())
            .order('created_at', { ascending: false });

        if (error) throw error;

        if (!ofertas || ofertas.length === 0) {
            contenedor.innerHTML = `<div style="text-align:center; padding:30px; opacity:0.5; color:white;">No hay ofertas flash activas.</div>`;
            return;
        }

        contenedor.innerHTML = "";
        ofertas.forEach(oferta => {
            const dr = oferta.perfiles_dentistas || {};
            const drName = `${dr.prefijo || 'Dr.'} ${dr.nombre_completo || ''}`;
            // Muestra imagen real o un placeholder bonito
            const imgUrl = oferta.imagen_url || 'https://via.placeholder.com/400x200/1e293b/00b4d8?text=Promo+Especial';
            
            contenedor.innerHTML += `
                <div class="offer-card" style="background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:15px; overflow:hidden; margin-bottom:15px;">
                    <img src="${imgUrl}" style="width:100%; height:160px; object-fit:cover;">
                    <div style="padding:15px;">
                        <span style="background:var(--pixar-orange); color:white; padding:3px 8px; border-radius:10px; font-size:0.7rem; font-weight:bold;">DESTACADO</span>
                        <h3 style="margin:10px 0 5px 0; color:white; font-size:1.1rem;">${oferta.servicio_nombre}</h3>
                        <p style="margin:0 0 10px 0; color:#aaa; font-size:0.85rem;">Por ${drName}</p>
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <span style="text-decoration:line-through; color:#888;">$${oferta.precio_real.toLocaleString('es-CL')}</span>
                            <span style="color:var(--pixar-orange); font-size:1.3rem; font-weight:bold;">$${oferta.precio_oferta.toLocaleString('es-CL')}</span>
                        </div>
                    </div>
                </div>
            `;
        });
    } catch (err) {
        console.error("Error al cargar ofertas:", err);
    }
}

// --- 3. MODAL Y CALENDARIO REAL ---
window.abrirPerfilDoctor = function(drInfoStr, sedeInfoStr) {
    const drInfo = JSON.parse(decodeURIComponent(drInfoStr));
    const sedeInfo = JSON.parse(decodeURIComponent(sedeInfoStr));

    dentistaIdSeleccionado = drInfo.id;
    telefonoDentistaSeleccionado = drInfo.telefono || "";
    slotSeleccionadoGlobal = null;

    // Llenar Modal
    document.getElementById('modalDocNombre').innerText = `${drInfo.prefijo || 'Dr.'} ${drInfo.nombre_completo || 'Doctor'}`;
    document.getElementById('modalDocEspecialidad').innerText = drInfo.especialidad || 'Odontología General';
    document.getElementById('modalDocAvatar').src = drInfo.avatar_url || 'assets/avatar-default-doctor.png';
    document.getElementById('modalDocDireccion').innerText = `${sedeInfo.nombre_sede} - ${sedeInfo.direccion}, ${sedeInfo.comuna}`;

    const btn = document.getElementById('btnConfirmarCita') || document.getElementById('btnConfirmarReserva');
    if(btn) {
        btn.disabled = true;
        btn.style.opacity = '0.5';
        btn.innerText = "Selecciona una hora para agendar";
    }

    renderizarCalendarioReal(sedeInfo.horarios_json || []);
    
    document.getElementById('modalFichaDoctor').style.display = 'flex';
}

function renderizarCalendarioReal(horariosArray) {
    const track = document.getElementById('modalCalendarioHoras') || document.getElementById('patientCalendarDays');
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
    
    ordenDias.forEach(dia => {
        if (agendaAgrupada[dia]) {
            const col = document.createElement('div');
            col.className = 'day-col';
            col.style.minWidth = '90px';
            col.style.textAlign = 'center';
            col.style.marginRight = '10px';
            
            col.innerHTML = `<div style="font-weight:bold; color:var(--blue-elegant); margin-bottom:10px;">${dia}</div>`;

            agendaAgrupada[dia].sort().forEach(hora => {
                const btn = document.createElement('button');
                btn.className = 'time-slot-btn';
                btn.style.width = '100%';
                btn.style.padding = '8px';
                btn.style.marginBottom = '5px';
                btn.style.border = '1px solid #ccc';
                btn.style.borderRadius = '5px';
                btn.style.background = 'white';
                btn.style.cursor = 'pointer';
                btn.innerText = hora;
                
                btn.onclick = () => window.seleccionarSlotReserva(btn, `${dia}-${hora}`);
                col.appendChild(btn);
            });
            track.appendChild(col);
        }
    });
}

window.seleccionarSlotReserva = function(btnHtml, slotId) {
    document.querySelectorAll('.time-slot-btn').forEach(b => {
        b.style.background = 'white';
        b.style.color = 'black';
        b.style.borderColor = '#ccc';
    });
    
    btnHtml.style.background = 'var(--pixar-cyan)';
    btnHtml.style.color = 'white';
    btnHtml.style.borderColor = 'var(--pixar-cyan)';
    
    slotSeleccionadoGlobal = slotId;

    const btnFinal = document.getElementById('btnConfirmarCita') || document.getElementById('btnConfirmarReserva');
    if(btnFinal) {
        btnFinal.disabled = false;
        btnFinal.style.opacity = '1';
        btnFinal.innerText = `Confirmar Cita: ${slotId}`;
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

    const btn = document.getElementById('btnConfirmarCita') || document.getElementById('btnConfirmarReserva');
    btn.disabled = true;
    btn.innerText = "Reservando en el sistema...";

    try {
        // ¡Magia! Aquí hacemos el INSERT real en Supabase
        const { error } = await window.midental.from('citas_agenda').insert([{
            paciente_id: pacienteId,
            dentista_id: dentistaIdSeleccionado,
            fecha_hora_formato_slot: slotSeleccionadoGlobal,
            estado: 'pendiente',
            motivo: esUrgenciaActiva ? 'Atención de Urgencia' : 'Evaluación General'
        }]);

        if (error) throw error;

        alert("🎉 ¡Reserva guardada exitosamente en la plataforma!");
        document.getElementById('modalFichaDoctor').style.display = 'none';

        // Ahora enviamos el WhatsApp
        const nombreDr = document.getElementById('modalDocNombre').innerText;
        let mensajeP = esUrgenciaActiva 
            ? `Hola ${nombreDr}, necesito atención de URGENCIA. Acabo de solicitar la hora (${slotSeleccionadoGlobal}) por la app MiDental. ¿Me confirma?`
            : `Hola ${nombreDr}, vi su agenda en la app MiDental y acabo de solicitar una reserva para el bloque: ${slotSeleccionadoGlobal}. ¿Me podría confirmar la hora?`;

        if (telefonoDentistaSeleccionado) {
            const telLimpio = telefonoDentistaSeleccionado.replace(/[^0-9]/g, '');
            window.open(`https://wa.me/${telLimpio}?text=${encodeURIComponent(mensajeP)}`, '_blank');
        } else {
            alert("Nota: El doctor no tiene WhatsApp público. Te contactará mediante la plataforma.");
        }

    } catch (err) {
        alert("Error al procesar reserva: " + err.message);
        btn.disabled = false;
        btn.innerText = `Reintentar Cita: ${slotSeleccionadoGlobal}`;
    }
}

// Filtros básicos
function configurarFiltrosChips() {
    const chips = document.querySelectorAll('.filter-chip');
    chips.forEach(chip => {
        chip.addEventListener('click', function() {
            chips.forEach(c => c.classList.remove('active'));
            this.classList.add('active');
            if(this.classList.contains('urgency')) {
                esUrgenciaActiva = true;
            } else {
                esUrgenciaActiva = false;
            }
        });
    });
}