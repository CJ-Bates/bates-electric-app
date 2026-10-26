// backend/lib/etaTexts.js
// Tech "On my way" / "Running late" texts (sql/038), shared by the tech
// route (routes/generator-tech.js) and the office route
// (routes/generator-care/visits.js) so both behave identically.
//
// Background (2026-10-26): Jay King's tech was late, nobody told him, and he
// texted "No one has shown up." These are the operational texts the customer
// wants, so:
//   - they are sent with the tech as `sentBy` (the thread labels them with
//     the tech's name) and therefore are NOT held by office mode;
//   - they may go from 7 AM Central on the visit day (quietHoursStart 7);
//   - consent, STOP and the undeliverable flag still refuse - the caller then
//     tells the tech plainly to call, with the number;
//   - "Running late" ALWAYS alerts the office (email to the office list +
//     a 'note' row in the customer's thread, which the tray shows), sent or
//     not, so Amy knows even when the customer could not be texted.
// Only for a visit scheduled TODAY (Central) - an ETA for next week is
// nonsense, and the 7 AM allowance is anchored to "the visit is today".
//
// Returns { ok, sent, status, can_text, call_phone, body, visit, message }.
// Throws only on a real system error.

const { supabaseAdmin } = require('./supabase');
const {
  normalizePhone, sendSms, fmtSmsTime, buildOnMyWaySms, buildEtaUpdateSms, buildRunningLateSms, logSmsMessage,
} = require('./sms');
const { sendEmail, escHtml } = require('./emails');
const { TEXTS_TAB_URL } = require('./smsConversations');

