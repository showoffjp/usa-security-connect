import { useState } from 'react';
import { setThemePreference, themePreference } from '../lib/theme.js';
import { Segmented } from './ui.jsx';

/** Auto (follow the device), Light or Dark, for the account menus. */
export default function ThemeChoice() {
  const [pref, setPref] = useState(themePreference());
  return (
    <div className="stack-sm">
      <div className="small strong">Appearance</div>
      <Segmented
        label="Appearance"
        value={pref}
        onChange={(v) => {
          setPref(v);
          setThemePreference(v);
        }}
        options={[
          { value: 'auto', label: 'Auto' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Night' },
        ]}
      />
    </div>
  );
}
