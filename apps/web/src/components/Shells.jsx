import { useEffect, useState } from 'react';
import { NavLink, Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import QuickSearch from './QuickSearch.jsx';
import AlertsBell from './AlertsBell.jsx';
import ThemeChoice from './ThemeChoice.jsx';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Icon, Shield, Modal } from './ui.jsx';
import { ROLE_LABEL } from '@shared/domain.js';

/* ------------------------------------------------------------- top bar -- */

function AccountMenu({ open, onClose }) {
  const { user, signOut, isSupervisor } = useAuth();
  if (!open) return null;

  return (
    <Modal title="Account" onClose={onClose}>
      <div className="stack">
        <div className="row">
          <div
            style={{
              width: 46, height: 46, borderRadius: 12, background: 'var(--navy-100)',
              color: 'var(--navy-700)', display: 'grid', placeItems: 'center', fontWeight: 700,
            }}
          >
            {user.first_name[0]}
            {user.last_name[0]}
          </div>
          <div>
            <div className="strong">{user.full_name}</div>
            <div className="small muted">
              {ROLE_LABEL[user.role]} &middot; Code {user.employee_code}
            </div>
          </div>
        </div>

        <ThemeChoice />

        <div className="stack-sm">
          <Link className="btn btn-ghost btn-block" to="/profile" onClick={onClose}>
            <Icon name="user" size={16} /> My profile &amp; hours
          </Link>
          <Link className="btn btn-ghost btn-block" to="/change-pin" onClick={onClose}>
            <Icon name="shield" size={16} /> Change PIN
          </Link>
          {isSupervisor && (
            <Link className="btn btn-navy btn-block" to="/admin" onClick={onClose}>
              <Icon name="chart" size={16} /> Open admin console
            </Link>
          )}
          <button className="btn btn-danger btn-block" onClick={signOut}>
            <Icon name="logout" size={16} /> Sign out
          </button>
        </div>
      </div>
    </Modal>
  );
}

function TopBar({ onMenu, dutyState, onSearch, alerts = false }) {
  const [menu, setMenu] = useState(false);
  const { user } = useAuth();

  return (
    <header className="topbar">
      {onMenu && (
        <button className="icon-btn hide-desktop" onClick={onMenu} aria-label="Open navigation">
          <Icon name="menu" size={18} />
        </button>
      )}
      <Link className="brand" to="/">
        <Shield size={34} />
        <span className="hide-mobile">
          <span className="name">USA Security Connect</span>
          <br />
          <span className="sub">Protection Group</span>
        </span>
      </Link>
      <span className="spacer" />
      {dutyState && (
        <span className={`duty ${dutyState.onDuty ? 'on' : 'off'}`}>
          <span className={`dot ${dutyState.onDuty ? 'dot-pulse' : ''}`} />
          {dutyState.onDuty ? 'On post' : 'Off duty'}
        </span>
      )}
      {onSearch && (
        <button className="icon-btn qs-trigger" onClick={onSearch} aria-label="Search (Ctrl+K)" title="Search (Ctrl+K)">
          <Icon name="search" size={18} />
          <span className="hide-mobile qs-hint" aria-hidden="true">
            Search <kbd>Ctrl K</kbd>
          </span>
        </button>
      )}
      {alerts && <AlertsBell />}
      <button className="icon-btn" onClick={() => setMenu(true)} aria-label="Account menu" title={user.full_name}>
        <Icon name="user" size={18} />
      </button>
      <AccountMenu open={menu} onClose={() => setMenu(false)} />
    </header>
  );
}

/* ---------------------------------------------------- keyboard shortcuts -- */

/** "g" then a letter jumps to a screen, the way mail and issue trackers do it. */
const GO_TO = [
  ['d', '/admin', 'Dashboard'],
  ['l', '/admin/live', 'Live tracking'],
  ['f', '/admin/flags', 'Flags'],
  ['i', '/admin/incidents', 'Incidents'],
  ['p', '/admin/post-logs', 'Post logs'],
  ['s', '/admin/schedule', 'Schedule'],
  ['e', '/admin/employees', 'Employees'],
  ['t', '/admin/timesheets', 'Timesheets & pay'],
  ['r', '/admin/reports', 'Reports'],
  ['h', '/admin/site-health', 'Site health'],
  ['v', '/admin/visits', 'Field visits'],
  ['k', '/admin/dispatch', 'Dispatch'],
  ['c', '/admin/clients', 'Client portal'],
];

