import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../lib/auth.jsx';
import { LoadingPage, Empty, Icon, Chip, Modal, Field, Banner, useToast } from '../../components/ui.jsx';
import { LocationPicker, googleMapsLink } from '../../components/Map.jsx';
import { RULES } from '@shared/domain.js';

function SiteDialog({ onClose, onSaved }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: '', clientName: '', address: '', city: '', state: 'FL', postalCode: '',
    latitude: '', longitude: '', contactName: '', contactPhone: '',
  });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setBusy(true);
    try {
      await api.post('/admin/sites', {
        ...form,
        latitude: form.latitude === '' ? null : Number(form.latitude),
        longitude: form.longitude === '' ? null : Number(form.longitude),
        active: true,
      });
      toast.success('Site added.');
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add site"
      onClose={onClose}
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
        <div className="grid grid-2">
          <Field label="Latitude" hint="Used for post geofences.">
            <input type="number" step="0.000001" value={form.latitude} onChange={set('latitude')} placeholder="30.3196" />
          </Field>
          <Field label="Longitude">
            <input type="number" step="0.000001" value={form.longitude} onChange={set('longitude')} placeholder="-81.6795" />
          </Field>
        </div>
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
    geofenceRadiusM: post?.geofence_radius_m ?? RULES.defaultGeofenceRadiusM,
    checkInIntervalMin: post?.check_in_interval_min ?? RULES.defaultCheckInIntervalMinutes,
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
        latitude: form.latitude === '' ? null : Number(form.latitude),
        longitude: form.longitude === '' ? null : Number(form.longitude),
        geofenceRadiusM: Number(form.geofenceRadiusM),
        checkInIntervalMin: Number(form.checkInIntervalMin),
        requiresGps: form.requiresGps,
        armed: form.armed,
        trainingRequired: form.trainingRequired,
        active: form.active,
      };
      if (editing) await api.patch(`/admin/posts/${post.id}`, payload);
      else await api.post('/admin/posts', payload);
      toast.success(editing ? 'Post updated.' : 'Post added.');
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
              onChange={({ latitude, longitude, label }) =>
                setForm((f) => ({
                  ...f,
                  latitude: latitude ?? '',
                  longitude: longitude ?? '',
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
              label="Status check-in every (minutes)"
              hint={`0 turns check-ins off. Officers have ${RULES.checkInWindowMinutes} minutes to answer.`}
            >
              <input type="number" min="0" max="480" value={form.checkInIntervalMin} onChange={set('checkInIntervalMin')} />
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
  const [siteDialog, setSiteDialog] = useState(false);
  const [postDialog, setPostDialog] = useState(null);

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
          <p className="lead">Geofences, check-in cadence and post orders live here.</p>
        </div>
        {isAdmin && (
          <div className="row">
            <button className="btn btn-ghost" onClick={() => setSiteDialog(true)}>
              <Icon name="building" size={16} /> Add site
            </button>
            <button className="btn btn-primary" onClick={() => setPostDialog({ post: null })} disabled={!data.sites.length}>
              <Icon name="plus" size={16} /> Add post
            </button>
          </div>
        )}
      </div>

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
                                  {p.geofence_radius_m}m
                                  <div className="tiny muted mono">
                                    {p.latitude.toFixed(4)}, {p.longitude.toFixed(4)}
                                  </div>
                                </>
                              ) : (
                                <span className="muted">Not set</span>
                              )}
                            </td>
                            <td className="small">
                              {p.check_in_interval_min ? `Every ${p.check_in_interval_min}m` : <span className="muted">Off</span>}
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

      {siteDialog && <SiteDialog onClose={() => setSiteDialog(false)} onSaved={() => { setSiteDialog(false); load(); }} />}
      {postDialog && (
        <PostDialog
          post={postDialog.post}
          sites={data.sites}
          onClose={() => setPostDialog(null)}
          onSaved={() => { setPostDialog(null); load(); }}
        />
      )}
    </div>
  );
}
