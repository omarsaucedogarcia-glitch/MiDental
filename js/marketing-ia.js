document.addEventListener('DOMContentLoaded', () => {
    // 1. Capturamos los elementos clave del DOM
    const form = document.getElementById('marketing-generator-form');
    const emptyState = document.getElementById('preview-state-empty');
    const resultsState = document.getElementById('preview-state-results');
    const btnPublish = document.getElementById('btn-publish-meta');

    // 2. Escuchamos el evento "Submit" del formulario
    form.addEventListener('submit', async (e) => {
        e.preventDefault(); // Evitamos que la página se recargue

        // Cambiamos la UI al estado de "Carga"
        activarEstadoDeCarga();

        // 3. Recopilamos todos los parámetros elegidos por el dentista
        const payload = {
            especialidad: document.getElementById('clinical-specialty').value,
            enfoque: document.getElementById('campaign-focus').value,
            origenImagen: document.querySelector('input[name="image-source"]:checked').value,
            formato: document.querySelector('input[name="image-format"]:checked').value,
            tono: document.getElementById('communication-tone').value,
            incluirLink: document.getElementById('include-booking-link').checked
        };

        // 4. Validamos si el usuario eligió "Subir fotos"
        if (payload.origenImagen === 'user-uploaded') {
            const fileAntes = document.getElementById('img-before').files[0];
            const fileDespues = document.getElementById('img-after').files[0];
            
            if (!fileAntes && !fileDespues) {
                alert("Por favor, sube al menos una foto clínica o cambia el origen a 'Crear 100% con IA'.");
                restaurarEstadoVacio();
                return;
            }
            console.log("Fotos cargadas listas para procesar.");
            // NOTA: Para implementar la subida de imagen real a OpenAI,
            // aquí se convertirían los archivos a Base64 para añadirlos al payload.
        }

        // 5. Llamada REAL a la Edge Function de Supabase
        try {
            const { data, error } = await window.midental.functions.invoke('generar-campana-ia', {
                body: payload
            });

            // Si Supabase o la Edge Function devuelven un error, lo atrapamos
            if (error) throw error;

            // Renderizamos los resultados reales enviados por OpenAI
            renderizarResultados({
                imageUrl: data.imageUrl,
                copy: data.copy
            }, payload.formato);

        } catch (error) {
            console.error("Error al conectar con la IA:", error);
            emptyState.innerHTML = '<p style="color:var(--red-urgency); font-weight:bold;">Ocurrió un error al generar la publicación. Verifica tu conexión o revisa la consola.</p>';
        }
    });

    // ==========================================
    // FUNCIONES AUXILIARES DE INTERFAZ
    // ==========================================

    function activarEstadoDeCarga() {
        resultsState.classList.add('hidden');
        emptyState.classList.remove('hidden');
        emptyState.innerHTML = `
            <div style="color: var(--pixar-cyan);">
                <span class="material-symbols-outlined" style="font-size: 3.5rem; animation: spin 1.5s linear infinite;">autorenew</span>
                <h3 style="color: var(--blue-elegant); margin-top: 15px;">Generando contenido...</h3>
                <p style="color: #64748b; font-size: 0.9rem;">Analizando parámetros clínicos y creando la imagen perfecta.</p>
            </div>
        `;
    }

    function restaurarEstadoVacio() {
        emptyState.innerHTML = `
            <div class="placeholder-graphics">
                <span class="material-symbols-outlined placeholder-icon" style="color: var(--pixar-cyan);">image_search</span>
            </div>
            <p style="color: #64748b; margin-top: 1rem; font-weight: 500;">Configura los parámetros a la izquierda y presiona "Generar Publicación" para crear tu diseño.</p>
        `;
    }

    function renderizarResultados(respuestaIA, formatoStr) {
        emptyState.classList.add('hidden');
        resultsState.classList.remove('hidden');

        // Definimos proporciones según lo elegido
        let aspectClass = formatoStr === '1:1' ? 'aspect-ratio: 1/1;' : formatoStr === '9:16' ? 'aspect-ratio: 9/16; max-height: 500px;' : 'aspect-ratio: 4/5;';

        // Inyectamos el componente resultante en el DOM
        resultsState.innerHTML = `
            <div style="background: white; border: 1px solid #e2e8f0; border-radius: 15px; overflow: hidden; margin-bottom: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.05);">
                
                <!-- Área de la Imagen Generada -->
                <div style="background: #f1f5f9; padding: 20px; display: flex; justify-content: center; align-items: center; border-bottom: 1px solid #e2e8f0; position: relative;">
                    <img src="${respuestaIA.imageUrl}" style="${aspectClass} width: 100%; object-fit: cover; border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.1);" alt="Imagen Generada por IA">
                    
                    <button class="btn-pixar" style="position: absolute; bottom: 30px; right: 30px; background: rgba(255,255,255,0.9); backdrop-filter: blur(4px); color: var(--blue-elegant); border: none; padding: 8px 15px; border-radius: 20px; font-size: 0.85rem; font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 5px; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
                        <span class="material-symbols-outlined" style="font-size: 1.1rem;">refresh</span> Regenerar Imagen
                    </button>
                </div>

                <!-- Área del Copy (Texto) -->
                <div style="padding: 20px; text-align: left;">
                    <label style="font-weight: 800; color: var(--blue-elegant); font-size: 0.85rem; display: block; margin-bottom: 8px;">Texto Sugerido (Copy)</label>
                    <textarea id="copy-generado" rows="7" style="width: 100%; padding: 15px; border: 2px solid #e2e8f0; border-radius: 10px; resize: vertical; font-family: inherit; font-size: 0.95rem; color: #334155; line-height: 1.5;">${respuestaIA.copy}</textarea>
                    
                    <div style="display: flex; justify-content: flex-end; margin-top: 10px;">
                        <button onclick="navigator.clipboard.writeText(document.getElementById('copy-generado').value); alert('¡Texto copiado al portapapeles!');" style="background: transparent; border: 1px solid #cbd5e1; color: #475569; padding: 6px 12px; border-radius: 8px; font-size: 0.85rem; cursor: pointer; display: flex; align-items: center; gap: 5px; font-weight: bold;">
                            <span class="material-symbols-outlined" style="font-size: 1rem;">content_copy</span> Copiar Texto
                        </button>
                    </div>
                </div>
            </div>
        `;

        // Activamos la zona de integración con Meta
        btnPublish.disabled = false;
        btnPublish.style.filter = 'grayscale(0%)';
        btnPublish.style.transform = 'scale(1)';
        btnPublish.innerHTML = '<span class="material-symbols-outlined">send</span> Publicar ahora en Instagram';
    }
});