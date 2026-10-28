// Config plugin: no on-disk HTTP cache on iOS.
//
// React Native's networking uses an NSURLSession with the default configuration, whose cache is
// `URLCache.shared` (`Library/Caches/<bundle id>/Cache.db`). On iOS that cache stores GET replies
// even when the server sends `Cache-Control: no-store` (checked on the simulator: the report with
// merchants and amounts stayed in Cache.db after the import was deleted). Android's OkHttp cache
// honours `no-store`, so only iOS needs this.
//
// At launch, before React Native makes any request: drop what an earlier build cached, then
// replace the shared cache with a zero-size one. Injected at the top of
// `application(_:didFinishLaunchingWithOptions:)` in AppDelegate.swift. Idempotent.

const { withAppDelegate } = require('expo/config-plugins');

const MARKER = '// statement-import: no on-disk HTTP cache (server replies carry report data)';
const LINES = [
  'URLCache.shared.removeAllCachedResponses()',
  'URLCache.shared = URLCache(memoryCapacity: 0, diskCapacity: 0, directory: nil)',
];

/**
 * Pure transform of AppDelegate.swift source: inserts the cache lines as the first statements of
 * `didFinishLaunchingWithOptions`. Unchanged when they are already there.
 *
 * @param {string} src
 * @returns {string}
 */
function addNoUrlCache(src) {
  if (src.includes(MARKER)) return src;
  const header = /didFinishLaunchingWithOptions[^)]*\)\s*->\s*Bool\s*\{[ \t]*\n/.exec(src);
  if (header === null) {
    throw new Error('withNoUrlCache: AppDelegate has no didFinishLaunchingWithOptions to anchor to');
  }
  const end = header.index + header[0].length;
  const indent = /^([ \t]*)\S/m.exec(src.slice(end))?.[1] ?? '    ';
  const block = [MARKER, ...LINES].map((line) => `${indent}${line}\n`).join('');
  return `${src.slice(0, end)}${block}\n${src.slice(end)}`;
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
function withNoUrlCache(config) {
  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error(
        `withNoUrlCache: only a Swift AppDelegate is supported (got ${cfg.modResults.language})`,
      );
    }
    cfg.modResults.contents = addNoUrlCache(cfg.modResults.contents);
    return cfg;
  });
}

module.exports = withNoUrlCache;
module.exports.addNoUrlCache = addNoUrlCache;
module.exports.NO_URL_CACHE_LINES = LINES;