const ETA_QUIET_START_HOUR = 7;
const LATE_REASONS = { traffic: 'traffic', previous_job: 'previous job ran long', other: 'other' };
const CANNOT_TEXT = new Set(['no_consent', 'opted_out', 'undeliverable', 'invalid_phone']);
const OFFICE_NOTIFY_TO = (process.env.GENERATOR_DIGEST_TO || 'cjbates@bates-electric.com,generators@bates-electric.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

const centralDate = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

// Resolve the ETA the caller asked for: an ISO instant, or minutes from now.
// Must be in the near future (up to 12h) - a typo'd "tomorrow" is rejected.
function resolveEta({ etaAt, etaMinutes, now }) {
  const t = now ? new Date(now).getTime() : Date.now();
  let eta = null;
  if (etaMinutes != null && etaMinutes !== '') {
    const m = Number(etaMinutes);
    if (!Number.isFinite(m) || m < 0 || m > 12 * 60) return null;
    eta = new Date(t + m * 60000);
  } else if (etaAt) {
    eta = new Date(etaAt);
    if (isNaN(eta.getTime())) return null;
  }
  if (!eta) return null;
  if (eta.getTime() < t - 5 * 60000 || eta.getTime() > t + 12 * 3600 * 1000) return null;
  return eta;
}

async function loadVisit(visitId) {
  const { data, error } = await supabaseAdmin
    .from('generator_service_visits')
    .select('id, status, appointment_at, arrival_window, assigned_tech_id, en_route_at, eta_at, running_late_at, late_reason, subscription:generator_subscriptions(id, customer:generator_customers(id, name, phone, install_state))')
    .eq('id', visitId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function profileName(id) {
  if (!id) return null;
  const { data } = await supabaseAdmin.from('profiles').select('full_name, email').eq('id', id).maybeSingle();
  return (data && (data.full_name || data.email)) || null;
}

// kind: 'on_my_way' | 'running_late'. sender: req.profile (tech or office).
async function sendEtaText({ visitId, kind, etaAt, etaMinutes, reason, sender, now }) {
  const clock = now ? new Date(now) : new Date();
  if (kind !== 'on_my_way' && kind !== 'running_late') return { ok: false, httpStatus: 400, error: 'Unknown ETA text kind.' };
  if (kind === 'running_late' && reason != null && reason !== '' && !LATE_REASONS[reason]) {
    return { ok: false, httpStatus: 400, error: 'Unknown reason.' };
  }
  const eta = resolveEta({ etaAt, etaMinutes, now: clock });
  if (!eta) return { ok: false, httpStatus: 400, error: 'Pick an arrival time in the next 12 hours.' };

  const visit = await loadVisit(visitId);
  if (!visit) return { ok: false, httpStatus: 404, error: 'Visit not found.' };
  if (visit.status !== 'scheduled' || !visit.appointment_at) return { ok: false, httpStatus: 409, error: 'This visit is not scheduled.' };
  if (centralDate(visit.appointment_at) !== centralDate(clock)) {
    return { ok: false, httpStatus: 409, error: 'ETA texts are for a visit scheduled today.' };
  }
  const customer = visit.subscription && visit.subscription.customer;
  if (!customer) return { ok: false, httpStatus: 409, error: 'No customer on this visit.' };

  // The name the customer reads: the assigned tech, else whoever is sending.
  const techFull = (visit.assigned_tech_id && await profileName(visit.assigned_tech_id)) || (sender && (sender.full_name || sender.email)) || '';
  const techFirstName = firstName(techFull);
  const timeText = fmtSmsTime(eta);
  const isUpdate = kind === 'on_my_way' && !!visit.en_route_at;
  const body = kind === 'running_late'
    ? buildRunningLateSms({ installState: customer.install_state, techFirstName, timeText })
    : (isUpdate ? buildEtaUpdateSms({ installState: customer.install_state, techFirstName, timeText }) : buildOnMyWaySms({ installState: customer.install_state, techFirstName, timeText }));

  const phone = normalizePhone(customer.phone);
  const result = await sendSms({
    toPhone: customer.phone,
    body,
    customerId: customer.id,
    relatedVisitId: visit.id,
    sentBy: sender && sender.id,            // thread label = the tech; also exempt from the office-mode hold
    quietHoursStart: ETA_QUIET_START_HOUR,  // visit is today: 7 AM is fine
    now: clock,
  });
  const canText = !CANNOT_TEXT.has(result.status);

  // Record on the visit (sent or not for running_late - the office needs the
  // flag either way; on_my_way only when the customer actually got it).
  const patch = {};
  if (kind === 'running_late') {
    patch.running_late_at = clock.toISOString();
    patch.late_reason = reason || null;
    patch.eta_at = eta.toISOString();
    patch.eta_sent_by = sender && sender.id ? sender.id : null;
  } else if (result.sent) {
    if (!visit.en_route_at) patch.en_route_at = clock.toISOString();
    patch.eta_at = eta.toISOString();
    patch.eta_sent_by = sender && sender.id ? sender.id : null;
  }
  if (Object.keys(patch).length) {
    const { error: upErr } = await supabaseAdmin.from('generator_service_visits').update(patch).eq('id', visit.id);
    if (upErr) console.error('[eta-texts] visit stamp failed:', upErr.message);
  }

  if (kind === 'running_late') {
    await notifyOfficeRunningLate({ visit, customer, techFull: techFull || 'The tech', timeText, reason, sent: result.sent, status: result.status, phone, clock });
  }

  const message = result.sent
    ? 'Text sent: ' + body
    : (canText
      ? 'Not sent: ' + (result.reason || result.status) + '.'
      : 'This customer doesn\'t get texts (' + cannotTextWhy(result.status) + ') - call them.');
  return {
    ok: true,
    sent: !!result.sent,
    status: result.status,
    can_text: canText,
    call_phone: canText ? null : (phone || customer.phone || null),
    body,
    eta_at: eta.toISOString(),
    visit: { id: visit.id, ...visit, ...patch },
    message,
  };
}

function cannotTextWhy(status) {
  return {
    no_consent: 'no text consent on file',
    opted_out: 'they replied STOP',
    undeliverable: 'texts to this number don\'t go through',
    invalid_phone: 'no usable mobile number',
  }[status] || status;
}

// Office alert for a late tech: email to the office list + a system note in
// the customer's text thread ('note' rows are never sent; the tray and the
// customer record show them as a neutral line). Never throws.
async function notifyOfficeRunningLate({ visit, customer, techFull, timeText, reason, sent, status, phone, clock }) {
  const why = reason && LATE_REASONS[reason] ? ' (' + LATE_REASONS[reason] + ')' : '';
  const note = sent
    ? 'Running late: ' + techFull + ' texted a new ETA of ' + timeText + why + '.'
    : 'Running late: ' + techFull + '\'s new ETA is ' + timeText + why + '. The customer could not be texted (' + cannotTextWhy(status) + ') - call them.';
  try {
    await logSmsMessage({
      direction: 'out',
      to_phone: phone || String(customer.phone || '').slice(0, 30),
      from_phone: normalizePhone(process.env.SIMPLETEXTING_ACCOUNT_PHONE) || null,
      body: note,
      status: 'note',
      detail: 'system note - not a text',
      customer_id: customer.id,
      related_visit_id: visit.id,
    });
  } catch (e) { console.error('[eta-texts] note log failed:', e && e.message); }
  try {
    const name = customer.name || phone || 'customer';
    const lines = [
      'Customer: ' + name + (phone ? ' (' + phone + ')' : ''),
      'Tech: ' + techFull + why,
      'New ETA: ' + timeText + ' (visit window ' + (visit.arrival_window || 'n/a') + ')',
      sent ? 'The customer was texted the new ETA.' : 'The customer could NOT be texted (' + cannotTextWhy(status) + ') - please call them.',
    ];
    await sendEmail({
      to: OFFICE_NOTIFY_TO,
      subject: '[Generator Care] Running late: ' + techFull + ' for ' + name + ' (new ETA ' + timeText + ')',
      html: '<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;">' +
        lines.map((l) => '<p style="margin:0 0 6px;">' + escHtml(l) + '</p>').join('') +
        '<p style="margin:12px 0 0;"><a href="' + TEXTS_TAB_URL + '">Open the Texts inbox</a></p></div>',
      text: lines.join('\n') + '\n' + TEXTS_TAB_URL,
      logTag: '[running-late-office-email]',
      log: { customerId: customer.id },
    });
  } catch (e) { console.error('[eta-texts] office email failed:', e && e.message); }
  void clock;
}

module.exports = { sendEtaText, resolveEta, LATE_REASONS, ETA_QUIET_START_HOUR };
