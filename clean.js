const fs = require('fs');
const path = require('path');

function processHtml(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let originalContent = content;

  // Remove paywall and payment modals
  content = content.replace(/<div id="modalPaywall"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g, '');
  content = content.replace(/<div id="modalRegistrarPago"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/g, '');
  content = content.replace(/<div id="modalPagoFicha"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g, '');
  content = content.replace(/<div id="modalEditarPagoFicha"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g, '');
  content = content.replace(/<div id="modalCertificadoPagos"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g, '');
  
  // Remove token UI
  content = content.replace(/<div class="token-monedero-header">[\s\S]*?<\/div>/g, '');
  content = content.replace(/<div class="token-balance-card">[\s\S]*?<\/div>\s*<\/div>/g, '');
  
  // Remove suscripciones buttons
  content = content.replace(/<button[^>]*id="btn-paywall-suscribir"[^>]*>[\s\S]*?<\/button>/g, '');

  if (content !== originalContent) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Modified ' + filePath);
  }
}

function processJs(filePath) {
    let content = fs.readFileSync(filePath, 'utf8');
    let originalContent = content;
    
    // Remove references to tokens
    content = content.replace(/window\.procesarPagoReal\s*=\s*async\s*function\(\)\s*\{[\s\S]*?\}\s*;\s*/g, '');
    content = content.replace(/window\.actualizarPrecioTokens\s*=\s*function\(\)\s*\{[\s\S]*?\}\s*;\s*/g, '');
    content = content.replace(/async\s*function\s*cargarSaldoTokens\(\)\s*\{[\s\S]*?\}\s*/g, '');
    content = content.replace(/async\s*function\s*procesarSuscripcionPro\([^)]*\)\s*\{[\s\S]*?\}\s*/g, '');
    
    // Call removers
    content = content.replace(/cargarSaldoTokens\(\);/g, '');

    if (content !== originalContent) {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log('Modified ' + filePath);
    }
}

function walk(dir) {
  const list = fs.readdirSync(dir);
  for (let file of list) {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      if (!file.includes('node_modules') && !file.includes('.git') && !file.includes('supabase')) {
        walk(file);
      }
    } else {
      if (file.endsWith('.html')) {
        processHtml(file);
      } else if (file.endsWith('.js')) {
          processJs(file);
      }
    }
  }
}

walk('.');
