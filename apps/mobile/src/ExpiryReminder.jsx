import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { api } from './api.js';
import { fmtDay } from './format.js';
import { expiryState } from './shared.js';
import { Banner } from './ui.jsx';
import { S } from './theme.js';

/** A licence or certification lapsing within 30 days, or lapsed. */
export function ExpiryReminder({ user }) {
  const [items, setItems] = useState([]);
  useEffect(() => {
    let alive = true;
    const soon = (days) => days !== null && days <= 30;
    const list = [];
    if (user?.license_expires_on) {
      const { days } = expiryState(user.license_expires_on);
      if (soon(days)) list.push({ key: 'licence', name: `${user.license_type || 'Security'} licence`, days, on: user.license_expires_on });
    }
    api.get('/certifications').then(
      (d) => {
        for (const c of d.certifications || []) {
          if (soon(c.expiry?.days)) list.push({ key: `cert-${c.id}`, name: c.type, days: c.expiry.days, on: c.expires_on });
        }
        if (alive) setItems([...list].sort((a, b) => a.days - b.days));
      },
      () => alive && setItems(list)
    );
    return () => {
      alive = false;
    };
  }, [user?.license_expires_on, user?.license_type]);
  if (!items.length) return null;
  const lapsed = items.some((i) => i.days < 0);
  return (
    <Banner tone={lapsed ? 'danger' : 'warn'} title={lapsed ? 'A licence or certificate has lapsed' : 'Renewal due soon'}>
      <View style={{ gap: 3 }}>
        {items.map((i) => (
          <Text key={i.key} style={[S.small, { lineHeight: 19 }]}>
            {i.name}:{' '}
            {i.days < 0 ? `lapsed ${fmtDay(i.on)}` : i.days === 0 ? 'expires today' : `expires in ${i.days} day${i.days === 1 ? '' : 's'}`}
          </Text>
        ))}
        <Text style={[S.tiny, { marginTop: 2 }]}>Speak to the office about renewal.</Text>
      </View>
    </Banner>
  );
}
