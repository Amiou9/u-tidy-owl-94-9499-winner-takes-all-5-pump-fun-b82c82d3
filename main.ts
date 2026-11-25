// Momentum scalper bot for the pump.fun replay sprint.
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and
// the wire shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte in
// vendor/makefun-bot.ts. Every decision is a pure function of the hello,
// batch and orders the harness sends, slot by slot — no clock, no randomness,
// no network — so the two graded executions agree byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
