// Section/field definitions for the inspection report. Used by both the
// HTML email body and the PDF generator so the two stay in sync.

const mpFields = [
  ['Manufacturer', 'mp_mfr'], ['Voltage', 'mp_volt'], ['Amps', 'mp_amps'],
  ['Phase', 'mp_phase'], ['Age', 'mp_age'], ['Obsolete', 'mp_obs'],
  ['UL Listed', 'mp_ul'], ['Breakers sized', 'mp_sized'], ['Main breaker protected', 'mp_main_breaker'],
  ['Main breaker sized', 'mp_main_sized'], ['GFCI working', 'mp_gfci'], ['AFCI working', 'mp_afci'],
  ['Burning/corrosion', 'mp_burn'], ['Connections tight', 'mp_tight'], ['Wire type', 'mp_wiretype'],
  ['Grounding correct', 'mp_ground'], ['Surge device', 'mp_surge'], ['Clamps/bushings', 'mp_clamps'],
  ['Panel labeled', 'mp_labeled'], ['Knockouts sealed', 'mp_knockouts'], ['Bonded', 'mp_bonded'],
  ['Heat', 'mp_heat'], ['Corrosion', 'mp_corr'], ['Water/rust', 'mp_rust'],
  ['Double taps', 'mp_dbl_tap'], ['Surge protector', 'mp_surge2'], ['Breakers for wire', 'mp_wire_size'],
  ['Condition', 'mp_cond'], ['Exposed wires', 'mp_exposed'], ['Entries protected', 'mp_entries'],
  ['Overall rating', 'mp_rating'],
];

const spFields = mpFields.map(([l, k]) => [l, k.replace('mp_', 'sp_')]);

const svcFields = [
  ['Ampere Rating', 'svc_amps'], ['Phase', 'svc_phase'], ['Age', 'svc_age'],
  ['Riser Type', 'svc_riser'], ['POA Condition', 'svc_poa'],
  ['Entry', 'svc_entry'], ['Location', 'svc_loc'],
  ['Disconnect switch', 'svc_q01'], ['Eyebolt', 'svc_q02'], ['Weatherhead', 'svc_q03'],
  ['Flashing', 'svc_q04'], ['Utility connections', 'svc_q05'], ['Trees on wires', 'svc_q06'],
  ['Grounding', 'svc_q07'], ['Drip loop', 'svc_q08'], ['Components secured', 'svc_q09'],
  ['Meter/Service', 'svc_q10'], ['Entrance cable', 'svc_q11'], ['Overall rating', 'svc_rating'],
];

const gwFields = [
  ['GFCI in required', 'gw_q01'], ['Outside GFCI', 'gw_q02'], ['Bubble covers', 'gw_q03'],
  ['Outside wiring', 'gw_q04'], ['Open splices', 'gw_q05'], ['Stab wired', 'gw_q06'],
  ['Extension cords', 'gw_q07'], ['Outlets', 'gw_q08'], ['GFCI coverage', 'gw_q09'],
  ['AFCI coverage', 'gw_q10'], ['Fixtures', 'gw_q11'], ['Exhaust fans', 'gw_q12'],
  ['Charging stations', 'gw_q13'], ['Colors noted', 'gw_colors'], ['Overall rating', 'gw_rating'],
];

const smFields = [
  ['Tested/working', 'sm_q01'], ['In required areas', 'sm_q02'], ['Hardwired/interconnected', 'sm_q03'],
  ['CO alarms', 'sm_q04'], ['Doorbell', 'sm_q05'], ['Detector age', 'sm_age'], ['Overall rating', 'sm_rating'],
];

const acFields = [
  ['Wiring correct', 'ac_q01'], ['Count', 'ac_count'], ['Improper methods', 'ac_q03'], ['Overall rating', 'ac_rating'],
];

const hvFields = [
  ['AC Min', 'hv_min'], ['AC Max', 'hv_max'],
  ['AC breaker correct', 'hv_q01'], ['AC disconnect', 'hv_q02'], ['Furnace wiring', 'hv_q03'],
  ['Furnace disconnect', 'hv_q04'], ['Aluminum wiring', 'hv_q05'], ['Aluminum terminated', 'hv_q06'],
  ['A/C condition', 'hv_q07'], ['Furnace condition', 'hv_q08'], ['Overall rating', 'hv_rating'],
];

const SECTIONS = [
  ['Main Electrical Panel', mpFields],
  ['Secondary / Sub Panel', spFields],
  ['Main Electrical Service', svcFields],
  ['General Wiring', gwFields],
  ['Smoke & CO Alarms', smFields],
  ['Attic & Crawlspace', acFields],
  ['Furnace & A/C Wiring', hvFields],
];

const UPSELL_NAMES = [
  'up_panel', 'up_surge', 'up_breaker', 'up_gfci', 'up_afci', 'up_ev',
  'up_sub', 'up_circuit', 'up_smoke', 'up_co', 'up_alum', 'up_arc',
  'up_svc', 'up_gen', 'up_outdoor', 'up_covers', 'up_label', 'up_ground',
];

const JOB_FIELDS = [
  ['Date', 'job_date'],
  ['Job #', 'job_num'],
  ['Invoice #', 'job_inv'],
  ['Technician', 'job_tech'],
  ['Customer', 'job_cust'],
  ['Address', 'job_addr'],
  ['Email', 'job_email'],
  ['Year Built', 'job_yr'],
  ['Property Type', 'job_type'],
  ['# Photos', 'job_photos'],
];

module.exports = { SECTIONS, UPSELL_NAMES, JOB_FIELDS };
