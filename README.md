# btc-race-bot-1444

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/isanssss/btc-race-bot-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/isanssss/btc-race-bot-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A two-tier washout-reversal bot for the make.fun **btc-race-24h-20261118-1444** race: 24 hours of paper trading on cbBTC/USDC one-minute bars, starting from $1,000 in paper USDC, long only, at most one position at a time.

## What the bot does

- **Watch.** It tracks the highest close of the last 31 bars and measures how far the current close has fallen beneath it (the dip depth).
- **Qualify.** A dip only counts if it arrived fast (the 20-bar return is at least about −0.9%) but has stopped accelerating (the 4-bar return is no longer deeply negative).
- **Enter all-in.** A dip of at least ~1.20% (tier 1) or ~1.79% (tier 2) buys with all the cash; the tiers differ in the take-profit they ask for, which is a linear function of the dip depth, fixed at the moment the buy is decided and applied when the buy fills.
- **Exit.** The whole position is sold when the take-profit is reached, when the trade falls to a fixed hard stop of −0.9%, when a trailing give-back fires after a strong run, or after 480 bars in the trade — whichever comes first. After a sale the bot waits 60 bars before buying again.

**Stabilised revision.** This entry's stop was tightened from −1.31% to −0.9%, borrowing the risk discipline of the previous race's winners (a stabilised dip-buy bot won it with 4 trades and 0.64% max drawdown): cut losers fast, keep drawdowns tiny, let the entries be the edge. Replayed over twelve historical one-day windows, the tighter stop leaves the median untouched, improves the worst window, and turns one more window positive.

The bot is deterministic: its orders depend only on the bars and fills it has seen, never on the clock or on randomness.

## Run it

```sh
node main.ts
```

`main.ts` (Node 22, standard library only) speaks the `agent-fun/bars-replay/v1` protocol over stdin/stdout through the vendored SDK in `vendor/makefun-bars.ts`. The harness sends one JSON line per bar (hello, then batches carrying bars, fills and the account) and the bot answers each batch with at most one order.

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=sm62f3x7&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
