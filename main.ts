// Washout-reversal bot for the btc-race-24h-20261118-1444 replay.
//
// Idea in one paragraph: cbBTC trades in one-minute bars and the account is
// long-only paper money, so the bot waits for a fast, deep sell-off, checks
// that the fall has stopped accelerating, and buys the dip in one of two
// sizes. Shallow washouts (about 1.2% under the recent peak) get half the
// cash; deeper ones (about 1.8% under) get all of it. The deeper the dip,
// the smaller the bounce the bot asks for before taking profit, because the
// take-profit fraction is a linear function of the dip depth recorded at
// entry time. While holding, the position is closed by whichever comes
// first: the take-profit, a fixed stop, a trailing give-back once the trade
// is well in profit, or a hard cap on how many bars a trade may last. After
// any sale the bot sits out for a fixed cooldown before it may buy again.
//
// Everything below is a pure function of the bars and fills seen so far:
// no clock, no randomness, no environment reads, so two runs over the same
// replay produce the same orders.
//
// Tuning note: every threshold below was picked by replaying this exact
// logic against the competition's published dev window plus ten other
// 24-hour windows of the same pool's real one-minute history, and keeping
// the parameter set whose median window stayed positive while its worst
// window stayed near break-even. The numbers are deliberately not the
// sharpest peak of that search: each one was checked to sit on a plateau,
// so a race window that merely resembles the tuning windows, rather than
// repeating one, still trades the same way. The two dip tiers, the speed
// gate and the stall gate all have to agree before any cash is committed,
// which is why the bot trades rarely and keeps its drawdown small.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const SLIPPAGE_BPS = 1000;

// Entry geometry. The "peak" is the highest close of the last 31 bars and
// the dip depth is how far the current close sits under it.
const PEAK_SPAN = 30; // peak window is closes[i - 30 .. i], inclusive
const SPEED_SPAN = 20; // the fall must be fast over this many bars
const SPEED_LIMIT = -0.00902; // 20-bar return must be at or below this
const STALL_SPAN = 4; // ... but no longer accelerating over this window
const STALL_LIMIT = -0.002499; // 4-bar return below this means still falling
const SHALLOW_DEPTH = 0.012031; // tier 1: at least this deep
const DEEP_DEPTH = 0.017852; // tier 2: at least this deep
const SHALLOW_FRACTION = 0.5; // tier 1 spends half the cash
const DEEP_FRACTION = 1; // tier 2 spends all of it
const SHALLOW_TP_BASE = 0.009169;
const SHALLOW_TP_SLOPE = 0.390676;
const DEEP_TP_BASE = 0.007985;
const DEEP_TP_SLOPE = 0.603444;

// Exit geometry, all fractions of the entry price unless noted.
const STOP_GAIN = -0.013109; // cut the trade at this loss
const LAST_BAR_IN = 480; // never hold longer than this many bars
const TRAIL_ARM_GAIN = 0.018842; // trailing exit arms at this gain
const TRAIL_DROP = 0.005514; // ... and fires this far under the peak close
const COOLDOWN_BARS = 60; // bars to sit out after a sale

// Replay history: one entry per batch that carried a CBBTC bar, warm-up
// batches included. The index i used by every rule is closes.length - 1.
const closes: number[] = [];

// Position bookkeeping, rebuilt from fills as they arrive.
let entryPrice: number | null = null; // executed price of the open trade
let barsIn = 0; // batches survived since the buy fill
let peakSinceEntry = 0; // highest close seen while holding
let pendingTp: number | null = null; // take-profit chosen at buy-decision time
let activeTp: number | null = null; // take-profit in force for the open trade
let cooldownUntil = -1; // no new entry while i <= cooldownUntil

function priceScale(state: BarsState): number {
  return state.symbols.get(SYMBOL)?.price_scale ?? 5;
}

/** Fold one batch's fills into the position bookkeeping. */
function absorbFills(state: BarsState, batch: Batch, i: number, lastClose: number | null): void {
  const scale = 10 ** priceScale(state);
  for (const fill of batch.fills) {
    if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
    if (fill.side === 'buy') {
      entryPrice = Number(fill.price) / scale;
      barsIn = 0;
      peakSinceEntry = lastClose ?? entryPrice;
      if (pendingTp !== null) {
        activeTp = pendingTp;
        pendingTp = null;
      }
    } else {
      cooldownUntil = i + COOLDOWN_BARS;
      entryPrice = null;
      activeTp = null;
      barsIn = 0;
      peakSinceEntry = 0;
    }
  }
}

/** The exit test for an open trade, evaluated on the current close. */
function shouldExit(close: number): boolean {
  if (entryPrice === null || activeTp === null) return false;
  const gain = close / entryPrice - 1;
  if (gain >= activeTp) return true;
  if (gain <= STOP_GAIN) return true;
  if (barsIn >= LAST_BAR_IN) return true;
  return gain >= TRAIL_ARM_GAIN && close <= peakSinceEntry * (1 - TRAIL_DROP);
}

/** The entry test for a flat account; returns the order to send, if any. */
function planEntry(state: BarsState, i: number, close: number): OrderInput | null {
  if (i < PEAK_SPAN || i <= cooldownUntil) return null;

  let peak = 0;
  for (let k = i - PEAK_SPAN; k <= i; k++) if (closes[k]! > peak) peak = closes[k]!;
  const depth = -(close / peak - 1);
  if (depth < SHALLOW_DEPTH) return null;

  // The dip must have arrived quickly, yet no longer be in free fall.
  if (closes[i]! / closes[i - SPEED_SPAN]! - 1 > SPEED_LIMIT) return null;
  if (closes[i]! / closes[i - STALL_SPAN]! - 1 < STALL_LIMIT) return null;

  // The deeper tier wins when both qualify.
  let fraction: number;
  let tp: number;
  if (depth >= DEEP_DEPTH) {
    fraction = DEEP_FRACTION;
    tp = DEEP_TP_BASE + DEEP_TP_SLOPE * depth;
  } else {
    fraction = SHALLOW_FRACTION;
    tp = SHALLOW_TP_BASE + SHALLOW_TP_SLOPE * depth;
  }

  const notional = fraction === 1 ? state.cash : state.cash / 2n;
  if (notional <= 0n) return null;
  pendingTp = tp;
  return { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: SLIPPAGE_BPS };
}

await runBars({
  onBatch(state, batch) {
    // Record this batch's close first; every index below counts it.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) closes.push(Number(bar.c) / 10 ** priceScale(state));
    const i = closes.length - 1;
    const close = i >= 0 ? closes[i]! : null;

    absorbFills(state, batch, i, close);

    if (state.warmingUp || bar === undefined || close === null) return [];

    const held = state.positions.get(SYMBOL);
    if (held !== undefined && held.qty > 0n) {
      barsIn += 1;
      if (close > peakSinceEntry) peakSinceEntry = close;
      if (!shouldExit(close)) return [];
      return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: SLIPPAGE_BPS }];
    }

    const entry = planEntry(state, i, close);
    return entry === null ? [] : [entry];
  },
});
