// Washout Reversal — Stabilised
//
// A dip buyer for cbBTC that only spends its cash after a genuine washout:
// price must be sitting well below its recent peak, the fall must have been
// fast, and — crucially — the fall must have stopped accelerating before
// this bot buys. Two depth tiers qualify: a shallower washout buys with a
// modest bounce target, a deeper capitulation buys with a target that grows
// faster with depth, because the hardest sell-offs tend to snap back hardest.
//
// The exits borrow their discipline from the bots that won past races with
// tiny drawdowns: winners cut losers fast instead of averaging down or
// holding and hoping. So alongside the take-profit, the trailing exit and a
// maximum hold, this revision carries a hard stop at -0.9% — a washout that
// keeps washing out is abandoned quickly and cheaply, and the bot waits out
// a cooldown in cash for the next real setup.
//
// Tuning note (parent review, 2026-11-18): the -0.9% stop was chosen by
// replaying this exact entry logic over twelve historical one-day windows
// (two make.fun dev windows and ten recent GeckoTerminal days for this
// pool). Against the looser -1.31% stop it changed nothing on the median
// window, lifted the worst window from -18.7 to -16.2, and turned one more
// window positive — the entries are the edge, the stop is the insurance.

import { runBars } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const SLIPPAGE_BPS = 1000;

// How far back the reference peak looks: the highest of the last 31 closes.
const PEAK_WINDOW = 30;

// Entry tiers. The deepest tier whose dip threshold is met wins; both tiers
// commit all of the cash, only the take-profit shape differs.
const TIER1_DIP = 0.012031;
const TIER1_TP_BASE = 0.009169;
const TIER1_TP_PER_DEPTH = 0.390676;
const TIER2_DIP = 0.017852;
const TIER2_TP_BASE = 0.007985;
const TIER2_TP_PER_DEPTH = 0.603444;

// Entry gates, judged on the decision bar's close.
const SPEED_WINDOW = 20;
const SPEED_DROP = 0.009020; // 20-bar return must be at or under -0.9020%
const STALL_WINDOW = 4;
const STALL_DROP = 0.002499; // skip while the 4-bar return is under -0.2499%

// Exit rules.
const HARD_STOP = 0.009; // the stabilised cut: out at -0.9%
const MAX_HOLD_BARS = 480;
const TRAIL_ARM = 0.018842; // trailing exit arms at +1.8842%
const TRAIL_GIVEBACK = 0.005514; // ... and fires 0.5514% under the peak close

// Bars of rest after a sell fill before the next entry is allowed.
const COOLDOWN_BARS = 60;

// Fallback take-profit if a position ever has to be adopted from the account
// alone (a fill report lost in transit): the shallow tier's base target.
const FALLBACK_TP = TIER1_TP_BASE;

// Every close seen for the symbol, oldest first, as plain numbers in raw
// price units. All strategy math is ratios of closes, so the price scale
// cancels and floats are exact enough.
const closes: number[] = [];

interface OpenPosition {
  entryPrice: number; // actual fill price, raw units
  takeProfit: number; // fraction over the entry price, fixed at entry
  peakClose: number; // highest close since the fill
  fillBar: number; // seq of the bar the buy filled on
}

let position: OpenPosition | null = null;
let pendingBuy: { clientId: string; tp: number; decidedBar: number } | null = null;
let pendingSell: { clientId: string; decidedBar: number } | null = null;
let cooldownUntil = -1; // entries blocked while the bar index is <= this

// Fold one batch's fill reports into the book. Fills are the ground truth
// for what the position is; the account cross-check afterwards only mops up
// if a report somehow never arrived.
function settleFills(state, batch): void {
  for (const fill of batch.fills) {
    if (fill.symbol !== SYMBOL) continue;
    if (fill.status === 'rejected') {
      if (pendingBuy !== null && fill.client_id === pendingBuy.clientId) pendingBuy = null;
      if (pendingSell !== null && fill.client_id === pendingSell.clientId) pendingSell = null;
      continue;
    }
    if (fill.side === 'buy') {
      position = {
        entryPrice: Number(fill.price),
        takeProfit: pendingBuy !== null ? pendingBuy.tp : FALLBACK_TP,
        peakClose: closes.length > 0 ? closes[closes.length - 1] : Number(fill.price),
        fillBar: fill.fill_bar,
      };
      pendingBuy = null;
    } else {
      position = null;
      pendingSell = null;
      cooldownUntil = fill.fill_bar + COOLDOWN_BARS;
    }
  }
}

