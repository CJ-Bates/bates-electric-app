/**
 * SDS (Safety Data Sheets) Page
 * Displays all Bates Electric chemical products with detailed safety information
 */

const CHEMICALS = [
  {
    name: "Acetone",
    brand: "Klean-Strip",
    use: "PVC cement cleanup",
    revised: "6/26/2019",
    page: 10,
    signal: "DANGER",
    hazards: ["Highly flammable liquid & vapor", "Causes serious eye irritation", "May cause drowsiness or dizziness"],
    ppe: ["Safety glasses", "Nitrile gloves", "Ventilation required"],
    storage: "Away from heat/ignition. Keep container tightly closed.",
    firstaid: "Eyes: flush 15 min. Skin: wash with soap/water. Inhale: fresh air. Ingestion: call Poison Control.",
    fire: "CO₂, dry chemical, or foam. Do NOT use water jet.",
    color: "orange"
  },
  {
    name: "Aqua-Gel II",
    brand: "Ideal Industries",
    use: "Cold-weather wire pulling",
    revised: "4/13/2023",
    page: 18,
    signal: "WARNING",
    hazards: ["May cause mild skin/eye irritation"],
    ppe: ["Safety glasses", "Work gloves"],
    storage: "Store above freezing. Keep sealed.",
    firstaid: "Eyes: flush with water. Skin: wash thoroughly.",
    fire: "Not flammable under normal conditions.",
    color: "blue"
  },
  {
    name: "Citrus-Based Degreaser",
    brand: "Simple Green",
    use: "Electrical panel wipe-down",
    revised: "1/1/2023",
    page: 27,
    signal: "WARNING",
    hazards: ["Causes skin and eye irritation"],
    ppe: ["Safety glasses", "Nitrile gloves", "Adequate ventilation"],
    storage: "Store in cool, dry area away from heat.",
    firstaid: "Eyes: flush 15 min. Skin: wash with soap/water.",
    fire: "Not flammable. CO₂ or dry chemical if ignited.",
    color: "green"
  },
  {
    name: "Cold Galvanizing Compound",
    brand: "Rust-Oleum",
    use: "Conduit touch-up",
    revised: "8/6/2025",
    page: 33,
    signal: "WARNING",
    hazards: ["Flammable liquid", "Contains zinc powder", "Harmful if inhaled (dust/mist)", "Skin/eye irritant"],
    ppe: ["Safety glasses/goggles", "Nitrile gloves", "Respirator if spraying"],
    storage: "Flammable — keep away from heat and ignition sources.",
    firstaid: "Eyes: flush 15 min. Skin: wash. Inhale: fresh air.",
    fire: "Flammable. CO₂ or dry chemical.",
    color: "orange"
  },
  {
    name: "Construction Adhesive",
    brand: "Loctite",
    use: "Panel and equipment mounting",
    revised: "2/7/2019",
    page: 40,
    signal: "WARNING",
    hazards: ["Skin/eye irritant", "Contains isocyanates if polyurethane-based", "Harmful vapors in confined spaces"],
    ppe: ["Safety glasses", "Chemical-resistant gloves", "Ventilation"],
    storage: "Cool, dry location. Keep away from moisture.",
    firstaid: "Eyes: flush 15 min. Skin: wash immediately. Inhale: fresh air.",
    fire: "CO₂ or dry chemical.",
    color: "yellow"
  },
  {
    name: "Diesel Fuel",
    brand: "Chevron",
    use: "Temporary generator fuel",
    revised: "4/16/2020",
    page: 47,
    signal: "WARNING",
    hazards: ["Combustible liquid", "Aspiration hazard", "Skin/eye irritant", "Suspected carcinogen (prolonged exposure)"],
    ppe: ["Safety glasses", "Nitrile gloves", "Ventilation"],
    storage: "Flammable storage cabinet. Away from ignition sources.",
    firstaid: "Skin: wash thoroughly. Eyes: flush 15 min. Ingestion: do NOT induce vomiting — call Poison Control.",
    fire: "CO₂, foam, or dry chemical. DO NOT use water jet.",
    color: "red"
  },
  {
    name: "Duct Seal Compound",
    brand: "Gardner Bender",
    use: "Conduit and box sealing",
    revised: "1/1/2015",
    page: 57,
    signal: "WARNING",
    hazards: ["Mild skin/eye irritant"],
    ppe: ["Safety glasses", "Work gloves"],
    storage: "Store in cool, dry area.",
    firstaid: "Eyes: flush with water. Skin: wash with soap/water.",
    fire: "Not flammable under normal conditions.",
    color: "green"
  },
  {
    name: "Electrical Contact Cleaner (aerosol)",
    brand: "CRC",
    use: "Switchgear and contact cleaning",
    revised: "12/18/2018",
    page: 63,
    signal: "DANGER",
    hazards: ["Extremely flammable aerosol", "Harmful if inhaled", "Asphyxiation risk in confined spaces", "Skin defatting"],
    ppe: ["Safety glasses", "Gloves", "Adequate ventilation — NO ignition sources"],
    storage: "Pressurized container — do not pierce or burn. Keep away from heat/sunlight.",
    firstaid: "Inhale: fresh air immediately. Skin: wash. Eyes: flush 15 min.",
    fire: "Flammable aerosol. CO₂ or dry chemical.",
    color: "red"
  },
  {
    name: "Electrical Insulating Varnish",
    brand: "Glyptal",
    use: "Motor and coil coating",
    revised: "9/17/2020",
    page: 75,
    signal: "DANGER",
    hazards: ["Flammable liquid", "Harmful vapors", "Contains VOCs", "Skin/eye irritant"],
    ppe: ["Safety glasses/goggles", "Chemical-resistant gloves", "Respirator", "Ventilation"],
    storage: "Flammable storage. Keep container tightly closed.",
    firstaid: "Eyes: flush 15 min. Skin: wash. Inhale: fresh air.",
    fire: "CO₂, dry chemical, or foam.",
    color: "orange"
  },
  {
    name: "Firestop Caulk",
    brand: "3M",
    use: "Fire-rated wall penetrations",
    revised: "9/4/2024",
    page: 86,
    signal: "WARNING",
    hazards: ["Skin and eye irritant", "Contains silicone/intumescent materials"],
    ppe: ["Safety glasses", "Gloves"],
    storage: "Store between 40–90°F. Keep sealed.",
    firstaid: "Eyes: flush with water. Skin: wash with soap/water.",
    fire: "Non-flammable.",
    color: "green"
  },
  {
    name: "Gasoline",
    brand: "Chevron",
    use: "Small engine fuel",
    revised: "3/1/2023",
    page: 100,
    signal: "DANGER",
    hazards: ["Highly flammable liquid & vapor", "Aspiration hazard — FATAL if swallowed", "Known carcinogen (benzene content)", "Harmful vapors"],
    ppe: ["Safety glasses", "Chemical-resistant gloves", "Good ventilation — NO open flames or sparks"],
    storage: "Approved fuel containers only. Away from all ignition sources.",
    firstaid: "Ingestion: do NOT induce vomiting — call 911/Poison Control. Skin: wash thoroughly. Eyes: flush 15 min. Inhale: fresh air.",
    fire: "CO₂, foam, or dry chemical. NEVER water.",
    color: "red"
  },
  {
    name: "Isopropyl Alcohol 99%",
    brand: "MG Chemicals",
    use: "Fiber optic and PCB cleaning",
    revised: "8/28/2025",
    page: 116,
    signal: "DANGER",
    hazards: ["Highly flammable liquid & vapor", "Causes serious eye irritation", "May cause drowsiness or dizziness"],
    ppe: ["Safety glasses", "Gloves", "Ventilation away from ignition sources"],
    storage: "Flammable storage. Keep container tightly closed and away from heat.",
    firstaid: "Eyes: flush 15 min. Skin: wash. Inhale: fresh air.",
    fire: "CO₂, dry chemical, or foam. Small fires only.",
    color: "orange"
  },
  {
    name: "Lead-Free Solder Wire",
    brand: "Kester",
    use: "Circuit board soldering",
    revised: "6/29/2017",
    page: 129,
    signal: "WARNING",
    hazards: ["Contains tin/silver/copper alloys", "Flux fumes if overheated — irritant", "Possible skin sensitizer"],
    ppe: ["Safety glasses", "Gloves", "Ventilation when soldering"],
    storage: "Cool, dry location.",
    firstaid: "Wash hands before eating. Eyes: flush. Skin: wash.",
    fire: "Not flammable in wire form.",
    color: "yellow"
  },
  {
    name: "Liquid Electrical Tape",
    brand: "Gardner Bender",
    use: "Splice and termination sealing",
    revised: "9/10/2015",
    page: 137,
    signal: "WARNING",
    hazards: ["Flammable liquid", "Skin/eye irritant", "Harmful vapors"],
    ppe: ["Safety glasses", "Gloves", "Ventilation"],
    storage: "Away from heat/ignition. Keep sealed.",
    firstaid: "Eyes: flush 15 min. Skin: wash. Inhale: fresh air.",
    fire: "CO₂ or dry chemical.",
    color: "orange"
  },
  {
    name: "Lithium-Ion Tool Battery",
    brand: "Milwaukee",
    use: "Cordless power tools",
    revised: "1/1/2018",
    page: 153,
    signal: "WARNING",
    hazards: ["Fire/explosion risk if damaged or overcharged", "Thermal runaway possible", "Electrolyte irritant if leaking"],
    ppe: ["Safety glasses if battery is damaged", "Gloves if handling leaking battery"],
    storage: "Store at room temperature. Do not short-circuit, puncture, or expose to heat.",
    firstaid: "Electrolyte contact — flush eyes/skin immediately with water for 15 min.",
    fire: "Use large amounts of water to cool. Li-ion fires are difficult to extinguish.",
    color: "red"
  },
  {
    name: "Loctite 242 (Blue)",
    brand: "Henkel",
    use: "Conduit fitting lock",
    revised: "11/7/2016",
    page: 162,
    signal: "WARNING",
    hazards: ["Skin/eye irritant", "Skin sensitizer (methacrylate)", "Harmful if inhaled in large quantities"],
    ppe: ["Safety glasses", "Nitrile gloves", "Ventilation"],
    storage: "Store at 46–82°F. Avoid direct sunlight. Keep sealed.",
    firstaid: "Eyes: flush 15 min. Skin: wash with soap/water. Remove contaminated clothing.",
    fire: "CO₂ or dry chemical. Flash point ~149°F (65°C).",
    color: "yellow"
  },
  {
    name: "MAPP Gas",
    brand: "Worthington",
    use: "High-temperature brazing",
    revised: "7/1/2016",
    page: 169,
    signal: "DANGER",
    hazards: ["Extremely flammable compressed gas", "Asphyxiation risk", "Cryogenic burns if liquid contacts skin"],
    ppe: ["Safety glasses/face shield", "Leather gloves", "No ignition sources nearby"],
    storage: "Upright in ventilated area. Away from heat, flames, and combustibles.",
    firstaid: "Frostbite: warm gently with warm water. Inhale: fresh air. Call 911 if exposed.",
    fire: "Stop gas flow if safe. Isolate area. Call fire department.",
    color: "red"
  },
  {
    name: "Mastic Tape",
    brand: "3M",
    use: "Moisture sealing",
    revised: "2/5/2024",
    page: 182,
    signal: "WARNING",
    hazards: ["Mild skin irritant", "Tacky material — difficult to remove from skin"],
    ppe: ["Safety glasses", "Gloves recommended"],
    storage: "Store below 90°F away from direct sunlight.",
    firstaid: "Skin: remove mechanically, wash with soap/water. Eyes: flush.",
    fire: "Not flammable under normal use.",
    color: "green"
  },
  {
    name: "Mineral Spirits",
    brand: "Sunnyside",
    use: "Paint preparation",
    revised: "11/8/2013",
    page: 187,
    signal: "WARNING",
    hazards: ["Flammable liquid", "Aspiration hazard", "Skin defatting with prolonged contact", "Harmful vapors in confined spaces"],
    ppe: ["Safety glasses", "Nitrile gloves", "Ventilation"],
    storage: "Away from heat/ignition. Approved flammable storage.",
    firstaid: "Skin: wash with soap/water. Eyes: flush 15 min. Inhale: fresh air. Ingestion: do NOT induce vomiting.",
    fire: "CO₂, foam, or dry chemical.",
    color: "orange"
  },
  {
    name: "Never-Seez Nickel Grade",
    brand: "Bostik",
    use: "Ground rod threading",
    revised: "1/6/2016",
    page: 200,
    signal: "WARNING",
    hazards: ["Contains nickel compounds (carcinogen if inhaled as dust)", "Skin/eye irritant"],
    ppe: ["Safety glasses", "Gloves", "Avoid generating dust"],
    storage: "Cool dry area. Keep sealed.",
    firstaid: "Eyes/skin: flush and wash. Inhale dust: fresh air.",
    fire: "Not flammable in paste form.",
    color: "yellow"
  },
  {
    name: "No-Clean Flux Pen",
    brand: "Techspray",
    use: "Field electronics repair",
    revised: "3/6/2024",
    page: 211,
    signal: "WARNING",
    hazards: ["Flammable liquid (IPA-based)", "Eye/skin irritant", "Avoid heating — produces irritating fumes"],
    ppe: ["Safety glasses", "Gloves", "Ventilation when soldering"],
    storage: "Away from heat. Keep capped when not in use.",
    firstaid: "Eyes: flush 15 min. Skin: wash.",
    fire: "CO₂ or dry chemical.",
    color: "orange"
  },
  {
    name: "Panel Enclosure Paint",
    brand: "Hoffman",
    use: "Custom panel painting",
    revised: "9/7/2021",
    page: 225,
    signal: "WARNING",
    hazards: ["Flammable aerosol", "VOC — avoid enclosed spaces", "Skin/eye/respiratory irritant"],
    ppe: ["Safety glasses/goggles", "Gloves", "Half-mask respirator if spraying indoors"],
    storage: "Pressurized container. Away from heat and open flames.",
    firstaid: "Eyes: flush 15 min. Inhale: fresh air. Skin: wash.",
    fire: "Flammable aerosol — CO₂ or dry chemical.",
    color: "orange"
  },
  {
    name: "Penetrating Oil",
    brand: "WD-40",
    use: "Rusted fitting release",
    revised: "7/19/2018",
    page: 230,
    signal: "WARNING",
    hazards: ["Combustible liquid", "Skin/eye irritant", "Aerosol version is flammable"],
    ppe: ["Safety glasses", "Gloves"],
    storage: "Away from heat. Keep container sealed.",
    firstaid: "Eyes: flush. Skin: wash with soap/water.",
    fire: "CO₂ or dry chemical.",
    color: "yellow"
  },
  {
    name: "Polywater J Lubricant",
    brand: "American Polywater",
    use: "High-voltage cable pulling",
    revised: "6/9/2020",
    page: 236,
    signal: "WARNING",
    hazards: ["Mild skin/eye irritant", "Non-toxic base"],
    ppe: ["Safety glasses", "Gloves (optional)"],
    storage: "Store in cool dry area.",
    firstaid: "Eyes: flush with water. Skin: wash.",
    fire: "Not flammable.",
    color: "green"
  },
  {
    name: "Portland Cement (Type I/II)",
    brand: "Quikrete",
    use: "Anchor base setting",
    revised: "2/10/2023",
    page: 247,
    signal: "DANGER",
    hazards: ["Causes skin burns (wet cement)", "Serious eye damage", "Respiratory irritant if dust inhaled", "Alkaline — pH ~12"],
    ppe: ["Safety glasses/goggles", "Waterproof gloves", "Dust mask or respirator", "Long sleeves/pants"],
    storage: "Keep dry. Store off ground on pallets.",
    firstaid: "Skin: remove from skin immediately, wash with water. Eyes: flush 15–20 min — seek medical attention. Inhale: fresh air.",
    fire: "Non-combustible.",
    color: "red"
  },
  {
    name: "Propane (20 lb cylinder)",
    brand: "Bernzomatic",
    use: "Torch heating",
    revised: "12/19/2018",
    page: 258,
    signal: "DANGER",
    hazards: ["Extremely flammable compressed gas", "Asphyxiation risk", "Cylinder overpressure/explosion risk if heated"],
    ppe: ["Safety glasses", "No ignition sources", "Adequate ventilation"],
    storage: "Upright outdoors or in ventilated area. Away from heat, vehicles, and building openings.",
    firstaid: "Inhale: fresh air. Frostbite from liquid: warm gently. Call 911 for exposures.",
    fire: "Stop flow if safe. BLEVE risk if cylinder is heated. Call fire department.",
    color: "red"
  },
  {
    name: "PVC Glue (Cement)",
    brand: "Oatey / Weld-On",
    use: "PVC conduit and fitting bonding",
    revised: "7/1/2022",
    page: 267,
    signal: "DANGER",
    hazards: ["Highly flammable liquid & vapor", "Harmful vapors — use in ventilated area", "Causes eye/skin irritation", "Contains THF and MEK"],
    ppe: ["Safety glasses/goggles", "Chemical-resistant gloves", "Ventilation — no ignition sources"],
    storage: "Flammable storage. Keep tightly sealed.",
    firstaid: "Eyes: flush 15 min. Skin: wash. Inhale: fresh air immediately.",
    fire: "CO₂, dry chemical, or foam.",
    color: "red"
  },
  {
    name: "PVC Primer",
    brand: "Oatey / Weld-On",
    use: "Surface prep for PVC bonding",
    revised: "8/2/2012",
    page: 278,
    signal: "DANGER",
    hazards: ["Highly flammable liquid & vapor", "Contains acetone and MEK", "Eye/skin/respiratory irritant"],
    ppe: ["Safety glasses", "Chemical-resistant gloves", "Ventilation — no ignition sources"],
    storage: "Flammable storage. Keep sealed.",
    firstaid: "Eyes: flush 15 min. Skin: wash. Inhale: fresh air.",
    fire: "CO₂, dry chemical, or foam.",
    color: "red"
  },
  {
    name: "Rapid-Set Concrete Mix",
    brand: "CTS Cement",
    use: "Emergency pad repairs",
    revised: "1/14/2022",
    page: 289,
    signal: "WARNING",
    hazards: ["Causes skin/eye burns when wet", "Respiratory irritant (dust)", "Alkaline — sets quickly, can trap hands"],
    ppe: ["Safety glasses/goggles", "Waterproof gloves", "Dust mask", "Long sleeves"],
    storage: "Keep dry. Use promptly once opened.",
    firstaid: "Skin: remove and wash thoroughly. Eyes: flush 15 min — seek medical attention. Dust: fresh air.",
    fire: "Non-combustible.",
    color: "yellow"
  },
  {
    name: "Rubber Splicing Tape",
    brand: "3M",
    use: "Medium-voltage splices",
    revised: "4/2/2024",
    page: 302,
    signal: "WARNING",
    hazards: ["Mild skin irritant", "Stretched material may snap back"],
    ppe: ["Safety glasses", "Gloves when working at voltage"],
    storage: "Cool, dry area away from ozone sources.",
    firstaid: "Eyes: flush. Skin: wash if irritated.",
    fire: "Not flammable under normal conditions.",
    color: "green"
  },
  {
    name: "RTV Silicone (clear)",
    brand: "CRC",
    use: "Junction box gasketing",
    revised: "8/15/2017",
    page: 308,
    signal: "WARNING",
    hazards: ["Releases acetic acid vapors during cure (vinegar odor)", "Eye/skin irritant", "Harmful if inhaled in confined spaces"],
    ppe: ["Safety glasses", "Gloves", "Ventilation during application and cure"],
    storage: "Cool, dry location. Avoid freezing.",
    firstaid: "Eyes: flush 15 min. Skin: wash. Inhale: fresh air.",
    fire: "Not flammable in cured form.",
    color: "yellow"
  },
  {
    name: "Safety Yellow Spray Paint",
    brand: "Krylon",
    use: "Equipment marking",
    revised: "10/18/2025",
    page: 318,
    signal: "WARNING",
    hazards: ["Flammable aerosol", "VOCs — eye/respiratory irritant", "Dizziness in confined spaces"],
    ppe: ["Safety glasses", "Gloves", "Respirator if using indoors"],
    storage: "Pressurized container. Away from heat and direct sunlight.",
    firstaid: "Eyes: flush 15 min. Inhale: fresh air. Skin: wash.",
    fire: "Flammable aerosol — CO₂ or dry chemical.",
    color: "orange"
  },
  {
    name: "Scotchkote Electrical Coating",
    brand: "3M",
    use: "Conduit corrosion protection",
    revised: "5/7/2023",
    page: 342,
    signal: "WARNING",
    hazards: ["Flammable liquid", "Skin/eye irritant", "Harmful vapors"],
    ppe: ["Safety glasses", "Chemical-resistant gloves", "Ventilation"],
    storage: "Away from heat/ignition. Keep sealed.",
    firstaid: "Eyes: flush 15 min. Skin: wash. Inhale: fresh air.",
    fire: "CO₂ or dry chemical.",
    color: "orange"
  },
  {
    name: "Sealed Lead-Acid Battery",
    brand: "Interstate Batteries",
    use: "UPS backup power",
    revised: "2/1/2021",
    page: 363,
    signal: "WARNING",
    hazards: ["Contains sulfuric acid electrolyte (corrosive)", "Hydrogen gas during charging (flammable)", "Lead components (toxic)", "Heavy — lifting hazard"],
    ppe: ["Safety glasses/face shield", "Chemical-resistant gloves", "Apron if handling electrolyte"],
    storage: "Cool, dry, ventilated area. Away from ignition sources during charging.",
    firstaid: "Acid contact: flush skin/eyes immediately with large amounts of water for 15 min. Seek medical attention.",
    fire: "CO₂ or dry chemical. Ventilate area — hydrogen gas present.",
    color: "red"
  },
  {
    name: "Vinyl Electrical Tape",
    brand: "3M",
    use: "Wire phasing and insulation",
    revised: "11/4/2022",
    page: 378,
    signal: "WARNING",
    hazards: ["Minimal hazard in normal use", "Combustible if exposed to flame"],
    ppe: ["No special PPE required for normal use"],
    storage: "Store at room temperature.",
    firstaid: "No special first aid required.",
    fire: "May burn. Use standard fire extinguisher.",
    color: "green"
  },
  {
    name: "Wasp & Hornet Spray",
    brand: "Raid",
    use: "Outdoor panel pest control",
    revised: "2/23/2015",
    page: 389,
    signal: "DANGER",
    hazards: ["Flammable aerosol", "Harmful if swallowed or inhaled", "Toxic to bees and aquatic organisms", "Eye/skin irritant"],
    ppe: ["Safety glasses", "Gloves", "No ignition sources while spraying"],
    storage: "Pressurized container. Away from heat and open flames.",
    firstaid: "Eyes: flush 15 min. Skin: wash with soap/water. Inhale: fresh air. Ingestion: call Poison Control.",
    fire: "Flammable aerosol — CO₂ or dry chemical.",
    color: "red"
  },
  {
    name: "Wire Pulling Lubricant",
    brand: "3M",
    use: "Conduit and cable pulling",
    revised: "4/30/2021",
    page: 404,
    signal: "WARNING",
    hazards: ["Mild skin/eye irritant", "Slipping hazard if spilled on floor"],
    ppe: ["Safety glasses", "Gloves (optional)"],
    storage: "Store above freezing if water-based. Keep container sealed.",
    firstaid: "Eyes: flush with water. Skin: wash.",
    fire: "Not flammable.",
    color: "green"
  }
];

