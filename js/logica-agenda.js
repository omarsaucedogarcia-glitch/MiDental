// js/logica-agenda.js

window.procesarJornada = function(citas, fechaHoyStr, fechaMananaStr) {
    let resumen = {
        hoy: { confirmadas: 0, pendientes: 0, atendidos: 0, noAsistieron: 0, total: 0, citas: [] },
        manana: { confirmadas: 0, pendientes: 0, atendidos: 0, noAsistieron: 0, total: 0, citas: [] }
    };

    // 1. Filtrar citas de hoy y mañana
    const citasProximas = citas.filter(c => 
        c.fecha_hora_formato_slot && 
        (c.fecha_hora_formato_slot.includes(fechaHoyStr) || c.fecha_hora_formato_slot.includes(fechaMananaStr))
    );

    // 2. Ordenar cronológicamente (tu lógica original intacta)
    citasProximas.sort((a, b) => {
        if (a.fecha_hora && b.fecha_hora) {
            return new Date(a.fecha_hora) - new Date(b.fecha_hora);
        }
        const horaA = (a.fecha_hora_formato_slot.split('-')[1] || a.fecha_hora_formato_slot).trim();
        const horaB = (b.fecha_hora_formato_slot.split('-')[1] || b.fecha_hora_formato_slot).trim();
        return horaA.localeCompare(horaB);
    });

    // 3. Clasificar estados y guardar los datos
    citasProximas.forEach(cita => {
        const esHoy = cita.fecha_hora_formato_slot.includes(fechaHoyStr);
        const diaKey = esHoy ? 'hoy' : 'manana';
        const estadoLower = cita.estado ? cita.estado.toLowerCase() : 'pendiente';

        if (estadoLower === 'pendiente') resumen[diaKey].pendientes++;
        else if (estadoLower === 'confirmado' || estadoLower === 'confirmada') resumen[diaKey].confirmadas++;
        else if (estadoLower === 'completada' || estadoLower === 'en_atencion') resumen[diaKey].atendidos++;
        else if (estadoLower === 'no_asiste') resumen[diaKey].noAsistieron++;

        resumen[diaKey].total++;
        resumen[diaKey].citas.push(cita); // Guardamos el objeto completo, no el HTML
    });

    return resumen;
};