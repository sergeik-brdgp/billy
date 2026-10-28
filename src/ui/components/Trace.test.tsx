// The log may repeat a line key (a retried delete, a second by-key lookup): React keys must still
// be unique, and a settled log folds into one toggle that opens on press.

import { fireEvent, render, screen } from '@testing-library/react-native';

import type { Trace } from '../trace';
import { TraceView } from './Trace';

const RETRIED: Trace = {
  opId: 'op-1',
  lines: [
    { key: 'delete_asked', text: 'Asked the server to delete' },
    { key: 'delete_failed', text: "Delete didn't go through" },
    { key: 'delete_asked', text: 'Asked the server to delete again' },
    { key: 'delete_failed', text: "Delete didn't go through" },
  ],
  ignoredSeen: 0,
  settled: true,
};

describe('TraceView', () => {
  it('renders repeated line keys without React key warnings', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<TraceView trace={RETRIED} />);
    fireEvent.press(screen.getByTestId('trace-toggle'));
    expect(screen.getAllByText("Delete didn't go through")).toHaveLength(2);
    const keyWarnings = error.mock.calls.filter((call) =>
      call.some((part) => typeof part === 'string' && part.includes('same key')),
    );
    expect(keyWarnings).toEqual([]);
    error.mockRestore();
  });

  it('a settled log is folded until the toggle is pressed', () => {
    render(<TraceView trace={RETRIED} />);
    expect(screen.queryByText('Asked the server to delete again')).toBeNull();
    expect(screen.getByRole('button', { name: 'How I got here · 4 steps' })).toBeTruthy();
    fireEvent.press(screen.getByTestId('trace-toggle'));
    expect(screen.getByText('Asked the server to delete again')).toBeTruthy();
  });
});
