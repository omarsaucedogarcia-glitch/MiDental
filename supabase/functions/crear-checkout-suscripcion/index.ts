import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  // 1. Manejo de seguridad CORS para que tu web HTML pueda llamar a esta función
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 2. Leemos los datos que nos enviará tu web (el ID del dentista y su email)
    const { dentista_id, email_dentista } = await req.json()

    // 3. Obtenemos tu llave secreta de Mercado Pago guardada en Supabase
    const MP_ACCESS_TOKEN = Deno.env.get('MP_ACCESS_TOKEN')
    if (!MP_ACCESS_TOKEN) throw new Error('Falta el token de Mercado Pago en el servidor')

    // 4. Armamos el contrato de suscripción (Preapproval)
    const subData = {
      reason: "MiDental Pro - Suscripción Mensual",
      auto_recurring: {
        frequency: 1,
        frequency_type: "months",
        transaction_amount: 29990, // El valor de tu mensualidad en CLP
        currency_id: "CLP"
      },
      back_url: "https://midental.cl/Dashboard-dentista.html", // A dónde vuelve tras pagar
      payer_email: email_dentista,
      external_reference: dentista_id // Clave: Enviamos el ID del dentista para que MP nos lo devuelva en el webhook
    }

    // 5. Nos comunicamos con los servidores de Mercado Pago
    const mpResponse = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(subData)
    })

    const mpResult = await mpResponse.json()

    if (!mpResponse.ok) {
      console.error("Error de MP:", mpResult)
      throw new Error('No se pudo generar el link de Mercado Pago')
    }

    // 6. Devolvemos el link de pago (init_point) de forma segura al frontend
    return new Response(
      JSON.stringify({ init_point: mpResult.init_point }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error: any) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})