let sdsCurrentSearch = '';
let sdsCurrentFilter = 'all';

/**
 * Initialize SDS page on load
 */
document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('sdsSearch');
  searchInput.addEventListener('input', (e) => {
    sdsCurrentSearch = e.target.value;
    renderSDS();
  });

  renderSDS();
});

/**
 * Get the emoji for a signal based on type and color
 */
function getSignalEmoji(signal, color) {
  if (signal === 'DANGER') return '🔴';
  if (signal === 'WARNING') return '🟠';
  if (color === 'yellow') return '🟡';
  if (color === 'blue') return '🔵';
  if (color === 'green') return '🟢';
  return '🟠';
}

/**
 * Render the SDS list based on current search and filter
 */
function renderSDS() {
  const list = document.getElementById('sdsList');
  if (!list) return;

  const q = sdsCurrentSearch.toLowerCase();
  const f = sdsCurrentFilter;

  let filtered = CHEMICALS.filter(c => {
    const matchQ = !q ||
      c.name.toLowerCase().includes(q) ||
      c.brand.toLowerCase().includes(q) ||
      c.use.toLowerCase().includes(q);

    const matchF = f === 'all' ||
      (f === 'DANGER' && c.signal === 'DANGER') ||
      (f === 'WARNING' && c.signal === 'WARNING') ||
      (f === 'flammable' && c.hazards.some(h => h.toLowerCase().includes('flammable')));

    return matchQ && matchF;
  });

  if (filtered.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🔎</div>
        <div class="empty-state-title">No products found</div>
        <div class="empty-state-text">Try adjusting your search or filters</div>
      </div>
    `;
    return;
  }

  list.innerHTML = filtered.map((c, i) => `
    <div class="sds-card" onclick="openSDS(${CHEMICALS.indexOf(c)})">
      <div class="sds-signal ${c.color}">${getSignalEmoji(c.signal, c.color)}</div>
      <div class="sds-info">
        <div class="sds-name">${c.name}</div>
        <div class="sds-brand">${c.brand}</div>
        <div class="sds-use">${c.use}</div>
      </div>
      <span class="signal-badge ${c.signal}">${c.signal}</span>
      <svg class="sds-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </div>
  `).join('');
}

/**
 * Filter SDS by search term (called on input)
 */
function filterSDS(val) {
  sdsCurrentSearch = val;
  renderSDS();
}

/**
 * Set the active filter (by signal or category)
 */
function setSDSFilter(f, btn) {
  sdsCurrentFilter = f;
  document.querySelectorAll('.sds-filter').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderSDS();
}

/**
 * Open SDS modal for a specific chemical
 */
function openSDS(idx) {
  const c = CHEMICALS[idx];
  if (!c) return;

  const overlay = document.getElementById('sdsModalOverlay');
  const modal = document.getElementById('sdsModal');
  const title = document.getElementById('modalTitle');
  const body = document.getElementById('modalBody');

  title.textContent = c.name;

  // Determine the background color for the header based on signal
  const bgColor = c.signal === 'DANGER' ? 'rgba(217, 48, 37, 0.12)' :
                  c.signal === 'WARNING' ? 'rgba(217, 119, 6, 0.12)' :
                  c.color === 'yellow' ? 'rgba(234, 179, 8, 0.12)' :
                  c.color === 'blue' ? 'rgba(3, 105, 161, 0.12)' :
                  'rgba(34, 197, 94, 0.12)';

  body.innerHTML = `
    <div class="sds-modal-section">
      <div class="sds-detail-header">
        <div class="sds-detail-icon">${getSignalEmoji(c.signal, c.color)}</div>
        <div class="sds-detail-meta">
          <div class="sds-detail-label">Manufacturer</div>
          <div class="sds-detail-value">${c.brand}</div>
          <div class="sds-detail-note">${c.use}</div>
        </div>
        <div class="sds-detail-badge">
          <span class="signal-badge ${c.signal}">${c.signal}</span>
          <div class="sds-detail-label" style="margin-top:6px;">Rev. ${c.revised}</div>
        </div>
      </div>
    </div>

    <div class="sds-modal-section">
      <div class="sds-detail-title">⚠️ Hazard identification</div>
      <div>
        ${c.hazards.map(h => `<span class="hazard-tag">${h}</span>`).join('')}
      </div>
    </div>

    <div class="sds-modal-section">
      <div class="sds-detail-title">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        </svg>
        Required PPE
      </div>
      <div>
        ${c.ppe.map(p => `<span class="ppe-tag">${p}</span>`).join('')}
      </div>
    </div>

    <div class="sds-modal-section">
      <div class="sds-detail-title">🚑 First aid measures</div>
      <div class="info-row">${c.firstaid}</div>
    </div>

    <div class="sds-modal-section">
      <div class="sds-detail-title">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2c0 2 1 3.5 2.5 5C16 8.5 17 10 17 12a5 5 0 0 1-10 0c0-2 1-3.5 2.5-5 .5.7.5 1.5.5 2"/>
        </svg>
        Fire fighting
      </div>
      <div class="info-row">${c.fire}</div>
    </div>

    <div class="sds-modal-section">
      <div class="sds-detail-title">📦 Storage</div>
      <div class="info-row">${c.storage}</div>
    </div>

    <div class="sds-modal-section">
      <div class="sds-detail-title">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
        </svg>
        SDS reference
      </div>
      <div class="info-row"><strong>Booklet page:</strong> Page ${c.page} of the Bates Electric SDS Booklet</div>
      <div class="info-row"><strong>SDS revised:</strong> ${c.revised}</div>
    </div>
  `;

  overlay.classList.add('open');
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
}

/**
 * Close the SDS modal
 */
function closeSDS() {
  const overlay = document.getElementById('sdsModalOverlay');
  const modal = document.getElementById('sdsModal');

  overlay.classList.remove('open');
  modal.classList.remove('open');
  document.body.style.overflow = '';
}

/**
 * Close modal when clicking outside (on overlay)
 */
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('sdsModalOverlay');
  if (overlay) {
    overlay.addEventListener('click', closeSDS);
  }

  // Also close on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSDS();
    }
  });
});
