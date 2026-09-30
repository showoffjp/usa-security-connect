import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { fmtDateShort } from '../lib/format.js';
import { Icon, Modal } from './ui.jsx';
import { ROLE_LABEL } from '@shared/domain.js';

/**
 * Jump anywhere in the console: Ctrl+K (or Cmd+K, or "/") opens it. Screens
 * match as you type; people, sites and incident numbers come from the server
 * once there are two characters to search on. Arrow keys and Enter work as
 * they do in any search box.
 */
export default function QuickSearch({ pages, onClose }) {
  const navigate = useNavigate();
  const input = useRef(null);
  const [q, setQ] = useState('');
  const [found, setFound] = useState(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setFound(null);
      return undefined;
    }
    let alive = true;
    const t = setTimeout(() => {
      api.get(`/admin/search?q=${encodeURIComponent(term)}`).then(
        (d) => alive && setFound(d),
        () => alive && setFound({ employees: [], sites: [], incidents: [] })
      );
    }, 180);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    const screens = pages
      .filter((p) => !term || p.label.toLowerCase().includes(term) || p.group.toLowerCase().includes(term))
      .slice(0, term ? 6 : 30)
      .map((p) => ({ key: `p${p.to}`, icon: p.icon, label: p.label, meta: p.group, to: p.to }));
    const people = (found?.employees || []).map((e) => ({
      key: `e${e.id}`,
      icon: 'user',
      label: e.full_name,
      meta: `${e.employee_code} · ${ROLE_LABEL[e.role] || e.role}${e.status !== 'active' ? ` · ${e.status.replace('_', ' ')}` : ''}`,
      to: `/admin/employees/${e.id}`,
    }));
    const sites = (found?.sites || []).map((s) => ({
      key: `s${s.id}`,
      icon: 'building',
      label: s.name,
      meta: [s.city, s.client_name].filter(Boolean).join(' · '),
      to: '/admin/sites',
    }));
    const incidents = (found?.incidents || []).map((i) => ({
      key: `i${i.id}`,
      icon: 'alert',
      label: i.ref_number,
      meta: `${i.category} · ${i.site_name || ''} · ${fmtDateShort(i.occurred_at)}`,
      to: '/admin/incidents',
    }));
    return [...people, ...screens, ...sites, ...incidents];
  }, [q, found, pages]);

  useEffect(() => setActive(0), [results.length, q]);

  const go = (r) => {
    if (!r) return;
    onClose();
    navigate(r.to);
  };

  const onKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(results[active]);
    }
  };

  useEffect(() => {
    document.getElementById(`qs-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const searching = q.trim().length >= 2 && !found;

  return (
    <Modal title="Quick search" onClose={onClose}>
      <div className="quick-search">
        <div className="qs-input">
          <Icon name="search" size={18} />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="People, codes, sites, incident numbers, screens"
            role="combobox"
            aria-label="Search the console"
            aria-expanded={results.length > 0}
            aria-controls="qs-results"
            aria-activedescendant={results.length ? `qs-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <ul className="qs-results" id="qs-results" role="listbox" aria-label="Results">
          {results.map((r, i) => (
            <li
              key={r.key}
              id={`qs-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(r)}
            >
              <Icon name={r.icon} size={16} />
              <span className="grow">
                <span className="strong small">{r.label}</span>
                {r.meta && <span className="tiny muted"> · {r.meta}</span>}
              </span>
              {i === active && <Icon name="chevron" size={14} />}
            </li>
          ))}
        </ul>
        <div className="tiny muted" aria-live="polite" style={{ marginTop: 8 }}>
          {searching ? 'Searching...' : results.length === 0 ? 'Nothing matches that.' : 'Up and down to move, Enter to open, Esc to close. Press ? on any screen for every shortcut.'}
        </div>
      </div>
    </Modal>
  );
}
