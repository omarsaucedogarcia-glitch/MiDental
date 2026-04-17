// ==========================================
// js/app.js - El "Cerebro" de MiDental
// ==========================================

document.addEventListener('DOMContentLoaded', () => {
    console.log("🚀 MiDental App iniciada correctamente.");
    sincronizarDatosGlobales();

    window.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal-overlay')) {
            e.target.style.display = 'none';
        }
    });
});

// ------------------------------------------
// 1. FORMATOS EN VIVO (RUT y Teléfono)
// ------------------------------------------
window.formatearRutInput = function(input) {
    let valor = input.value.replace(/[^0-9kK]/g, '').toUpperCase();
    if (valor.length === 0) { input.value = ''; return; }
    if (valor.length === 1) { input.value = valor; return; }
    const cuerpo = valor.slice(0, -1);
    const dv = valor.slice(-1);
    const cuerpoFormateado = cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    input.value = `${cuerpoFormateado}-${dv}`;
}

window.formatearTelefonoInput = function(input) {
    let valor = input.value.replace(/\D/g, ''); 
    if (valor.length > 0 && !valor.startsWith('569')) {
        if (valor.startsWith('9')) valor = '56' + valor;
        else if (!valor.startsWith('56')) valor = '569' + valor;
    }
    if (valor.length > 11) valor = valor.slice(0, 11);
    input.value = valor;
}

window.formatearRutEstricto = function(rutInput) {
    let valor = rutInput.replace(/[^0-9kK]/g, '').toUpperCase();
    if (valor.length <= 1) return valor;
    const cuerpo = valor.slice(0, -1);
    const dv = valor.slice(-1);
    const cuerpoConPuntos = cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return `${cuerpoConPuntos}-${dv}`;
}

function formatearTelefonoParaWhatsApp(telInput) {
    let num = telInput.replace(/\D/g, ''); 
    if (num.startsWith('569') && num.length === 11) return num; 
    return num.length <= 9 ? '569' + num.slice(-8) : num; 
}

// ------------------------------------------
// 2. SISTEMA DE REGISTRO Y LOGIN
// ------------------------------------------
async function registrarUsuarioMidental(tipo) {
    const prefijo = tipo === 'dentista' ? 'regDentista' : 'regPaciente';
    const elementos = {
        rut: document.getElementById(`${prefijo}RUT`),
        nombre: document.getElementById(`${prefijo}Nombre`),
        telefono: document.getElementById(`${prefijo}Telefono`),
        email: document.getElementById(`${prefijo}Email`),
        pass: document.getElementById(`${prefijo}Password`),
        passConfirm: document.getElementById(`${prefijo}PasswordConfirm`),
        tyc: document.getElementById(`${prefijo}TyC`)
    };

    for (const [campo, elemento] of Object.entries(elementos)) {
        if (!elemento) return alert(`🛑 Error: Falta el campo "${campo}".`);
    }

    const rutCrudo = elementos.rut.value;
    const nombre = elementos.nombre.value;
    const telefonoCrudo = elementos.telefono.value;
    let email = elementos.email.value;
    const pass = elementos.pass.value;
    const passConfirm = elementos.passConfirm.value;
    const tycAceptados = elementos.tyc.checked;
    
    let sis = null;
    if (tipo === 'dentista') {
        const elSis = document.getElementById('regDentistaSIS');
        if (!elSis) return alert("🛑 Falta 'regDentistaSIS'.");
        sis = elSis.value;
        if (!sis) return alert("⚠️ El Registro SIS es obligatorio.");
    }

    if (!tycAceptados) return alert("⚠️ Acepta los Términos y Condiciones.");
    if (!rutCrudo || !nombre || !telefonoCrudo || !pass) return alert("⚠️ Completa los campos obligatorios.");
    if (pass !== passConfirm) return alert("❌ Las contraseñas no coinciden.");
    if (!/^(?=.*\d)(?=.*[A-Z]).{8,}$/.test(pass)) return alert("⚠️ Contraseña: Mínimo 8 caracteres, una mayúscula y un número.");

    const rutLimpio = formatearRutEstricto(rutCrudo);
    const telefonoFormateado = formatearTelefonoParaWhatsApp(telefonoCrudo);

    if (!email && tipo === 'paciente') email = `${rutLimpio.replace(/[^0-9kK]/g, '')}@paciente.midental.cl`;
    else if (!email) return alert("⚠️ Correo electrónico obligatorio.");

    try {
        const { data: authData, error: authError } = await window.midental.auth.signUp({
            email: email, password: pass,
            options: { data: { tipo_usuario: tipo, rut_usuario: rutLimpio, nombre_completo: nombre, telefono: telefonoFormateado } }
        });
        if (authError) throw authError;

        const tabla = (tipo === 'dentista') ? 'perfiles_dentistas' : 'perfiles_pacientes';
        const payload = { id: authData.user.id, rut: rutLimpio, nombre_completo: nombre, telefono: telefonoFormateado, email: email.includes('@paciente') ? null : email };
        if (tipo === 'dentista') { payload.registro_sis = sis; payload.especialidad = "Odontología General"; }

        const { error: dbError } = await window.midental.from(tabla).upsert([payload], { onConflict: 'id' });
        if (dbError) throw dbError;
        
        alert("🎉 ¡Registro exitoso!");
        document.getElementById(`modalRegistro${tipo.charAt(0).toUpperCase() + tipo.slice(1)}`).style.display = 'none';
        document.getElementById(`modalLogin${tipo.charAt(0).toUpperCase() + tipo.slice(1)}`).style.display = 'flex';
    } catch (err) {
        alert(`Error: ${err.message}`);
    }
}

