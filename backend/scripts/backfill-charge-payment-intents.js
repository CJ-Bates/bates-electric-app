// One-time backfill: recover stripe_payment_intent_id on legacy charged rows.
//
// The Basil API removal of Invoice.payment_intent meant every invoice-based
// charge made before the PI-resolution fix (merge 5383c72) stored a NULL
// stripe_payment_intent_id. The dashboard's invoice reconciliation matches
// rows to invoices by that PI, so a NULL row is structurally invisible to it
// and reads "Charged" with a live Refund link forever, even when its invoice
// was refunded. The reconciler is correct — this script restores the data it
// was starved of.
//
// Recovery threads, in order (both end at the Basil-safe resolver in
// lib/gcShared — NEVER invoice.payment_intent directly; that property is
// what broke):
//   1. stripe_invoice_item_id -> invoice item -> its invoice. In practice
//      the charge flows CLEAR the item id when marking a row charged, so
//      most legacy rows don't have it — kept because it's the direct thread
//      whenever it does exist.
//   2. Invoice line metadata: every invoice line these flows create carries
//      metadata.addon_id / metadata.adhoc_charge_id (it's what the
//      invoice.paid webhook and the refund self-heal key on), so scan the
//      customer's paid invoices for the line naming this row — the same
//      linkage findChargedRowPaymentIntent in lib/gcShared trusts, mirrored
//      here so the invoice id can be reported alongside the PI.
//
// Run from the backend folder (needs SUPABASE_* + STRIPE_SECRET_KEY):
//   node scripts/backfill-charge-payment-intents.js           # DRY RUN (default): no DB writes
//   node scripts/backfill-charge-payment-intents.js --live    # write resolved PIs back
//
// Guardrails:
//   - NO money movement, ever: Stripe access is read-only (invoice item /
//     invoice retrieves, paid-invoice + invoice-payments lists); the only
//     write is the stripe_payment_intent_id column on already-charged rows.
//   - Only settled rows (status 'charged') are considered — pending/performed
//     rows are never touched.
//   - Never overwrites: the scan takes only NULL-PI rows, and the UPDATE
//     re-asserts `stripe_payment_intent_id is null` so a concurrent write wins.
//   - Idempotent: a re-run finds the rows populated and reports them as such.
//   - Missing/deleted invoice items and unresolvable PIs are SKIPped loudly
//     with a reason — never guessed, never fabricated.
//   - Stripe calls run through mapPool at low concurrency so a large backfill
//     can't fan out and wedge the connection pool.

require('dotenv').config();
if (!process.env.STRIPE_SECRET_KEY) {
  // Both modes read Stripe (the dry run resolves real PIs). Locally the key
  // usually isn't in backend/.env — run this in the Render shell instead.
  console.error('STRIPE_SECRET_KEY is not set - aborting before any call. Run where it is configured (Render shell).');
  process.exit(1);
}
const { stripe, resolveInvoicePaymentIntentId } = require('../lib/gcShared');
const { supabaseAdmin } = require('../lib/supabase');
const { mapPool } = require('../lib/asyncGuards');

const LIVE = process.argv.includes('--live');
const CONCURRENCY = 3; // Stripe reads in flight at once — deliberately small
const PAGE_SIZE = 1000; // Supabase caps un-ranged selects at 1000 — page to be safe

// Settled = the row actually took money. There is no 'refunded' status —
// refund state is derived from notes/Stripe, so charged covers refunded rows.
const SETTLED_STATUSES = ['charged'];

// metadataKey = the invoice-line metadata field that names a row of this
// table (same keys the invoice.paid webhook matches on).
const TABLES = [
  { table: 'generator_pending_addons', descField: 'addon_type', metadataKey: 'addon_id' },
  { table: 'generator_adhoc_charges', descField: 'description', metadataKey: 'adhoc_charge_id' },
];

const money = (cents) => '$' + ((cents || 0) / 100).toFixed(2);

