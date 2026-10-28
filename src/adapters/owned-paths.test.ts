import { canonicalFileUri, isInside, isOwnedPickerCopy, uriScheme } from './owned-paths';

const C = 'file:///var/mobile/Containers/Data/Application/APP';
const roots = { tmpDir: `${C}/tmp/`, pickerCacheDir: `${C}/Library/Caches/DocumentPicker/` };

describe('owned picker copies', () => {
  it.each([
    [
      `file:///private/var/mobile/Containers/Data/Application/APP/tmp/dev.narhi.statementimport-Inbox/statement.pdf`,
      true,
    ],
    [`${C}/tmp/dev.narhi.statementimport-Inbox/my%20statement.csv`, true],
    [`${C}/Library/Caches/DocumentPicker/1234.csv`, true],
    [`${C}/tmp/dev.narhi.statementimport-Inbox`, false],
    [`${C}/tmp/other/statement.pdf`, false],
    [`${C}/Documents/statement.pdf`, false],
    [`${C}/tmp/x-Inbox/../../Documents/statement.pdf`, false],
    ['content://com.android.providers.downloads.documents/document/42', false],
    ['file:///storage/emulated/0/Download/statement.csv', false],
  ])('%s → %s', (uri, owned) => {
    expect(isOwnedPickerCopy(uri, roots)).toBe(owned);
  });

  it('owns no tmp Inbox where there is none (Android)', () => {
    expect(isOwnedPickerCopy(`${C}/tmp/a-Inbox/x.csv`, { ...roots, tmpDir: null })).toBe(false);
  });
});

describe('path helpers', () => {
  it('canonicalises', () => {
    expect(uriScheme('CONTENT://x')).toBe('content');
    expect(uriScheme('/no/scheme')).toBe('');
    expect(canonicalFileUri('file:///private/var/a/b/')).toBe('file:///var/a/b');
    expect(canonicalFileUri('file:///a/%E0%A4%A')).toBeNull();
    expect(canonicalFileUri('content://a')).toBeNull();
  });

  it('isInside is strict', () => {
    expect(isInside(`${C}/Library/Caches/imports/x.bin`, `${C}/Library/Caches/imports/`)).toBe(
      true,
    );
    expect(isInside(`${C}/Library/Caches/imports`, `${C}/Library/Caches/imports/`)).toBe(false);
    expect(isInside(`${C}/Library/Caches/imports-evil/x.bin`, `${C}/Library/Caches/imports`)).toBe(
      false,
    );
  });
});
