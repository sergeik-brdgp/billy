// "Details" card body: a receipt for one recurring charge (the familiar "payment receipt" layout:
// merchant, big amount, a row of key facts), torn along a perforation from the stub below it with
// the raw server record. Billy peeks over the top edge. Read-only: there is no subscription
// management here (TZ), so the card has no actions besides Close.

import { StyleSheet, Text, View } from 'react-native';

import { DETAILS_COPY } from '../copy';
import { useType } from '../fonts';
import { DISPLAY_MAX_SCALE, LIP, font, radius, space, TITLE_MAX_SCALE, useTheme } from '../theme';
import type { ReceiptModel } from '../viewModel';
import { Mascot } from './Mascot';
import { Badge, useStacked } from './parts';

const MASCOT_SCALE = 0.7;
/** How much of Billy hides behind the receipt (the body; the face stays above the edge). */
const MASCOT_TUCK = 36;
const NOTCH = 22;
const DASHES = 16;

/** `19.99 AUD` → big number + unit. */
function splitAmount(amount: string): { readonly value: string; readonly unit: string } {
  const gap = amount.indexOf(' ');
  return gap < 0
    ? { value: amount, unit: '' }
    : { value: amount.slice(0, gap), unit: amount.slice(gap) };
}

export function Receipt({ receipt }: { readonly receipt: ReceiptModel }) {
  const { color } = useTheme();
  const type = useType();
  const stacked = useStacked();
  const amount = splitAmount(receipt.amount);
  const avatar = receipt.position % color.avatarSurface.length;
  return (
    <View testID="receipt">
      <View style={styles.mascot}>
        <Mascot mood="happy" scale={MASCOT_SCALE} />
      </View>
      <View
        style={[
          styles.paper,
          { backgroundColor: color.surface, borderColor: color.border, marginTop: -MASCOT_TUCK },
        ]}
      >
        <View style={styles.head}>
          <View style={[styles.headRow, stacked && styles.column]}>
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={[styles.avatar, { backgroundColor: color.avatarSurface[avatar] }]}
            >
              <Text style={[styles.avatarText, type.black, { color: color.avatarText[avatar] }]}>
                {receipt.merchant.slice(0, 1).toUpperCase()}
              </Text>
            </View>
            <View style={styles.headText}>
              <Text
                accessibilityRole="header"
                maxFontSizeMultiplier={TITLE_MAX_SCALE}
                style={[styles.kicker, type.black, { color: color.textMuted }]}
              >
                {DETAILS_COPY.title}
              </Text>
              {/* Title-sized, like a heading: same 1.5× cap so AX5 does not split the name. */}
              <Text
                selectable
                maxFontSizeMultiplier={TITLE_MAX_SCALE}
                style={[styles.merchant, type.black, { color: color.text }]}
              >
                {receipt.merchant}
              </Text>
            </View>
          </View>
          <Text
            testID="receipt-amount"
            maxFontSizeMultiplier={DISPLAY_MAX_SCALE}
            style={[styles.amount, type.black, { color: color.text }]}
          >
            {amount.value}
            <Text style={[styles.unit, type.heavy, { color: color.textMuted }]}>{amount.unit}</Text>
          </Text>
          <View
            style={[styles.summary, stacked && styles.column, { borderTopColor: color.hairline }]}
          >
            {receipt.summary.map((fact, index) => (
              <View
                key={fact.label}
                accessible
                accessibilityLabel={`${fact.label}: ${fact.value}`}
                style={[
                  styles.summaryCell,
                  !stacked &&
                    index > 0 && [styles.summaryDivider, { borderLeftColor: color.hairline }],
                ]}
              >
                <Text style={[styles.caption, type.black, { color: color.textMuted }]}>
                  {fact.label}
                </Text>
                <Text style={[styles.body, type.heavy, { color: color.text }]}>{fact.value}</Text>
              </View>
            ))}
          </View>
        </View>

        <Perforation />

        <View style={styles.stub}>
          <View style={[styles.stubHead, stacked && styles.column]}>
            <Text
              accessibilityRole="header"
              maxFontSizeMultiplier={TITLE_MAX_SCALE}
              style={[styles.kicker, styles.stubTitle, type.black, { color: color.textMuted }]}
            >
              {DETAILS_COPY.recordHeading}
            </Text>
            <View accessible accessibilityLabel={DETAILS_COPY.statusLabel(receipt.status)}>
              <Badge text={receipt.status} tone="success" />
            </View>
          </View>
          {receipt.record.map((field, index) => (
            <View
              key={field.key}
              accessible
              accessibilityLabel={`${field.label}: ${field.value}`}
              style={[
                styles.recordRow,
                stacked && styles.column,
                index > 0 && { borderTopColor: color.hairline, borderTopWidth: 1 },
              ]}
            >
              <Text style={[styles.small, type.bold, styles.recordKey, { color: color.textMuted }]}>
                {field.key}
              </Text>
              <Text
                selectable
                style={[
                  styles.small,
                  type.heavy,
                  styles.recordValue,
                  !stacked && styles.alignEnd,
                  { color: color.text },
                ]}
              >
                {field.value}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

/** Ticket perforation: two half-circle bites in the edges and a dashed tear line between them. */
function Perforation() {
  const { color } = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.perforation}
    >
      <View
        style={[
          styles.notch,
          styles.notchLeft,
          { backgroundColor: color.background, borderColor: color.border },
        ]}
      />
      <View style={styles.dashes}>
        {Array.from({ length: DASHES }, (_, index) => (
          <View key={index} style={[styles.dash, { backgroundColor: color.border }]} />
        ))}
      </View>
      <View
        style={[
          styles.notch,
          styles.notchRight,
          { backgroundColor: color.background, borderColor: color.border },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  mascot: { alignItems: 'center' },
  paper: {
    borderWidth: 2,
    borderBottomWidth: 2 + LIP.card,
    borderRadius: radius.xl,
    // Clips the outer halves of the perforation notches.
    overflow: 'hidden',
  },
  head: {
    paddingHorizontal: space.lg + 2,
    paddingTop: space.xl,
    paddingBottom: space.lg,
    gap: space.md,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  column: { flexDirection: 'column', alignItems: 'flex-start' },
  headText: { flexShrink: 1, gap: 2 },
  avatar: {
    minWidth: 48,
    minHeight: 48,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: font.title },
  kicker: { fontSize: font.caption, letterSpacing: 0.8, textTransform: 'uppercase' },
  merchant: { fontSize: font.title },
  amount: { fontSize: font.display, letterSpacing: -0.5 },
  unit: { fontSize: font.title, letterSpacing: 0 },
  summary: {
    flexDirection: 'row',
    borderTopWidth: 1,
    paddingTop: space.md,
    gap: space.md,
  },
  summaryCell: { flex: 1, gap: 2 },
  summaryDivider: { borderLeftWidth: 1, paddingLeft: space.md },
  perforation: { height: NOTCH, flexDirection: 'row', alignItems: 'center' },
  notch: {
    position: 'absolute',
    width: NOTCH,
    height: NOTCH,
    borderRadius: NOTCH / 2,
    borderWidth: 2,
  },
  notchLeft: { left: -NOTCH / 2 - 2 },
  notchRight: { right: -NOTCH / 2 - 2 },
  dashes: {
    flex: 1,
    flexDirection: 'row',
    marginHorizontal: NOTCH / 2 + space.sm,
    gap: space.xs + 2,
  },
  dash: { flex: 1, height: 2, borderRadius: 1 },
  stub: {
    paddingHorizontal: space.lg + 2,
    paddingTop: space.md,
    paddingBottom: space.lg,
    gap: space.xs,
  },
  stubHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingBottom: space.xs,
  },
  stubTitle: { flexShrink: 1 },
  recordRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.md,
    paddingVertical: space.sm,
  },
  recordKey: { flexShrink: 0 },
  recordValue: { flex: 1 },
  alignEnd: { textAlign: 'right' },
  caption: { fontSize: font.caption },
  small: { fontSize: font.small },
  body: { fontSize: font.body },
});
