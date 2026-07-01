// backend/routes/generator-care/accounting.js
// Brenda's reconciliation views: transactions by date and the payout
// (bank-settlement) grouping. Read-only against Stripe + the DB.
// Auth (requireAuth + office role) is applied by ./index.js.

const express = require('express');
const { supabaseAdmin } = require('../../lib/supabase');
const { stripe } = require('../../lib/gcShared');

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

// === ACCOUNTING ENDPOINTS ===

// GET /accounting/transactions?from=YYYY-MM-DD&to=YYYY-MM-DD
// Pulls succeeded charges from Stripe in the date range, joins with our DB
// for customer name + install address, and returns per-charge gross / Stripe fee / net.
router.get('/accounting/transactions', async (req, res) => {
  try {
    const today = new Date();
    const defaultFrom = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fromDate = req.query.from ? new Date(req.query.from + 'T00:00:00Z') : defaultFrom;
    const toDate = req.query.to ? new Date(req.query.to + 'T23:59:59Z') : today;
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
          stripe_charge_id: c.id,        // kept in the API response for debugging; not shown in the table/CSV
          stripe_customer_id: c.customer,
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
        stripe_charge_id: origChargeId,
        stripe_customer_id: custId,
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
      stripe_charge_id: t.id,
      stripe_customer_id: null,
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
router.get('/accounting/payouts', async (req, res) => {
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
    const fromDate = req.query.from ? new Date(req.query.from + 'T00:00:00Z') : defaultFrom;
    const toDate = req.query.to ? new Date(req.query.to + 'T23:59:59Z') : today;
    const fromTs = Math.floor(fromDate.getTime() / 1000);
    const toTs = Math.floor(toDate.getTime() / 1000);

    // 1) Payouts whose arrival_date falls in the range (paged). Stripe wants
    //    epoch seconds for the gt/lt filters, which fromTs/toTs already are.
    let payouts = [];
    try {
      let after; let guard = 0;
      do {
        const page = await stripe.payouts.list({
          arrival_date: { gte: fromTs, lte: toTs },
          limit: 100,
          starting_after: after,
        });
        payouts = payouts.concat(page.data);
        after = page.has_more ? page.data[page.data.length - 1].id : undefined;
        guard++;
        if (guard > 20) break;
      } while (after);
    } catch (e) { note('payouts.list', e); }

    const payoutById = {};
    payouts.forEach((p) => { payoutById[p.id] = p; });
    const inRange = new Set(payouts.map((p) => p.id));

    // 2) Group by the balance transaction's `payout` FIELD, not the per-payout
    //    reconciliation report (balanceTransactions.list({payout})) — that report
    //    is unsupported for auto-debit payouts and throws. Listing balance
    //    transactions over the window and reading bt.payout works for normal
    //    deposits AND auto-debits. The lower bound is widened so a payout
    //    arriving early in the range still captures its slightly-earlier
    //    constituents. The settlement entry (type 'payout') is the balancing
    //    line, not a constituent.
    const payoutBts = {};
    payouts.forEach((p) => { payoutBts[p.id] = []; });
    let pendingBts = [];
    const btById = {};
    try {
      const btFromTs = fromTs - 14 * 24 * 60 * 60;
      let after; let guard = 0;
      do {
        const page = await stripe.balanceTransactions.list({
          created: { gte: btFromTs, lte: toTs },
          limit: 100,
          starting_after: after,
        });
        page.data.forEach((bt) => {
          btById[bt.id] = bt;
          if (bt.type === 'payout') return;                         // settlement line
          if (bt.payout && inRange.has(bt.payout)) payoutBts[bt.payout].push(bt);
          else if (!bt.payout) pendingBts.push(bt);                 // not yet settled
          // else: settled by a payout outside this range — neither here nor pending
        });
        after = page.has_more ? page.data[page.data.length - 1].id : undefined;
        guard++;
        if (guard > 30) break;
      } while (after);
    } catch (e) { note('balanceTransactions.list window', e); }

    // 3) Authoritative signed bank movement per payout, from the payout's own
    //    settlement balance transaction. A bt's `amount` is the change to the
    //    Stripe balance; the bank sees the opposite, so bank = -pbt.amount:
    //    a normal payout lowers the Stripe balance (pbt.amount < 0) => money to
    //    bank (+); an auto-debit raises it (pbt.amount > 0) => money from bank (−).
    //    Retrieving a single bt is supported even for auto-debits (only the list
    //    report isn't). Reuse btById where the settlement bt is already in window.
    const payoutBankCents = {};
    {
      const needPbt = payouts.filter((p) => p.balance_transaction && !btById[p.balance_transaction]);
      await Promise.all(needPbt.slice(0, 100).map(async (p) => {
        try { btById[p.balance_transaction] = await stripe.balanceTransactions.retrieve(p.balance_transaction); }
        catch (e) { note('balanceTransactions.retrieve ' + p.balance_transaction, e); }
      }));
      payouts.forEach((p) => {
        const pbt = p.balance_transaction ? btById[p.balance_transaction] : null;
        if (pbt && typeof pbt.amount === 'number') payoutBankCents[p.id] = -pbt.amount;
      });
    }

    // 4) Enrichment via bounded retrieves (no expand). Each balance transaction's
    //    `source` is just an id string here: charge/payment -> the charge id;
    //    refund -> the refund id (retrieved to find its originating charge). Then
    //    each charge is retrieved once for its auth code, customer, and a
    //    description. Amounts never depend on any of this, so failures here only
    //    leave a row less-labeled, never wrong.
    const allBts = [...Object.values(payoutBts).reduce((a, b) => a.concat(b), []), ...pendingBts];
    const srcIdOf = (bt) => (typeof bt.source === 'string' ? bt.source : (bt.source && bt.source.id)) || null;
    const refundIds = new Set();
    const chargeIds = new Set();
    allBts.forEach((bt) => {
      const sid = srcIdOf(bt);
      if (!sid) return;
      if (bt.type === 'charge' || bt.type === 'payment') chargeIds.add(sid);
      else if (bt.type === 'refund' || bt.type === 'payment_refund') refundIds.add(sid);
    });

    const RETRIEVE_CAP = 300;
    // refund id -> originating charge id
    const refundToCharge = {};
    await Promise.all([...refundIds].slice(0, RETRIEVE_CAP).map(async (rid) => {
      try {
        const rf = await stripe.refunds.retrieve(rid);
        const cid = typeof rf.charge === 'string' ? rf.charge : (rf.charge && rf.charge.id);
        if (cid) { refundToCharge[rid] = cid; chargeIds.add(cid); }
      } catch (e) { note('refunds.retrieve ' + rid, e); }
    }));

    // charge id -> auth code / customer id / description
    const authByChargeId = {};
    const chargeCustomerId = {};
    const chargeDescById = {};
    await Promise.all([...chargeIds].slice(0, RETRIEVE_CAP).map(async (cid) => {
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

    // 5) Assemble payout groups. Normal deposits itemize via bt.payout. Auto-debits
    //    are special: Stripe does NOT set bt.payout on the balance transactions an
    //    auto-debit recovers, so they come back with 0 constituents. For an
    //    unconstituted DEBIT, attribute the not-yet-paid-out transactions whose
    //    available_on is on/before the payout's arrival — but ONLY if they sum
    //    EXACTLY to the payout's bank amount. If they don't, keep the honest note
    //    and leave them in Pending (never force a wrong/partial attribution).
    const nowTs = Math.floor(today.getTime() / 1000);
    let pendingPool = pendingBts.slice();
    const procOrder = payouts.slice().sort((a, b) => (a.arrival_date || 0) - (b.arrival_date || 0)); // oldest claims first
    const groupById = {};
    for (const p of procOrder) {
      let rows = (payoutBts[p.id] || []).map(rowFromBt).sort((a, b) => a.date.localeCompare(b.date));
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

      if (unconstituted && direction === 'debit') {
        const arrivalTs = typeof p.arrival_date === 'number' ? p.arrival_date : nowTs;
        const candidates = pendingPool
          .filter((bt) => typeof bt.available_on === 'number' && bt.available_on <= arrivalTs)
          .sort((a, b) => (a.created - b.created) || (a.available_on - b.available_on));
        const candNet = candidates.reduce((s, bt) => s + (typeof bt.net === 'number' ? bt.net : 0), 0);
        if (candidates.length && candNet === bankAmount) {
          // Exact reconciliation: itemize under the payout and pull from Pending.
          const claimed = new Set(candidates.map((b) => b.id));
          pendingPool = pendingPool.filter((b) => !claimed.has(b.id));
          rows = candidates.map(rowFromBt).sort((a, b) => a.date.localeCompare(b.date));
          unconstituted = false;
        } else {
          groupNote = 'Auto-debit recovering a prior negative balance. Its itemized transactions settled in an earlier period and aren’t listed here.';
        }
      } else if (unconstituted) {
        groupNote = 'No itemized transactions reference this payout in the selected range.';
      }

      const transactionsNet = rows.reduce((s, r) => s + r.net_cents, 0);
      groupById[p.id] = {
        id: p.id,
        arrival_date: p.arrival_date ? new Date(p.arrival_date * 1000).toISOString().slice(0, 10) : '',
        status: p.status, // paid | in_transit | pending | failed | canceled
        direction,
        bank_amount_cents: bankAmount,            // signed: + deposit, − debit
        transactions_net_cents: transactionsNet,  // signed sum of the rows
        ties: rows.length > 0 ? transactionsNet === bankAmount : false,
        unconstituted,
        note: groupNote,
        gross_cents: rows.reduce((s, r) => s + r.gross_cents, 0),
        fee_cents: rows.reduce((s, r) => s + r.fee_cents, 0),
        count: rows.length,
        transactions: rows,
      };
    }
    const payoutGroups = payouts.map((p) => groupById[p.id]).sort((a, b) => b.arrival_date.localeCompare(a.arrival_date));

    // 6) Pending group (after window attribution removed any settled items).
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
        payouts_fetched: payouts.length,
        pending_fetched: pendingBts.length,
        pending_after_attribution: pendingRows.length,
        payouts_seen: payoutGroups.map((g) => ({
          id: g.id, date: g.arrival_date, dir: g.direction, amount: g.bank_amount_cents,
          txns: g.count, net: g.transactions_net_cents, ties: g.ties, unconstituted: g.unconstituted,
          bt_payout_grouped: (payoutBts[g.id] || []).length, // raw bt.payout matches before window attribution
        })),
      } } : {}),
    });
  } catch (err) {
    // Log the full stack so we're never blind again; keep the client message
    // generic unless ?debug=1 is set (office-gated route).
    console.error('[accounting] payouts error:', (err && err.stack) ? err.stack : err);
    const body = { error: 'Server error' };
    if (req.query.debug === '1') {
      body.detail = { message: err && err.message, type: err && err.type, code: err && err.code, param: err && err.param, stack: err && err.stack };
      body.section_errors = errors;
    }
    res.status(500).json(body);
  }
});

module.exports = router;