async function iniciarSesion(tipo) {
    const prefijo = tipo === 'paciente' ? 'loginPaciente' : 'loginDentista';
    const rutInput = document.getElementById(`${prefijo}RUT`).value;
    const password = document.getElementById(`${prefijo}Password`).value;
    const btn = document.querySelector(`#modalLogin${tipo.charAt(0).toUpperCase() + tipo.slice(1)} .btn-pixar`);

    if (!rutInput || !password) return alert("⚠️ Ingresa RUT y Contraseña.");
    const textoOriginal = btn.innerHTML; btn.innerHTML = "Verificando...";

    try {
        const rutLimpio = formatearRutEstricto(rutInput);
        const tabla = tipo === 'dentista' ? 'perfiles_dentistas' : 'perfiles_pacientes';

        const { data: perfil } = await window.midental.from(tabla).select('email').eq('rut', rutLimpio).maybeSingle();
        let emailParaLogin = perfil?.email;
        if (!emailParaLogin && tipo === 'paciente') emailParaLogin = `${rutLimpio.replace(/[^0-9kK]/g, '')}@paciente.midental.cl`;
        if (!emailParaLogin) throw new Error("RUT no registrado.");

        const { data: session, error: authError } = await window.midental.auth.signInWithPassword({ email: emailParaLogin, password: password });
        if (authError) throw new Error("Contraseña incorrecta.");

        localStorage.setItem('midental_user_id', session.user.id);
        localStorage.setItem('midental_user_tipo', tipo);
        window.location.href = (tipo === 'dentista') ? 'dashboard-dentista.html' : 'mapa-paciente.html';
    } catch (err) {
        alert("Acceso denegado: " + err.message);
        btn.innerHTML = textoOriginal;
    }
}

async function recuperarPassword() {
    const email = prompt("Ingresa el correo electrónico asociado a tu cuenta:");
    if (email) {
        const { error } = await window.midental.auth.resetPasswordForEmail(email);
        alert(error ? "Error: " + error.message : "Se ha enviado un enlace a tu correo.");
    }
}

