// Minimal fake Stripe client covering exactly the methods
// backend/lib/planChange.js calls. Every method is a recording async stub:
// unconfigured calls resolve to undefined (fine for calls whose return value
// a test doesn't inspect); pass `impls` to script specific responses. Each
// stub exposes `.calls` (array of arg-lists) so tests can assert on the exact
// shape of what was sent to Stripe.

function fn(impl) {
  const calls = [];
  const f = async (...args) => {
    calls.push(args);
    return impl ? impl(...args) : undefined;
  };
  f.calls = calls;
  return f;
}

// impls: { subscriptionsRetrieve, subscriptionsUpdate, schedulesCreate,
//          schedulesRetrieve, schedulesUpdate, schedulesRelease, itemsCreate,
//          invoicesCreate, invoiceItemsCreate, invoicesFinalize, invoicesPay,
//          invoicesVoid, createBalanceTransaction }
function createMockStripe(impls = {}) {
  return {
    subscriptions: {
      retrieve: fn(impls.subscriptionsRetrieve),
      update: fn(impls.subscriptionsUpdate),
    },
    subscriptionSchedules: {
      create: fn(impls.schedulesCreate),
      retrieve: fn(impls.schedulesRetrieve),
      update: fn(impls.schedulesUpdate),
      release: fn(impls.schedulesRelease),
    },
    subscriptionItems: {
      create: fn(impls.itemsCreate),
    },
    invoices: {
      create: fn(impls.invoicesCreate),
      finalizeInvoice: fn(impls.invoicesFinalize),
      pay: fn(impls.invoicesPay),
      voidInvoice: fn(impls.invoicesVoid),
    },
    invoiceItems: {
      create: fn(impls.invoiceItemsCreate),
    },
    customers: {
      createBalanceTransaction: fn(impls.createBalanceTransaction),
    },
  };
}

module.exports = { createMockStripe, fn };
