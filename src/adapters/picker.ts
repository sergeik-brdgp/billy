// System document picker. The picked URI and name are opaque to everything but the
// core's prepare step: never logged, never put into an error.

import { getDocumentAsync, type DocumentPickerResult } from 'expo-document-picker';

import type { PickedFile } from '../core';

/**
 * Broad on purpose: providers label CSVs inconsistently (`text/plain`, `application/vnd.ms-excel`,
 * …) and the verdict is made on the private copy's bytes, never on the MIME type. `*\/*`
 * keeps a mislabelled statement (and the spoofed fixture) selectable.
 */
export const PICKER_TYPES: readonly string[] = [
  'application/pdf',
  'text/csv',
  'text/comma-separated-values',
  'text/plain',
  'application/vnd.ms-excel',
  '*/*',
];

/** The picker itself failed (not a cancel). Carries no URI or file name. */
export class PickerError extends Error {
  constructor() {
    super('picker_failed');
    this.name = 'PickerError';
  }
}

/** Maps the picker result; null on cancel or an empty selection. */
export function toPickedFile(result: DocumentPickerResult): PickedFile | null {
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (asset === undefined || typeof asset.uri !== 'string' || asset.uri.length === 0) return null;
  const size = asset.size;
  return {
    uri: asset.uri,
    name: typeof asset.name === 'string' ? asset.name : '',
    // A positive size is "known"; 0 / missing (Android providers without OpenableColumns.SIZE) is
    // unknown and the bounded copy decides.
    declaredSize: typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : null,
  };
}

/**
 * Opens the system picker. `copyToCacheDirectory: false`: Android hands out a `content://` URI
 * (temporary grant, copied by `FilesPort.copyIn` with a bounded stream); iOS still copies into
 * `tmp/<bundle id>-Inbox/` (`UIDocumentPickerViewController(asCopy: true)`), which the app owns,
 * moves into its private dir and sweeps. `base64` is web-only in SDK 58 but is disabled
 * explicitly so the file is never read into JS memory.
 *
 * Resolves null on cancel; rejects with `PickerError` (no URI / name) if the picker fails.
 */
export async function pickStatementFile(): Promise<PickedFile | null> {
  let result: DocumentPickerResult;
  try {
    result = await getDocumentAsync({
      type: [...PICKER_TYPES],
      copyToCacheDirectory: false,
      multiple: false,
      base64: false,
    });
  } catch {
    throw new PickerError();
  }
  return toPickedFile(result);
}
