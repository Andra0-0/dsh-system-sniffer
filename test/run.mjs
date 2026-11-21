/**
 * Every check behind one command: `node test/run.mjs`.
 *
 * The files are imported rather than spawned, because a child process with a
 * piped stdio is exactly what the tool sandbox forbids (`PITFALLS.md` §8), and
 * because a failing assertion should stop the run with its own stack, not with
 * a summary that hides which file broke.
 *
 * The two client files each get their own copy of `client.js` (the `?render` /
 * `?boot` query is an ESM cache key, not a request): the first registers against
 * a jsdom window with real React, the second against a fake one. Without the
 * query the second import would be a cache hit and register nothing.
 */
await import('./test-beat.mjs')
await import('./test-store.mjs')
await import('./test-trace.mjs')
await import('./test-diskscan.mjs')
await import('./test-native-manager.mjs')
await import('./test-icon.mjs')
await import('./test-format.mjs')
await import('./test-trace-chart.mjs')
await import('./test-trace-reentry.mjs')
await import('./test-client-render.mjs')
await import('./test-client-boot.mjs')

console.log('test: all files passed')