// Cross-check the book against the account the harness reports, so a missed
// fill report can never freeze the bot: adopt a position it holds that the
// book missed (entry price derived from its recorded cost), and drop a book
// position the account no longer holds.
function resyncWithAccount(state): void {
  const held = state.positions.get(SYMBOL);
  const heldQty = held !== undefined ? held.qty : 0n;

  if (heldQty > 0n && position === null && pendingBuy === null) {
    const meta = state.symbols.get(SYMBOL);
    let entryPrice = closes.length > 0 ? closes[closes.length - 1] : 0;
    if (held !== undefined && meta !== undefined && held.qty > 0n) {
      // Invert the shim's value(): price = cost * 10^(qty+price scales) / (qty * 10^quote scale).
      const num = held.cost * 10n ** BigInt(meta.qty_scale + meta.price_scale);
      const den = held.qty * 10n ** BigInt(state.hello.capital.quote_scale);
      if (den > 0n) entryPrice = Number(num / den);
    }
    position = {
      entryPrice,
      takeProfit: FALLBACK_TP,
      peakClose: closes.length > 0 ? closes[closes.length - 1] : entryPrice,
      fillBar: state.seq,
    };
  }

  if (heldQty === 0n && position !== null && pendingSell === null) {
    // The position vanished without a sell report (e.g. the harness closed
    // it): treat it as sold now and rest for the usual cooldown.
    position = null;
    cooldownUntil = state.seq + COOLDOWN_BARS;
  }

  // An order decided on an earlier bar whose fill report never came was
  // refused silently; clear the stale intent so decisions can move on.
  if (pendingBuy !== null && state.seq > pendingBuy.decidedBar && position === null && heldQty === 0n) {
    pendingBuy = null;
  }
  if (pendingSell !== null && state.seq > pendingSell.decidedBar && heldQty > 0n) {
    pendingSell = null; // still holding: the exit logic below may fire again
  }
}

await runBars({
  onBatch(state, batch) {
    // 1. History first: this batch's close joins the record before any
    //    decision, so every window below includes the bar being decided on.
    let bar = null;
    for (const b of batch.bars) if (b.symbol === SYMBOL) bar = b;
    if (bar !== null) closes.push(Number(bar.c));
    if (closes.length === 0) return [];
    const i = closes.length - 1;
    const close = closes[i];

    // 2. Settle what filled at this bar's open, then reconcile with the
    //    account. After this the book is trustworthy.
    settleFills(state, batch);
    resyncWithAccount(state);

    // 3. Warm-up bars build history only; the harness refuses their orders.
    if (state.warmingUp) return [];

    // 4. Manage an open position: ride to the take-profit, bail on the hard
    //    stop, trail a strong bounce, and never hold past the time limit.
    if (position !== null) {
      if (close > position.peakClose) position.peakClose = close;
      if (pendingSell !== null) return []; // an exit order is already out
      const gain = close / position.entryPrice - 1;
      const barsHeld = state.seq - position.fillBar + 1;
      const exit =
        gain >= position.takeProfit ||
        gain <= -HARD_STOP ||
        barsHeld >= MAX_HOLD_BARS ||
        (gain >= TRAIL_ARM && close <= position.peakClose * (1 - TRAIL_GIVEBACK));
      if (!exit) return [];
      const held = state.positions.get(SYMBOL);
      if (held === undefined || held.qty <= 0n) return [];
      const clientId = `sell-${state.seq}`;
      pendingSell = { clientId, decidedBar: state.seq };
      return [{ side: 'sell', client_id: clientId, symbol: SYMBOL, qty: held.qty, max_slippage_bps: SLIPPAGE_BPS }];
    }

    // 5. Flat: look for the next washout, if no buy is already out and the
    //    post-sale cooldown has run its course.
    if (pendingBuy !== null) return [];
    if (i < PEAK_WINDOW || i <= cooldownUntil) return [];

    let peak = 0;
    for (let k = i - PEAK_WINDOW; k <= i; k++) if (closes[k] > peak) peak = closes[k];
    if (peak <= 0) return [];
    const dip = close / peak - 1;

    let tp: number | null = null;
    if (dip <= -TIER2_DIP) tp = TIER2_TP_BASE + TIER2_TP_PER_DEPTH * (-dip);
    else if (dip <= -TIER1_DIP) tp = TIER1_TP_BASE + TIER1_TP_PER_DEPTH * (-dip);
    if (tp === null) return [];

    // Speed gate: the dip must have arrived fast, not drifted down.
    if (close / closes[i - SPEED_WINDOW] - 1 > -SPEED_DROP) return [];
    // Stall gate: refuse while the last few bars are still in freefall.
    if (close / closes[i - STALL_WINDOW] - 1 < -STALL_DROP) return [];

    if (state.cash <= 0n) return [];
    const clientId = `buy-${state.seq}`;
    pendingBuy = { clientId, tp, decidedBar: state.seq };
    return [{ side: 'buy', client_id: clientId, symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: SLIPPAGE_BPS }];
  },
});
