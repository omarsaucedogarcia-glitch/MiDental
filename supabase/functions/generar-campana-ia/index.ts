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
    const { especialidad, enfoque, formato, tono, incluirLink } = await req.json()
    const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY')

    if (!OPENAI_API_KEY) {
      throw new Error("Clave de OpenAI no configurada en las variables de entorno.")
    }

    const size = "1024x1024"

    const promptTexto = `Eres un copywriter experto en marketing odontológico. Escribe un post para redes sociales (Instagram/Facebook) sobre ${especialidad} enfocado en ${enfoque}. 
    El tono debe ser ${tono}. 
    Estructura:
    1. Un título atractivo con un emoji.
    2. Un cuerpo de texto corto (2-3 párrafos breves) que eduque o resalte el beneficio clínico.
    3. Un llamado a la acción (CTA) claro al final.
    ${incluirLink ? 'El CTA debe terminar exactamente con esta frase: "Reserva tu hora directamente aquí: [ENLACE_MIDENTAL]"' : ''}
    No uses hashtags genéricos, máximo 3 específicos.`

    const promptImagen = `Fotografía clínica dental, iluminación de estudio profesional, estilo editorial. Tema: ${especialidad}. Enfoque: ${enfoque}. Proporciones correctas, encías sanas color rosa coral, simetría.`

    const [respuestaTexto, respuestaImagen] = await Promise.all([
      fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-3.5-turbo",
          messages: [{ role: "user", content: promptTexto }],
          temperature: 0.7
        })
      }),
      fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "dall-e-2",
          prompt: promptImagen,
          n: 1,
          size: size
        })
      })
    ])

    const dataTexto = await respuestaTexto.json()
    const dataImagen = await respuestaImagen.json()

    if (dataImagen.error) throw new Error(`DALL-E Error: ${dataImagen.error.message}`)
    if (dataTexto.error) throw new Error(`GPT Error: ${dataTexto.error.message}`)

    const copyFinal = dataTexto.choices[0].message.content
    const urlImagenFinal = dataImagen.data[0].url

    return new Response(
      JSON.stringify({ copy: copyFinal, imageUrl: urlImagenFinal }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    console.error("Error en generar-campana-ia:", error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})