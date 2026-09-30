import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import App from './App.jsx';
import PortalApp from './pages/portal/PortalApp.jsx';
import { AuthProvider } from './lib/auth.jsx';
import { ToastProvider } from './components/ui.jsx';
import DemoStrip from './components/DemoStrip.jsx';
import './styles/app.css';
import './lib/theme.js';

/**
 * Two applications in one bundle.
 *
 * The split is made here rather than inside App so that a client contact never
 * enters the staff AuthProvider at all - the portal has its own session, its
 * own token and its own shell.
 */
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <DemoStrip />
        <Routes>
          <Route path="/portal/*" element={<PortalApp />} />
          <Route
            path="*"
            element={
              <AuthProvider>
                <App />
              </AuthProvider>
            }
          />
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>
);

// Installable to a phone's home screen, with an offline page when the signal
// drops. Production only: in development a service worker would get in the
// way of hot reload.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* the app works the same without it */
    });
  });
}
