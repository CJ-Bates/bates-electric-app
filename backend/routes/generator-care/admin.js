// backend/routes/generator-care/admin.js
// Admin utilities: render + send a customer-facing email template with
// fixture data for visual verification.
// Auth (requireAuth + office role) is applied by ./index.js.

const express = require('express');
const {
  sendEmail,
  buildCardUpdateLinkEmail,
  buildWelcomeEmail,
  buildCardFailedEmail,
  buildVisitScheduledEmail,
  buildVisitCompletedEmail,
  buildRenewalUpcomingEmail,
  buildCancellationEmail,
} = require('../../lib/emails');

const router = express.Router();

// POST /api/generator-care/admin/send-test-email
// Renders one of the customer-facing templates with fixture data and sends
// it to the supplied address. Lets us visually verify templates before
// flipping Stripe to live mode without triggering real customer events.
// Body: { template: 'welcome' | 'failed_charge' | 'portal_link', to: '...' }
const TEST_EMAIL_TEMPLATES = ['welcome', 'failed_charge', 'portal_link', 'visit_scheduled', 'visit_complete', 'renewal_upcoming', 'cancellation'];
const FAKE_PORTAL_URL = 'https://billing.stripe.com/p/session/test_PLACEHOLDER';

function buildTestTemplate(template) {
  if (template === 'welcome') {
    return buildWelcomeEmail({
      customer: { name: 'Sample Customer', email: 'sample@example.com' },
      meta: {
        gen_class: 'air_cooled',
        gen_type: 'Standby',
        gen_model: 'Generac Guardian 22kW',
        gen_serial: 'TEST-12345',
        install_address: '123 Main St',
        install_city: 'Imperial',
        install_state: 'MO',
        install_zip: '63052',
      },
      planLabel: 'Annual Care',
      nextVisitDate: '2026-08-15',
      annualPriceCents: 49900,
      fleetMonitoring: true,
      paidAmountCents: 49900,
      paidDate: '2026-06-18',
    });
  }
  if (template === 'failed_charge') {
    return buildCardFailedEmail({
      customer: { name: 'Sample Customer' },
      amountCents: 11000,
      description: 'Transfer Switch Inspection & Simulated Outage Test',
      portalUrl: FAKE_PORTAL_URL,
    });
  }
  if (template === 'portal_link') {
    return buildCardUpdateLinkEmail({
      name: 'Sample Customer',
      portalUrl: FAKE_PORTAL_URL,
    });
  }
  if (template === 'visit_scheduled') {
    return buildVisitScheduledEmail({
      customer: { name: 'Sample Customer' },
      scheduledDate: '2026-08-15',
      arrivalWindowLabel: '8:00–10:00 AM',
      planLabel: 'Annual',
    });
  }
  if (template === 'visit_complete') {
    return buildVisitCompletedEmail({
      customer: { name: 'Sample Customer' },
      completedDate: '2026-06-08',
      nextVisitDate: '2027-06-08',
      planLabel: 'Annual',
      notes: 'Replaced battery. Tested generator under load — ran cleanly for 15 minutes. Topped off coolant.',
    });
  }
  if (template === 'cancellation') {
    return buildCancellationEmail({
      customer: { name: 'Sample Customer', email: 'sample@example.com' },
      periodEndDate: '2026-12-11',
    });
  }
  if (template === 'renewal_upcoming') {
    return buildRenewalUpcomingEmail({
      customer: { name: 'Sample Customer' },
      renewalDate: '2026-08-15',
      amountCents: 50500,
      planLabel: 'Annual',
      lineItems: [
        { amount_cents: 39500, description: 'Air Cooled Generator Care -- Annual' },
        { amount_cents: 11000, description: 'Transfer Switch Inspection & Simulated Outage Test' },
      ],
    });
  }
  return null;
}

router.post('/admin/send-test-email', async (req, res) => {
  try {
    const { template, to } = req.body || {};
    if (!template || !TEST_EMAIL_TEMPLATES.includes(template)) {
      return res.status(400).json({ error: `template must be one of: ${TEST_EMAIL_TEMPLATES.join(', ')}` });
    }
    if (!to || typeof to !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) {
      return res.status(400).json({ error: 'to must be a valid email address' });
    }
    const built = buildTestTemplate(template);
    if (!built) {
      return res.status(400).json({ error: 'unknown template' });
    }
    const subjectWithPrefix = `[TEST] ${built.subject}`;
    const result = await sendEmail({
      to: to.trim(),
      subject: subjectWithPrefix,
      html: built.html,
      text: built.text,
      logTag: `[test-email:${template}]`,
    });
    if (!result.sent) {
      return res.status(502).json({ ok: false, template, to: to.trim(), error: result.reason });
    }
    return res.json({ ok: true, sent: true, template, to: to.trim(), subject: subjectWithPrefix });
  } catch (err) {
    console.error('[admin/send-test-email] error:', err);
    return res.status(500).json({ error: err.message || 'unknown error' });
  }
});

module.exports = router;
