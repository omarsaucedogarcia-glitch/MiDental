// js/supabase-config.js
const supabaseUrl = 'https://kbpxqknvemmudutyhjln.supabase.co';
const supabaseKey = 'sb_publishable_fkP5JiSOEv0Efbao7-pWHg_STN6muNR';

// Inicialización global
const _supabase = supabase.createClient(supabaseUrl, supabaseKey);

// Exportamos para que otros archivos lo usen (si usas módulos) 
// o simplemente lo dejamos global si usas scripts normales.
window.midental = _supabase; 

console.log("✅ Conexión con MiDental Backend establecida");