// ------------------------------------------
// 3. SINCRONIZACIÓN GLOBAL
// ------------------------------------------
window.sincronizarDatosGlobales = async function() {
    const userId = localStorage.getItem('midental_user_id');
    const tipo = localStorage.getItem('midental_user_tipo');
    if (!userId) return;

    if (tipo === 'dentista') {
        const { data: dr } = await window.midental.from('perfiles_dentistas').select('*').eq('id', userId).single();
        if (dr) {
            if (dr.avatar_url) {
                ['topbarAvatar', 'profileLargeAvatar', 'dashAvatar', 'agendaAvatar', 'flashProfilePic', 'shortsProfilePic']
                .forEach(id => { const el = document.getElementById(id); if (el) el.src = dr.avatar_url; });
            }
            const nombreCompleto = `${dr.prefijo || 'Dr.'} ${dr.nombre_completo}`;
            if (document.getElementById('sidebarNombreCompleto')) document.getElementById('sidebarNombreCompleto').innerText = nombreCompleto;
            if (document.getElementById('sidebarEspecialidad')) document.getElementById('sidebarEspecialidad').innerText = dr.especialidad || 'Especialista';
            if (document.getElementById('dashGreeting')) document.getElementById('dashGreeting').innerText = `Hola, ${nombreCompleto} 👋`;
            
            if (document.getElementById('dentistaNombre')) {
                document.getElementById('dentistaPrefijo').value = dr.prefijo || 'Dr.';
                document.getElementById('dentistaNombre').value = dr.nombre_completo || '';
                document.getElementById('dentistaEspecialidad').value = dr.especialidad || 'Odontología General';
                document.getElementById('dentistaTelefono').value = dr.telefono || '';
                document.getElementById('dentistaRUT').value = dr.rut || '';
                document.getElementById('dentistaSIS').value = dr.registro_sis || '';
            }

            ['displayTokens', 'dashTokens', 'headerTokenBalance', 'sidebarTokenBalance', 'b2bTokenBalance']
            .forEach(id => { const el = document.getElementById(id); if (el) el.innerText = dr.tokens_disponibles || "0"; });
        }
    }
}

// ------------------------------------------
// 4. LÓGICA DE AGENDA VISUAL Y WHATSAPP
// ------------------------------------------
window.cargarAgendaDesdeSedes = async function() {
    const userId = localStorage.getItem('midental_user_id');
    if (!userId) return;

    try {
        const { data: sedes } = await window.midental.from('sedes_dentistas').select('nombre_sede, horarios_json').eq('dentista_id', userId);
        if (sedes) {
            sedes.forEach(sede => {
                if (sede.horarios_json && Array.isArray(sede.horarios_json)) {
                    sede.horarios_json.forEach(slot => {
                        const celdaHTML = document.querySelector(`[data-slot="${slot}"]`);
                        if (celdaHTML) celdaHTML.innerHTML = `<div class="slot-workplace" onclick="clicOpcionesSede(event, '${slot}')"><div class="watermark-text">${sede.nombre_sede}</div></div>`;
                    });
                }
            });
        }

        const { data: citas } = await window.midental.from('citas_agenda').select('*, perfiles_pacientes(nombre_completo, telefono)').eq('dentista_id', userId);
        if (citas) {
            citas.forEach(cita => {
                const slot = cita.fecha_hora_formato_slot; 
                const celdaHTML = document.querySelector(`[data-slot="${slot}"]`);
                if (celdaHTML) {
                    const pctName = cita.perfiles_pacientes ? cita.perfiles_pacientes.nombre_completo : 'Paciente';
                    const pctTel = cita.perfiles_pacientes ? cita.perfiles_pacientes.telefono : '';
                    const estado = cita.estado || 'Confirmado';
                    let cls = 'event-confirmed';
                    if(estado.toLowerCase() === 'en curso') cls = 'event-inprogress';
                    if(estado.toLowerCase() === 'finalizado') cls = 'event-completed';
                    
                    // Escapamos los datos para evitar errores en onclick
                    celdaHTML.innerHTML = `<div class="${cls}" onclick="abrirDetallePaciente('${pctName}', '${cita.motivo || 'Consulta'}', '${pctTel}', '${estado}', '${slot}', this.parentElement, '')"><strong>${pctName}</strong></div>`;
                }
            });
        }
    } catch (err) { console.error("Error agenda:", err); }
}

window.confirmarPorWhatsApp = function(pNombre, diaHora, pTelefono) {
    if(!pTelefono) return alert("El paciente no tiene un teléfono registrado.");
    const mensaje = encodeURIComponent(`Estimado paciente ${pNombre}, le escribo desde mi plataforma en MiDental para confirmar su hora para el día ${diaHora}. Recuerde que su compromiso y puntualidad son fundamentales. Nos vemos.`);
    const telLimpio = pTelefono.replace(/[^0-9]/g, ''); 
    window.open(`https://wa.me/${telLimpio}?text=${mensaje}`, '_blank');
}

window.cerrarSesionLocal = function() {
    localStorage.removeItem('midental_user_id');
    localStorage.removeItem('midental_user_tipo');
    window.location.href = 'index.html';
}