async function fetchNullPiRows({ table, descField }) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select(`id, ${descField}, amount_cents, status, stripe_invoice_item_id, stripe_payment_intent_id, subscription:generator_subscriptions(stripe_customer_id)`)
      .in('status', SETTLED_STATUSES)
      .is('stripe_payment_intent_id', null)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(table + ' query failed: ' + error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

async function countAlreadyPopulated(table) {
  const { count, error } = await supabaseAdmin
    .from(table)
    .select('id', { count: 'exact', head: true })
    .in('status', SETTLED_STATUSES)
    .not('stripe_payment_intent_id', 'is', null);
  if (error) throw new Error(table + ' count failed: ' + error.message);
  return count || 0;
}

// Paid-invoice lists for the metadata scan, fetched once per Stripe customer
// (several legacy rows usually share one customer). Promise-cached so
// concurrent rows can't double-fetch. Same 100-invoice cap as
// findChargedRowPaymentIntent — if a customer somehow exceeds it, say so
// loudly instead of silently scanning a truncated list.
const paidInvoicesByCustomer = new Map();
function listPaidInvoices(stripeCustomerId) {
  if (!paidInvoicesByCustomer.has(stripeCustomerId)) {
    paidInvoicesByCustomer.set(stripeCustomerId, (async () => {
      const res = await stripe.invoices.list({ customer: stripeCustomerId, status: 'paid', limit: 100, expand: ['data.payments'] });
      if (res && res.has_more) {
        console.log('  NOTE: customer ' + stripeCustomerId + ' has >100 paid invoices - metadata scan covers only the most recent 100');
      }
      return (res && res.data) || [];
    })());
  }
  return paidInvoicesByCustomer.get(stripeCustomerId);
}

// Thread 1: the row's own invoice item -> its invoice. Returns the invoice
// object, or { skip: reason } when the item is gone/detached.
async function invoiceViaItem(row) {
  let item;
  try {
    item = await stripe.invoiceItems.retrieve(row.stripe_invoice_item_id);
  } catch (e) {
    const gone = e && (e.code === 'resource_missing' || e.statusCode === 404);
    return { skip: gone ? 'invoice item missing/deleted in Stripe' : 'invoice item retrieve failed: ' + (e && e.message) };
  }
  const invoiceId = typeof item.invoice === 'string' ? item.invoice : (item.invoice && item.invoice.id) || null;
  if (!invoiceId) return { skip: 'invoice item is not attached to an invoice' };
  try {
    return { invoice: await stripe.invoices.retrieve(invoiceId, { expand: ['payments'] }) };
  } catch (e) {
    return { skip: 'invoice retrieve failed for ' + invoiceId + ': ' + (e && e.message) };
  }
}

// Thread 2: the paid invoice whose line metadata names this row.
async function invoiceViaLineMetadata(row, metadataKey) {
  const stripeCustomerId = row.subscription && row.subscription.stripe_customer_id;
  if (!stripeCustomerId) return { skip: 'no invoice item and no Stripe customer on the subscription' };
  let invoices;
  try {
    invoices = await listPaidInvoices(stripeCustomerId);
  } catch (e) {
    return { skip: 'paid-invoice list failed for ' + stripeCustomerId + ': ' + (e && e.message) };
  }
  for (const inv of invoices) {
    const lines = (inv.lines && inv.lines.data) || [];
    if (lines.some((l) => l && l.metadata && l.metadata[metadataKey] === row.id)) return { invoice: inv, viaMetadata: true };
  }
  return { skip: 'no invoice item, and no paid invoice line carries this row id in metadata.' + metadataKey };
}

// Resolve one row's PI through Stripe. Returns
//   { action: 'set', invoiceId, paymentIntentId, thread } or { action: 'skip', reason }.
// Read-only; never throws (a Stripe hiccup becomes a loud SKIP, not an abort).
async function resolveRow(row, metadataKey) {
  const found = row.stripe_invoice_item_id
    ? await invoiceViaItem(row)
    : await invoiceViaLineMetadata(row, metadataKey);
  if (found.skip) return { action: 'skip', reason: found.skip };
  const paymentIntentId = await resolveInvoicePaymentIntentId(found.invoice);
  if (!paymentIntentId) {
    return { action: 'skip', reason: 'PaymentIntent unresolvable for invoice ' + found.invoice.id + ' (status ' + found.invoice.status + ')' };
  }
  return { action: 'set', invoiceId: found.invoice.id, paymentIntentId, thread: found.viaMetadata ? 'line metadata' : 'invoice item' };
}

(async () => {
  console.log('\n=== Charged-row PaymentIntent backfill ' + (LIVE ? '(LIVE - will write)' : '(DRY RUN - no writes)') + ' ===\n');

  const summary = { scanned: 0, resolved: 0, skipped: 0, alreadyPopulated: 0, skipReasons: {} };

  for (const cfg of TABLES) {
    const { table, descField } = cfg;
    const populated = await countAlreadyPopulated(table);
    summary.alreadyPopulated += populated;
    const rows = await fetchNullPiRows(cfg);
    summary.scanned += rows.length;
    console.log(table + ': ' + rows.length + ' settled row(s) with NULL PI (' + populated + ' already populated - untouched)');

    await mapPool(rows, CONCURRENCY, async (row) => {
      const label = table + ' ' + row.id + ' | ' + String(row[descField] || '(no description)') + ' | ' + money(row.amount_cents)
        + ' | item ' + (row.stripe_invoice_item_id || '-');
      const result = await resolveRow(row, cfg.metadataKey);

      if (result.action === 'skip') {
        summary.skipped++;
        summary.skipReasons[result.reason] = (summary.skipReasons[result.reason] || 0) + 1;
        console.log('  SKIP       ' + label + ' | ' + result.reason);
        return;
      }

      if (!LIVE) {
        summary.resolved++;
        console.log('  WOULD SET  ' + label + ' | invoice ' + result.invoiceId + ' | ' + result.paymentIntentId + ' | via ' + result.thread);
        return;
      }

      // Re-assert NULL in the filter so this can never overwrite a PI written
      // by anything else (webhook, refund self-heal) since the scan.
      const { data: updated, error } = await supabaseAdmin
        .from(table)
        .update({ stripe_payment_intent_id: result.paymentIntentId })
        .eq('id', row.id)
        .is('stripe_payment_intent_id', null)
        .select('id');
      if (error) {
        summary.skipped++;
        summary.skipReasons['DB update failed'] = (summary.skipReasons['DB update failed'] || 0) + 1;
        console.log('  SKIP       ' + label + ' | DB update failed: ' + error.message);
      } else if (!updated || !updated.length) {
        summary.skipped++;
        summary.skipReasons['PI appeared since scan (not overwritten)'] = (summary.skipReasons['PI appeared since scan (not overwritten)'] || 0) + 1;
        console.log('  SKIP       ' + label + ' | PI appeared since scan - left untouched');
      } else {
        summary.resolved++;
        console.log('  SET        ' + label + ' | invoice ' + result.invoiceId + ' | ' + result.paymentIntentId + ' | via ' + result.thread);
      }
    });
  }

  console.log('\nSummary: scanned ' + summary.scanned + ' NULL-PI settled row(s), '
    + (LIVE ? 'set ' : 'would set ') + summary.resolved + ', skipped ' + summary.skipped
    + ', already populated ' + summary.alreadyPopulated + '.');
  for (const [reason, n] of Object.entries(summary.skipReasons)) {
    console.log('  skip x' + n + ': ' + reason);
  }
  if (!LIVE) console.log('Dry run - no database writes were made. Re-run with --live to apply.');
  console.log('');
})().catch((e) => {
  console.error('Backfill aborted: ' + ((e && e.message) || e));
  process.exit(1);
});
