// backend/routes/generator-care/accounting.js
// Brenda's reconciliation views: transactions by date and the payout
// (bank-settlement) grouping. Read-only against Stripe + the DB.
// Auth (requireAuth + office role) is applied by ./index.js.

const express = require('express');
const { requirePermission } = require('../../middleware/permissions');
const { supabaseAdmin } = require('../../lib/supabase');
const { stripe } = require('../../lib/gcShared');
const { reportError } = require('../../middleware/error-reporter');

const router = express.Router();

// ---- Accounting helpers (shared by the date-range and payout views) ----
// Issuer card authorization (approval) code on a charge — what Brenda reconciles
// against. Only present on the fully-retrieved charge, not always on list results.
function authCodeOf(ch) {
  return (ch && ch.payment_method_details && ch.payment_method_details.card
    && ch.payment_method_details.card.authorization_code) || null;
}
// Best-effort human label for a charge. The payout view doesn't expand the
// invoice object, so a charge tied to an invoice is labeled generically.
function chargeDescription(ch) {
  if (!ch) return 'Card charge';
  if (ch.invoice && typeof ch.invoice === 'object') {
    if (ch.invoice.description) return ch.invoice.description;
    if (ch.invoice.subscription) return 'Subscription renewal';
    return 'Invoice payment';
  }
  if (ch.invoice) return 'Subscription invoice';
  if (ch.description) return ch.description;
  if (ch.metadata && ch.metadata.adhoc_charge_id) return 'Ad-hoc charge';
  return 'Card charge';
}
// Strict YYYY-MM-DD parser for the from/to query params. Returns null for
// anything unparseable — bad format, impossible month/day, a 5-digit year from
// a mistyped date input ("12026") — so callers can answer 400 instead of
// letting a NaN timestamp reach Stripe and bounce back as a 500. The
// round-trip check rejects dates JS would silently roll over (Feb 29 -> Mar 1).
function parseYmdParam(s, timeSuffix) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return null;
  const d = new Date(s + timeSuffix);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  return d;
}

// === ACCOUNTING ENDPOINTS ===

