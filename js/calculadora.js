// ==========================================
// js/calculadora.js - Lógica B2B y Transacciones
// ==========================================

document.addEventListener('DOMContentLoaded', () => {
    console.log("📈 Simulador de Rentabilidad MiDental iniciado.");

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
    const displaySaldoReal = document.getElementById('displaySaldoTokens');

    // --- 3. FUNCIONES DE CÁLCULO ---
    function formatearCLP(valor) {
        return new Intl.NumberFormat('es-CL', {
            style: 'currency',
            currency: 'CLP',
            maximumFractionDigits: 0
        }).format(valor);
    }

    function calcularRentabilidad() {
        if (!sliderJornadas || !sliderHoras) return;

        // Captura de valores
        const numJornadas = parseInt(sliderJornadas.value);
        const precioJornada = parseInt(inputValorJornada.value) || 0;
        const numHoras = parseInt(sliderHoras.value);
        const precioHora = parseInt(inputValorHora.value) || 0;

        // Actualización de etiquetas visuales
        txtJornadas.innerText = numJornadas;
        txtHoras.innerText = numHoras;

        // Cálculo Mensual (Estándar 4 semanas)
        const totalMes = (numJornadas * precioJornada * 4) + (numHoras * precioHora * 4);

        // Inyección de resultado con animación de conteo (opcional)
        resTotal.innerText = formatearCLP(totalMes);
    }

    // --- 4. LÓGICA DE LA TIENDA DE TOKENS ---
    window.actualizarPrecioTokens = function() {
        if (!inputCantidad) return;
        
        const cant = parseInt(inputCantidad.value) || 1;
        let total = 0;

        // Aplicamos la lógica de precios decrecientes (Economía de escala)
        if (cant >= 20) total = cant * 1000;      // Mega Ahorro
        else if (cant >= 10) total = cant * 1499; // Ahorro 25%
        else if (cant >= 5) total = cant * 1598;  // Ahorro 20%
        else if (cant >= 3) total = cant * 1663;  // Ahorro 16%
        else total = cant * 1990;                 // Precio Base

        displayTotalPagar.innerText = formatearCLP(total);
    };

    window.procesarPagoReal = async function() {
        const userId = localStorage.getItem('midental_user_id');
        const cantidad = parseInt(inputCantidad.value);

        if (!userId) {
            alert("Debes iniciar sesión para comprar tokens.");
            return;
        }

        console.log(`Iniciando pasarela para ${cantidad} tokens...`);
        
        // Simulación de respuesta de Webpay/Stripe
        const pagoExitoso = true; 

        if (pagoExitoso) {
            // AQUÍ CONECTAREMOS CON SUPABASE EN EL SIGUIENTE PASO
            alert(`✅ ¡Pago Confirmado! Se han añadido ${cantidad} tokens a tu cuenta.`);
            window.location.href = 'ofertas-flash.html';
        }
    };

    // --- 5. EVENT LISTENERS ---
    if (sliderJornadas) {
        [sliderJornadas, inputValorJornada, sliderHoras, inputValorHora].forEach(el => {
            el.addEventListener('input', calcularRentabilidad);
        });
        // Cálculo inicial
        calcularRentabilidad();
    }

    // --- 6. SINCRONIZACIÓN CON BACKEND ---
    async function cargarSaldoTokens() {
        const userId = localStorage.getItem('midental_user_id');
        if (!userId || !displaySaldoReal) return;

        // Consultamos la tabla de perfiles para ver los tokens (ajustar según tu DB)
        const { data, error } = await window.midental
            .from('perfiles_dentistas')
            .select('tokens_disponibles')
            .eq('id', userId)
            .single();

        if (data) {
            displaySaldoReal.innerText = data.tokens_disponibles || "0";
        }
    }

    cargarSaldoTokens();
});