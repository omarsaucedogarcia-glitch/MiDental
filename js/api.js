// js/api.js

window.MiDentalAPI = {
    Perfil: {
        validarSesion: async (userId) => {
            const { data, error } = await window.midental.from('perfiles_dentistas')
                .select('id').eq('id', userId).maybeSingle();
            if (error) throw error;
            if (!data) throw new Error("Sesión inválida");
            return data;
        },
        obtenerDatosGlobales: async (userId) => {
            const [perfil, sede] = await Promise.all([
                window.midental.from('perfiles_dentistas')
                    .select('nombre_completo, prefijo, avatar_url, acepta_urgencias')
                    .eq('id', userId).maybeSingle(),
                window.midental.from('sedes_dentistas')
                    .select('nombre_sede')
                    .eq('dentista_id', userId).limit(1).maybeSingle()
            ]);
            
            if (perfil.error) throw perfil.error;
            
            return {
                perfil: perfil.data || {},
                sede: sede.data ? sede.data.nombre_sede : null
            };
        },
        actualizarUrgencia: async (userId, estado) => {
            const { error } = await window.midental.from('perfiles_dentistas')
                .update({ acepta_urgencias: estado }).eq('id', userId);
            if (error) throw error;
        }
    },

    Agenda: {
        obtenerDisponibilidad: async (dentistaId) => {
            const [perfil, sedes] = await Promise.all([
                window.midental.from('perfiles_dentistas').select('disponibilidad_json, horarios_json').eq('id', dentistaId).maybeSingle(),
                window.midental.from('sedes_dentistas').select('nombre_sede, disponibilidad_json, horarios_json').eq('dentista_id', dentistaId)
            ]);
            return { perfil: perfil.data, sedes: sedes.data };
        },
        obtenerCitasActivas: async (userId) => {
    const { data, error } = await window.midental.from('citas_agenda')
        .select('*, perfiles_pacientes(nombre_completo, telefono, proxima_sesion_nota, proxima_sesion_duracion_minutos)')
        .eq('dentista_id', userId)
        .neq('estado', 'cancelada')
        .neq('estado', 'Rechazado')
        .neq('estado', 'bloqueado');
    if (error) throw error;
    return data || [];
},
        obtenerPendientes: async (userId) => {
            const { data, error } = await window.midental.from('citas_agenda')
                .select('*, perfiles_pacientes(nombre_completo, telefono)')
                .eq('dentista_id', userId)
                .eq('estado', 'pendiente');
            if (error) throw error;
            return data || [];
        },
        actualizarEstadoCita: async (citaId, nuevoEstado) => {
            const { error } = await window.midental.from('citas_agenda')
                .update({ estado: nuevoEstado }).eq('id', citaId);
            if (error) throw error;
        },
        crearCita: async (dentistaId, pacienteId, slotRealId, motivo, duracion, estado = 'Confirmado') => {
            const esBloqueo = estado === 'bloqueado';
            const { error } = await window.midental.from('citas_agenda').insert([{
                dentista_id: dentistaId, 
                paciente_id: pacienteId, 
                fecha_hora_formato_slot: slotRealId,
                estado: estado, 
                motivo: motivo, 
                duracion_minutos: duracion,
                paciente_nombre_manual: (esBloqueo ? 'BLOQUEADO' : null),
                paciente_telefono_manual: (esBloqueo ? '000000000' : null)
            }]);
            if (error) throw error;
        }
    },

    Pacientes: {
        buscarPorRut: async (rut) => {
            const { data, error } = await window.midental.from('perfiles_pacientes')
                .select('id, nombre_completo, telefono, user_id').eq('rut', rut).maybeSingle();
            if (error) throw error;
            return data;
        },
        buscarPorNombre: async (dentistaId, termino) => {
            const { data, error } = await window.midental.from('citas_agenda')
                .select('paciente_id, perfiles_pacientes!inner(id, rut, nombre_completo, telefono)')
                .eq('dentista_id', dentistaId)
                .ilike('perfiles_pacientes.nombre_completo', `%${termino}%`)
                .limit(30);
            if (error) throw error;
            return data || [];
        },
        crearPacienteManual: async (rut, nombre, telefono) => {
            const nuevoId = crypto.randomUUID();
            const { error } = await window.midental.from('perfiles_pacientes').insert([{
                id: nuevoId, 
                rut: rut || null, 
                nombre_completo: nombre, 
                telefono: telefono,
                enfermedades_cronicas: 'Ninguna', 
                medicamentos: 'Ninguno', 
                alergias: 'Ninguna', 
                user_id: null
            }]);
            if (error) throw error;
            return nuevoId;
        },
        obtenerRecordatorio: async (pacienteId) => {
             const { data, error } = await window.midental.from('perfiles_pacientes')
                .select('proxima_sesion_nota, proxima_sesion_duracion_minutos')
                .eq('id', pacienteId).maybeSingle();
             if (error) throw error;
             return data;
        }
    },

    Marketing: {
        obtenerOfertaActiva: async (userId) => {
            const { data, error } = await window.midental.from('ofertas_flash')
                .select('servicio_nombre, expira_at')
                .eq('dentista_id', userId)
                .eq('activa', true)
                .gte('expira_at', new Date().toISOString())
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle(); 
            if (error) throw error;
            return data;
        }
    },

    Interconsultas: {
        validarPin: async (pin) => {
            const { data, error } = await window.midental.from('interconsultas')
                .select('paciente_id, id')
                .eq('token_pin', pin).maybeSingle();
            if (error) throw error;
            if (!data) throw new Error("PIN Inválido");
            return data;
        },
        abrirFicha: async (interconsultaId, dentistaDestinoId) => {
            const { error } = await window.midental.from('interconsultas')
                .update({ estado: 'abierto', dentista_destino_id: dentistaDestinoId })
                .eq('id', interconsultaId);
            if (error) throw error;
        }
    },

    Finanzas: {
        obtenerPagosRango: async (userId, inicioIso, finIso) => {
            const { data, error } = await window.midental.from('pagos')
                .select('monto, fecha_pago, medio_pago, perfiles_pacientes(nombre_completo)')
                .eq('dentista_id', userId)
                .gte('fecha_pago', inicioIso)
                .lt('fecha_pago', finIso)
                .order('fecha_pago', { ascending: false });
            if (error) throw error;
            return data || [];
        },
        obtenerGastosLabRango: async (userId, inicioIso, finIso) => {
            const { data, error } = await window.midental.from('pagos_laboratorio')
                .select('*').eq('dentista_id', userId)
                .gte('fecha_gasto', inicioIso).lt('fecha_gasto', finIso)
                .order('fecha_gasto', { ascending: false });
            if (error) throw error;
            return data || [];
        },
        agregarGastoLab: async (userId, descripcion, monto) => {
            const { error } = await window.midental.from('pagos_laboratorio')
                .insert([{ dentista_id: userId, descripcion, monto }]);
            if (error) throw error;
        },
        eliminarGastoLab: async (id) => {
            const { error } = await window.midental.from('pagos_laboratorio').delete().eq('id', id);
            if (error) throw error;
        },
        obtenerConveniosActivos: async (userId) => {
            const { data, error } = await window.midental.from('convenios_centros_medicos')
                .select('*').eq('dentista_id', userId).eq('activo', true)
                .order('created_at', { ascending: false });
            if (error) throw error;
            return data || [];
        },
        agregarConvenio: async (userId, nombre_centro, porcentaje) => {
            const { error } = await window.midental.from('convenios_centros_medicos')
                .insert([{ dentista_id: userId, nombre_centro, porcentaje, activo: true }]);
            if (error) throw error;
        },
        eliminarConvenio: async (id) => {
            const { error } = await window.midental.from('convenios_centros_medicos').delete().eq('id', id);
            if (error) throw error;
        },
        registrarPagoCita: async (dentistaId, pacienteId, monto, medio, notas) => {
            const { error } = await window.midental.from('pagos').insert([{
                paciente_id: pacienteId, dentista_id: dentistaId, monto: monto, metodo_pago: medio, notas: notas || null
            }]);
            if (error) throw error;
        }
    }
};