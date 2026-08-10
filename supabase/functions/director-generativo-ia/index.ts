import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

// ============================================================================
// 1. UTILIDADES: PROMPT COMPILER (El Constructor de Prompts)
// ============================================================================
class PromptBuilder {
    private sections: string[] = [];

    addRole(roleDescription: string) {
        this.sections.push(`[ROLE]\n${roleDescription}`);
        return this;
    }

    addInputContext(context: any) {
        this.sections.push(`[INPUT_CONTEXT]\n${JSON.stringify(context, null, 2)}`);
        return this;
    }

    addMission(mission: string) {
        this.sections.push(`[MISSION]\n${mission}`);
        return this;
    }

    addOutputSchema(schema: any) {
        this.sections.push(`[OUTPUT_SCHEMA]\n${JSON.stringify(schema, null, 2)}\n\n(Debes retornar estrictamente un JSON que cumpla esta estructura, sin markdown).`);
        return this;
    }

    build() {
        return this.sections.join('\n\n-------------------\n\n');
    }
}

// ============================================================================
// 2. CAPACIDADES: CAMPAIGN BUILDER (Especialización)
// ============================================================================
class CampaignCapability {
    static getOutputSchema() {
        return {
            "campaign": {
                "title": "string",
                "goal": "string",
                "priority": "string",
                "confidence": "number (0 a 1)",
                "reasoning": ["string", "string"],
                "estimatedImpact": {
                    "agenda": "number",
                    "patients": "number"
                }
            },
            "copies": {
                "instagram": "string",
                "facebook": "string",
                "linkedin": "string",
                "telegram": "string",
                "email": "string",
                "sms": "string"
            },
            "creative": {
                "headline": "string",
                "subheadline": "string",
                "visualPrompt": "string",
                "colorPalette": "string",
                "cta": "string"
            }
        };
    }

    static buildPrompt(payload: any) {
        return new PromptBuilder()
            .addRole("Eres el Director de Inteligencia de Marketing de MiDental. Eres un experto en crecimiento clínico, persuasión ética y branding odontológico.")
            .addInputContext({
                knowledge: payload.knowledge,
                reasoning: payload.reasoning
            })
            .addMission("Tu misión es transformar el contexto clínico y la decisión estratégica recibida (Reasoning) en una campaña de marketing omnicanal estructurada y lista para su ejecución.")
            .addOutputSchema(this.getOutputSchema())
            .build();
    }
}

// ============================================================================
// 3. CORE: EL MOTOR DE IA (Adaptador Agóstico)
// ============================================================================
class AIEngine {
    static async generateJSON(systemPrompt: string, userPrompt: string = "Procesa el contexto y genera el JSON.") {
        const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');
        if (!GEMINI_API_KEY) throw new Error("Missing AI Key");

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: userPrompt }] }],
                systemInstruction: { parts: [{ text: systemPrompt }] },
                generationConfig: {
                    temperature: 0.4, // Baja temperatura porque queremos ejecución precisa de la estrategia
                    response_mime_type: "application/json"
                }
            })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error?.message || "AI Error");

        const jsonString = data.candidates[0].content.parts[0].text;
        return JSON.parse(jsonString); // Falla rápido si la IA alucina
    }
}

// ============================================================================
// 4. EL ORQUESTADOR GLOBAL (Edge Function Entry Point)
// ============================================================================
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

    try {
        // 1. Recibir Payload Completo (Knowledge + Reasoning + Config)
        const requestData = await req.json();

        // 2. Enrutador de Capacidades (Decision Engine Router)
        // El frontend o un trigger decide qué capacidad invocar (Ej: 'build_campaign', 'explain_score')
        const capability = requestData.action || 'build_campaign';
        
        let aiResult;

        if (capability === 'build_campaign') {
            // Construir el prompt modular
            const finalPrompt = CampaignCapability.buildPrompt(requestData);
            
            // Invocar el modelo agnóstico
            aiResult = await AIEngine.generateJSON(finalPrompt);
            
            // Aquí podríamos agregar una capa de "Enriquecimiento" (Ej: guardar en Memoria Estratégica)
            // await saveToMemory(requestData.knowledge.clinic.id, aiResult.campaign);
        } else {
            throw new Error(`Capability '${capability}' not implemented yet.`);
        }

        // 3. Retornar el objeto estructurado
        return new Response(JSON.stringify(aiResult), { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 200 
        });

    } catch (error) {
        console.error("Orchestrator Error:", error);
        return new Response(JSON.stringify({ error: error.message }), { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            status: 500
        });
    }
});