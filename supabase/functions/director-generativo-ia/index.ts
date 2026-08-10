import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

// ============================================================================
// CORS
// Se devuelven en TODAS las respuestas (preflight, exito y error).
// Sin esto, un 400/500 llega al navegador como "Failed to fetch" y el mensaje
// real del servidor se pierde.
// ============================================================================
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' }

// Respuesta de error unificada: siempre JSON, siempre con CORS.
// `stage` le dice al frontend DONDE fallo (payload | config | gemini | parse).
function errorResponse(stage: string, message: string, status: number, extra: Record<string, unknown> = {}) {
  console.error(`[director-generativo-ia] stage=${stage} status=${status} :: ${message}`)
  return new Response(JSON.stringify({ error: message, stage, ...extra }), {
    headers: jsonHeaders,
    status,
  })
}

// ============================================================================
// MODELOS
// gemini-2.5-flash quedo retirado para claves nuevas (404 NOT_FOUND:
// "no longer available to new users"). Usamos el alias `latest` como primario
// y una cadena de respaldo para que un retiro futuro no vuelva a tumbar la app.
// ============================================================================
const MODELOS = ['gemini-flash-latest', 'gemini-3.6-flash', 'gemini-2.5-flash']

const TIMEOUT_MS = 45_000

// Esquema estricto: obliga a Gemini a devolver exactamente estas 6 claves.
// Las `description` son lo que realmente respeta el modelo (mucho más que la
// instrucción en prosa): en pruebas, sin esto sugerencia_visual salía de 200+
// caracteres y desbordaba el canvas.
const responseSchema = {
  type: 'OBJECT',
  properties: {
    analisis_estrategico: {
      type: 'STRING',
      description: 'Máximo 2 líneas: por qué esta campaña es vital para el negocio hoy.',
    },
    publico_objetivo: {
      type: 'STRING',
      description: 'Máximo 40 palabras: perfil exacto del paciente al que va dirigida.',
    },
    plan_de_accion: {
      type: 'ARRAY',
      items: { type: 'STRING' },
      description: 'Exactamente 3 pasos accionables, uno por elemento.',
      minItems: 3,
      maxItems: 3,
    },
    texto_sugerido_base: {
      type: 'STRING',
      description: 'Guion listo para copiar y pegar en redes o WhatsApp.',
    },
    prompt_para_ia_externa: {
      type: 'STRING',
      description: 'Prompt específico para pegar en ChatGPT o Claude y generar variaciones.',
    },
    sugerencia_visual: {
      type: 'STRING',
      description: 'MÁXIMO 10 PALABRAS. Solo la descripción de la foto clínica ideal, sin explicaciones ni frases completas. Ejemplo: "Paciente adulto sonriendo en sillón dental, luz natural".',
    },
  },
  required: [
    'analisis_estrategico',
    'publico_objetivo',
    'plan_de_accion',
    'texto_sugerido_base',
    'prompt_para_ia_externa',
    'sugerencia_visual',
  ],
}

// Extrae el texto del candidato ignorando las partes de "pensamiento" (thought)
// que los modelos 2.5/3.x pueden incluir antes de la respuesta final.
function extraerTexto(geminiData: any): string {
  const bloqueo = geminiData?.promptFeedback?.blockReason
  if (bloqueo) {
    throw new Error(`Gemini bloqueo la solicitud por politica de contenido (${bloqueo}).`)
  }

  const candidato = geminiData?.candidates?.[0]
  if (!candidato) {
    throw new Error('Gemini no devolvio ningun candidato de respuesta.')
  }

  const partes = candidato?.content?.parts
  if (!Array.isArray(partes) || partes.length === 0) {
    // Caso tipico: finishReason MAX_TOKENS / SAFETY -> candidato sin `parts`.
    throw new Error(
      `Gemini devolvio una respuesta vacia (finishReason: ${candidato.finishReason ?? 'desconocido'}).`,
    )
  }

  const texto = partes
    .filter((p: any) => typeof p?.text === 'string' && p.thought !== true)
    .map((p: any) => p.text)
    .join('')
    .trim()

  if (!texto) {
    throw new Error('Gemini devolvio partes sin contenido de texto utilizable.')
  }
  return texto
}

