/**
 * The USA Security Connect mark: "Chrome Guardian", a polished chrome shield
 * with navy and red enamel fields, an engine-turned pattern and a raised
 * silver pin.
 *
 * Plain JavaScript returning SVG markup, so the same drawing serves the React
 * <Shield> component and tools/make-icons.mjs, which writes the favicon, the
 * installed-app icons and the mobile app's images from it. Every id carries a
 * prefix because a page can show the mark more than once.
 */

export const SHIELD_VIEWBOX = '0 0 200 240';
export const SHIELD_RATIO = 200 / 240;

const OUT = 'M100 6 L186 36 V112 C186 170 150 210 100 232 C50 210 14 170 14 112 V36 Z';
const RIM2 = 'M100 11 L181 39.2 V112 C181 166.5 147 204.5 100 225.5 C53 204.5 19 166.5 19 112 V39.2 Z';
const MID = 'M100 17 L175 43.5 V112 C175 163 143 199 100 219 C57 199 25 163 25 112 V43.5 Z';
const INN = 'M100 27 L165 50 V112 C165 157 137 189 100 207 C63 189 35 157 35 112 V50 Z';
const PIN =
  'M100 66 C86 66 75 77 75 91 C75 110 100 140 100 140 C100 140 125 110 125 91 C125 77 114 66 100 66 Z ' +
  'M100 101 C94.5 101 90 96.5 90 91 C90 85.5 94.5 81 100 81 C105.5 81 110 85.5 110 91 C110 96.5 105.5 101 100 101 Z';

function star(cx, cy, r, inner = r * 0.42) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = ((-90 + i * 36) * Math.PI) / 180;
    const rr = i % 2 ? inner : r;
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

const CHROME = `
  <stop offset="0" stop-color="#fbfcfe"/><stop offset=".16" stop-color="#cfd6df"/>
  <stop offset=".33" stop-color="#6f7a87"/><stop offset=".47" stop-color="#f3f6f9"/>
  <stop offset=".6" stop-color="#a3adb8"/><stop offset=".78" stop-color="#3f4752"/>
  <stop offset=".9" stop-color="#9ba5b0"/><stop offset="1" stop-color="#e3e7ec"/>`;

/**
 * The inside of the <svg> element. `gleam` adds the bar of light the CSS
 * sweeps across on hover; `shadow` the soft drop shadow under the shield.
 */
export function shieldInner(p, { gleam = true, shadow = true } = {}) {
  return `
  <defs>
    <linearGradient id="${p}-cr" x1="0" y1="0" x2=".25" y2="1">${CHROME}</linearGradient>
    <linearGradient id="${p}-crr" x1=".25" y1="1" x2="0" y2="0">${CHROME}</linearGradient>
    <radialGradient id="${p}-nv" cx=".42" cy=".3" r=".85">
      <stop offset="0" stop-color="#2b63a3"/><stop offset=".45" stop-color="#0b2f5c"/><stop offset="1" stop-color="#010f22"/>
    </radialGradient>
    <radialGradient id="${p}-rd" cx=".4" cy=".28" r=".9">
      <stop offset="0" stop-color="#f06a4c"/><stop offset=".5" stop-color="#aa2f19"/><stop offset="1" stop-color="#4f1007"/>
    </radialGradient>
    <linearGradient id="${p}-pin" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#e2e7ee"/><stop offset=".56" stop-color="#b8c1cc"/><stop offset="1" stop-color="#f4f7fa"/>
    </linearGradient>
    <linearGradient id="${p}-gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="${p}-gl" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".3" stop-color="#fff" stop-opacity=".22"/>
      <stop offset=".5" stop-color="#fff" stop-opacity=".95"/><stop offset=".7" stop-color="#fff" stop-opacity=".22"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <pattern id="${p}-turn" width="8" height="8" patternUnits="userSpaceOnUse">
      <circle cx="4" cy="4" r="3.2" fill="none" stroke="#fff" stroke-opacity=".09" stroke-width=".7"/>
    </pattern>
    <clipPath id="${p}-mid"><path d="${MID}"/></clipPath>
    <clipPath id="${p}-clip"><path d="${OUT}"/></clipPath>
    <filter id="${p}-bev" x="-8%" y="-8%" width="116%" height="116%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceAlpha" stdDeviation="2.6" result="b"/>
      <feSpecularLighting in="b" surfaceScale="6" specularConstant="1.15" specularExponent="26" lighting-color="#ffffff" result="s">
        <fePointLight x="55" y="10" z="160"/>
      </feSpecularLighting>
      <feComposite in="s" in2="SourceAlpha" operator="in" result="si"/>
      <feComposite in="SourceGraphic" in2="si" operator="arithmetic" k1="0" k2="1" k3="1" k4="0"/>
    </filter>
    ${shadow ? `<filter id="${p}-sh" x="-25%" y="-20%" width="150%" height="150%"><feDropShadow dx="0" dy="6" stdDeviation="6" flood-color="#000" flood-opacity=".45"/></filter>` : ''}
  </defs>
  <g ${shadow ? `filter="url(#${p}-sh)"` : ''}>
    <g filter="url(#${p}-bev)">
      <path d="${OUT}" fill="url(#${p}-cr)"/>
      <path d="${RIM2}" fill="url(#${p}-crr)"/>
    </g>
    <path d="${OUT}" fill="none" stroke="#0a0d12" stroke-opacity=".7" stroke-width="1.4"/>
    <path d="${MID}" fill="url(#${p}-nv)" stroke="#05080c" stroke-width="1.2"/>
    ${[[100, 23], [44, 46], [156, 46]].map(([x, y]) => `<polygon points="${star(x, y + 0.5, 3.1)}" fill="#e9eef4"/>`).join('')}
    <g filter="url(#${p}-bev)"><path d="${INN}" fill="url(#${p}-rd)"/></g>
    <path d="${INN}" fill="url(#${p}-turn)"/>
    <path d="${INN}" fill="none" stroke="url(#${p}-cr)" stroke-width="3"/>
    <g transform="translate(0 14)">
      <path d="${PIN}" fill-rule="evenodd" fill="#000" opacity=".35" transform="translate(1.5 3)"/>
      <g filter="url(#${p}-bev)"><path d="${PIN}" fill-rule="evenodd" fill="url(#${p}-pin)"/></g>
      <path d="${PIN}" fill-rule="evenodd" fill="none" stroke="#5e6a77" stroke-width=".8"/>
    </g>
    <g clip-path="url(#${p}-mid)">
      <path d="M20 40 L100 12 L180 40 V98 C145 82 55 82 20 104 Z" fill="url(#${p}-gloss)" opacity=".55"/>
    </g>
    ${gleam ? `<g clip-path="url(#${p}-clip)" style="mix-blend-mode:screen">
      <rect class="gleam" x="-56" y="-20" width="84" height="290" fill="url(#${p}-gl)"/>
      <rect class="gleam gleam-late" x="-4" y="-20" width="14" height="290" fill="url(#${p}-gl)" opacity=".7"/>
    </g>` : ''}
  </g>`;
}

/** A complete standalone SVG document, for files and icons. */
export function shieldDocument(opts = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${SHIELD_VIEWBOX}" role="img" aria-label="USA Security Connect">${shieldInner('usc', { gleam: false, ...opts })}</svg>\n`;
}
