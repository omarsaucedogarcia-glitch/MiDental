// ==========================================
// js/mapa.js - El Buscador Dinámico
// ==========================================

// Variables globales para rastrear la selección
let doctorSeleccionadoID = ""; 
let nombreDoctorSeleccionado = "";
let horaSeleccionada = "";
let esUrgenciaActiva = false;

document.addEventListener('DOMContentLoaded', () => {
    console.log("📍 Buscador MiDental iniciado.");
    
    // 1. Iniciamos servicios
    cargarDentistasDesdeBD();
    animarBotonOfertas();
    configurarFiltrosChips();
    
    // 2. Generamos los días en el calendario del modal
    generarCarruselPaciente();
});

// --- 1. CARGA REAL DE DOCTORES DESDE SUPABASE ---
async function cargarDentistasDesdeBD() {
    const listaContainer = document.getElementById('listaDoctores');
    if (!listaContainer) return;

    try {
        // Consultamos la tabla que creamos en los pasos anteriores
        const { data: dentistas, error } = await window.midental
            .from('perfiles_dentistas')
            .select('*');

        if (error) throw error;

        listaContainer.innerHTML = ""; // Limpiamos placeholders

        if (dentistas.length === 0) {
            listaContainer.innerHTML = `
                <div style="padding:20px; text-align:center; color:#888;">
                    <p>No hay dentistas registrados en tu zona aún.</p>
                    <button class="btn-pixar btn-outline" onclick="location.reload()">Reintentar</button>
                </div>`;
            return;
        }

        dentistas.forEach(dr => {
            listaContainer.innerHTML += `
                <div class="doctor-card" onclick="iniciarReserva('${dr.id}', '${dr.nombre_completo}')">
                    <img src="${dr.avatar_url || 'assets/avatar-default-doctor.png'}" class="doc-photo">
                    <div class="doc-details">
                        <div class="doc-header">
                            <h4>${dr.nombre_completo}</h4>
                            <span class="rating">⭐ 5.0</span>
                        </div>
                        <p class="specialty">${dr.especialidad || 'Cirujano Dentista'}</p>
                        <p class="distance"><span class="material-symbols-outlined icon-small">location_on</span> ${dr.comuna || 'Chile'}</p>
                        <div class="price-availability">
                            <span class="price">Desde $${dr.valor_consulta ? dr.valor_consulta.toLocaleString() : '20.000'}</span>
                            <span class="availability green">Disponible hoy</span>
                        </div>
                        <button class="btn-pixar btn-book">Reservar</button>
                    </div>
                </div>
            `;
        });

        if(document.getElementById('contadorDentistas')) {
            document.getElementById('contadorDentistas').innerText = `${dentistas.length} dentistas disponibles`;
        }

    } catch (err) {
        console.error("Error cargando dentistas:", err.message);
    }
}

// --- 2. LÓGICA DE FILTROS (CHIPS) ---
function configurarFiltrosChips() {
    const chips = document.querySelectorAll('.filter-chip');
    chips.forEach(chip => {
        chip.addEventListener('click', function() {
            chips.forEach(c => c.classList.remove('active'));
            this.classList.add('active');
            
            if(this.classList.contains('urgency')) {
                this.style.backgroundColor = 'var(--red-urgency)';
                this.style.color = 'white';
                esUrgenciaActiva = true;
            } else {
                const urgChip = document.querySelector('.urgency');
                if(urgChip) {
                    urgChip.style.backgroundColor = 'white';
                    urgChip.style.color = 'var(--red-urgency)';
                }
                esUrgenciaActiva = false;
            }
            console.log("Filtro Urgencia:", esUrgenciaActiva);
        });
    });
}

// --- 3. GESTIÓN DE RESERVA (MODAL) ---
function iniciarReserva(id, nombre) {
    doctorSeleccionadoID = id;
    nombreDoctorSeleccionado = nombre;
    
    document.getElementById('fichaNombreDoctor').innerText = nombre;
    document.getElementById('modalFichaDoctor').style.display = 'flex';
    
    const btnConfirmar = document.getElementById('btnConfirmarReserva');
    btnConfirmar.innerText = "Selecciona una hora arriba";
    btnConfirmar.disabled = true;
    btnConfirmar.classList.remove('btn-active');
}

function cerrarFichaDoctor() {
    document.getElementById('modalFichaDoctor').style.display = 'none';
}

function seleccionarHoraPaciente(btn, texto) {
    horaSeleccionada = texto;
    document.querySelectorAll('.time-slot-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    
    const btnConfirmar = document.getElementById('btnConfirmarReserva');
    btnConfirmar.innerText = `Confirmar para: ${texto}`;
    btnConfirmar.disabled = false;
    btnConfirmar.style.background = "var(--pixar-cyan)";
}

// --- 4. CONFIRMACIÓN FINAL Y WHATSAPP ---
async function confirmarReservaFinal() {
    const confirmacion = confirm(`¿Enviar solicitud de reserva a ${nombreDoctorSeleccionado} por WhatsApp?`);
    
    if (confirmacion) {
        try {
            // Buscamos el teléfono real del doctor usando su ID (Más seguro que el nombre)
            const { data: dr, error } = await window.midental
                .from('perfiles_dentistas')
                .select('telefono')
                .eq('id', doctorSeleccionadoID)
                .single();

            if (error || !dr.telefono) {
                alert("No pudimos obtener el WhatsApp del doctor.");
                return;
            }

            const numLimpio = dr.telefono.replace(/\D/g, ''); 
            let mensaje = esUrgenciaActiva 
                ? `Hola Dr. ${nombreDoctorSeleccionado}, necesito atención de URGENCIA. Lo vi disponible ahora en MiDental. ¿Me confirma?`
                : `Hola Dr. ${nombreDoctorSeleccionado}, vi su agenda en MiDental y me gustaría reservar para el ${horaSeleccionada}. ¿Está disponible?`;

            const url = `https://wa.me/${numLimpio}?text=${encodeURIComponent(mensaje)}`;
            
            cerrarFichaDoctor();
            window.open(url, '_blank');

        } catch (err) {
            console.error("Error en reserva:", err);
        }
    }
}

// --- 5. UI Y CALENDARIO ---
function generarCarruselPaciente() {
    const container = document.getElementById('patientCalendarDays');
    if (!container) return;

    const meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    let fecha = new Date();

    container.innerHTML = ""; // Limpiar carrusel

    for (let i = 0; i < 7; i++) {
        const diaNum = fecha.getDate();
        const mesTxt = meses[fecha.getMonth()];
        const fechaTxt = `${diaNum} ${mesTxt}`;

        const col = document.createElement('div');
        col.className = 'day-col';
        col.innerHTML = `
            <div class="day-col-header">${mesTxt}<strong>${diaNum}</strong></div>
            <button class="time-slot-btn" onclick="seleccionarHoraPaciente(this, '${fechaTxt} - 10:00')">10:00</button>
            <button class="time-slot-btn" onclick="seleccionarHoraPaciente(this, '${fechaTxt} - 15:30')">15:30</button>
        `;
        container.appendChild(col);
        fecha.setDate(fecha.getDate() + 1);
    }
}

function animarBotonOfertas() {
    const btn = document.querySelector('.btn-ofertas-small');
    if (btn) {
        setInterval(() => {
            btn.style.transform = "scale(1.05)";
            setTimeout(() => btn.style.transform = "scale(1)", 300);
        }, 4000);
    }
}