// Red de seguridad: aunque pedimos JSON puro, limpiamos vallas markdown
// (```json ... ```) por si el modelo las agrega.
function limpiarJson(texto: string): string {
  let t = texto.trim()
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  }
  const inicio = t.indexOf('{')
  const fin = t.lastIndexOf('}')
  if (inicio > 0 || (fin !== -1 && fin < t.length - 1)) {
    if (inicio !== -1 && fin > inicio) t = t.slice(inicio, fin + 1)
  }
  return t
}

// Normaliza el objeto para que el frontend NUNCA reciba una clave faltante.
function normalizarPlan(plan: any) {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  let pasos = plan?.plan_de_accion
  if (typeof pasos === 'string') pasos = pasos.split(/\r?\n/)
  if (!Array.isArray(pasos)) pasos = []

  return {
    analisis_estrategico: str(plan?.analisis_estrategico),
    publico_objetivo: str(plan?.publico_objetivo),
    plan_de_accion: pasos.map((p: unknown) => str(p)).filter(Boolean),
    texto_sugerido_base: str(plan?.texto_sugerido_base),
    prompt_para_ia_externa: str(plan?.prompt_para_ia_externa),
    sugerencia_visual: str(plan?.sugerencia_visual),
  }
}

serve(async (req) => {
  // 1. PREFLIGHT: 204 + headers CORS completos.
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return errorResponse('payload', `Metodo ${req.method} no permitido. Usa POST.`, 405)
  }

  // 2. PARSEO DEL PAYLOAD
  //    Las claves deben coincidir con las que envia motor-decisiones-ia.js.
  let body: any
  try {
    body = await req.json()
  } catch {
    return errorResponse('payload', 'El cuerpo de la peticion no es JSON valido.', 400)
  }

  const doctor = typeof body?.doctor === 'string' && body.doctor.trim()
    ? body.doctor.trim()
    : 'el profesional a cargo'
  const objetivo_estrategico = typeof body?.objetivo_estrategico === 'string'
    ? body.objetivo_estrategico.trim()
    : ''
  const tono_marca = typeof body?.tono_marca === 'string' && body.tono_marca.trim()
    ? body.tono_marca.trim()
    : 'Profesional, cercano y enfocado en evidencia clinica'
  const restricciones = typeof body?.restricciones === 'string' && body.restricciones.trim()
    ? body.restricciones.trim()
    : 'Lenguaje apto para pacientes, sin tecnicismos complejos.'
  const contexto_clinico = body?.contexto_clinico ?? null

  if (!objetivo_estrategico) {
    return errorResponse(
      'payload',
      'Falta "objetivo_estrategico" en el cuerpo de la peticion.',
      400,
      { recibido: Object.keys(body ?? {}) },
    )
  }

  // 3. CONFIGURACION
  const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')
  if (!GEMINI_API_KEY) {
    return errorResponse(
      'config',
      'GEMINI_API_KEY no esta configurada en los secrets de la Edge Function. Ejecuta: supabase secrets set GEMINI_API_KEY=...',
      500,
    )
  }

  const systemInstruction = `Eres el Director de Marketing Inteligente de una clinica dental de alto nivel.
Tu mision no es simplemente escribir un post de redes sociales, sino desarrollar un PLAN DE EJECUCION MAESTRO. Debes entregar instrucciones exactas y paso a paso para que el dentista implemente esta campana con exito.

DATOS DEL ENTORNO:
- Profesional a cargo: ${doctor}
- Objetivo Estrategico de la Campana: "${objetivo_estrategico}"
- Tono de comunicacion: ${tono_marca}
- Reglas: ${restricciones}${
    contexto_clinico ? `\n- Metricas reales de la clinica este mes: ${JSON.stringify(contexto_clinico)}` : ''
  }

CONTENIDO EXIGIDO POR CAMPO:
- analisis_estrategico: 2 lineas explicando por que esta campana es vital para el negocio hoy.
- publico_objetivo: descripcion exacta del perfil del paciente al que va dirigida.
- plan_de_accion: exactamente 3 pasos. (1) Que grabar, que foto buscar o que preparar antes de publicar. (2) En que canales especificos publicar y en que horarios. (3) Que protocolo seguir cuando el paciente pregunte o interactue.
- texto_sugerido_base: borrador o guion listo para copiar y pegar en redes o enviar por WhatsApp.
- prompt_para_ia_externa: un prompt ultra especifico que el dentista pueda pegar en ChatGPT o Claude para generar variaciones de este mismo concepto.
- sugerencia_visual: maximo 10 palabras describiendo la foto clinica ideal para la pieza grafica.

Responde unicamente con el objeto JSON. No uses markdown ni bloques de codigo.`

  const payloadGemini = JSON.stringify({
    contents: [{
      role: 'user',
      parts: [{ text: 'Genera el plan de ejecucion maestro estructurado para el objetivo indicado.' }],
    }],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      responseSchema,
    },
  })

  // 4. LLAMADA A GEMINI con cadena de respaldo y timeout duro.
  let textoCrudo = ''
  let modeloUsado = ''
  const fallos: string[] = []

  for (const modelo of MODELOS) {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // La key va en header, no en la URL, para que no quede en logs.
            'x-goog-api-key': GEMINI_API_KEY,
          },
          body: payloadGemini,
          signal: abort.signal,
        },
      )

      const geminiData = await response.json().catch(() => null)

      if (!response.ok) {
        const msg = geminiData?.error?.message ?? `HTTP ${response.status} desde Gemini`
        fallos.push(`${modelo}: ${msg}`)
        // 404 (modelo retirado) o 400 de modelo -> probamos el siguiente.
        // 401/403 (key invalida) o 429 (cuota) no se arreglan cambiando de modelo.
        if (response.status === 401 || response.status === 403 || response.status === 429) {
          return errorResponse('gemini', msg, 502, { modelo, intentos: fallos })
        }
        continue
      }

      textoCrudo = extraerTexto(geminiData)
      modeloUsado = geminiData?.modelVersion ?? modelo
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      fallos.push(`${modelo}: ${abort.signal.aborted ? `timeout tras ${TIMEOUT_MS}ms` : msg}`)
      continue
    } finally {
      clearTimeout(timer)
    }
  }

  if (!textoCrudo) {
    return errorResponse(
      'gemini',
      `Ningun modelo de Gemini respondio correctamente. Detalle: ${fallos.join(' | ')}`,
      502,
      { intentos: fallos },
    )
  }

  // 5. VALIDACION SERVER-SIDE
  //    Parseamos aqui para no enviarle al navegador un JSON roto: si el modelo
  //    alucina, el frontend recibe un error claro en vez de un SyntaxError opaco.
  let plan: any
  try {
    plan = JSON.parse(limpiarJson(textoCrudo))
  } catch {
    return errorResponse(
      'parse',
      'Gemini no devolvio un JSON valido.',
      502,
      { muestra: textoCrudo.slice(0, 300), modelo: modeloUsado },
    )
  }

  const planNormalizado = normalizarPlan(plan)
  if (!planNormalizado.texto_sugerido_base && !planNormalizado.analisis_estrategico) {
    return errorResponse(
      'parse',
      'El plan generado llego vacio en sus campos principales.',
      502,
      { modelo: modeloUsado },
    )
  }

  return new Response(
    JSON.stringify({ ...planNormalizado, _meta: { modelo: modeloUsado } }),
    { headers: jsonHeaders, status: 200 },
  )
})
