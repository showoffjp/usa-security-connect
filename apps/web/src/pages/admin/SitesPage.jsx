import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { LoadingPage, Empty, Icon, Chip, Modal, Field, useToast } from '../../components/ui.jsx';
import { LocationPicker } from '../../components/Map.jsx';
import { RULES, LOCATION_RULES, CHECK_IN_CHOICES, checkInLabel } from '@shared/domain.js';

/** Metres, with feet beside them: officers and clients here think in feet. */
export const fmtDist = (m) =>
  m == null ? '--' : m < 1000 ? `${Math.round(m)} m (${Math.round(m * 3.281).toLocaleString()} ft)` : `${(m / 1000).toFixed(1)} km (${(m / 1609.34).toFixed(1)} mi)`;

const STATE_KIND = { surveyed: 'ok', ok: 'ok', check: 'warn', wrong: 'danger', no_pin: 'danger', no_match: 'warn', unchecked: '' };
const PIN_FROM = { address: 'placed on the street address', map: 'placed on the map', survey: 'set at the post' };

/** What the location check says about one pin, in a sentence. */
export function verdictText(v) {
  const from = v.from === 'site' ? 'the site pin' : v.match?.label ? `the address (${v.match.precision === 'building' ? 'the building' : 'along the street'})` : 'the address';
  if (v.state === 'surveyed') return `Set at the post with a fix good to ${v.accuracy_m} m${v.distance_m != null ? `; ${fmtDist(v.distance_m)} from ${from}` : ''}.`;
  if (v.state === 'ok') return `Within ${fmtDist(v.distance_m)} of ${from}.`;
  if (v.state === 'check') return `${fmtDist(v.distance_m)} from ${from}: more than the ${fmtDist(v.tolerance_m)} expected. Check the pin.`;
  if (v.state === 'wrong') return `${fmtDist(v.distance_m)} from ${from}. The pin is in the wrong place, so the geofence is too.`;
  if (v.state === 'no_pin') return 'No pin, so nobody can be checked against this place.';
  if (v.state === 'no_match') return 'The address could not be found precisely. Set the pin from the post itself.';
  return 'Not checked yet.';
}

/**
 * Every site and post pin against its street address, worst first: a pin in
 * the wrong place moves the geofence with it, and the check that officers
 * are where they say they are is only as good as the pin.
 */
