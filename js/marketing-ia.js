// js/marketing-ia.js

document.addEventListener('DOMContentLoaded', () => {
    // 1. Capturamos los elementos clave del DOM
    const form = document.getElementById('marketing-generator-form');
    const emptyState = document.getElementById('preview-state-empty');
    const resultsState = document.getElementById('preview-state-results');
    const btnPublish = document.getElementById('btn-publish-meta');
    const radioSource = document.getElementsByName('image-source');
    const photoZone = document.getElementById('upload-clinical-photos');

    // 2. Lógica para mostrar/ocultar carga de fotos
    radioSource.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if(e.target.value === 'user-uploaded') {
                photoZone.style.display = 'block';
            } else {
                photoZone.style.display = 'none';
            }
        });
    });

    // 3. Escuchamos el evento "Submit" del formulario
    form.addEventListener('submit', async (e) => {
        e.preventDefault(); 

        const btn = document.getElementById('btn-generate-post');
        const originalBtnHtml = btn.innerHTML;

        // Recopilamos todos los parámetros
        const payload = {
            dentista_id: localStorage.getItem('midental_user_id'), // Vital para saber a quién descontar tokens
            especialidad: document.getElementById('clinical-specialty').value,
            enfoque: document.getElementById('campaign-focus').value,
            origenImagen: document.querySelector('input[name="image-source"]:checked').value,
            formato: document.querySelector('input[name="image-format"]:checked').value,
            tono: document.getElementById('communication-tone').value,
            incluirLink: document.getElementById('include-booking-link').checked,
            imagenAntesBase64: null,
            imagenDespuesBase64: null
        };

        // Validamos si el usuario eligió "Subir fotos"
        if (payload.origenImagen === 'user-uploaded') {
            const fileAntes = document.getElementById('img-before').files[0];
            const fileDespues = document.getElementById('img-after').files[0];
            
            if (!fileAntes && !fileDespues) {
                alert("Por favor, sube al menos una foto clínica o cambia el origen a 'Crear 100% con IA'.");
                return;
            }

            try {
                // Convertimos las imágenes a Base64 para que la IA pueda procesarlas
                if (fileAntes) payload.imagenAntesBase64 = await convertirABase64(fileAntes);
                if (fileDespues) payload.imagenDespuesBase64 = await convertirABase64(fileDespues);
            } catch (err) {
                alert("Error al leer las imágenes. Intenta con otro archivo.");
                return;
            }
        }

        // Cambiamos la UI al estado de "Carga"
        activarEstadoDeCarga(btn);

        // 4. Llamada REAL a la Edge Function de Supabase
        try {
            const { data, error } = await window.midental.functions.invoke('generar-campana-ia', {
                body: payload
            });

            // Si Supabase devuelve un error (ej. sin tokens, error de API), lo atrapamos
            if (error) throw error;

            // Renderizamos los resultados reales enviados por la IA
            renderizarResultados({
                imageUrl: data.imageUrl,
                copy: data.copy
            }, payload.formato);

            // Descontar token visualmente
            let tokenCount = document.querySelector('.token-count');
            let currentTokens = parseInt(tokenCount.innerText);
            if(currentTokens > 0) tokenCount.innerText = currentTokens - 1;

        } catch (error) {
            console.error("Error al conectar con la IA:", error);
            resultsState.innerHTML = `<p style="color:var(--red-urgency); font-weight:bold; padding: 20px; text-align: center; border: 1px solid #fecaca; border-radius: 10px; background: #fef2f2;">Ocurrió un error al generar la publicación. Verifica tu conexión o revisa que tengas tokens disponibles.</p>`;
            setTimeout(() => {
                restaurarEstadoVacio();
            }, 4000);
        } finally {
            // Restaurar el botón
            btn.innerHTML = originalBtnHtml;
            btn.disabled = false;
        }
    });

    // ==========================================
    // FUNCIONES AUXILIARES
    // ==========================================

    function convertirABase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = () => resolve(reader.result.split(',')[1]); // Extraer solo la data, sin el header data:image/jpeg;base64,
            reader.onerror = error => reject(error);
        });
    }

    function activarEstadoDeCarga(btnSubmit) {
        btnSubmit.innerHTML = '<span class="material-symbols-outlined" style="animation: spin 1s linear infinite;">sync</span> Generando magia IA...';
        btnSubmit.disabled = true;

        emptyState.classList.add('hidden');
        resultsState.classList.remove('hidden');
        
        resultsState.innerHTML = `
            <div style="padding: 40px 0; text-align: center;">
                <span class="material-symbols-outlined" style="font-size: 3.5rem; color: var(--pixar-cyan); animation: spin 1.5s linear infinite;">autorenew</span>
                <h3 style="color: var(--blue-elegant); margin-top: 15px;">Generando contenido...</h3>
                <p style="color: #64748b; font-size: 0.9rem;">Analizando parámetros clínicos y creando la imagen perfecta.</p>
            </div>
        `;
    }

    function restaurarEstadoVacio() {
        resultsState.classList.add('hidden');
        emptyState.classList.remove('hidden');
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
                    <img src="${respuestaIA.imageUrl}" style="${aspectClass} width: 100%; max-width: 350px; object-fit: cover; border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.1);" alt="Imagen Generada por IA">
                    
                    <a href="${respuestaIA.imageUrl}" target="_blank" download="midental-ia-post.jpg" class="btn-pixar" style="position: absolute; bottom: 30px; right: 30px; background: rgba(255,255,255,0.9); backdrop-filter: blur(4px); color: var(--blue-elegant); border: none; padding: 8px 15px; border-radius: 20px; font-size: 0.85rem; font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 5px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); text-decoration: none;">
                        <span class="material-symbols-outlined" style="font-size: 1.1rem;">download</span> Descargar
                    </a>
                </div>

                <!-- Área del Copy (Texto) -->
                <div style="padding: 20px; text-align: left;">
                    <label style="font-weight: 800; color: var(--blue-elegant); font-size: 0.85rem; display: block; margin-bottom: 8px;">Texto Sugerido (Puedes editarlo aquí mismo)</label>
                    <textarea id="copy-generado" rows="7" style="width: 100%; padding: 15px; border: 2px solid #e2e8f0; border-radius: 10px; resize: vertical; font-family: inherit; font-size: 0.95rem; color: #334155; line-height: 1.5; box-sizing: border-box;">${respuestaIA.copy}</textarea>
                    
                    <div style="display: flex; justify-content: flex-end; margin-top: 10px;">
                        <button onclick="navigator.clipboard.writeText(document.getElementById('copy-generado').value); alert('¡Texto copiado al portapapeles!');" style="background: transparent; border: 1px solid #cbd5e1; color: #475569; padding: 6px 12px; border-radius: 8px; font-size: 0.85rem; cursor: pointer; display: flex; align-items: center; gap: 5px; font-weight: bold; transition: 0.2s;">
                            <span class="material-symbols-outlined" style="font-size: 1rem;">content_copy</span> Copiar Texto
                        </button>
                    </div>
                </div>
            </div>
        `;

        // Activamos la zona de integración con Meta (Instagram)
        const btnPublish = document.getElementById('btn-publish-meta');
        if (btnPublish) {
            btnPublish.disabled = false;
            btnPublish.style.filter = 'grayscale(0%)';
            btnPublish.style.opacity = '1';
            btnPublish.style.cursor = 'pointer';
            btnPublish.innerHTML = '<span class="material-symbols-outlined">send</span> Publicar ahora en Instagram';
        }
    }
});