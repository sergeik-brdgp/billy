// Config plugin: hide the app's screen in the Android "Recents" thumbnail without FLAG_SECURE.
//
// FLAG_SECURE would also black out screen recording / screenshots, and a screen recording of the
// app is a required part of the submission. `Activity.setRecentsScreenshotEnabled(false)` (API 33+)
// only stops the system from using a screenshot of the activity as its Recents thumbnail.
// On API < 33 there is no such call: the thumbnail still shows the screen (documented gap).
//
// Injected into MainActivity.onCreate (Kotlin) right after `super.onCreate(...)`. Idempotent:
// re-running `npx expo prebuild` over an already patched file changes nothing.

const { withMainActivity } = require('expo/config-plugins');

const LINE = 'if (android.os.Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false)';
const MARKER = '// statement-import: no screen contents in the Recents thumbnail (API 33+)';

/**
 * Pure transform of MainActivity.kt source. Returns the source unchanged when the call is already
 * there; inserts it after `super.onCreate(...)` when `onCreate` exists; otherwise adds an
 * `onCreate` override at the top of the `MainActivity` class body.
 *
 * @param {string} src
 * @returns {string}
 */
function addRecentsScreenshotDisabled(src) {
  if (src.includes('setRecentsScreenshotEnabled(false)')) return src;

  const superCall = /^([ \t]*)super\.onCreate\([^)]*\)[ \t]*;?[ \t]*$/m;
  const onCreate = /override\s+fun\s+onCreate\s*\(/;
  if (onCreate.test(src)) {
    const match = superCall.exec(src);
    if (match === null) {
      throw new Error(
        'withRecentsScreenshotDisabled: MainActivity.onCreate has no super.onCreate(...) call to anchor to',
      );
    }
    const indent = match[1];
    const end = match.index + match[0].length;
    return `${src.slice(0, end)}\n${indent}${MARKER}\n${indent}${LINE}${src.slice(end)}`;
  }

  const classHeader = /^([ \t]*)class\s+MainActivity\b[^{\n]*\{[ \t]*$/m;
  const header = classHeader.exec(src);
  if (header === null) {
    throw new Error('withRecentsScreenshotDisabled: class MainActivity not found');
  }
  const indent = `${header[1]}  `;
  const method = [
    `${indent}override fun onCreate(savedInstanceState: android.os.Bundle?) {`,
    `${indent}  super.onCreate(savedInstanceState)`,
    `${indent}  ${MARKER}`,
    `${indent}  ${LINE}`,
    `${indent}}`,
  ].join('\n');
  const end = header.index + header[0].length;
  return `${src.slice(0, end)}\n${method}\n${src.slice(end)}`;
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
function withRecentsScreenshotDisabled(config) {
  return withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt') {
      throw new Error(
        `withRecentsScreenshotDisabled: only a Kotlin MainActivity is supported (got ${cfg.modResults.language})`,
      );
    }
    cfg.modResults.contents = addRecentsScreenshotDisabled(cfg.modResults.contents);
    return cfg;
  });
}

module.exports = withRecentsScreenshotDisabled;
module.exports.addRecentsScreenshotDisabled = addRecentsScreenshotDisabled;
module.exports.RECENTS_LINE = LINE;
