// Ready report (monthly total + one row per recurring charge) and the details card.
// Only rendered for a job with status `ready` and a result (R5: a 202 / queued is never a report).
// Each row is a single button («Details: <merchant>»): the whole card is the touch target.

import { useState } from 'react';
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { DETAILS_COPY } from '../copy';
import { useType } from '../fonts';
import { useAppear, usePress } from '../motion';
import { PrivacyCover } from '../PrivacyCover';
import {
  DISPLAY_MAX_SCALE,
  LIP,
  MIN_TOUCH,
  font,
  radius,
  space,
  TITLE_MAX_SCALE,
  useTheme,
} from '../theme';
import type { ReceiptModel, ReportModel, ReportRow } from '../viewModel';
import { ActionButton } from './ActionButton';
import { useStacked } from './parts';
import { Receipt } from './Receipt';

/** «151.99 AUD/month» → big number + unit. */
function splitTotal(total: string): { readonly value: string; readonly unit: string } {
  const space = total.indexOf(' ');
  return space < 0
    ? { value: total, unit: '' }
    : { value: total.slice(0, space), unit: total.slice(space) };
}

export function ReportView({
  report,
  onOpenDetails,
}: {
  readonly report: ReportModel;
  readonly onOpenDetails: (itemId: string) => void;
}) {
  const { color } = useTheme();
  const type = useType();
  const total = splitTotal(report.total);
  return (
    <View testID="report" style={styles.report}>
      <View
        style={[
          styles.totalCard,
          { backgroundColor: color.toneSurface.warning, borderColor: color.toneBorder.warning },
        ]}
      >
        <Text style={[styles.totalLabel, type.black, { color: color.tone.warning }]}>
          {report.totalLabel}
        </Text>
        <Text
          testID="monthly-total"
          maxFontSizeMultiplier={DISPLAY_MAX_SCALE}
          style={[styles.totalValue, type.black, { color: color.text }]}
        >
          {total.value}
          <Text style={[styles.totalUnit, type.heavy, { color: color.tone.warning }]}>
            {total.unit}
          </Text>
        </Text>
      </View>
      <Text
        accessibilityRole="header"
        maxFontSizeMultiplier={TITLE_MAX_SCALE}
        style={[styles.heading, type.black, { color: color.text }]}
      >
        {report.heading}
      </Text>
      {report.rows.map((row, index) => (
        <ReportRowCard key={row.id} row={row} index={index} onPress={() => onOpenDetails(row.id)} />
      ))}
    </View>
  );
}

function ReportRowCard({
  row,
  index,
  onPress,
}: {
  readonly row: ReportRow;
  readonly index: number;
  readonly onPress: () => void;
}) {
  const { color } = useTheme();
  const type = useType();
  const stacked = useStacked();
  const press = usePress();
  // Rows slide in one after another when the report arrives.
  const appear = useAppear(row.id, 60 * index);
  const sink = press.pressed.interpolate({ inputRange: [0, 1], outputRange: [0, LIP.card] });
  const avatar = index % color.avatarSurface.length;
  return (
    <Animated.View style={appear}>
      {/* The whole card is the touch target for sighted users. For VoiceOver / TalkBack it is not
          one element: merchant, date and amount are read as text, and the «Details» part is the
          button (activate → the same onPress). */}
      <Pressable
        accessible={false}
        onPress={onPress}
        onPressIn={press.onPressIn}
        onPressOut={press.onPressOut}
        style={[styles.rowButton, { backgroundColor: color.border }]}
      >
        <Animated.View
          style={[
            styles.rowFace,
            stacked && styles.rowFaceStacked,
            {
              backgroundColor: color.surface,
              borderColor: color.border,
              transform: [{ translateY: sink }],
            },
          ]}
        >
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.avatar, { backgroundColor: color.avatarSurface[avatar] }]}
          >
            <Text style={[styles.avatarText, type.black, { color: color.avatarText[avatar] }]}>
              {row.merchant.slice(0, 1).toUpperCase()}
            </Text>
          </View>
          <View style={styles.rowText}>
            <Text style={[styles.body, type.heavy, { color: color.text }]}>{row.merchant}</Text>
            <Text style={[styles.small, type.bold, { color: color.textMuted }]}>{row.meta}</Text>
          </View>
          <View style={[styles.rowEnd, stacked && styles.rowEndStacked]}>
            <View style={[styles.amount, { backgroundColor: color.surfaceMuted }]}>
              <Text style={[styles.body, type.black, { color: color.text }]}>{row.amount}</Text>
            </View>
            <View
              testID={`details-${row.id}`}
              accessible
              accessibilityRole="button"
              accessibilityLabel={DETAILS_COPY.openLabel(row.merchant)}
              accessibilityHint={DETAILS_COPY.openHint}
              accessibilityActions={[{ name: 'activate' }]}
              onAccessibilityAction={onPress}
              style={styles.more}
            >
              <Text style={[styles.small, type.black, { color: color.onPrimarySoft }]}>
                {DETAILS_COPY.open}
              </Text>
              <View style={[styles.chevron, { borderColor: color.onPrimarySoft }]} />
            </View>
          </View>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

