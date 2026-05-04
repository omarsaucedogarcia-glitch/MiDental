// ==========================================
// js/calculadora.js - Lógica B2B y Transacciones
// ==========================================

document.addEventListener('DOMContentLoaded', () => {
    console.log("📈 Simulador de Rentabilidad y Monedero MiDental iniciado.");

    // --- 1. REFERENCIAS DE UI (Simulador) ---
    const sliderJornadas = document.getElementById('mediasJornadas');
    const inputValorJornada = document.getElementById('valorJornada');
    const txtJornadas = document.getElementById('valJornadas');

    const sliderHoras = document.getElementById('horasSueltas');
    const inputValorHora = document.getElementById('valorHora');
    const txtHoras = document.getElementById('valHoras');

    const resTotal = document.getElementById('resTotal');

    // --- 2. REFERENCIAS DE UI (Tienda de Tokens) ---
    const inputCantidad = document.getElementById('inputCantidad');
    const displayTotalPagar = document.getElementById('totalPagar');
    // Ajustado al ID que usamos en el HTML del monedero
    const displaySaldoReal = document.getElementById('displaySaldoGlobal'); 

    // Variables Globales de Estado
    let precioBaseActual = 1990;

    // --- 3. FUNCIONES DE CÁLCULO ---
    function formatearCLP(valor) {
        return new Intl.NumberFormat('es-CL', {
            style: 'currency',
            currency: 'CLP',
            maximumFractionDigits: 0
        }).format(valor);
    }

    window.calcularRentabilidad = function() {
        if (!sliderJornadas || !sliderHoras) return;

        // Captura de valores
        const numJornadas = parseInt(sliderJornadas.value) || 0;
        const precioJornada = parseInt(inputValorJornada.value) || 0;
        const numHoras = parseInt(sliderHoras.value) || 0;
        const precioHora = parseInt(inputValorHora.value) || 0;

        // Actualización de etiquetas visuales
        if (txtJornadas) txtJornadas.innerText = numJornadas;
        if (txtHoras) txtHoras.innerText = numHoras;

        // Cálculo Mensual (Estándar 4 semanas)
        const totalMes = (numJornadas * precioJornada * 4) + (numHoras * precioHora * 4);

        // Inyección de resultado
        if (resTotal) resTotal.innerText = formatearCLP(totalMes);
    }

    // --- 4. LÓGICA DE LA TIENDA DE TOKENS (PRECIOS POR VOLUMEN) ---
    window.actualizarPrecioTokens = function() {
        if (!inputCantidad) return;
        
        const cant = parseInt(inputCantidad.value) || 1;
        let total = 0;

        // Lógica de precios decrecientes (Economía de escala)
        if (cant >= 20) precioBaseActual = 1000;      // Mega Ahorro
        else if (cant >= 10) precioBaseActual = 1499; // Ahorro 25%
        else if (cant >= 5) precioBaseActual = 1598;  // Ahorro 20%
        else if (cant >= 3) precioBaseActual = 1663;  // Ahorro 16%
        else precioBaseActual = 1990;                 // Precio Base

        total = cant * precioBaseActual;
        if (displayTotalPagar) displayTotalPagar.innerText = formatearCLP(total);
    };

    // Esto reemplaza al antiguo procesarPagoSimulado del HTML
    window.procesarPagoReal = async function() {
        const userId = localStorage.getItem('midental_user_id');
        if (!inputCantidad) return;
        
        const cantidad = parseInt(inputCantidad.value);

        if (!userId) {
            alert("Debes iniciar sesión para comprar tokens.");
            return;
        }

        const btn = document.getElementById('btnProcesarPago');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = "<span class='material-symbols-outlined' style='animation: spin 1s linear infinite;'>sync</span> Procesando pago seguro...";
        }

        try {
            // 1. Simulación de respuesta de Webpay/Stripe (1.5 segundos)
            await new Promise(resolve => setTimeout(resolve, 1500));

            // Extraemos el total numérico
            const totalPagadoText = displayTotalPagar ? displayTotalPagar.innerText.replace(/[^0-9]/g, '') : (cantidad * precioBaseActual).toString();
            const totalPagadoNumerico = parseInt(totalPagadoText);

            // 2. Guardar el comprobante en historial_pagos
            const { error: errorHistorial } = await window.midental
                .from('historial_pagos')
                .insert([{
                    dentista_id: userId,
                    monto: totalPagadoNumerico,
                    tokens_comprados: cantidad,
                    estado: 'completado',
                    external_reference: 'SIMULACION_WEBPAY_' + Date.now()
                }]);

            if (errorHistorial) throw new Error("Fallo al guardar el registro de la transacción.");

            // 3. BLINDAJE DE CONCURRENCIA: Obtener el saldo directo de DB antes de sumar
            const { data: perfilData, error: errorLectura } = await window.midental
                .from('perfiles_dentistas')
                .select('tokens_disponibles')
                .eq('id', userId)
                .single();

            if (errorLectura) throw new Error("No se pudo verificar tu billetera para la recarga.");

            const saldoRealDB = perfilData.tokens_disponibles || 0;
            const nuevoSaldo = saldoRealDB + cantidad;

            // 4. Actualizar el saldo en el perfil del dentista
            const { error: errorPerfil } = await window.midental
                .from('perfiles_dentistas')
                .update({ tokens_disponibles: nuevoSaldo })
                .eq('id', userId);

            if (errorPerfil) throw new Error("Pago exitoso, pero fallo al recargar los tokens. Contacta soporte.");

            // 5. Éxito
            alert(`✅ ¡Pago Aprobado!\nSe han cargado ${cantidad} tokens a tu monedero.`);
            
            // Cerrar el modal y recargar la interfaz visual
            if (typeof window.cerrarModalCompra === 'function') window.cerrarModalCompra();
            cargarSaldoTokens(); 
            if (typeof window.sincronizarDatosGlobales === 'function') window.sincronizarDatosGlobales();

        } catch (err) {
            alert("❌ Transacción rechazada: " + err.message);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `<span class="material-symbols-outlined" style="vertical-align: middle; margin-right: 5px;">lock</span> Pagar de Forma Segura`;
            }
        }
    };

    // --- 5. EVENT LISTENERS ---
    if (sliderJornadas) {
        [sliderJornadas, inputValorJornada, sliderHoras, inputValorHora].forEach(el => {
            if (el) el.addEventListener('input', window.calcularRentabilidad);
        });
        window.calcularRentabilidad(); // Cálculo inicial
    }

    // Asegurar que si el input de cantidad cambia, se actualice el precio
    // Notar que esto apoya a la función cambiarCantidad(delta) del HTML
    if (inputCantidad) {
        inputCantidad.addEventListener('change', window.actualizarPrecioTokens);
    }

    // --- 6. SINCRONIZACIÓN CON BACKEND ---
    async function cargarSaldoTokens() {
        const userId = localStorage.getItem('midental_user_id');
        if (!userId || !displaySaldoReal) return;

        try {
            const { data, error } = await window.midental
                .from('perfiles_dentistas')
                .select('tokens_disponibles')
                .eq('id', userId)
                .single();

            if (data) {
                displaySaldoReal.innerText = data.tokens_disponibles || "0";
            }
        } catch (err) {
            console.error("Error al cargar saldo:", err.message);
        }
    }

    // Carga inicial de tokens al entrar a la página
    cargarSaldoTokens();
});