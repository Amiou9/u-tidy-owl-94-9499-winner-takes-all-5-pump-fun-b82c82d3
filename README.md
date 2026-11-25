[![make.fun · u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![rank](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/Amiou9/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/rank.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![reward](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/Amiou9/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/reward.svg)](https://make.fun/bounty/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3?utm_source=github&utm_medium=readme&utm_campaign=u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)

# Pump.fun Replay Momentum Scalper

A trading bot for the make.fun bounty "Winner Takes All — $5 Pump.fun Replay Sprint". It trades 10 SOL of paper money on a 6-hour pump.fun replay; the bot with the best net PnL after fees wins the whole pot.

## Strategy

Most new pump.fun coins dump toward zero and a few run several times up, so the bot never bets big on one coin and never holds long:

- **Entry:** a coin qualifies only after its tape already shows real buyers pushing the price up from its launch price (5–200% up), with at least 2 distinct non-creator buyers, net SOL inflow, and a real SOL reserve of 0.3–80 SOL. A creator-dump filter skips coins whose creator dominates the inflow or has already sold a meaningful amount.
- **Size:** first buy 0.05 SOL (capped at 1% of the curve's real SOL reserve, the harness cap), one 0.05 SOL add-on only while the price keeps rising.
- **Exits:** the whole position is sold on the first of a 10% stop loss against the entry price, a 20% trailing stop from the peak (armed after +10%), a 100% take-profit, or a 600-slot time limit. At most 5 open positions.
- **Risk:** per-round-trip fees are about 3% of the stake, so losers are cut small and fast while winners are allowed to run. The bot aims for the 20+ distinct-coin round trips the guardrails require, with max drawdown far under the 50% cap.

## How it runs

`main.ts` is Node 22 TypeScript with no dependencies, run by the grader as `node /bot/main.ts`. The strategy lives in `strategy.ts`; the wire shim is the kit's `sdk/ts/makefun-bot.ts`, vendored byte for byte in `vendor/makefun-bot.ts`. It speaks the `agent-fun/replay/v2` protocol on stdin/stdout: one `hello` message, then one reply per `batch` (the orders decided on that slot), then `done`. Every decision is a pure function of the batches the harness sends — no clock, no randomness, no network, no hardcoded pool address, mint, or token — so the two graded executions produce byte-identical action logs.

Local grading (process driver; Docker is not available on this machine):

```
node cli/makefun.mjs grade-local --kit <kit> --bot <this repo> --driver process
```
