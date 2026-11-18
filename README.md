# BTC Race — Two-Tier Washout-Reversal Bot

Entry for the make.fun competition **btc-race-24h-20261118-1444**: a 24-hour
paper-trading race on cbBTC/USDC one-minute bars, starting from $1,000 in
paper USDC, long only, at most one position at a time.

## What the bot does

The bot trades a two-tier washout-reversal pattern on cbBTC 1-minute bars:

- **Watch.** It tracks the highest close of the last 31 bars and measures how
  far the current close has fallen beneath it (the dip depth).
- **Qualify.** A dip only counts if it arrived fast (the 20-bar return is at
  least about −0.9%) but has stopped accelerating (the 4-bar return is no
  longer deeply negative).
- **Enter.** A dip of at least ~1.20% buys with half the cash (tier 1); a dip
  of at least ~1.79% buys with all of it (tier 2). Each tier's take-profit is
  a linear function of the dip depth, fixed at the moment the buy is decided
  and applied when the buy fills.
- **Exit.** The whole position is sold when the take-profit is reached, when
  the trade falls to a fixed stop (about −1.31%), when a trailing give-back
  fires after a strong run, or after 480 bars in the trade — whichever comes
  first. After a sale the bot waits 60 bars before buying again.

The bot is deterministic: its orders depend only on the bars and fills it has
seen, never on the clock or on randomness.

## How it runs

`main.ts` (Node 22, standard library only) speaks the
`agent-fun/bars-replay/v1` protocol over stdin/stdout through the vendored
SDK in `vendor/makefun-bars.ts`:

```
node main.ts
```

The harness sends one JSON line per bar (hello, then batches carrying bars,
fills and the account) and the bot answers each batch with at most one order.

## License

MIT — see `LICENSE`.
