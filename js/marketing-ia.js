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
        // NOTA: En lugar de un <img> estático, ahora inyectamos el <canvas> que dibujará la imagen con la marca
        resultsState.innerHTML = `
            <div style="background: white; border: 1px solid #e2e8f0; border-radius: 15px; overflow: hidden; margin-bottom: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.05);">
                
                <!-- Área de la Imagen Generada (Ahora es un Canvas Dinámico) -->
                <div style="background: #1e293b; padding: 20px; display: flex; flex-direction: column; justify-content: center; align-items: center; border-bottom: 1px solid #e2e8f0; position: relative; min-height: 350px;">
                    
                    <canvas id="canvasPreview" style="${aspectClass} width: 100%; max-width: 350px; border-radius: 8px; box-shadow: 0 4px 15px rgba(0,0,0,0.3);"></canvas>
                    
                    <button id="btnDescargarCanvas" class="btn-pixar" style="margin-top: 15px; background: rgba(255,255,255,0.9); backdrop-filter: blur(4px); color: var(--blue-elegant); border: none; padding: 8px 15px; border-radius: 20px; font-size: 0.85rem; font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 5px; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
                        <span class="material-symbols-outlined" style="font-size: 1.1rem;">download</span> Descargar Imagen
                    </button>
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

        // Llamamos a la función mágica para pintar el lienzo con la foto y los datos del doctor
        fusionarImagenYMarca(respuestaIA.imageUrl, formatoStr);

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

    // ==========================================
    // CAPA DINÁMICA (CANVAS Y MARCA)
    // ==========================================

    function fusionarImagenYMarca(imagenFondoUrl, formatoStr) {
        const canvas = document.getElementById('canvasPreview');
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        
        // Obtenemos los valores de los controles del formulario
        const sede = document.getElementById('sedeSelect') ? document.getElementById('sedeSelect').value : '';
        const telefono = document.getElementById('telefonoContacto') ? document.getElementById('telefonoContacto').value : '';
        const mostrarBoton = document.getElementById('mostrarBotonAgenda') ? document.getElementById('mostrarBotonAgenda').checked : false;

        const img = new Image();
        img.crossOrigin = "Anonymous"; // Crucial para que el navegador permita la descarga del Canvas final
        img.src = imagenFondoUrl;

        img.onload = () => {
            // Ajustamos el tamaño del Canvas según el formato elegido
            if (formatoStr === '1:1') {
                canvas.width = 1080;
                canvas.height = 1080;
            } else if (formatoStr === '4:5') {
                canvas.width = 1080;
                canvas.height = 1350;
            } else if (formatoStr === '9:16') {
                canvas.width = 1080;
                canvas.height = 1920;
            } else {
                canvas.width = 1080;
                canvas.height = 1080;
            }

            // 1. Dibujar la foto de fondo (Capa Base)
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

            // 2. Dibujar degradado oscuro inferior para legibilidad del texto
            const altoDegradado = canvas.height * 0.35; // El degradado ocupa el 35% inferior
            const gradient = ctx.createLinearGradient(0, canvas.height - altoDegradado, 0, canvas.height);
            gradient.addColorStop(0, 'rgba(0,0,0,0)');
            gradient.addColorStop(1, 'rgba(0,0,0,0.9)');
            ctx.fillStyle = gradient;
            ctx.fillRect(0, canvas.height - altoDegradado, canvas.width, altoDegradado);

            // 3. Escribir Datos del Profesional (Capa Dinámica Editable)
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            
            // Leemos directamente desde los inputs editables creados por el usuario
            const textoNombreCustom = document.getElementById('inputTextoNombre') ? document.getElementById('inputTextoNombre').value : `Dr(a). ${window.nombreDoctorActual || 'Profesional'}`;
            const textoDetalleCustom = document.getElementById('inputTextoDetalle') ? document.getElementById('inputTextoDetalle').value : `${sede}  |  📞 ${telefono}`;
            const textoTelCustom = document.getElementById('inputTextoTelefono') ? document.getElementById('inputTextoTelefono').value : '';

            // Dibujar Título / Nombre
            ctx.font = 'bold 42px "Segoe UI", Arial, sans-serif';
            ctx.fillText(textoNombreCustom, canvas.width / 2, canvas.height - 180);

            // Dibujar Sede / Teléfono
            ctx.font = 'normal 28px "Segoe UI", Arial, sans-serif';
            ctx.fillStyle = '#e2e8f0';
            ctx.fillText(textoDetalleCustom, canvas.width / 2, canvas.height - 125);

            if(textoTelCustom) {
                ctx.font = 'bold 26px "Segoe UI", Arial, sans-serif';
                ctx.fillStyle = '#38bdf8'; // Toque estético corporativo
                ctx.fillText(textoTelCustom, canvas.width / 2, canvas.height - 80);
            }

            // Configuramos el botón de descarga para que guarde la imagen final procesada
            configurarBotonDescarga(canvas);
        };
        
        img.onerror = () => {
            console.error("Error al cargar la imagen externa en el Canvas. Revisa las políticas CORS de Unsplash/Storage.");
        };
    }

    function configurarBotonDescarga(canvas) {
        const btnDescargar = document.getElementById('btnDescargarCanvas');
        if(btnDescargar) {
            btnDescargar.addEventListener('click', () => {
                // Convertimos el lienzo a un archivo PNG y forzamos la descarga
                const dataURL = canvas.toDataURL('image/png');
                const a = document.createElement('a');
                a.href = dataURL;
                a.download = `MiDental-Post-${Date.now()}.png`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            });
        }
    }
    // Escuchar cambios en tiempo real en los inputs de texto de la imagen
    ['inputTextoNombre', 'inputTextoDetalle', 'inputTextoTelefono', 'sedeSelect', 'telefonoContacto', 'mostrarBotonAgenda'].forEach(id => {
        const el = document.getElementById(id);
        if(el) {
            el.addEventListener('input', () => {
                // Si ya hay una imagen generada, la redibuja con los nuevos textos al instante
                const imgElement = document.getElementById('canvasPreview');
                if(imgElement && imgElement.style.display !== 'none' && window.ultimaUrlImagenIA) {
                    fusionarImagenYMarca(window.ultimaUrlImagenIA, window.ultimoFormatoIA);
                }
            });
        }
    });
});