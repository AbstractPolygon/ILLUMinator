// Debug and test switches, in one place.
//
// Nothing here is set by the app itself: a test harness or the browser console sets them (in the worker, usually by prepending a line to worker.js).
//   * `debugFlags()` is the `__lytro` object: named switches that change how a stage runs (`noGpuBlur`, `legacy`, `printColor`, tuning values such as `viewRing`).
//     It is always an object, so `debugFlags().legacy` is undefined when nothing was set.
//   * `hook(name)` reads a global `__name` a harness set: a function the code calls with a stage's result to dump or inspect it (`__awbDump`, `__depthFinal`), or a value that
//     overrides one (`__depthOverride`, `__forceStyle`). `setHook(name, value)` publishes a result for a harness to read (`__lytroStats`, `__focusMetrics`).

const NONE = Object.freeze({});

/** The `__lytro` switches (an empty object when none are set). */
export function debugFlags() {
  return globalThis.__lytro || NONE;
}

/** The harness global `__name` (undefined when not set). */
export function hook(name) {
  return globalThis[`__${name}`];
}

/** Publishes `value` as the global `__name` for a harness to read; returns it. */
export function setHook(name, value) {
  globalThis[`__${name}`] = value;
  return value;
}
