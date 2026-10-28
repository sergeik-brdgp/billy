// Details card: a receipt (Billy, merchant, amount, key facts) over a stub with the raw server
// record. When it closes, the sheet keeps its last content while it slides out instead of
// collapsing mid-animation.

import { render, screen } from '@testing-library/react-native';
import { Modal } from 'react-native';

import { JOB_ID, READY_RESULT } from '../test-utils/fakeController';
import { DISPLAY_MAX_SCALE, TITLE_MAX_SCALE } from '../theme';
import { itemReceipt } from '../viewModel';
import { DetailsModal } from './report';

const [FIRST, SECOND] = READY_RESULT.items;
if (FIRST === undefined || SECOND === undefined) throw new Error('fixture');
const STREAMBEAM = itemReceipt(FIRST, 0, 'AUD', JOB_ID, 3);
const BRIGHTGRID = itemReceipt(SECOND, 1, 'AUD', JOB_ID, 3);

const noop = (): void => undefined;

describe('DetailsModal', () => {
  it('draws the receipt and the server record', () => {
    render(<DetailsModal receipt={STREAMBEAM} covered={false} onClose={noop} />);
    expect(screen.getByRole('header', { name: 'Recurring charge' })).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Server record' })).toBeTruthy();
    expect(screen.getByTestId('receipt-amount')).toHaveTextContent('19.99 AUD');
    // Billy is decorative: present, but hidden from screen readers.
    expect(screen.getByTestId('mascot', { includeHiddenElements: true })).toBeTruthy();
    expect(screen.queryByTestId('mascot')).toBeNull();
    // Facts and record rows are read as "label: value" pairs.
    for (const label of [
      'Last charged: 1 Oct 2026',
      'Frequency: Monthly',
      'ID: rec-001',
      'Merchant: StreamBeam',
      'Amount in minor units: 1999',
      'Frequency: monthly',
      'Last charged: 2026-10-01',
      `Job: ${JOB_ID}`,
      'Revision: 3',
      'Job status: ready',
    ]) {
      expect(screen.getAllByLabelText(label).length).toBeGreaterThan(0);
    }
    // No action besides Close: the task has no subscription management.
    expect(screen.getAllByRole('button').map((node) => node.props.accessibilityLabel)).toEqual([
      'Close',
    ]);
  });

  it('large text: heading-sized lines stop at 1.5x, the amount at 1.75x, the rest scales', () => {
    render(<DetailsModal receipt={STREAMBEAM} covered={false} onClose={noop} />);
    // The merchant name is the receipt's heading: capped like titles so AX5 keeps the word whole.
    const merchant = screen.getAllByText('StreamBeam')[0];
    expect(merchant?.props.maxFontSizeMultiplier).toBe(TITLE_MAX_SCALE);
    expect(screen.getByTestId('receipt-amount').props.maxFontSizeMultiplier).toBe(
      DISPLAY_MAX_SCALE,
    );
    expect(screen.getByText('2026-10-01').props.maxFontSizeMultiplier).toBeUndefined();
    expect(screen.getByText('1 Oct 2026').props.maxFontSizeMultiplier).toBeUndefined();
  });

  it('hides on close but keeps the last receipt for the slide-out', () => {
    const view = render(<DetailsModal receipt={STREAMBEAM} covered={false} onClose={noop} />);
    view.rerender(<DetailsModal receipt={null} covered={false} onClose={noop} />);
    const modal = screen.UNSAFE_getByType(Modal);
    expect(modal.props.visible).toBe(false);
    // What the native sheet still draws while animating out.
    render(modal.props.children);
    expect(screen.getAllByText('StreamBeam').length).toBeGreaterThan(0);
    expect(screen.getByTestId('receipt-amount')).toHaveTextContent('19.99 AUD');
  });

  it('shows a new receipt as soon as it changes', () => {
    const view = render(<DetailsModal receipt={STREAMBEAM} covered={false} onClose={noop} />);
    view.rerender(<DetailsModal receipt={BRIGHTGRID} covered={false} onClose={noop} />);
    expect(screen.getAllByText('BrightGrid').length).toBeGreaterThan(0);
    expect(screen.queryByText('StreamBeam')).toBeNull();
  });
});