function LocationCheck({ isAdmin, onEdit, onChanged, refreshKey }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (refresh = false) => {
    try {
      setData(await api.get(`/admin/locations${refresh ? '?refresh=1' : ''}`));
    } catch (err) {
      toast.error(err.message);
    }
  }, [toast]);
  useEffect(() => {
    load();
  }, [load, refreshKey]);
  if (!data) return null;
  const useAddress = async (kind, x) => {
    setBusy(true);
    try {
      const r = await api.post(`/admin/locations/${kind}/${x.id}/use-address`, {});
      toast.success(`${x.name}: ${verdictText(r.location)}`);
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  const again = async () => {
    setBusy(true);
    await load(true);
    setBusy(false);
  };
  const rows = data.sites.flatMap((site) => [{ kind: 'site', x: site, site }, ...site.posts.map((p) => ({ kind: 'post', x: p, site }))]);
  const shown = all ? rows : rows.filter((r) => ['wrong', 'no_pin', 'check', 'no_match', 'unchecked'].includes(r.x.state));
  const c = data.counts;
  return (
    <div className="card" id="location-check">
      <div className="card-head wrap" style={{ gap: 8 }}>
        <div>
          <h3>Location check</h3>
          <div className="tiny muted">
            Each pin against its street address: within {fmtDist(LOCATION_RULES.pinToleranceM)} of the building, or set at the post with a fix good to{' '}
            {LOCATION_RULES.surveyAccuracyM} m. Officers are judged against these pins.
          </div>
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          {c.surveyed > 0 && <Chip kind="ok">{c.surveyed} set at the post</Chip>}
          {c.ok > 0 && <Chip kind="ok">{c.ok} match the address</Chip>}
          {data.needsAttention > 0 ? <Chip kind="danger">{data.needsAttention} to fix</Chip> : <Chip kind="ok">All accurate</Chip>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAll((v) => !v)}>{all ? 'Only problems' : 'Show all'}</button>
          {data.geocoder !== 'off' && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={again} disabled={busy}>Look up again</button>
          )}
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="card-pad small muted" style={{ paddingTop: 0 }}>
          Every site and post pin is where its address says it is, or was set by someone standing there.
        </div>
      ) : (
        <div className="list">
          {shown.map(({ kind, x, site }) => (
            <div key={`${kind}-${x.id}`} className="list-item" style={{ cursor: 'default' }}>
              <div className="grow">
                <div className="small strong">
                  {kind === 'site' ? x.name : `${x.name}`}
                  {kind === 'post' && <span className="tiny muted"> · {site.name}</span>}
                </div>
                <div className="tiny muted">{verdictText(x)}</div>
                {x.location_source && (
                  <div className="tiny muted">
                    Pin {PIN_FROM[x.location_source] || x.location_source}
                    {x.location_set_at ? ` ${new Date(x.location_set_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}.
                  </div>
                )}
              </div>
              <div className="row wrap" style={{ gap: 6, justifyContent: 'flex-end' }}>
                <Chip kind={STATE_KIND[x.state]}>{x.state_label}</Chip>
                {isAdmin && ['check', 'wrong', 'no_pin'].includes(x.state) && x.match?.precision !== 'area' && (kind === 'site' || x.address_line) && (
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => useAddress(kind, x)} aria-label={`Move the pin for ${x.name} to its address`}>
                    Use the address
                  </button>
                )}
                {isAdmin && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onEdit(kind, x)} aria-label={`Edit ${x.name}`}>
                    Edit
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * How often officers check in, company-wide. A post can set its own; any that
 * does not follows this. The first is due this long after clocking in.
 */
function CheckInSettings({ isAdmin, onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [value, setValue] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get('/admin/settings/check-ins').then((d) => {
      setData(d);
      setValue(d.everyMin);
    }, () => setData(null));
  }, []);
  if (!data) return null;
  const save = async () => {
    setBusy(true);
    try {
      const d = await api.put('/admin/settings/check-ins', { everyMin: Number(value) });
      setData(d);
      toast.success(`Check-ins: ${d.label.toLowerCase()} at posts that follow the company setting.`);
      onChanged?.();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card card-pad" id="check-in-settings">
      <div className="row-between wrap" style={{ gap: 10 }}>
        <div className="grow" style={{ minWidth: 220 }}>
          <h3 style={{ margin: 0 }}>Status check-ins</h3>
          <div className="tiny muted">
            After clocking in, officers get a Check in button at each interval until they clock out, and have {RULES.checkInWindowMinutes} minutes to
            answer. Where they were is checked against the post. {data.postsFollowing} post{data.postsFollowing === 1 ? '' : 's'} follow this;{' '}
            {data.postsOwn} set their own.
          </div>
        </div>
        {isAdmin ? (
          <div className="row" style={{ gap: 8 }}>
            <label className="sr-only" htmlFor="check-in-every">Company check-in interval</label>
            <select id="check-in-every" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 'auto' }}>
              {data.choices.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
            <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy || Number(value) === data.everyMin}>Save</button>
          </div>
        ) : (
          <Chip kind="info">{data.label}</Chip>
        )}
      </div>
    </div>
  );
}

/** The pin's origin as the dialogs send it. */
const pinFields = (form) => ({
  latitude: form.latitude === '' ? null : Number(form.latitude),
  longitude: form.longitude === '' ? null : Number(form.longitude),
  ...(form.locationSource ? { locationSource: form.locationSource, locationAccuracyM: form.locationAccuracyM ?? null } : {}),
});

function SiteDialog({ site = null, onClose, onSaved }) {
  const toast = useToast();
  const editing = Boolean(site);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: site?.name || '', clientName: site?.client_name || '', address: site?.address || '', city: site?.city || '',
    state: site?.state || 'FL', postalCode: site?.postal_code || '',
    latitude: site?.latitude ?? '', longitude: site?.longitude ?? '', contactName: site?.contact_name || '', contactPhone: site?.contact_phone || '',
    locationSource: null, locationAccuracyM: null,
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const { latitude, longitude, locationSource, locationAccuracyM, ...fields } = form;

  const save = async () => {
    setBusy(true);
    try {
      const body = { ...fields, ...pinFields(form) };
      const r = editing ? await api.patch(`/admin/sites/${site.id}`, body) : await api.post('/admin/sites', { ...body, active: true });
      const v = r.location;
      if (v && ['check', 'wrong', 'no_pin', 'no_match'].includes(v.state)) toast.error(`Saved, but: ${verdictText(v)}`);
      else toast.success(`${editing ? 'Site updated' : 'Site added'}.${v ? ` ${verdictText(v)}` : ''}`);
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? `Edit ${site.name}` : 'Add site'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || form.name.trim().length < 2}>Save site</button>
        </>
      }
    >
      <div className="stack">
        <div className="grid grid-2">
          <Field label="Site name" required>
            <input value={form.name} onChange={set('name')} placeholder="Riverfront Commerce Center" />
          </Field>
          <Field label="Client">
            <input value={form.clientName} onChange={set('clientName')} />
          </Field>
        </div>
        <Field label="Address">
          <input value={form.address} onChange={set('address')} />
        </Field>
        <div className="grid grid-3">
          <Field label="City">
            <input value={form.city} onChange={set('city')} />
          </Field>
          <Field label="State">
            <input value={form.state} onChange={set('state')} maxLength={2} />
          </Field>
          <Field label="ZIP">
            <input value={form.postalCode} onChange={set('postalCode')} />
          </Field>
        </div>
        <fieldset>
          <legend>Where it is</legend>
          <LocationPicker
            latitude={form.latitude === '' ? null : Number(form.latitude)}
            longitude={form.longitude === '' ? null : Number(form.longitude)}
            radius={RULES.defaultGeofenceRadiusM}
            onChange={({ latitude: la, longitude: lo, source, accuracy }) =>
              setForm((f) => ({ ...f, latitude: la ?? '', longitude: lo ?? '', locationSource: source || 'map', locationAccuracyM: accuracy ?? null }))
            }
          />
          <div className="tiny muted" style={{ marginTop: 6 }}>
            Search the street address above to place the pin on the building, then check it on the map. Saving compares the pin with the address.
          </div>
        </fieldset>
        <div className="grid grid-2">
          <Field label="Client contact">
            <input value={form.contactName} onChange={set('contactName')} />
          </Field>
          <Field label="Contact phone">
            <input type="tel" value={form.contactPhone} onChange={set('contactPhone')} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function PostDialog({ post, sites, onClose, onSaved }) {
  const toast = useToast();
  const editing = Boolean(post);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    siteId: String(post?.site_id || sites[0]?.id || ''),
    name: post?.name || '',
    postCode: post?.post_code || '',
    instructions: post?.instructions || '',
    address: post?.address || '',
    latitude: post?.latitude ?? '',
    longitude: post?.longitude ?? '',
    locationSource: null,
    locationAccuracyM: null,
    geofenceRadiusM: post?.geofence_radius_m ?? RULES.defaultGeofenceRadiusM,
    // '' follows the company setting.
    checkInIntervalMin: post?.check_in_interval_min == null ? '' : String(post.check_in_interval_min),
    requiresGps: post ? Boolean(post.requires_gps) : true,
    armed: post ? Boolean(post.armed) : false,
    trainingRequired: post ? Boolean(post.training_required) : false,
    active: post ? Boolean(post.active) : true,
  });

  const set = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const save = async () => {
    setBusy(true);
    try {
      const payload = {
        siteId: Number(form.siteId),
        name: form.name,
        postCode: form.postCode || undefined,
        instructions: form.instructions || undefined,
        address: form.address || undefined,
        ...pinFields(form),
        geofenceRadiusM: Number(form.geofenceRadiusM),
        checkInIntervalMin: form.checkInIntervalMin === '' ? null : Number(form.checkInIntervalMin),
        requiresGps: form.requiresGps,
        armed: form.armed,
        trainingRequired: form.trainingRequired,
        active: form.active,
      };
      const r = editing ? await api.patch(`/admin/posts/${post.id}`, payload) : await api.post('/admin/posts', payload);
      const v = r.location;
      if (v && ['check', 'wrong', 'no_pin', 'no_match'].includes(v.state)) toast.error(`Saved, but: ${verdictText(v)}`);
      else toast.success(`${editing ? 'Post updated' : 'Post added'}.${v ? ` ${verdictText(v)}` : ''}`);
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={editing ? `Edit ${post.name}` : 'Add post'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || form.name.trim().length < 2}>Save post</button>
        </>
      }
    >
      <div className="stack">
        <div className="grid grid-3">
          <Field label="Site" required>
            <select value={form.siteId} onChange={set('siteId')}>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Post name" required>
            <input value={form.name} onChange={set('name')} placeholder="Main Lobby Console" />
          </Field>
          <Field label="Post code">
            <input value={form.postCode} onChange={set('postCode')} placeholder="RF-01" />
          </Field>
        </div>

        <Field label="Officer instructions" hint="Shown on the officer's home screen while they are on post. Saving a change issues a new version of the post orders, which officers acknowledge.">
          <textarea value={form.instructions} onChange={set('instructions')} rows={5} />
        </Field>

        <fieldset>
          <legend>Location &amp; geofence</legend>
          <div className="stack">
            <Field label="Geofence radius (metres)" hint="How far from the post a clock-in is accepted.">
              <input
                type="number"
                min="25"
                max="5000"
                value={form.geofenceRadiusM}
                onChange={set('geofenceRadiusM')}
              />
            </Field>

            <LocationPicker
              latitude={form.latitude === '' ? null : Number(form.latitude)}
              longitude={form.longitude === '' ? null : Number(form.longitude)}
              radius={Number(form.geofenceRadiusM) || 150}
              onChange={({ latitude, longitude, label, source, accuracy }) =>
                setForm((f) => ({
                  ...f,
                  latitude: latitude ?? '',
                  longitude: longitude ?? '',
                  locationSource: source || 'map',
                  locationAccuracyM: accuracy ?? null,
                  // A geocoded result fills the address in as well.
                  address: label || f.address,
                }))
              }
            />

            <Field label="Street address" hint="Shown to the officer, and used for directions.">
              <input value={form.address} onChange={set('address')} />
            </Field>

            <label className="check">
              <input type="checkbox" checked={form.requiresGps} onChange={set('requiresGps')} />
              <span>
                Require GPS to clock in
                <div className="tiny muted">
                  Officers outside the radius must give a reason, which raises a flag.
                </div>
              </span>
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Check-ins &amp; status</legend>
          <div className="stack">
            <Field
              label="Status check-ins"
              hint={`From clock-in to clock-out the officer gets a Check in button at this interval, and has ${RULES.checkInWindowMinutes} minutes to answer. Where they were is checked against this post.`}
            >
              <select value={form.checkInIntervalMin} onChange={set('checkInIntervalMin')}>
                <option value="">Company setting</option>
                {CHECK_IN_CHOICES.map((m) => (
                  <option key={m} value={String(m)}>{checkInLabel(m)}</option>
                ))}
              </select>
            </Field>
            <label className="check">
              <input type="checkbox" checked={form.armed} onChange={set('armed')} />
              <span>Armed post (Class G licence required)</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={form.trainingRequired} onChange={set('trainingRequired')} />
              <span>
                Needs site training
                <div className="tiny muted">
                  Only officers a supervisor has signed off here can claim or swap into its shifts. Manage it under Site training.
                </div>
              </span>
            </label>
            <label className="check">
              <input type="checkbox" checked={form.active} onChange={set('active')} />
              <span>Active</span>
            </label>
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}

export default function SitesPage() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [siteDialog, setSiteDialog] = useState(null);
  const [postDialog, setPostDialog] = useState(null);
  // Bumped after a save, so the location check looks again.
  const [saved, setSaved] = useState(0);

  const load = async () => {
    try {
      setData(await api.get('/admin/sites'));
    } catch (err) {
      toast.error(err.message);
      setData({ sites: [], posts: [] });
    }
  };
  useEffect(() => {
    load();
  }, []);

  if (!data) return <LoadingPage label="Loading sites" />;

  return (
    <div className="page stack">
      <div className="row-between wrap">
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div className="eyebrow">Configuration</div>
          <h1>Sites &amp; posts</h1>
          <p className="lead">Where each site and post is, the geofence officers are checked against, how often they check in, and post orders.</p>
        </div>
        {isAdmin && (
          <div className="row">
            <button className="btn btn-ghost" onClick={() => setSiteDialog({ site: null })}>
              <Icon name="building" size={16} /> Add site
            </button>
            <button className="btn btn-primary" onClick={() => setPostDialog({ post: null })} disabled={!data.sites.length}>
              <Icon name="plus" size={16} /> Add post
            </button>
          </div>
        )}
      </div>

      <CheckInSettings isAdmin={isAdmin} onChanged={load} />
      <LocationCheck
        isAdmin={isAdmin}
        refreshKey={saved}
        onChanged={load}
        onEdit={(kind, x) =>
          kind === 'site' ? setSiteDialog({ site: data.sites.find((s) => s.id === x.id) }) : setPostDialog({ post: data.posts.find((p) => p.id === x.id) })
        }
      />

      {data.sites.length === 0 ? (
        <div className="card">
          <Empty icon="building" title="No sites yet">Add a client site, then the posts officers work at it.</Empty>
        </div>
      ) : (
        <div className="stack">
          {data.sites.map((site) => {
            const posts = data.posts.filter((p) => p.site_id === site.id);
            return (
              <div key={site.id} className="card">
                <div className="card-head">
                  <div>
                    <h3>{site.name}</h3>
                    <div className="tiny muted">
                      {site.client_name ? `${site.client_name} - ` : ''}
                      {site.address}
                      {site.city ? `, ${site.city} ${site.state}` : ''}
                    </div>
                  </div>
                  <div className="row">
                    {site.contact_phone && <span className="tiny muted hide-mobile">{site.contact_name} {site.contact_phone}</span>}
                    <Chip>{posts.length} posts</Chip>
                    {!site.active && <Chip kind="warn">Inactive</Chip>}
                    {isAdmin && (
                      <button className="btn btn-sm btn-ghost" onClick={() => setSiteDialog({ site })} aria-label={`Edit ${site.name}`}>
                        Edit
                      </button>
                    )}
                  </div>
                </div>

                {posts.length === 0 ? (
                  <Empty icon="shield" title="No posts at this site" />
                ) : (
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>Post</th>
                          <th>Code</th>
                          <th>Geofence</th>
                          <th>Check-in</th>
                          <th>Flags</th>
                          {isAdmin && <th />}
                        </tr>
                      </thead>
                      <tbody>
                        {posts.map((p) => (
                          <tr key={p.id}>
                            <td>
                              <div className="strong small">{p.name}</div>
                              {p.instructions && (
                                <div className="tiny muted truncate" style={{ maxWidth: 320 }}>
                                  {p.instructions.split('\n')[0]}
                                </div>
                              )}
                            </td>
                            <td className="mono small">{p.post_code || '--'}</td>
                            <td className="small">
                              {p.latitude != null ? (
                                <>
                                  {fmtDist(p.geofence_radius_m)}
                                  <div className="tiny muted">
                                    {p.location_source === 'survey'
                                      ? `Set at the post, ±${p.location_accuracy_m} m`
                                      : p.location_source === 'address'
                                        ? 'From the address'
                                        : p.location_source === 'map'
                                          ? 'Placed on the map'
                                          : `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`}
                                  </div>
                                </>
                              ) : (
                                <span className="muted">Not set</span>
                              )}
                            </td>
                            <td className="small">
                              {p.check_in_interval_min == null ? (
                                <span className="muted">Company setting</span>
                              ) : p.check_in_interval_min ? (
                                checkInLabel(p.check_in_interval_min)
                              ) : (
                                <span className="muted">Off</span>
                              )}
                            </td>
                            <td>
                              <div className="row wrap" style={{ gap: 4 }}>
                                {Boolean(p.armed) && <Chip kind="danger">Armed</Chip>}
                                {Boolean(p.training_required) && <Chip kind="info">Site training</Chip>}
                                {Boolean(p.requires_gps) && <Chip kind="info">GPS</Chip>}
                                {!p.active && <Chip kind="warn">Inactive</Chip>}
                              </div>
                            </td>
                            {isAdmin && (
                              <td>
                                <button className="btn btn-sm btn-ghost" onClick={() => setPostDialog({ post: p })}>
                                  Edit
                                </button>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {siteDialog && (
        <SiteDialog
          site={siteDialog.site}
          onClose={() => setSiteDialog(null)}
          onSaved={() => { setSiteDialog(null); setSaved((n) => n + 1); load(); }}
        />
      )}
      {postDialog && (
        <PostDialog
          post={postDialog.post}
          sites={data.sites}
          onClose={() => setPostDialog(null)}
          onSaved={() => { setPostDialog(null); setSaved((n) => n + 1); load(); }}
        />
      )}
    </div>
  );
}
