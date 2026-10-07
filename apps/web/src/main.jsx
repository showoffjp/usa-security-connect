import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import App from './App.jsx';
import PortalApp from './pages/portal/PortalApp.jsx';
import ApplyPage from './pages/ApplyPage.jsx';
import { AuthProvider } from './lib/auth.jsx';
import { ToastProvider } from './components/ui.jsx';
import DemoStrip from './components/DemoStrip.jsx';
import './styles/app.css';
import './lib/theme.js';

/**
 * The product tour is a static page (public/tour/index.html), also served at
 * /demo/. A link that reaches the app instead - either without the slash, or
 * the dev server's fallback - is sent on to it, signed in or not.
 */
function TourRedirect() {
  window.location.replace('/tour/index.html');
  return null;
}

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
          <Route path="/apply" element={<ApplyPage />} />
          <Route path="/tour/*" element={<TourRedirect />} />
          <Route path="/demo/*" element={<TourRedirect />} />
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
