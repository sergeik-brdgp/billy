// Pure path rules: which `file://` URIs the app owns and may delete ("Cleanup only
// touches Paths.cache/imports/*, the iOS Inbox and the picker cache dir").

/** URI scheme in lower case (`file`, `content`, …), or '' when there is none. */
export function uriScheme(uri: string): string {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(uri);
  return match?.[1]?.toLowerCase() ?? '';
}

/**
 * Canonical form for prefix comparisons: lower-case scheme, `/private/var/` → `/var/` (iOS hands
 * out both spellings of the same container), percent-decoding, no trailing slash. Returns null
 * for anything that is not a plain `file://` URI or that contains `.`/`..` segments.
 */
export function canonicalFileUri(uri: string): string | null {
  if (uriScheme(uri) !== 'file') return null;
  let path = uri.slice('file://'.length);
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (!path.startsWith('/')) return null;
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  if (path.startsWith('/private/var/')) path = path.slice('/private'.length);
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return `file://${path}`;
}

/** True when `uri` is strictly inside `dir` (both canonicalised). */
export function isInside(uri: string, dir: string): boolean {
  const child = canonicalFileUri(uri);
  const parent = canonicalFileUri(dir);
  if (child === null || parent === null) return false;
  return child.startsWith(`${parent}/`) && child.length > parent.length + 1;
}

export interface PickerCopyRoots {
  /** iOS `<container>/tmp` (holds `<bundle id>-Inbox/`); null where there is none (Android). */
  readonly tmpDir: string | null;
  /** expo-document-picker's `copyToCacheDirectory` target (`<cache>/DocumentPicker`). */
  readonly pickerCacheDir: string;
}

/**
 * A picker copy the app owns: a `file://` URI inside `tmp/<something>-Inbox/` (iOS
 * `UIDocumentPickerViewController(asCopy: true)`) or inside the picker cache dir. `content://`
 * URIs and any other `file://` location (the user's original) are never owned.
 */
export function isOwnedPickerCopy(uri: string, roots: PickerCopyRoots): boolean {
  if (isInside(uri, roots.pickerCacheDir)) return true;
  if (roots.tmpDir === null || !isInside(uri, roots.tmpDir)) return false;
  const tmp = canonicalFileUri(roots.tmpDir);
  const child = canonicalFileUri(uri);
  if (tmp === null || child === null) return false;
  const [inbox, ...rest] = child.slice(tmp.length + 1).split('/');
  return inbox !== undefined && inbox.endsWith('-Inbox') && rest.length > 0;
}