// GET /accounting/transactions?from=YYYY-MM-DD&to=YYYY-MM-DD
// Pulls succeeded charges from Stripe in the date range, joins with our DB
// for customer name + install address, and returns per-charge gross / Stripe fee / net.
router.get('/accounting/transactions', requirePermission('accounting'), async (req, res) => {
  try {
    const today = new Date();
    const defaultFrom = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fromDate = req.query.from ? parseYmdParam(req.query.from, 'T00:00:00Z') : defaultFrom;
    const toDate = req.query.to ? parseYmdParam(req.query.to, 'T23:59:59Z') : today;
    if (!fromDate || !toDate) return res.status(400).json({ error: 'Invalid date range' });
    const fromTs = Math.floor(fromDate.getTime() / 1000);
    const toTs = Math.floor(toDate.getTime() / 1000);

    // Page through all charges in the range
    let allCharges = [];
    let starting_after = undefined;
    let safety = 0;
    do {
      const page = await stripe.charges.list({
        created: { gte: fromTs, lte: toTs },
        limit: 100,
        starting_after,
        expand: ['data.balance_transaction', 'data.invoice']
      });
      allCharges = allCharges.concat(page.data);
      starting_after = page.has_more ? page.data[page.data.length - 1].id : undefined;
      safety++;
      if (safety > 20) break;
    } while (starting_after);

    // Page through refunds in the same range too. Refunds don't change the
    // original charge's amount, so without surfacing them here, money returned to
    // customers (plan/invoice refunds AND ad-hoc refunds) would be invisible in
    // the books — the tab would overstate net revenue.
    let allRefunds = [];
    {
      let after = undefined;
      let guard = 0;
      do {
        const page = await stripe.refunds.list({
          created: { gte: fromTs, lte: toTs },
          limit: 100,
          starting_after: after,
          expand: ['data.balance_transaction', 'data.charge'],
        });
        allRefunds = allRefunds.concat(page.data);
        after = page.has_more ? page.data[page.data.length - 1].id : undefined;
        guard++;
        if (guard > 20) break;
      } while (after);
    }
    // Defensive: keep only refunds actually created in range, in case the list
    // endpoint ignores the created filter.
    allRefunds = allRefunds.filter(r => r.created >= fromTs && r.created <= toTs);

    // Page through standalone Stripe account fees (e.g. Billing "Usage Fee", the
    // 0.7% of subscription invoice volume) in the range. Stripe deducts these
    // straight from our balance — they never appear as charges or refunds — so
    // without them the Net here is short of what actually moves toward payouts,
    // and Brenda's bank deposits won't reconcile. type:'stripe_fee' is exactly
    // these account-level fees; it excludes the per-charge processing fees (which
    // live inside each charge's balance transaction and are already shown in the
    // fee column), so there is no double counting.
    let allFees = [];
    {
      let after = undefined;
      let guard = 0;
      do {
        const page = await stripe.balanceTransactions.list({
          type: 'stripe_fee',
          created: { gte: fromTs, lte: toTs },
          limit: 100,
          starting_after: after,
        });
        allFees = allFees.concat(page.data);
        after = page.has_more ? page.data[page.data.length - 1].id : undefined;
        guard++;
        if (guard > 20) break;
      } while (after);
    }
    // Same client-side date-range defense as refunds.
    allFees = allFees.filter(t => t.created >= fromTs && t.created <= toTs);

    // Look up customer info for all stripe customers in the result set (charges + refunds)
    const refundCustomerIds = allRefunds.map(r => (r.charge && typeof r.charge === 'object') ? r.charge.customer : null);
    const customerIds = [...new Set([...allCharges.map(c => c.customer), ...refundCustomerIds].filter(Boolean))];
    let customerMap = {};
    if (customerIds.length > 0) {
      const { data: subs, error: subErr } = await supabaseAdmin
        .from('generator_subscriptions')
        .select('stripe_customer_id, customer:generator_customers(name, install_address, install_city, install_state, install_zip)')
        .in('stripe_customer_id', customerIds);
      if (subErr) throw subErr;
      (subs || []).forEach(s => {
        if (s.customer) customerMap[s.stripe_customer_id] = s.customer;
      });
    }

    // Issuer card authorization (approval) code — what Brenda reconciles against.
    const authCodeOf = (ch) =>
      (ch && ch.payment_method_details && ch.payment_method_details.card
        && ch.payment_method_details.card.authorization_code) || null;

    // Build chargeId -> auth code. The charge objects from charges.list /
    // refund.charge don't reliably surface payment_method_details.card
    // .authorization_code, so for any charge whose listed object didn't carry it
    // we retrieve the charge (which returns it definitively). Deduped across
    // charges + the originating charges of refunds, and bounded so a huge range
    // can't fan out into unbounded API calls.
    const authByChargeId = {};
    const needRetrieve = new Set();
    const noteCharge = (chargeObj, chargeId) => {
      if (!chargeId) return;
      const fromObj = authCodeOf(chargeObj);
      if (fromObj) authByChargeId[chargeId] = fromObj;
      else if (!(chargeId in authByChargeId)) needRetrieve.add(chargeId);
    };
    allCharges.forEach(c => { if (c.status === 'succeeded') noteCharge(c, c.id); });
    allRefunds.forEach(r => {
      const ch = r.charge && typeof r.charge === 'object' ? r.charge : null;
      noteCharge(ch, ch ? ch.id : (typeof r.charge === 'string' ? r.charge : null));
    });

    const RETRIEVE_CAP = 300;
    const toRetrieve = [...needRetrieve].slice(0, RETRIEVE_CAP);
    if (needRetrieve.size > RETRIEVE_CAP) {
      console.warn(`[accounting] auth-code retrieve capped at ${RETRIEVE_CAP}; ${needRetrieve.size - RETRIEVE_CAP} charges will have no code`);
    }
    await Promise.all(toRetrieve.map(async (id) => {
      try {
        const full = await stripe.charges.retrieve(id);
        const code = authCodeOf(full);
        if (code) authByChargeId[id] = code;
      } catch (e) {
        console.error('[accounting] charge retrieve for auth code failed:', id, e && e.message);
      }
    }));

    const chargeTxns = allCharges
      .filter(c => c.status === 'succeeded')
      .map(c => {
        const bt = c.balance_transaction;
        const cust = customerMap[c.customer] || {};
        const address = [cust.install_address, cust.install_city, cust.install_state, cust.install_zip].filter(Boolean).join(', ');
        let description = '';
        if (c.invoice && typeof c.invoice === 'object') {
          if (c.invoice.description) description = c.invoice.description;
          else if (c.invoice.subscription) description = 'Subscription renewal';
          else description = 'Invoice payment';
        } else if (c.description) {
          description = c.description;
        } else if (c.metadata && c.metadata.adhoc_charge_id) {
          description = 'Ad-hoc charge';
        } else {
          description = 'Card charge';
        }
        return {
          date: new Date(c.created * 1000).toISOString().slice(0, 10),
          customer_name: cust.name || '(unmatched)',
          address,
          description,
          gross_cents: c.amount,
          fee_cents: bt ? bt.fee : 0,
          net_cents: bt ? bt.net : c.amount,
          auth_code: authByChargeId[c.id] || null,
          is_refund: false
        };
      });

    // Refunds as negative entries. Stripe doesn't return the original processing
    // fee on a standard refund (balance_transaction.fee is 0), so net is the
    // negative refund amount — correctly leaving the business out the original fee.
    const refundTxns = allRefunds.map(r => {
      const bt = r.balance_transaction && typeof r.balance_transaction === 'object' ? r.balance_transaction : null;
      const ch = r.charge && typeof r.charge === 'object' ? r.charge : null;
      const custId = ch ? ch.customer : null;
      const cust = customerMap[custId] || {};
      const address = [cust.install_address, cust.install_city, cust.install_state, cust.install_zip].filter(Boolean).join(', ');
      const isInvoice = !!(ch && ch.invoice);
      const isAdhoc = !!(ch && ch.metadata && ch.metadata.adhoc_charge_id);
      const origChargeId = ch ? ch.id : (typeof r.charge === 'string' ? r.charge : null);
      return {
        date: new Date(r.created * 1000).toISOString().slice(0, 10),
        customer_name: cust.name || '(unmatched)',
        address,
        description: 'Refund' + (isInvoice ? ' (plan/invoice)' : isAdhoc ? ' (ad-hoc charge)' : ''),
        gross_cents: -r.amount,
        fee_cents: bt ? bt.fee : 0,
        net_cents: bt ? bt.net : -r.amount,
        auth_code: origChargeId ? (authByChargeId[origChargeId] || null) : null,  // original charge's approval code (ties the refund back)
        is_refund: true
      };
    });

    // Standalone Stripe account fees as negative entries. A balance transaction's
    // amount/net are already signed (negative for a fee), and fee==0 because the
    // transaction IS the fee — so we use them directly without negating.
    const feeTxns = allFees.map(t => ({
      date: new Date(t.created * 1000).toISOString().slice(0, 10),
      customer_name: 'Stripe',
      address: '',
      description: t.description || 'Stripe fee',
      gross_cents: t.amount,
      fee_cents: 0,
      net_cents: typeof t.net === 'number' ? t.net : t.amount,
      auth_code: null,                   // account-level fee, no card authorization
      is_fee: true
    }));

    const transactions = [...chargeTxns, ...refundTxns, ...feeTxns].sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      from: fromDate.toISOString().slice(0, 10),
      to: toDate.toISOString().slice(0, 10),
      transactions,
      totals: {
        count: transactions.length,
        gross_cents: transactions.reduce((s, t) => s + t.gross_cents, 0),
        fee_cents: transactions.reduce((s, t) => s + t.fee_cents, 0),
        net_cents: transactions.reduce((s, t) => s + t.net_cents, 0)
      }
    });
  } catch (err) {
    console.error('[accounting] transactions error:', err);
    reportError(err, { route: req.originalUrl, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /accounting/payouts?from=YYYY-MM-DD&to=YYYY-MM-DD
// Reconcile by Stripe PAYOUT instead of by calendar date. Stripe moves money
// to/from the bank in settlement batches (payouts) on its own schedule, so a
// calendar-date "Net to Bank" total rarely matches any single bank line. This
// view groups balance transactions by the payout that settled them, so each
// group sums to the exact amount that hit the bank — and surfaces the unsettled
// balance (not yet assigned to a payout) separately as `pending`.
//
// The date range filters by payout ARRIVAL DATE (when money moves at the bank),
// not by transaction date. Mirrors Stripe's own balance/payout reconciliation.
//
// Correctness note: every row's amounts are read straight from its balance
// transaction (amount/fee/net, already signed by Stripe), so a group's net ties
// to its payout by construction. Customer/description/auth-code enrichment is
// layered on top and can never move the totals.
router.get('/accounting/payouts', requirePermission('accounting'), async (req, res) => {
  // Each Stripe section is isolated so one failing call (or one bad payout)
  // degrades to empty instead of 500ing the whole view. Real errors are always
  // logged server-side; ?debug=1 also returns them to the (office) caller.
  const debug = req.query.debug === '1';
  const errors = [];
  const note = (where, e) => {
    console.error('[payouts]', where, '—', (e && e.stack) ? e.stack : e);
    errors.push({ where, message: e && e.message, type: e && e.type, code: e && e.code, param: e && e.param });
  };
  try {
    const today = new Date();
    const defaultFrom = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fromDate = req.query.from ? parseYmdParam(req.query.from, 'T00:00:00Z') : defaultFrom;
    const toDate = req.query.to ? parseYmdParam(req.query.to, 'T23:59:59Z') : today;
    if (!fromDate || !toDate) return res.status(400).json({ error: 'Invalid date range' });
    const fromTs = Math.floor(fromDate.getTime() / 1000);
    const toTs = Math.floor(toDate.getTime() / 1000);

    // 1) Payouts. Display groups are the ones whose arrival_date falls in the
    //    range, but the fetch is WIDER — everything arriving on/after the
    //    lookback bound — because any payout, in range or not, may have settled
    //    balance transactions created inside the window, and the Pending bucket
    //    must exclude those (step 3). A payout always arrives after its
    //    constituents were created, so payouts arriving before the lookback
    //    bound can't claim window transactions and don't need fetching. Stripe
    //    wants epoch seconds for the gt/lt filters, which fromTs/toTs are.
    const btFromTs = fromTs - 14 * 24 * 60 * 60; // window lookback (pending + fallback pool)
    let allPayouts = [];
    try {
      let after; let guard = 0;
      do {
        const page = await stripe.payouts.list({
          arrival_date: { gte: btFromTs },
          limit: 100,
          starting_after: after,
        });
        allPayouts = allPayouts.concat(page.data);
        after = page.has_more ? page.data[page.data.length - 1].id : undefined;
        guard++;
        if (guard > 20) break;
      } while (after);
    } catch (e) { note('payouts.list', e); }

    const payouts = allPayouts.filter((p) =>
      typeof p.arrival_date === 'number' && p.arrival_date >= fromTs && p.arrival_date <= toTs);
    const inRange = new Set(payouts.map((p) => p.id));

    // 2) Constituents per payout via Stripe's documented payout-reconciliation
    //    listing: balanceTransactions.list({ payout }) returns exactly the
    //    transactions that payout settled, plus the payout's own settlement
    //    line (type 'payout' — the balancing entry, not a constituent). This is
    //    the reliable path for standard automatic payouts, daily or weekly; the
    //    bt.payout FIELD, by contrast, stopped being populated on charge/fee
    //    balance transactions when the schedule switched to daily (2026-06-29),
    //    which is why grouping by that field collapsed to zero itemization.
    //    The listing DOES throw for auto-debit (negative-balance recovery)
    //    payouts — only those; they fall back to window attribution in step 5.
    //    Out-of-range payouts are listed too, solely to mark their constituents
    //    as settled so Pending never shows them. In-range payouts go first so
    //    the cap can never starve the display groups.
    const payoutBts = {};            // in-range payout id -> constituent bts (source expanded)
    payouts.forEach((p) => { payoutBts[p.id] = []; });
    const claimedBtIds = new Set();  // bt ids settled by ANY fetched payout
    const listingFailed = new Set(); // payouts whose reconciliation listing threw
    const btById = {};
    const LISTING_CAP = 200;
    const listingOrder = [...payouts, ...allPayouts.filter((p) => !inRange.has(p.id))];
    if (listingOrder.length > LISTING_CAP) {
      console.warn(`[payouts] reconciliation listings capped at ${LISTING_CAP} of ${listingOrder.length} payouts; Pending may overstate for very wide ranges`);
    }
    await Promise.all(listingOrder.slice(0, LISTING_CAP).map(async (p) => {
      try {
        let after; let guard = 0;
        do {
          const page = await stripe.balanceTransactions.list({
            payout: p.id,
            limit: 100,
            starting_after: after,
            expand: ['data.source'],
          });
          page.data.forEach((bt) => {
            btById[bt.id] = bt;
            if (bt.type === 'payout') return;                 // settlement line
            claimedBtIds.add(bt.id);
            if (payoutBts[p.id]) payoutBts[p.id].push(bt);    // display only when in range
          });
          after = page.has_more ? page.data[page.data.length - 1].id : undefined;
          guard++;
          if (guard > 20) break;
        } while (after);
      } catch (e) {
        // Expected for auto-debit payouts (step 5 falls back); logged as a
        // warning — not into errors[] — so _debug.errors stays a signal for
        // genuinely unexpected failures.
        listingFailed.add(p.id);
        console.warn('[payouts] reconciliation listing fell back for', p.id, '—', e && e.message);
      }
    }));

    // 3) Balance-transaction window for the Pending bucket and the auto-debit
    //    fallback pool. Pending = genuinely unsettled only: anything that
    //    appears in some payout's reconciliation listing (claimedBtIds), or
    //    that carries a bt.payout reference, is settled and must NEVER show
    //    here. What remains is status 'pending' (funds not yet available) or
    //    'available' but not yet swept by any payout.
    let pendingBts = [];
    try {
      let after; let guard = 0;
      do {
        const page = await stripe.balanceTransactions.list({
          created: { gte: btFromTs, lte: toTs },
          limit: 100,
          starting_after: after,
        });
        page.data.forEach((bt) => {
          if (!btById[bt.id]) btById[bt.id] = bt;             // keep expanded copies
          if (bt.type === 'payout') return;                   // settlement line
          if (bt.payout || claimedBtIds.has(bt.id)) return;   // settled by some payout
          pendingBts.push(bt);
        });
        after = page.has_more ? page.data[page.data.length - 1].id : undefined;
        guard++;
        if (guard > 30) break;
      } while (after);
    } catch (e) { note('balanceTransactions.list window', e); }

    // 4) Authoritative signed bank movement per payout, from the payout's own
    //    settlement balance transaction. A bt's `amount` is the change to the
    //    Stripe balance; the bank sees the opposite, so bank = -pbt.amount:
    //    a normal payout lowers the Stripe balance (pbt.amount < 0) => money to
    //    bank (+); an auto-debit raises it (pbt.amount > 0) => money from bank (−).
    //    Retrieving a single bt is supported even for auto-debits (only the list
    //    report isn't). Reuse btById where the settlement bt is already known.
    //    Out-of-range payouts whose listing failed need this too — their bank
    //    amount anchors the exact-sum guard when the fallback pass (step 6)
    //    pulls their recovered transactions out of Pending.
    const payoutBankCents = {};
    {
      const bankScope = [...payouts, ...allPayouts.filter((p) => !inRange.has(p.id) && listingFailed.has(p.id))];
      const needPbt = bankScope.filter((p) => p.balance_transaction && !btById[p.balance_transaction]);
      await Promise.all(needPbt.slice(0, 100).map(async (p) => {
        try { btById[p.balance_transaction] = await stripe.balanceTransactions.retrieve(p.balance_transaction); }
        catch (e) { note('balanceTransactions.retrieve ' + p.balance_transaction, e); }
      }));
      bankScope.forEach((p) => {
        const pbt = p.balance_transaction ? btById[p.balance_transaction] : null;
        if (pbt && typeof pbt.amount === 'number') payoutBankCents[p.id] = -pbt.amount;
      });
    }

    // 5) Enrichment. Reconciliation-listed bts arrive with `source` expanded
    //    (the charge or refund object); window bts carry only the id string.
    //    Seed what the expanded objects give us (customer, description,
    //    sometimes the auth code), then retrieve — bounded — only what's still
    //    missing. Auth codes are only definitive on a retrieved charge
    //    (list-returned charge objects often omit payment_method_details.card
    //    .authorization_code), so any charge without a seeded code is
    //    retrieved. Amounts never depend on any of this, so failures here only
    //    leave a row less-labeled, never wrong.
    const allBts = [...Object.values(payoutBts).reduce((a, b) => a.concat(b), []), ...pendingBts];
    const srcIdOf = (bt) => (typeof bt.source === 'string' ? bt.source : (bt.source && bt.source.id)) || null;
    const refundIds = new Set();
    const chargeIds = new Set();
    const authByChargeId = {};
    const chargeCustomerId = {};
    const chargeDescById = {};
    const refundToCharge = {};    // refund id -> originating charge id
    allBts.forEach((bt) => {
      const sid = srcIdOf(bt);
      if (!sid) return;
      const src = (bt.source && typeof bt.source === 'object') ? bt.source : null;
      if (bt.type === 'charge' || bt.type === 'payment') {
        chargeIds.add(sid);
        if (src && src.object === 'charge') {
          const code = authCodeOf(src);
          if (code) authByChargeId[sid] = code;
          const custId = typeof src.customer === 'string' ? src.customer : (src.customer && src.customer.id);
          if (custId) chargeCustomerId[sid] = custId;
          chargeDescById[sid] = chargeDescription(src);
        }
      } else if (bt.type === 'refund' || bt.type === 'payment_refund') {
        refundIds.add(sid);
        if (src && src.object === 'refund') {
          const cid = typeof src.charge === 'string' ? src.charge : (src.charge && src.charge.id);
          if (cid) { refundToCharge[sid] = cid; chargeIds.add(cid); }
        }
      }
    });

    const RETRIEVE_CAP = 300;
    // Refunds not already resolved via expansion -> originating charge id
    await Promise.all([...refundIds].filter((rid) => !refundToCharge[rid]).slice(0, RETRIEVE_CAP).map(async (rid) => {
      try {
        const rf = await stripe.refunds.retrieve(rid);
        const cid = typeof rf.charge === 'string' ? rf.charge : (rf.charge && rf.charge.id);
        if (cid) { refundToCharge[rid] = cid; chargeIds.add(cid); }
      } catch (e) { note('refunds.retrieve ' + rid, e); }
    }));

    // Charges without a definitive auth code yet -> retrieve fills code,
    // customer, and description in one call.
    await Promise.all([...chargeIds].filter((cid) => !(cid in authByChargeId)).slice(0, RETRIEVE_CAP).map(async (cid) => {
      try {
        const ch = await stripe.charges.retrieve(cid);
        const code = authCodeOf(ch);
        if (code) authByChargeId[cid] = code;
        const custId = typeof ch.customer === 'string' ? ch.customer : (ch.customer && ch.customer.id);
        if (custId) chargeCustomerId[cid] = custId;
        chargeDescById[cid] = chargeDescription(ch);
      } catch (e) { note('charges.retrieve ' + cid, e); }
    }));

    // Customer directory (one query for all stripe customers seen).
    const customerIds = [...new Set(Object.values(chargeCustomerId).filter(Boolean))];
    let customerMap = {};
    if (customerIds.length) {
      try {
        const { data: subs, error: subErr } = await supabaseAdmin
          .from('generator_subscriptions')
          .select('stripe_customer_id, customer:generator_customers(name, install_address, install_city, install_state, install_zip)')
          .in('stripe_customer_id', customerIds);
        if (subErr) throw subErr;
        (subs || []).forEach((s) => { if (s.customer) customerMap[s.stripe_customer_id] = s.customer; });
      } catch (e) { note('supabase customer lookup', e); }
    }

    // A display row built straight from a balance transaction. amount/fee/net
    // are Stripe's signed figures — used verbatim so groups always tie.
    function rowFromBt(bt) {
      const sid = srcIdOf(bt);
      let chargeId = null; let custId = null; let description = ''; let fallbackName = '';
      if (bt.type === 'charge' || bt.type === 'payment') {
        chargeId = sid;
        custId = chargeId ? chargeCustomerId[chargeId] : null;
        description = (chargeId && chargeDescById[chargeId]) || 'Card charge';
      } else if (bt.type === 'refund' || bt.type === 'payment_refund') {
        chargeId = sid ? refundToCharge[sid] : null;
        custId = chargeId ? chargeCustomerId[chargeId] : null;
        description = 'Refund';
      } else if (bt.type === 'stripe_fee') {
        fallbackName = 'Stripe';
        description = bt.description || 'Stripe fee';
      } else {
        description = bt.description || (bt.type || 'Transaction');
      }
      const cust = custId ? (customerMap[custId] || {}) : {};
      const address = [cust.install_address, cust.install_city, cust.install_state, cust.install_zip].filter(Boolean).join(', ');
      return {
        date: bt.created ? new Date(bt.created * 1000).toISOString().slice(0, 10) : '',
        customer_name: cust.name || fallbackName || '(unmatched)',
        address,
        description,
        gross_cents: typeof bt.amount === 'number' ? bt.amount : 0,
        fee_cents: bt.fee || 0,
        net_cents: typeof bt.net === 'number' ? bt.net : (typeof bt.amount === 'number' ? bt.amount : 0),
        auth_code: chargeId ? (authByChargeId[chargeId] || null) : null,
        type: bt.type,
      };
    }

    // 6) Fallback window attribution, then group assembly. Normal payouts
    //    (daily or weekly deposits) itemize straight from their reconciliation
    //    listing. Auto-debits are special: the listing throws for them and
    //    Stripe does NOT set bt.payout on the transactions an auto-debit
    //    recovers. For a payout whose listing failed (or any unconstituted
    //    debit), attribute the not-yet-paid-out transactions whose available_on
    //    is on/before the payout's arrival — but ONLY if they sum EXACTLY to
    //    the payout's bank amount. If they don't, keep the honest note and
    //    leave them in Pending (never force a wrong/partial attribution).
    //    The attribution pass runs over out-of-range fallback payouts too —
    //    not to display them, but so an auto-debit just outside the range still
    //    pulls its recovered transactions OUT of Pending. Oldest claims first.
    const nowTs = Math.floor(today.getTime() / 1000);
    let pendingPool = pendingBts.slice();
    const attributedById = {};    // payout id -> bts claimed by window attribution
    const fallbackOrder = allPayouts
      .filter((p) => listingFailed.has(p.id) || (inRange.has(p.id) && (payoutBts[p.id] || []).length === 0))
      .sort((a, b) => (a.arrival_date || 0) - (b.arrival_date || 0));
    for (const p of fallbackOrder) {
      const bankAmount = typeof payoutBankCents[p.id] === 'number'
        ? payoutBankCents[p.id]
        : Math.abs(typeof p.amount === 'number' ? p.amount : 0); // same derivation assembly uses for zero rows
      const direction = bankAmount < 0 ? 'debit' : 'deposit';
      if (direction !== 'debit' && !listingFailed.has(p.id)) continue;
      const arrivalTs = typeof p.arrival_date === 'number' ? p.arrival_date : nowTs;
      const candidates = pendingPool
        .filter((bt) => typeof bt.available_on === 'number' && bt.available_on <= arrivalTs)
        .sort((a, b) => (a.created - b.created) || (a.available_on - b.available_on));
      const candNet = candidates.reduce((s, bt) => s + (typeof bt.net === 'number' ? bt.net : 0), 0);
      if (candidates.length && candNet === bankAmount) {
        // Exact reconciliation: attribute to the payout and pull from Pending.
        const claimed = new Set(candidates.map((b) => b.id));
        pendingPool = pendingPool.filter((b) => !claimed.has(b.id));
        attributedById[p.id] = candidates;
      }
    }

    const procOrder = payouts.slice().sort((a, b) => (a.arrival_date || 0) - (b.arrival_date || 0));
    const groupById = {};
    const viaById = {};   // 'listing' | 'window-attribution' | 'none' (debug)
    for (const p of procOrder) {
      let rows = (payoutBts[p.id] || []).map(rowFromBt).sort((a, b) => a.date.localeCompare(b.date));
      let via = rows.length ? 'listing' : 'none';
      // Signed bank amount from the payout's own settlement bt (authoritative for
      // deposits AND auto-debits); fall back to |amount| signed by net.
      let bankAmount = payoutBankCents[p.id];
      if (typeof bankAmount !== 'number') {
        const n0 = rows.reduce((s, r) => s + r.net_cents, 0);
        const mag = Math.abs(typeof p.amount === 'number' ? p.amount : 0);
        bankAmount = (n0 < 0 ? -1 : 1) * mag;
      }
      const direction = bankAmount < 0 ? 'debit' : 'deposit';
      let unconstituted = rows.length === 0;
      let groupNote = null;

      if (unconstituted && attributedById[p.id]) {
        rows = attributedById[p.id].map(rowFromBt).sort((a, b) => a.date.localeCompare(b.date));
        unconstituted = false;
        via = 'window-attribution';
      } else if (unconstituted && direction === 'debit') {
        groupNote = 'Auto-debit recovering a prior negative balance. Its itemized transactions settled in an earlier period and aren’t listed here.';
      } else if (unconstituted && listingFailed.has(p.id)) {
        groupNote = 'Stripe did not return an itemized list for this payout. Its total is still exact; review the payout in the Stripe dashboard for detail.';
      } else if (unconstituted) {
        groupNote = 'No itemized transactions reference this payout in the selected range.';
      }

      const transactionsNet = rows.reduce((s, r) => s + r.net_cents, 0);
      const ties = rows.length > 0 && transactionsNet === bankAmount;
      if (rows.length > 0 && !ties && !groupNote) {
        // Show what we have honestly rather than hiding rows that don't sum.
        groupNote = 'Itemized transactions don’t fully account for the bank amount — Stripe returned an incomplete list for this payout. The rows shown are individually correct.';
      }
      viaById[p.id] = via;
      groupById[p.id] = {
        id: p.id,
        arrival_date: p.arrival_date ? new Date(p.arrival_date * 1000).toISOString().slice(0, 10) : '',
        status: p.status, // paid | in_transit | pending | failed | canceled
        direction,
        bank_amount_cents: bankAmount,            // signed: + deposit, − debit
        transactions_net_cents: transactionsNet,  // signed sum of the rows
        ties,
        unconstituted,
        note: groupNote,
        gross_cents: rows.reduce((s, r) => s + r.gross_cents, 0),
        fee_cents: rows.reduce((s, r) => s + r.fee_cents, 0),
        count: rows.length,
        transactions: rows,
      };
    }
    const payoutGroups = payouts.map((p) => groupById[p.id]).sort((a, b) => b.arrival_date.localeCompare(a.arrival_date));

    // 7) Pending group (after window attribution removed any settled items).
    const pendingRows = pendingPool.map(rowFromBt).sort((a, b) => a.date.localeCompare(b.date));
    const pendingNet = pendingRows.reduce((s, r) => s + r.net_cents, 0);

    res.json({
      from: fromDate.toISOString().slice(0, 10),
      to: toDate.toISOString().slice(0, 10),
      payouts: payoutGroups,
      pending: {
        net_cents: pendingNet,
        gross_cents: pendingRows.reduce((s, r) => s + r.gross_cents, 0),
        fee_cents: pendingRows.reduce((s, r) => s + r.fee_cents, 0),
        count: pendingRows.length,
        transactions: pendingRows,
      },
      totals: {
        payout_count: payoutGroups.length,
        settled_net_cents: payoutGroups.reduce((s, g) => s + g.bank_amount_cents, 0),
        untied_count: payoutGroups.filter((g) => !g.ties).length,
      },
      // Surfaced only with ?debug=1: section errors + per-payout signals so we
      // can confirm grouping/direction without Render log access.
      ...(debug ? { _debug: {
        errors,
        payouts_in_range: payouts.length,
        payouts_fetched_total: allPayouts.length,   // includes out-of-range claim-marking payouts
        claimed_bt_count: claimedBtIds.size,
        listing_fallbacks: [...listingFailed],      // payouts whose reconciliation listing threw (expected: auto-debits)
        pending_fetched: pendingBts.length,
        pending_after_attribution: pendingRows.length,
        payouts_seen: payoutGroups.map((g) => ({
          id: g.id, date: g.arrival_date, dir: g.direction, amount: g.bank_amount_cents,
          txns: g.count, net: g.transactions_net_cents, ties: g.ties, unconstituted: g.unconstituted,
          via: viaById[g.id],                       // 'listing' | 'window-attribution' | 'none'
        })),
      } } : {}),
    });
  } catch (err) {
    // Log the full stack so we're never blind again; keep the client message
    // generic unless ?debug=1 is set (office-gated route).
    console.error('[accounting] payouts error:', (err && err.stack) ? err.stack : err);
    reportError(err, { route: req.originalUrl, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    const body = { error: 'Server error' };
    if (req.query.debug === '1') {
      body.detail = { message: err && err.message, type: err && err.type, code: err && err.code, param: err && err.param, stack: err && err.stack };
      body.section_errors = errors;
    }
    res.status(500).json(body);
  }
});

module.exports = router;
