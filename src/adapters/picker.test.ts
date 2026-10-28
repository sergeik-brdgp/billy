import { getDocumentAsync } from 'expo-document-picker';

import { PICKER_TYPES, PickerError, pickStatementFile, toPickedFile } from './picker';

jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

const mockedPick = getDocumentAsync as jest.MockedFunction<typeof getDocumentAsync>;

const asset = (extra: Record<string, unknown>) => ({
  canceled: false as const,
  assets: [{ uri: 'content://provider/doc/1', name: 'statement.csv', lastModified: 0, ...extra }],
});

describe('toPickedFile', () => {
  it('returns null on cancel', () => {
    expect(toPickedFile({ canceled: true, assets: null })).toBeNull();
  });

  it('treats a positive size as known and 0 / missing as unknown', () => {
    expect(toPickedFile(asset({ size: 120 }))).toEqual({
      uri: 'content://provider/doc/1',
      name: 'statement.csv',
      declaredSize: 120,
    });
    expect(toPickedFile(asset({ size: 0 }))?.declaredSize).toBeNull();
    expect(toPickedFile(asset({}))?.declaredSize).toBeNull();
  });
});

describe('pickStatementFile', () => {
  it('opens the picker (no cache copy, single file, no base64)', async () => {
    mockedPick.mockResolvedValueOnce(asset({ size: 5 }));
    await expect(pickStatementFile()).resolves.toMatchObject({ declaredSize: 5 });
    expect(mockedPick).toHaveBeenCalledWith({
      type: [...PICKER_TYPES],
      copyToCacheDirectory: false,
      multiple: false,
      base64: false,
    });
    expect(PICKER_TYPES).toEqual([
      'application/pdf',
      'text/csv',
      'text/comma-separated-values',
      'text/plain',
      'application/vnd.ms-excel',
      '*/*',
    ]);
  });

  it('resolves null on cancel', async () => {
    mockedPick.mockResolvedValueOnce({ canceled: true, assets: null });
    await expect(pickStatementFile()).resolves.toBeNull();
  });

  it('rejects with a PickerError that carries no URI or name', async () => {
    mockedPick.mockRejectedValueOnce(
      new Error('Failed to read document details for URI: content://secret/statement.csv'),
    );
    const error = await pickStatementFile().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PickerError);
    expect(String((error as Error).message)).toBe('picker_failed');
  });
});
