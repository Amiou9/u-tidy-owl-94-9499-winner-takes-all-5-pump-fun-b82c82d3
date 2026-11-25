// Momentum scalper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea, in one paragraph: most new pump.fun coins dump toward zero, a few run
// several times up. So this bot never bets big on one coin and never holds long.
// It buys a small stake in a coin only after the tape already shows real buyers
// pushing the price up from its launch price, adds once if the rise continues,
// and sells the whole position on the first of a tight stop, a trailing stop
// from its peak, a take-profit, or a short time limit. Losers are cut small and
// fast; winners are allowed to run to the take-profit or the trailing stop.
// With at most five open positions and quick turnover it can trade the twenty
// or more coins the guardrails ask for without ever risking much of the 10 SOL
// on a single curve.
//
// The hello message sets the caps and fees this bot obeys: max five open
// positions, at most sixteen orders in one batch reply, buys capped at 1% of a
// curve's real SOL reserve, and a 2-slot latency between deciding in a batch
// and the fill. Every decision below is a pure function of the batches the
// harness sends — no clock, no randomness, no network — so the two graded
// executions produce byte-identical action logs.

import {
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age, in slots since the CreateEvent, at which a first buy is allowed. */
  minAge: number;
  /** Oldest age, in slots since the CreateEvent, at which a first buy is allowed. */
  maxAge: number;
  /** Minimum price rise from the launch price to consider a coin (fraction). */
  entryUpMin: number;
  /** Maximum price rise from the launch price to consider a coin (fraction). */
  entryUpMax: number;
  /** Minimum distinct non-creator buyers seen before a first buy. */
  minBuyers: number;
  /** Minimum trades seen before a first buy. */
  minTrades: number;
  /** Real SOL reserve window at decision time, in SOL. */
  minRealSol: number;
  maxRealSol: number;
  /** First-buy stake, in SOL. */
  stakeSol: number;
  /** One add-on stake, in SOL, bought only while the price keeps rising. */
  addSol: number;
  /** Price rise above the first buy's price that an add-on needs (fraction). */
  addUp: number;
  /** Stop loss against the first buy's price (fraction below it). */
  stopLoss: number;
  /** Trailing stop below the position's peak price (fraction). */
  trail: number;
  /** Peak must be at least this far above the entry price before trailing arms. */
  trailArm: number;
  /** Take profit above the first buy's price (fraction). */
  takeProfit: number;
  /** Maximum hold, in slots, before the position is sold for time alone. */
  maxHoldSlots: number;
  /** Slots after an exit before the same coin may be entered again. */
  cooldownSlots: number;
  /** Buy slippage allowance, in basis points. */
  buySlipBps: number;
  /** Sell slippage allowance, in basis points. */
  sellSlipBps: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 5,
  maxAge: 1500,
  entryUpMin: 0.05,
  entryUpMax: 2.0,
  minBuyers: 2,
  minTrades: 3,
  minRealSol: 0.3,
  maxRealSol: 80,
  stakeSol: 0.05,
  addSol: 0.05,
  addUp: 0.15,
  stopLoss: 0.1,
  trail: 0.2,
  trailArm: 0.1,
  takeProfit: 1.0,
  maxHoldSlots: 600,
  cooldownSlots: 100,
  buySlipBps: 1500,
  sellSlipBps: 3000,
};

interface Tape {
  createdSlot: number;
  createPrice: number;
  lastPrice: number;
  highPrice: number;
  trades: number;
  buys: number;
  netSol: number;
  buyers: Set<string>;
  creatorBuySol: number;
  creatorSellSol: number;
  entries: number;
  coolUntil: number;
  lastSeenSlot: number;
}

interface Held {
  entryPrice: number;
  peakPrice: number;
  entrySlot: number;
  adds: number;
  costLamports: bigint;
  /** A sell for this position is in flight; do not send another until it resolves. */
  exiting: boolean;
}

const SOL = 1_000_000_000;
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: the guardrail's minimum round trip

function priceOf(curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): number {
  const vt = curve.virtual_token_reserves;
  if (vt <= 0n) return 0;
  return Number(curve.virtual_quote_reserves) / Number(vt);
}

