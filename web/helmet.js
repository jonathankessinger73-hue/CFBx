// Team helmet icon: a side-view football helmet in the team's colors with a
// round side decal carrying the school's initial. Generic by design; it
// uses no school's actual logo or marks.

const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const safeColor = (c, fallback) => (hex.test(c || "") ? c : fallback);

function rgb(c) {
  let h = c.slice(1);
  if (h.length === 3) h = h.replace(/./g, (x) => x + x);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}
function luminance(c) {
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = rgb(c).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

// The school's initial for the decal: first letter of its name.
export function monogram(name) {
  const m = String(name || "").match(/[A-Za-z]/);
  return m ? m[0].toUpperCase() : "";
}

let uid = 0;

/**
 * @param {string} primary   shell color
 * @param {string} secondary stripe + decal color
 * @param {number} size      rendered width in px
 * @param {string} [name]    school name, for the decal initial
 */
export function helmetSVG(primary, secondary, size = 56, name = "") {
  const shell = safeColor(primary, "#3A4657");
  let accent = safeColor(secondary, "#C9CED6");
  // A stripe/decal the same shade as the shell disappears; fall back to
  // white or near-black, whichever stands out more.
  if (contrast(shell, accent) < 1.6) accent = contrast(shell, "#FFFFFF") >= contrast(shell, "#111111") ? "#FFFFFF" : "#111111";
  // Initial inside the decal: shell color if it reads on the accent,
  // otherwise black or white.
  let ink = shell;
  if (contrast(accent, ink) < 2.2) ink = contrast(accent, "#111111") >= contrast(accent, "#FFFFFF") ? "#111111" : "#FFFFFF";
  const letter = monogram(name);
  const id = `hg${++uid}`;
  const h = Math.round(size * 0.8);

  const SHELL =
    "M10 60 C8 34 28 12 60 10 C90 8 110 26 112 48 L112 53 L93 53 C89 53 87 57 87 61 " +
    "L87 72 C87 80 81 85 73 85 L38 85 C27 85 19 81 14 73 C11 69 10 65 10 60 Z";

  return (
    `<svg class="helmet" width="${size}" height="${h}" viewBox="0 0 126 96" aria-hidden="true">` +
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0.55" y2="1">` +
    `<stop offset="0" stop-color="#fff" stop-opacity=".42"/>` +
    `<stop offset=".4" stop-color="#fff" stop-opacity=".05"/>` +
    `<stop offset="1" stop-color="#000" stop-opacity=".32"/>` +
    `</linearGradient></defs>` +
    // Face opening, in shadow behind the mask.
    `<path d="M87 55 L112 53 L116 80 L87 82 Z" fill="rgba(0,0,0,.45)"/>` +
    // Shell, facing right: long dome, brow over the face, jaw flap.
    `<path d="${SHELL}" fill="${shell}"/>` +
    `<path d="${SHELL}" fill="url(#${id})" stroke="rgba(255,255,255,.38)" stroke-width="1.6" stroke-linejoin="round"/>` +
    // Bottom rim of the shell.
    `<path d="M16 74 C22 81 29 83 38 83 L72 83" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="2.4" stroke-linecap="round"/>` +
    // Center stripe over the crown.
    `<path d="M15 50 C16 28 34 14 60 13 C84 12 101 24 106 40" fill="none" stroke="${accent}" stroke-width="5.5" stroke-linecap="round"/>` +
    // Side decal with the school's initial.
    `<circle cx="48" cy="50" r="15" fill="${accent}" stroke="rgba(0,0,0,.25)" stroke-width="1"/>` +
    (letter
      ? `<text x="48" y="50" dy=".36em" text-anchor="middle" font-family="Oswald, 'Arial Narrow', sans-serif" font-weight="700" font-size="21" fill="${ink}">${letter}</text>`
      : "") +
    // Face mask: curved bars from the jaw forward, joined by a front upright.
    `<g fill="none" stroke="#D3D8DE" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M89 58 C99 55 109 55 118 58"/>` +
    `<path d="M88 69 C98 67 109 67 119 69"/>` +
    `<path d="M88 80 C97 81 107 80 115 77"/>` +
    `<path d="M118 58 C120 64 120 71 115 77"/>` +
    `</g>` +
    `</svg>`
  );
}
