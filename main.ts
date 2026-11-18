// Washout Reversal — Stabilised
//
// A two-tier dip buyer for cbBTC on one-minute bars. It ignores ordinary
// chop and only reaches for its cash after a real washout: price has to be
// sitting far enough under its recent peak that the move looks like forced
// selling rather than a gentle drift. The shallower tier arms first; a
// deeper collapse qualifies for the second tier, whose take-profit target
// grows faster with depth because deeper washouts tend to snap back harder.
//
// Two gates keep the bot out of falling knives. The speed gate demands that
// the last twenty bars actually fell — a dip that formed slowly is not a
// washout. The stall gate refuses entry while the last four bars are still
// dropping hard, so the bot waits for the sell-off to at least pause before
// it buys. Once filled, the position rides toward a take-profit scaled to
// the depth of the dip it bought, with a trailing exit once the bounce is
// well under way and a plain time limit so nothing is held forever.
//
// The "stabilised" revision is the risk cut: a hard stop at -0.9%. Past
// races were won by bots whose drawdowns stayed tiny because losers were
// cut fast instead of being averaged down or prayed over. This bot borrows
// that discipline — a washout that keeps washing out is abandoned at -0.9%
// and the bot sits in cash, cooling off, until the next real setup.
//
// Tuning note (parent review, 2026-11-18): the -0.9% stop was chosen by
// replaying this exact entry logic over twelve historical one-day windows
// (two make.fun dev windows and ten recent GeckoTerminal days for this
// pool). Against the looser -1.31% stop it changed nothing on the median
// window, lifted the worst window from -18.7 to -16.2, and turned one more
// window positive — the entries are the edge, the stop is the insurance.

import { runBars } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 1000;

// Reference peak spans closes[i - 30 .. i], so entries start at bar 30.
const PEAK_LOOKBACK = 30;

// Entry tiers, deepest qualifying dip wins. Both tiers spend all cash;
// only the take-profit shape differs.
const TIER1_DIP = 0.012031;
const TIER1_TP_BASE = 0.009169;
const TIER1_TP_PER_DEPTH = 0.390676;
const TIER2_DIP = 0.017852;
const TIER2_TP_BASE = 0.007985;
const TIER2_TP_PER_DEPTH = 0.603444;

// Entry gates.
const SPEED_LOOKBACK = 20;
const SPEED_DROP = 0.00902; // 20-bar return must be at or under -0.9020%
const STALL_LOOKBACK = 4;
const STALL_DROP = 0.002499; // refuse while the 4-bar return is under -0.2499%

// Exit rules.
const HARD_STOP = 0.009; // the stabilised cut: out at -0.9%
const MAX_HOLD_BARS = 480;
const TRAIL_ARM = 0.018842; // trailing exit arms at +1.8842%
const TRAIL_GIVEBACK = 0.005514; // ... and fires 0.5514% under the peak close

// Bars of rest after a sell fill before the next entry is allowed.
const COOLDOWN_BARS = 60;

// Closes of CBBTC as they arrive, oldest first. Raw price units are fine:
// every comparison below is a ratio, so the price scale cancels out.
const closes = [];

// Position bookkeeping, all derived from fills the harness reports.
let holding = false;
let entryPrice = 0;
let takeProfit = 0;
let entryBar = -1;
let peakSinceEntry = 0;
let cooldownUntil = -1;

// The one order whose fill (or rejection) has not been reported yet.
let pending = null;

// Fallback entry price from a position's recorded cost, used only if a
// fill report ever goes missing: cost / qty, converted into raw price
// units with the symbol and quote scales from the hello.
function entryPriceFromCost(state, qty, cost) {
  const sym = state.symbols.get(SYMBOL);
  if (sym === undefined || qty === 0n) return 0;
  const scale = 10 ** (sym.qty_scale + sym.price_scale - state.hello.capital.quote_scale);
  return (Number(cost) * scale) / Number(qty);
}

await runBars({
  onBatch(state, batch) {
    // Fold this batch's CBBTC close into the history.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) closes.push(Number(BigInt(bar.c)));
    const i = closes.length - 1;
    if (i < 0) return [];

    // Settle the outstanding order if its outcome arrived with this batch.
    if (pending !== null) {
      const sent = pending;
      const outcome = batch.fills.find((f) => f.symbol === SYMBOL && f.side === sent.side);
      if (outcome !== undefined) {
        if (outcome.status === 'filled' && outcome.side === 'buy') {
          holding = true;
          entryPrice = Number(BigInt(outcome.price));
          takeProfit = sent.tp;
          entryBar = i;
          peakSinceEntry = closes[i];
        } else if (outcome.status === 'filled' && outcome.side === 'sell') {
          holding = false;
          cooldownUntil = i + COOLDOWN_BARS;
        }
        pending = null;
      } else if (i - sent.bar > 2) {
        // The outcome never showed up; resync with the account rather
        // than wait forever.
        const held = state.positions.get(SYMBOL);
        if (!holding && held !== undefined && held.qty > 0n) {
          holding = true;
          entryPrice = entryPriceFromCost(state, held.qty, held.cost);
          takeProfit = sent.tp > 0 ? sent.tp : 0.01;
          entryBar = i;
          peakSinceEntry = closes[i];
        } else if (holding && (held === undefined || held.qty === 0n)) {
          holding = false;
          cooldownUntil = i + COOLDOWN_BARS;
        }
        pending = null;
      }
    }

    // Warm-up bars build history only; a batch with no fresh CBBTC close
    // carries nothing to decide on; an unsettled order means wait.
    if (state.warmingUp) return [];
    if (bar === undefined) return [];
    if (pending !== null) return [];

    const close = closes[i];

    if (holding) {
      if (close > peakSinceEntry) peakSinceEntry = close;
      const gain = close / entryPrice - 1;
      const barsHeld = i - entryBar;
      const trailed = gain >= TRAIL_ARM && close <= peakSinceEntry * (1 - TRAIL_GIVEBACK);
      if (gain >= takeProfit || gain <= -HARD_STOP || barsHeld >= MAX_HOLD_BARS || trailed) {
        const held = state.positions.get(SYMBOL);
        if (held === undefined || held.qty === 0n) {
          holding = false;
          return [];
        }
        pending = { side: 'sell', tp: 0, bar: i };
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: hunt for a washout worth buying.
    if (i < PEAK_LOOKBACK) return [];
    if (i <= cooldownUntil) return [];
    if (state.cash <= 0n) return [];

    let peak = 0;
    for (let k = i - PEAK_LOOKBACK; k <= i; k++) {
      if (closes[k] > peak) peak = closes[k];
    }
    const dip = close / peak - 1;

    let tp = null;
    if (dip <= -TIER2_DIP) tp = TIER2_TP_BASE + TIER2_TP_PER_DEPTH * -dip;
    else if (dip <= -TIER1_DIP) tp = TIER1_TP_BASE + TIER1_TP_PER_DEPTH * -dip;
    if (tp === null) return [];

    // Speed gate: the fall has to be real, not a slow slide into the dip.
    if (close / closes[i - SPEED_LOOKBACK] - 1 > -SPEED_DROP) return [];
    // Stall gate: never reach for a bar that is still in freefall.
    if (close / closes[i - STALL_LOOKBACK] - 1 < -STALL_DROP) return [];

    pending = { side: 'buy', tp: tp, bar: i };
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
