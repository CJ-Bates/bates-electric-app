// Row definitions for the inspection form. Keeping these in JS (instead of
// hand-written HTML) means each of 100+ Y/N/NA rows is one line, not eight.
// The keys in ROW_GROUPS match `data-rows="..."` attributes in inspection.html.

const YNNA   = ['Y', 'N', 'NA'];
const YN     = ['Y', 'N'];
const GFP    = ['Good', 'Fair', 'Poor'];
const SRH    = ['Safe', 'Risk', 'Hazard'];
const CUAL   = ['Copper', 'Aluminum'];
const OHUG   = ['Overhead', 'Underground'];
const POLEBL = ['Pole', 'Building'];

// Panel rows repeat for main + sub. Build once, stamp with a prefix.
const PANEL_MAIN_ROWS = (p) => [
  { name: `${p}_ul`,            q: 'Are breakers UL listed for this panel?',         opts: YNNA },
  { name: `${p}_sized`,         q: 'Are breakers/fuses sized correctly?',            opts: YNNA, sub: 'If no, explain in notes' },
  { name: `${p}_main_breaker`,  q: 'Is the panel protected by a main breaker?',      opts: YNNA },
  { name: `${p}_main_sized`,    q: 'Is the main breaker sized correctly?',           opts: YNNA },
  { name: `${p}_gfci`,          q: 'Are the GFCI breakers working correctly?',       opts: YNNA },
  { name: `${p}_afci`,          q: 'Are the AFCI breakers working correctly?',       opts: YNNA },
  { name: `${p}_burn`,          q: 'Any burning or corrosion present?',              opts: YNNA },
  { name: `${p}_tight`,         q: 'Are all connections tight?',                     opts: YNNA },
  { name: `${p}_wiretype`,      q: 'Wire type (anti-oxidant required if aluminum):', opts: CUAL },
  { name: `${p}_ground`,        q: 'Is the grounding done correctly?',               opts: YNNA },
  { name: `${p}_surge`,         q: 'Is there a main surge suppression device?',      opts: YNNA },
  { name: `${p}_clamps`,        q: 'Missing clamps or bushings?',                    opts: YNNA },
  { name: `${p}_labeled`,       q: 'Is the panel properly labeled?',                 opts: YNNA },
  { name: `${p}_knockouts`,     q: 'Are all knockouts sealed?',                      opts: YNNA },
  { name: `${p}_bonded`,        q: 'Is the panel properly bonded for safety?',       opts: YNNA },
];

const PANEL_WIRING_ROWS = (p) => [
  { name: `${p}_heat`,      q: 'Are there any signs of excessive heat?',          opts: YNNA },
  { name: `${p}_corr`,      q: 'Are there any signs of corrosion?',               opts: YNNA },
  { name: `${p}_rust`,      q: 'Are there any signs of water or rust?',           opts: YNNA },
  { name: `${p}_dbl_tap`,   q: 'Are there any double tapped wires?',              opts: YNNA },
  { name: `${p}_surge2`,    q: 'Is there a main surge protector?',                opts: YNNA },
  { name: `${p}_wire_size`, q: 'Are all breakers sized correctly for the wire?',  opts: YNNA },
  { name: `${p}_cond`,      q: 'Panel condition summary:',                        opts: GFP  },
  { name: `${p}_exposed`,   q: 'Are there any open or exposed wires?',            opts: YNNA },
  { name: `${p}_entries`,   q: 'Are all wire entries protected (clamps/bushings)?', opts: YNNA },
  { name: `${p}_rating`,    q: 'Overall:',                                        opts: SRH  },
];

