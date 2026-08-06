import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const {
      especialidad,
      enfoque,
      origenImagen,
      tono,
      incluirLink,
      imagenAntesBase64,
      imagenDespuesBase64
    } = await req.json()

    // Usaremos Gemini en lugar de OpenAI
    const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')
    if (!GEMINI_API_KEY) {
      throw new Error("Clave de Gemini no configurada en las variables de entorno.")
    }

    // Prompt estructurado y calibrado para tu perfil
    let promptText = `Eres un copywriter experto en marketing clínico odontológico. 
    El perfil clínico para el que escribes se enfoca fuertemente en la rehabilitación oral y la recuperación funcional y estética del paciente, entregando resultados de alta calidad y confianza.
    
    Redacta un "Copy" para Instagram con estos parámetros:
    - Tema/Tratamiento: ${especialidad}
    - Enfoque del post: ${enfoque}
    - Tono de comunicación: ${tono}
    
    ESTRUCTURA EXIGIDA:
    1. Título atractivo con un emoji.
    2. Cuerpo corto (2-3 párrafos) conectando el problema del paciente con la solución clínica.
    3. Llamado a la acción (CTA) claro. ${incluirLink ? 'Termina con: "Reserva tu evaluación en el enlace de nuestra biografía 👆"' : 'Termina con: "Envíanos un mensaje directo para analizar tu caso 💬"'}
    
    REGLAS: No uses comillas al inicio o final. Escribe directo el texto listo para copiar. Usa máximo 3 hashtags específicos.`;

    let contents: any[] = [];
    
    // Si enviaste fotos reales, le pedimos a la IA que las mire
    if (origenImagen === 'user-uploaded' && (imagenAntesBase64 || imagenDespuesBase64)) {
        promptText += "\n\nSe adjuntan fotos reales del caso clínico (Antes y/o Después). Analiza los cambios visuales y menciona sutilmente la mejora evidente en el texto para dar credibilidad clínica.";
        const parts: any[] = [{ text: promptText }];
        
        if (imagenAntesBase64) parts.push({ inline_data: { mime_type: "image/jpeg", data: imagenAntesBase64 } });
        if (imagenDespuesBase64) parts.push({ inline_data: { mime_type: "image/jpeg", data: imagenDespuesBase64 } });
        
        contents = [{ parts }];
    } else {
        contents = [{ parts: [{ text: promptText }] }];
    }

    // Llamada multimodal a Gemini 1.5 Flash
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`;
    
    const geminiResponse = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents })
    });

    const geminiData = await geminiResponse.json();
    if (!geminiResponse.ok) {
        throw new Error(geminiData.error?.message || 'Error desconocido al contactar a Gemini.');
    }

    const copyFinal = geminiData.candidates[0].content.parts[0].text;

    // Asignación de imágenes fotográficas reales (Fallback estético)
    let urlImagenFinal = "https://images.unsplash.com/photo-1606811841689-23dfddce3e95?auto=format&fit=crop&w=600&q=80"; 
    if (especialidad === 'blanqueamiento') urlImagenFinal = "https://images.unsplash.com/photo-1590625695029-79f977fc6d93?auto=format&fit=crop&w=600&q=80";
    if (especialidad === 'ortodoncia') urlImagenFinal = "https://images.unsplash.com/photo-1609840114035-3c981b782dfe?auto=format&fit=crop&w=600&q=80";
    if (especialidad === 'rehabilitacion') urlImagenFinal = "https://images.unsplash.com/photo-1588776814546-1ffcf47267a5?auto=format&fit=crop&w=600&q=80";

    return new Response(
      JSON.stringify({ copy: copyFinal, imageUrl: urlImagenFinal }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error: any) {
    console.error("Error en generar-campana-ia:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})