export function DetailsModal({
  receipt,
  covered,
  onClose,
}: {
  /** null: closed. */
  readonly receipt: ReceiptModel | null;
  /**
   * iOS app-switcher privacy cover is up. A native Modal is presented by its own view controller
   * above the root view, so the root-level cover cannot hide it: the card draws its own cover.
   * (Closing the card instead would animate out and could still be in the snapshot.)
   */
  readonly covered: boolean;
  readonly onClose: () => void;
}) {
  const { color } = useTheme();
  // While the sheet slides out, keep drawing the last receipt: otherwise it collapses to an empty
  // sheet mid-animation. Updated during render (derived state), not in an effect.
  const [lastReceipt, setLastReceipt] = useState(receipt);
  if (receipt !== null && receipt !== lastReceipt) setLastReceipt(receipt);
  const shown = receipt ?? lastReceipt;
  return (
    <Modal
      visible={receipt !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={[styles.modalRoot, { backgroundColor: color.background }]}>
        <ScrollView
          style={{ backgroundColor: color.background }}
          contentContainerStyle={styles.modalContent}
          contentInsetAdjustmentBehavior="always"
        >
          {shown !== null ? <Receipt receipt={shown} /> : null}
          <ActionButton
            label={DETAILS_COPY.close}
            hint={DETAILS_COPY.closeHint}
            kind="primary"
            enabled
            onPress={onClose}
          />
        </ScrollView>
        {covered ? <PrivacyCover /> : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  report: { gap: space.md },
  totalCard: {
    borderWidth: 2,
    borderBottomWidth: 2 + LIP.card,
    borderRadius: radius.xl,
    paddingHorizontal: space.lg + 2,
    paddingVertical: space.lg,
    gap: 2,
  },
  totalLabel: { fontSize: font.small, letterSpacing: 0.6, textTransform: 'uppercase' },
  totalValue: { fontSize: font.display },
  totalUnit: { fontSize: font.body },
  heading: { fontSize: font.title, paddingTop: space.sm, paddingHorizontal: space.xs },
  rowButton: { minHeight: MIN_TOUCH + LIP.card, borderRadius: radius.xl, paddingBottom: LIP.card },
  rowFace: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderWidth: 2,
    borderRadius: radius.xl,
    paddingHorizontal: space.md + 2,
    paddingVertical: space.md,
  },
  rowFaceStacked: { flexDirection: 'column', alignItems: 'flex-start' },
  // Grows with the letter at large font sizes (no fixed box around text).
  avatar: {
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: font.title },
  rowText: { flexGrow: 1, flexShrink: 1, gap: 2 },
  rowEnd: { alignItems: 'flex-end', gap: space.xs },
  rowEndStacked: { alignItems: 'flex-start' },
  // ≥ 48 pt tall: also the screen-reader target of the row.
  more: { minHeight: MIN_TOUCH, flexDirection: 'row', alignItems: 'center', gap: space.xs },
  amount: {
    borderRadius: radius.sm + 2,
    paddingHorizontal: space.sm + 2,
    paddingVertical: space.xs + 2,
  },
  // Chevron: the corner of a rotated box.
  chevron: {
    width: 8,
    height: 8,
    borderRightWidth: 2.5,
    borderTopWidth: 2.5,
    transform: [{ rotate: '45deg' }],
  },
  body: { fontSize: font.body },
  small: { fontSize: font.small },
  modalRoot: { flex: 1 },
  modalContent: {
    padding: space.lg,
    // Android (edge-to-edge): keep clear of the status bar; `currentHeight` is undefined on iOS,
    // where the page sheet and contentInsetAdjustmentBehavior handle the safe area.
    paddingTop: space.lg + (StatusBar.currentHeight ?? 0),
    paddingBottom: space.xxl * 2,
    gap: space.lg,
  },
});
