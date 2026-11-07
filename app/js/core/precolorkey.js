// What decides a full sensor picture before its color pass. The picture is kept at that point, so a change to the color settings (Process, Optics, local adjustments)
// makes the picture again from the kept one instead of from the sensor (worker.js). The key names everything else: the photo's state, the settings that are not color
// settings, and what the request itself carries. A setting that is missing here only costs time; one that is wrongly left out would show a stale picture, so the
// color settings are listed (the table the page's controls are read through) and every other setting counts.

import { COLOR_SETTINGS } from '../settingsmap.js';

// The top level names of the settings that only the color pass reads (the color pass also applies the local adjustments).
export const COLOR_PASS_SETTINGS = new Set([...COLOR_SETTINGS.map(([path]) => path.split('.')[0]), 'curve', 'ccm', 'local']);

// `settings`: the engine's settings; `state`: what else the picture depends on (numbers, strings or ids of objects); `parts`: the request's own values; `skip`: more setting
// names that only the color pass reads for this kind of picture.
export function preColorKey(settings, state, parts, skip = []) {
  const rest = {};
  for (const [k, v] of Object.entries(settings)) if (!COLOR_PASS_SETTINGS.has(k) && !skip.includes(k)) rest[k] = v;
  return JSON.stringify([state, rest, parts]);
}