/** Diagnostic counters for local tuning only: how many coins the entry loop
 * looked at and why each was passed over. Read by the backtest runner. */
export const DIAG: { checks: number; byReason: Record<string, number> } = {
  checks: 0,
  byReason: {},
};

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();

  function tapeOf(mint: Pubkey): Tape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        createdSlot: -1,
        createPrice: 0,
        lastPrice: 0,
        highPrice: 0,
        trades: 0,
        buys: 0,
        netSol: 0,
        buyers: new Set<string>(),
        creatorBuySol: 0,
        creatorSellSol: 0,
        entries: 0,
        coolUntil: -1,
        lastSeenSlot: -1,
      };
      tapes.set(mint, t);
    }
    return t;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const caps = state.hello.caps;
      const txFee = state.txFeeLamports();
      const slot = batch.slot;

      // Resolve last batch's fills first: a rejected or failed sell means the
      // position is still held and must be exited again, and a rejected or
      // failed buy means no position exists, so its held record must go or
      // the coin could never be entered again.
      for (const f of batch.fills) {
        if (f.status === 'rejected' || f.status === 'failed') {
          const h = held.get(f.mint);
          if (h !== undefined) {
            if (f.side === 'sell') h.exiting = false;
            else held.delete(f.mint);
          }
        }
      }

      // Fold this batch's events into the per-coin tapes.
      for (const e of batch.events) {
        const tape = tapeOf(e.mint);
        tape.lastSeenSlot = slot;
        if (e.event === 'CreateEvent') {
          tape.createdSlot = e.slot;
          const curve = state.curves.get(e.mint);
          if (curve !== undefined) {
            tape.createPrice = priceOf(curve);
            tape.lastPrice = tape.createPrice;
            tape.highPrice = tape.createPrice;
          }
        } else if (e.event === 'TradeEvent') {
          const curve = state.curves.get(e.mint);
          if (curve !== undefined) {
            const price = priceOf(curve);
            tape.lastPrice = price;
            if (price > tape.highPrice) tape.highPrice = price;
          }
          tape.trades += 1;
          const sol = Number(BigInt(e.sol_amount)) / SOL;
          if (e.is_buy) {
            tape.buys += 1;
            tape.netSol += sol;
            if (e.user !== e.creator) tape.buyers.add(e.user);
            else tape.creatorBuySol += sol;
          } else {
            tape.netSol -= sol;
            if (e.user === e.creator) tape.creatorSellSol += sol;
          }
        } else {
          // CompleteEvent: the curve is done; forget its tape once the harness
          // has closed any position in it.
          tapes.delete(e.mint);
        }
      }

      // Refresh held positions from the account the harness reports, and drop
      // any the harness already closed (complete / flatten / write-off).
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint)) held.delete(mint);
      }
      for (const [mint, pos] of state.positions) {
        const h = held.get(mint);
        if (h !== undefined) {
          h.costLamports = pos.cost_lamports;
          const curve = state.curves.get(mint);
          if (curve !== undefined) {
            const price = priceOf(curve);
            if (price > h.peakPrice) h.peakPrice = price;
          }
        }
      }

      // Exits first: a position is sold whole on the first exit rule that fires.
      for (const [mint, pos] of state.positions) {
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const h = held.get(mint);
        if (h === undefined) continue;
        const price = priceOf(curve);
        if (price <= 0 || h.entryPrice <= 0) continue;
        if (h.exiting) continue;
        const age = slot - h.entrySlot;
        const downFromEntry = price / h.entryPrice - 1;
        const downFromPeak = price / h.peakPrice - 1;
        const exit =
          downFromEntry <= -p.stopLoss ||
          (h.peakPrice >= h.entryPrice * (1 + p.trailArm) && downFromPeak <= -p.trail) ||
          downFromEntry >= p.takeProfit ||
          age >= p.maxHoldSlots;
        if (exit && orders.length < caps.max_orders_per_batch) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
          // Keep the held record until the position actually leaves the
          // account: deleting it here would orphan the position if this
          // sell is rejected, and it would then sit in all five open
          // slots until the replay flattens it at the end.
          h.exiting = true;
          const tape = tapes.get(mint);
          if (tape !== undefined) tape.coolUntil = slot + p.cooldownSlots;
        }
      }

      // Add-ons: one extra stake into a held coin that keeps rising on inflow.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= caps.max_orders_per_batch) break;
        const h = held.get(mint);
        const tape = tapes.get(mint);
        const curve = state.curves.get(mint);
        if (h === undefined || tape === undefined || curve === undefined || curve.complete) continue;
        if (h.adds >= 1) continue;
        const price = priceOf(curve);
        if (price < h.entryPrice * (1 + p.addUp)) continue;
        if (tape.netSol <= 0) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_BUY_LAMPORTS) continue;
        let amount = BigInt(Math.round(p.addSol * SOL));
        if (amount > cap) amount = cap;
        if (amount < MIN_BUY_LAMPORTS) continue;
        const free = state.freeCashLamports() - BigInt(orders.length) * txFee;
        let reserved = 0n;
        for (const o of orders) if (o.side === 'buy') reserved += BigInt(o.quote_lamports) + txFee;
        if (free - reserved < amount + txFee) continue;
        if (state.committedPositionCount() > caps.max_open_positions) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        h.adds += 1;
        void pos;
      }

      // Entries: new coins, in the batch's own event order, while slots remain.
      let free = state.freeCashLamports();
      for (const o of orders) {
        free -= txFee;
        if (o.side === 'buy') free -= BigInt(o.quote_lamports);
      }
      let openSlots = caps.max_open_positions - state.committedPositionCount();
      for (const e of batch.events) {
        if (orders.length >= caps.max_orders_per_batch || openSlots <= 0) break;
        if (e.event === 'CompleteEvent') continue;
        const mint = e.mint;
        if (state.positions.has(mint) || held.has(mint)) continue;
        const tape = tapes.get(mint);
        const curve = state.curves.get(mint);
        DIAG.checks += 1;
        const pass = (reason: string): boolean => {
          DIAG.byReason[reason] = (DIAG.byReason[reason] ?? 0) + 1;
          return false;
        };
        let ok = true;
        if (tape === undefined || curve === undefined || curve.complete) ok = pass('no-tape-or-complete');
        else if (tape.createdSlot < 0 || tape.createPrice <= 0) ok = pass('no-create-price');
        else {
          const age = slot - tape.createdSlot;
          if (age < p.minAge || age > p.maxAge) ok = pass('age');
          else if (slot < tape.coolUntil) ok = pass('cooldown');
          else if (tape.trades < p.minTrades || tape.buyers.size < p.minBuyers) ok = pass('tape-thin');
          else if (tape.netSol <= 0) ok = pass('net-flow');
          else {
            // Creator-dump filter: skip only when the creator's own buys
            // dominate inflow almost entirely, or the creator has already
            // sold a meaningful amount. Small creator sells are normal on
            // these curves and, on the dev window, filtering every coin
            // whose creator ever sold leaves almost nothing tradeable.
            const inflow = tape.creatorBuySol + Math.max(0, tape.netSol);
            if (tape.creatorBuySol > 0.8 * Math.max(inflow, 1e-9)) ok = pass('creator-buys');
            else if (tape.creatorSellSol > 0.2) ok = pass('creator-sells');
          }
        }
        if (!ok) continue;
        const price = priceOf(curve!);
        if (price <= 0) {
          pass('no-price');
          continue;
        }
        const up = price / tape!.createPrice - 1;
        if (up < p.entryUpMin || up > p.entryUpMax) {
          pass('price-up');
          continue;
        }
        const realSol = Number(curve!.real_quote_reserves) / SOL;
        if (realSol < p.minRealSol || realSol > p.maxRealSol) {
          pass('real-sol');
          continue;
        }
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_BUY_LAMPORTS) {
          pass('size-cap');
          continue;
        }
        let amount = BigInt(Math.round(p.stakeSol * SOL));
        if (amount > cap) amount = cap;
        if (amount < MIN_BUY_LAMPORTS) continue;
        if (free < amount + txFee) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        free -= amount + txFee;
        openSlots -= 1;
        tape.entries += 1;
        held.set(mint, {
          entryPrice: price,
          peakPrice: price,
          entrySlot: slot,
          adds: 0,
          costLamports: amount,
          exiting: false,
        });
      }

      return orders;
    },
  };
}