function ShortcutsHelp({ onClose }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <div className="stack">
        <table className="shortcuts">
          <tbody>
            <tr>
              <td><kbd>Ctrl</kbd> <kbd>K</kbd> or <kbd>/</kbd></td>
              <td>Search officers, sites, incidents and screens</td>
            </tr>
            <tr>
              <td><kbd>?</kbd></td>
              <td>This list</td>
            </tr>
            {GO_TO.map(([key, , label]) => (
              <tr key={key}>
                <td>
                  <kbd>g</kbd> then <kbd>{key}</kbd>
                </td>
                <td>{label}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="tiny muted">Shortcuts are off while you are typing in a field.</div>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------- officer shell -- */

export function OfficerShell() {
  const [status, setStatus] = useState(null);
  const location = useLocation();

  // Duty state drives the header pill and the tab badges; refresh it on
  // navigation and on a slow timer so it does not drift while the app is open.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const s = await api.get('/timeclock/status');
        if (alive) setStatus(s);
      } catch {
        /* the page itself will surface the error */
      }
    };
    load();
    const t = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [location.pathname]);

  const alerts = (status?.unreadBroadcasts || 0) + (status?.trainingDue || 0);

  const tabs = [
    { to: '/', icon: 'home', label: 'Home', end: true },
    { to: '/tours', icon: 'route', label: 'Tours' },
    { to: '/incidents', icon: 'alert', label: 'Report' },
    { to: '/schedule', icon: 'calendar', label: 'Schedule' },
    { to: '/messages', icon: 'megaphone', label: 'Updates', badge: alerts },
  ];

  return (
    <div className="app">
      {/* First thing in the tab order, so a keyboard user can jump the nav. */}
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <TopBar dutyState={status} />
      <main className="main" id="main" tabIndex={-1}>
        <Outlet context={{ status }} />
      </main>
      <nav className="tabbar" aria-label="Main">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            <Icon name={t.icon} size={21} />
            {t.label}
            {t.badge > 0 && (
              <>
                <span className="badge" aria-hidden="true">
                  {t.badge > 9 ? '9+' : t.badge}
                </span>
                {/* A bare "3" beside a label tells a screen reader nothing. */}
                <span className="sr-only">
                  {t.badge} needing attention
                </span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/* ---------------------------------------------------------- admin shell -- */

export function AdminShell() {
  const { isAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState({});
  const [searching, setSearching] = useState(false);
  const [help, setHelp] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => setOpen(false), [location.pathname]);

  // Ctrl+K / Cmd+K anywhere, or "/" when not already typing in a field;
  // "?" for the list of shortcuts, and "g" then a letter to jump to a screen.
  useEffect(() => {
    let goPending = 0;
    const onKey = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable;
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      const inDialog = Boolean(document.querySelector('[role="dialog"]'));
      if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setSearching(true);
        return;
      }
      if (typing || !plain || inDialog) return;
      if (e.key === '/') {
        e.preventDefault();
        setSearching(true);
      } else if (e.key === '?') {
        e.preventDefault();
        setHelp(true);
      } else if (e.key === 'g') {
        goPending = Date.now();
      } else if (goPending && Date.now() - goPending < 1500) {
        goPending = 0;
        const target = GO_TO.find(([key]) => key === e.key.toLowerCase());
        if (target) {
          e.preventDefault();
          navigate(target[1]);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const d = await api.get('/admin/dashboard');
        if (alive) setCounts(d.counts);
      } catch {
        /* dashboard page reports the failure */
      }
    };
    load();
    const t = setInterval(load, 60000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [location.pathname]);

  const groups = [
    {
      title: 'Operations',
      items: [
        { to: '/admin', icon: 'chart', label: 'Dashboard', end: true },
        { to: '/admin/live', icon: 'gps', label: 'Live tracking', count: counts.lateOrOff, urgent: true },
        { to: '/admin/safety', icon: 'shield', label: 'Safety & map', count: counts.activeAlerts, urgent: true },
        { to: '/admin/dispatch', icon: 'phone', label: 'Dispatch', count: counts.activeCalls, urgent: counts.waitingCalls > 0 },
        { to: '/admin/flags', icon: 'flag', label: 'Flags', count: counts.openFlags },
        { to: '/admin/incidents', icon: 'alert', label: 'Incidents', count: counts.openIncidents },
        { to: '/admin/tours', icon: 'route', label: 'Tours' },
        { to: '/admin/visits', icon: 'pin', label: 'Field visits', count: counts.visitsDue },
        { to: '/admin/equipment', icon: 'clipboard', label: 'Keys & equipment', count: counts.equipmentOut },
        { to: '/admin/fleet', icon: 'car', label: 'Fleet', count: counts.fleetAttention, urgent: counts.fleetAttention > 0 },
        { to: '/admin/post-logs', icon: 'users', label: 'Post logs', count: counts.visitorsOnSite },
      ],
    },
    {
      title: 'Workforce',
      items: [
        { to: '/admin/employees', icon: 'users', label: 'Employees' },
        { to: '/admin/hiring', icon: 'user', label: 'Hiring', count: counts.newApplicants },
        { to: '/admin/schedule', icon: 'calendar', label: 'Schedule', count: counts.unfilledShifts },
        { to: '/admin/shift-requests', icon: 'route', label: 'Shift requests', count: counts.openShiftRequests },
        { to: '/admin/coverage-requests', icon: 'plus', label: 'Client requests', count: counts.coverageRequests, urgent: true },
        { to: '/admin/punches', icon: 'list', label: 'Punch log' },
        { to: '/admin/timesheets', icon: 'clock', label: 'Timesheets & pay', count: counts.pendingCorrections },
        { to: '/admin/payroll', icon: 'dollar', label: 'Payroll', count: counts.payrollDue, urgent: true },
        { to: '/admin/expenses', icon: 'dollar', label: 'Expenses', count: counts.pendingExpenses },
        { to: '/admin/pay-rates', icon: 'dollar', label: 'Pay rates' },
        { to: '/admin/time-off', icon: 'calendar', label: 'Time off', count: counts.pendingTimeOff },
        { to: '/admin/compliance', icon: 'shield', label: 'Licensing', count: counts.expiringCredentials },
      ],
    },
    {
      title: 'Billing',
      items: [
        { to: '/admin/invoices', icon: 'chart', label: 'Invoices', count: counts.overdueInvoices, urgent: true },
        { to: '/admin/agreements', icon: 'clipboard', label: 'Service agreements', count: (counts.agreementsShort || 0) + (counts.agreementRenewals || 0) },
        { to: '/admin/clients', icon: 'users', label: 'Client portal' },
        { to: '/admin/feedback', icon: 'message', label: 'Client feedback', count: counts.unhappyClients, urgent: true },
        { to: '/admin/emails', icon: 'megaphone', label: 'Outbox' },
      ],
    },
    {
      title: 'Reporting',
      items: [
        { to: '/admin/reports', icon: 'chart', label: 'Reports' },
        { to: '/admin/scorecards', icon: 'users', label: 'Scorecards' },
        { to: '/admin/site-health', icon: 'building', label: 'Site health' },
        { to: '/admin/dar', icon: 'clipboard', label: 'Daily report' },
        { to: '/admin/broadcasts', icon: 'megaphone', label: 'Broadcasts' },
        { to: '/admin/training', icon: 'book', label: 'Training' },
      ],
    },
    {
      title: 'Configuration',
      items: [
        { to: '/admin/sites', icon: 'building', label: 'Sites & posts' },
        // The audit endpoint is administrators only, so a supervisor would
        // only find an error page behind this link.
        ...(isAdmin ? [{ to: '/admin/audit', icon: 'clipboard', label: 'Audit log' }] : []),
      ],
    },
  ];

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <TopBar onMenu={() => setOpen((v) => !v)} onSearch={() => setSearching(true)} alerts />
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}
      {searching && (
        <QuickSearch
          pages={groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.title })))}
          onClose={() => setSearching(false)}
        />
      )}
      <div className="admin-layout">
        {open && <div className="scrim" onClick={() => setOpen(false)} />}
        <nav className={`sidebar${open ? ' open' : ''}`} aria-label="Admin sections">
          {groups.map((g) => (
            <div key={g.title}>
              <div className="group">{g.title}</div>
              {g.items.map((i) => (
                <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive }) => (isActive ? 'active' : '')}>
                  <Icon name={i.icon} size={17} />
                  {i.label}
                  {i.count > 0 && (
                    <>
                      <span className="count" aria-hidden="true">
                        {i.count}
                      </span>
                      <span className="sr-only">
                        {i.count} {i.urgent ? 'needing attention now' : 'outstanding'}
                      </span>
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
          <div style={{ marginTop: 'auto', paddingTop: 16 }}>
            <NavLink to="/" end>
              <Icon name="back" size={17} />
              Officer view
            </NavLink>
          </div>
        </nav>
        <main className="admin-main" id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
