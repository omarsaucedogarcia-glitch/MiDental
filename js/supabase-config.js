// js/supabase-config.js
const supabaseUrl = 'https://kbpxqknvemmudutyhjln.supabase.co';
const supabaseKey = 'sb_publishable_fkP5JiSOEv0Efbao7-pWHg_STN6muNR';

// Guarda: si el CDN de supabase-js no cargó, esto lanzaba
// "supabase is not defined" y TODOS los scripts posteriores quedaban muertos
// sin ninguna pista en la UI.
if (typeof supabase === 'undefined' || !supabase.createClient) {
    console.error("❌ supabase-js no se cargó. Revisa el <script src='...@supabase/supabase-js@2'> antes de este archivo.");
} else {
    // Inicialización global
    const _supabase = supabase.createClient(supabaseUrl, supabaseKey);

    // Exportamos para que otros archivos lo usen (si usas módulos)
    // o simplemente lo dejamos global si usas scripts normales.
    window.midental = _supabase;

    console.log("✅ Conexión con MiDental Backend establecida");
}