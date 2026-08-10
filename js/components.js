// js/components.js

class MiDentalSidebar extends HTMLElement {
    connectedCallback() {
        // Obtenemos la ruta actual
        const currentPath = window.location.pathname;
        
        // Función a prueba de mayúsculas/minúsculas
        const isActive = (path) => currentPath.toLowerCase().includes(path.toLowerCase()) ? 'active' : '';

        this.innerHTML = `
            <aside class="sidebar">
                <div class="sidebar-header">
                    <img src="assets/LogoMiDental.png" alt="Logo MiDental" class="logo-img" style="height: 40px; margin-right: 10px;">
                    <h2>MiDental</h2>
                </div>
                <nav class="sidebar-nav">
                    <a href="Dashboard-dentista.html" class="nav-item ${isActive('dashboard-dentista')}"><span class="material-symbols-outlined">grid_view</span> Inicio</a>
                    <a href="agenda-dentista.html" class="nav-item ${isActive('agenda-dentista')}"><span class="material-symbols-outlined">calendar_month</span> Mi Agenda</a>
                    <a href="perfil-dentista.html" class="nav-item ${isActive('perfil-dentista')}"><span class="material-symbols-outlined">manage_accounts</span> Mi Perfil</a>
                    <a href="mis-pacientes.html" class="nav-item ${isActive('mis-pacientes')}"><span class="material-symbols-outlined">folder_shared</span> Mis Pacientes</a>
                    <a href="mis-arriendos.html" class="nav-item ${isActive('mis-arriendos')}"><span class="material-symbols-outlined">real_estate_agent</span> Mis Espacios Coworking</a>
                    <a href="laboratorio-marketing.html" class="nav-item ${isActive('laboratorio-marketing')}"><span class="material-symbols-outlined">science</span> Lab de Marketing</a>
                </nav>
                <hr style="border-top: 1px solid #e2e8f0; margin: 15px 20px;">

                <!-- Módulo de Plan Actualizado -->
                <div class="sidebar-plan-info" style="padding: 0 20px; margin-bottom: 20px;">
                    <p style="font-size: 0.8rem; color: #64748b; margin-bottom: 8px; font-weight: bold;">MODELO ACTUAL</p>
                    <div style="display: flex; align-items: center; justify-content: space-between; background: #f8fafc; padding: 10px; border-radius: 8px; border: 1px solid #e2e8f0;">
                        <span style="font-size: 0.9rem; font-weight: bold; color: var(--blue-elegant);">100% Gratis</span>
                        <span style="font-size: 0.75rem; background: #e2e8f0; padding: 3px 8px; border-radius: 12px; font-weight: bold;">Uso con Tokens</span>
                    </div>
                </div>

                <div class="sidebar-footer">
                    <button class="btn-logout" onclick="window.cerrarSesionLocal()"><span class="material-symbols-outlined">logout</span> Cerrar Sesión</button>
                </div>
            </aside>
        `;
    }
}

class MiDentalTopbar extends HTMLElement {
    connectedCallback() {
        this.innerHTML = `
            <header class="topbar" style="margin-bottom: 25px; display: flex; justify-content: space-between; align-items: center; padding: 15px 25px;">
                <div class="welcome-text" style="flex: 1; padding-right: 20px;">
                    <h1 id="dashGreeting" style="font-size: 1.8rem; margin: 0 0 5px 0; font-weight: 900; color: var(--blue-elegant);">Cargando...</h1>
                    <p id="dashMotivationalQuote" style="color: #64748b; font-size: 0.95rem; margin: 0; font-style: italic; line-height: 1.4;">Cargando resumen motivacional...</p>
                </div>
                
                <div class="topbar-right-area" style="display: flex; align-items: center; gap: 15px;">
                    
                    <div class="status-toggle-container" style="display: flex; align-items: center; gap: 15px;">
                        <div class="status-labels" style="text-align: right;">
                            <span class="status-title" style="display: block; font-size: 0.85rem; font-weight: 900; color: var(--blue-elegant); text-transform: uppercase;">Urgencias</span>
                            <span class="status-desc" id="statusText" style="display: block; font-size: 0.75rem; transition: 0.3s;">Apagado</span>
                        </div>
                        <label class="apple-switch">
                            <input type="checkbox" id="toggleDisponible" onchange="cambiarEstadoUrgenciaDB(this)">
                            <span class="slider round"></span>
                        </label>
                    </div>

                    <div class="topbar-profile" style="display: flex; align-items: center; gap: 10px;">
                        <img src="assets/avatar-default-doctor.png" alt="Perfil" id="topbarAvatar" class="profile-pic" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 2px solid var(--pixar-cyan);">
                    </div>
                </div>
            </header>
        `;
    }
}

// Registramos ambos componentes al final, solo una vez.
customElements.define('midental-sidebar', MiDentalSidebar);
customElements.define('midental-topbar', MiDentalTopbar);