const ROW_GROUPS = {
  mp_main:    PANEL_MAIN_ROWS('mp'),
  mp_wiring:  PANEL_WIRING_ROWS('mp'),
  sp_main:    PANEL_MAIN_ROWS('sp'),
  sp_wiring:  PANEL_WIRING_ROWS('sp'),

  svc: [
    { name: 'svc_entry', q: 'Entry Method:',                                    opts: OHUG   },
    { name: 'svc_loc',   q: 'If overhead, on:',                                 opts: POLEBL },
    { name: 'svc_q01',   q: 'Is there a main disconnect switch?',               opts: YNNA },
    { name: 'svc_q02',   q: 'Is the eyebolt okay?',                             opts: YNNA },
    { name: 'svc_q03',   q: 'Is the weatherhead okay?',                         opts: YNNA },
    { name: 'svc_q04',   q: 'Is the flashing okay?',                            opts: YNNA },
    { name: 'svc_q05',   q: 'Are main utility connections okay?',               opts: YNNA },
    { name: 'svc_q06',   q: 'Are there trees touching the utility wires?',      opts: YNNA },
    { name: 'svc_q07',   q: 'Is the grounding correct?',                        opts: YNNA },
    { name: 'svc_q08',   q: 'Is there a proper drip loop on the service cable?', opts: YNNA },
    { name: 'svc_q09',   q: 'Are all components secured properly?',             opts: YNNA },
    { name: 'svc_q10',   q: 'Condition of the Meter / Service?',                opts: GFP  },
    { name: 'svc_q11',   q: 'Condition of service entrance cable?',             opts: GFP  },
    { name: 'svc_rating', q: 'Overall:',                                        opts: SRH  },
  ],

  gw: [
    { name: 'gw_q01', q: 'Are all GFCI outlets present in required areas?',              opts: YNNA },
    { name: 'gw_q02', q: 'Are outside outlets GFCI protected (including exterior)?',     opts: YNNA },
    { name: 'gw_q03', q: 'Do all outside outlets have in-use / bubble covers?',          opts: YNNA },
    { name: 'gw_q04', q: 'Condition of outside wiring?',                                 opts: GFP  },
    { name: 'gw_q05', q: 'Are there any open splices?',                                  opts: YNNA },
    { name: 'gw_q06', q: 'Are any outlets stab-wired?',                                  opts: YNNA },
    { name: 'gw_q07', q: 'Are extension cords being used as permanent wiring?',          opts: YNNA },
    { name: 'gw_q08', q: 'Condition of outlets?',                                        opts: GFP  },
    { name: 'gw_q09', q: 'Is there GFCI protection in all required areas?',              opts: YNNA },
    { name: 'gw_q10', q: 'Is there AFCI protection in all required areas?',              opts: YNNA },
    { name: 'gw_q11', q: 'Condition of light fixtures?',                                 opts: GFP  },
    { name: 'gw_q12', q: 'Condition of exhaust fans?',                                   opts: GFP  },
    { name: 'gw_q13', q: 'Condition of charging stations?',                              opts: GFP  },
    { name: 'gw_colors', q: 'Receptacle / switch / GFCI colors noted:', inputType: 'text' },
    { name: 'gw_rating', q: 'Overall:',                                                  opts: SRH  },
  ],

  sm: [
    { name: 'sm_q01', q: 'Are all smoke / CO alarms tested and working correctly?', opts: YNNA },
    { name: 'sm_q02', q: 'Are there alarms in all required areas?',                 opts: YNNA },
    { name: 'sm_q03', q: 'Are smoke alarms hardwired and interconnected?',          opts: YNNA },
    { name: 'sm_q04', q: 'Are CO alarms present where required?',                   opts: YNNA },
    { name: 'sm_q05', q: 'Does the doorbell / video doorbell system work?',         opts: YNNA },
    { name: 'sm_age', q: 'Age (yrs):',                                              inputType: 'text' },
    { name: 'sm_q06', q: 'Age of smoke detectors?',                                 opts: YNNA },
    { name: 'sm_rating', q: 'Overall:',                                             opts: SRH  },
  ],

  ac: [
    { name: 'ac_q01',    q: 'Is the wiring done correctly?',         opts: YNNA },
    { name: 'ac_count',  q: 'How many:',                             inputType: 'text' },
    { name: 'ac_q02',    q: 'Are there any open splices?',           opts: YNNA },
    { name: 'ac_q03',    q: 'Any improper wiring methods observed?', opts: YNNA },
    { name: 'ac_rating', q: 'Overall:',                              opts: SRH  },
  ],

  hv: [
    { name: 'hv_min',    q: 'Min:', inputType: 'text' },
    { name: 'hv_max',    q: 'Max:', inputType: 'text' },
    { name: 'hv_q01',    q: 'Is the AC breaker sized correctly?',           opts: YNNA },
    { name: 'hv_q02',    q: 'Is there an AC disconnect switch?',            opts: YNNA },
    { name: 'hv_q03',    q: 'Is the furnace wiring correct and safe?',      opts: YNNA },
    { name: 'hv_q04',    q: 'Is there a furnace disconnect?',               opts: YNNA },
    { name: 'hv_q05',    q: 'Is there aluminum wiring present?',            opts: YNNA },
    { name: 'hv_q06',    q: 'Is the aluminum wiring terminated correctly?', opts: YNNA },
    { name: 'hv_q07',    q: 'Condition of A/C wiring overall?',             opts: GFP  },
    { name: 'hv_q08',    q: 'Condition of furnace wiring overall?',         opts: GFP  },
    { name: 'hv_rating', q: 'Overall:',                                     opts: SRH  },
  ],
};

const UPSELL_ITEMS = [
  { name: 'up_panel',   label: 'Panel upgrade / replacement' },
  { name: 'up_surge',   label: 'Whole-home surge protector' },
  { name: 'up_breaker', label: 'Main breaker replacement' },
  { name: 'up_gfci',    label: 'GFCI outlet installation' },
  { name: 'up_afci',    label: 'AFCI breaker installation' },
  { name: 'up_ev',      label: 'EV charging outlet (240V)' },
  { name: 'up_sub',     label: 'Subpanel installation' },
  { name: 'up_circuit', label: 'Dedicated circuit(s)' },
  { name: 'up_smoke',   label: 'Smoke detector replacement' },
  { name: 'up_co',      label: 'CO detector installation' },
  { name: 'up_alum',    label: 'Aluminum wiring remediation' },
  { name: 'up_arc',     label: 'Arc fault protection upgrade' },
  { name: 'up_svc',     label: 'Service upgrade (100A → 200A)' },
  { name: 'up_gen',     label: 'Whole-home generator / transfer sw.' },
  { name: 'up_outdoor', label: 'Outdoor / weatherproof outlets' },
  { name: 'up_covers',  label: 'In-use outlet covers installation' },
  { name: 'up_label',   label: 'Label / map panel circuits' },
  { name: 'up_ground',  label: 'Grounding / bonding correction' },
];

window.INSPECTION_ROW_GROUPS = ROW_GROUPS;
window.INSPECTION_UPSELL_ITEMS = UPSELL_ITEMS;
