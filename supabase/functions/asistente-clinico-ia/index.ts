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
    const { notas } = await req.json()
    
    // CORREGIDO: Llama a la variable de entorno, no a la llave directamente
    const apiKey = Deno.env.get('GEMINI_API_KEY')

    if (!apiKey) {
      throw new Error("La API Key de Gemini no se encontró en el servidor local.")
    }

    const prompt = `Eres un odontólogo experto redactando fichas clínicas. 
    Toma estas notas rápidas de un colega: "${notas}"
    y transfórmalas en lenguaje clínico, técnico, formal y en tercera persona.
    Devuelve ÚNICAMENTE un objeto JSON válido con esta estructura exacta:
    {
      "motivo": "redacción del motivo de consulta",
      "diagnostico": "redacción del diagnóstico",
      "procedimiento": "redacción del procedimiento realizado"
    }
    No incluyas formato markdown, ni la palabra json, solo las llaves y su contenido.`

    /// Llamada a la API actualizada a Gemini 2.0 Flash para compatibilidad con proyectos 2026
    const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 } 
      })
    })

    const geminiData = await response.json()

    // Verificamos si Google devolvió un error directo
    if (geminiData.error) {
        throw new Error(`Error de Google: ${geminiData.error.message}`)
    }

    const textResponse = geminiData.candidates[0].content.parts[0].text
    const cleanJson = textResponse.replace(/```json/g, '').replace(/```/g, '').trim()
    const jsonResult = JSON.parse(cleanJson)

    return new Response(JSON.stringify(jsonResult), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})