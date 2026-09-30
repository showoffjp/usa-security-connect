/**
 * The client portal, mounted at /portal.
 *
 * A separate identity, a separate token and a separate shell from the staff
 * app. Nothing here imports the staff AuthProvider, so there is no path by
 * which a contact's session can pick up staff state.
 */

import { useState } from 'react';
import { NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ClientAuthProvider, useClientAuth } from '../../lib/clientAuth.jsx';
import { Banner, Empty, Icon, LoadingPage, Modal, Field, Shield } from '../../components/ui.jsx';
import PortalLogin from './PortalLogin.jsx';
import SetPassword from './SetPassword.jsx';
import PortalRequests from './PortalRequests.jsx';
import PortalOrders from './PortalOrders.jsx';
import PortalMonthly from './PortalMonthly.jsx';
import ThemeChoice from '../../components/ThemeChoice.jsx';
import { useDemo } from '../../lib/demo.js';
import {
  PortalOverview, PortalCoverage, PortalPatrols, PortalIncidents, PortalReport, PortalInvoices,
} from './PortalPages.jsx';

/* ------------------------------------------------------- account menu -- */

function PasswordDialog({ onClose }) {
  const { changePassword } = useClientAuth();
  const demo = useDemo();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError('');
    setFieldErrors({});
    try {
      await changePassword(current, next, confirm);
      setDone(true);
    } catch (err) {
      setError(err.message);
      setFieldErrors(err.fieldErrors || {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Change your password"
      onClose={onClose}
      footer={
        done ? (
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={save}
              disabled={demo || busy || !current || next.length < 12 || !confirm}
            >
              Change password
            </button>
          </>
        )
      }
    >
      {done ? (
        <Banner kind="ok" title="Password changed">
          Any other device signed in to this account has been signed out.
        </Banner>
      ) : (
        <div className="stack">
          {demo && (
            <Banner kind="info" title="Not on the demo site">
              Everyone shares these demo logins, so passwords stay as published. Your real portal lets you change yours here.
            </Banner>
          )}
          {error && <Banner kind="danger">{error}</Banner>}
          <Field label="Current password" required>
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field
            label="New password"
            required
            hint="At least 12 characters. A short phrase you will remember works well."
            error={fieldErrors.newPassword}
          >
            <input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Field label="Confirm new password" required error={fieldErrors.confirmPassword}>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}

function AccountMenu({ onClose }) {
  const { client, sites, signOut } = useClientAuth();
  const [password, setPassword] = useState(false);

  if (password) return <PasswordDialog onClose={() => setPassword(false)} />;

  return (
    <Modal title="Account" onClose={onClose}>
      <div className="stack">
        <div>
          <div className="strong">{client.name}</div>
          <div className="small muted">
            {client.company || 'Client contact'}
            {client.email ? ` · ${client.email}` : ''}
          </div>
        </div>

        <div>
          <div className="small strong">Your properties</div>
          <ul className="list">
            {sites.map((s) => (
              <li key={s.id} className="list-item">
                <div className="grow">
                  <div className="small strong">{s.name}</div>
                  <div className="tiny muted">
                    {[s.address, s.city, s.state].filter(Boolean).join(', ')}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <ThemeChoice />

        <div className="stack-sm">
          <button className="btn btn-ghost btn-block" onClick={() => setPassword(true)}>
            <Icon name="shield" size={16} /> Change password
          </button>
          <button className="btn btn-danger btn-block" onClick={signOut}>
            <Icon name="logout" size={16} /> Sign out
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------- shell -- */

function PortalShell() {
  const { client, sites } = useClientAuth();
  const [menu, setMenu] = useState(false);

  const tabs = [
    { to: '/portal', icon: 'chart', label: 'Overview', end: true },
    { to: '/portal/coverage', icon: 'clock', label: 'Coverage' },
    { to: '/portal/patrols', icon: 'route', label: 'Patrols' },
    { to: '/portal/incidents', icon: 'alert', label: 'Incidents' },
    { to: '/portal/report', icon: 'clipboard', label: 'Report' },
    { to: '/portal/invoices', icon: 'chart', label: 'Invoices' },
    { to: '/portal/orders', icon: 'clipboard', label: 'Orders' },
    { to: '/portal/requests', icon: 'plus', label: 'Requests' },
  ];

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <span className="brand">
          <Shield size={30} />
          <span className="hide-mobile">
            <span className="name">Client Portal</span>
            <br />
            <span className="sub">USA Security &amp; Protection Group</span>
          </span>
        </span>
        <span className="spacer" />
        <span className="small muted hide-mobile" style={{ marginRight: 10 }}>
          {client.company || client.name}
          {sites.length > 1 ? ` · ${sites.length} properties` : ''}
        </span>
        <button className="icon-btn" onClick={() => setMenu(true)} aria-label="Account menu">
          <Icon name="user" size={18} />
        </button>
      </header>

      <main className="main" id="main" tabIndex={-1}>
        <Outlet />
      </main>

      <nav className="tabbar tabbar-dense" aria-label="Main">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            <Icon name={t.icon} size={21} />
            {t.label}
          </NavLink>
        ))}
      </nav>

      {menu && <AccountMenu onClose={() => setMenu(false)} />}
    </div>
  );
}

/* ------------------------------------------------------------ routing -- */

function PortalRoutes() {
  const { client, sites, notice, loading, signOut, refresh } = useClientAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // Reachable without a session: it is how a contact gets one in the first
  // place, so it has to come before the sign-in gate.
  if (location.pathname.endsWith('/set-password')) {
    return (
      <SetPassword
        onDone={async () => {
          await refresh();
          navigate('/portal', { replace: true });
        }}
      />
    );
  }

  if (loading) return <LoadingPage label="Opening your portal" />;
  if (!client) return <PortalLogin />;

  // The account is real but no property has been linked to it yet.
  if (notice || sites.length === 0) {
    return (
      <div className="page page-narrow" style={{ paddingTop: 60 }}>
        <Empty
          icon="building"
          title="No properties linked yet"
          action={
            <button className="btn btn-ghost" onClick={signOut}>
              Sign out
            </button>
          }
        >
          {notice || 'Your account manager needs to link your property to this login.'}
        </Empty>
      </div>
    );
  }

  // Paths are relative: this tree is mounted under /portal/* by main.jsx.
  return (
    <Routes>
      <Route element={<PortalShell />}>
        <Route index element={<PortalOverview sites={sites} />} />
        <Route path="coverage" element={<PortalCoverage sites={sites} />} />
        <Route path="patrols" element={<PortalPatrols sites={sites} />} />
        <Route path="incidents" element={<PortalIncidents sites={sites} />} />
        <Route path="report" element={<PortalReport sites={sites} />} />
        <Route path="invoices" element={<PortalInvoices />} />
        <Route path="requests" element={<PortalRequests sites={sites} />} />
        <Route path="orders" element={<PortalOrders />} />
        <Route path="monthly" element={<PortalMonthly sites={sites} />} />
      </Route>
      <Route path="*" element={<Navigate to="/portal" replace />} />
    </Routes>
  );
}

export default function PortalApp() {
  return (
    <ClientAuthProvider>
      <PortalRoutes />
    </ClientAuthProvider>
  );
}
