// Safety Documents Database
const SAFETY_DOCS = {
  'sheq': {
    title: 'SHEQ Policy',
    desc: 'Safety, Health, Environment & Quality commitments',
    icon: '📋',
    html: `
      <div class="policy-card">
        <strong>Our Commitment</strong>
        <p>At Bates Electric, we do not want to harm people or the environment. Safety, health, care for the environment and quality are a pre-requisite to any business we undertake.</p>
      </div>

      <div class="doc-section">
        <div class="doc-section-title">Core commitments</div>
        <ul>
          <li>We all take personal responsibility for SHEQ</li>
          <li>Managers at all levels demonstrate visible leadership</li>
          <li>We apply this policy in our day-to-day behavior and decisions</li>
          <li>SHEQ is 100% of our behavior, 100% of the time</li>
        </ul>
      </div>

      <div class="doc-section">
        <div class="doc-section-title">Objectives</div>
        <ul>
          <li>Zero incidents</li>
          <li>Zero harm to communities in which we do business</li>
          <li>Safe, secure, and healthy working conditions for all our people</li>
          <li>Supplying safe, compliant, and environmentally responsible products and services</li>
          <li>Prevention of pollution to the environment</li>
          <li>Responsible use of natural resources</li>
          <li>Satisfy customer needs and expectations</li>
        </ul>
      </div>

      <div class="doc-section">
        <div class="doc-section-title">We will</div>
        <ul>
          <li>Comply with all applicable legal, regulatory, internal, and industry requirements</li>
          <li>Pro-actively identify, eliminate, or minimize potential sources of harm or risk</li>
          <li>Continuously improve our performance to achieve our objectives</li>
          <li>Share our knowledge and experience in safety, health, and environment</li>
          <li>Show accountability by regularly measuring, reviewing, and reporting performance</li>
          <li>Require our contractors and partners to manage in line with this policy</li>
          <li>Provide training, standards, equipment, and support to ensure compliance</li>
          <li>Maintain open communications with our local communities and stakeholders</li>
        </ul>
      </div>

      <div class="doc-section">
        <div class="doc-section-title">Behavior Based Safety</div>
        <div class="golden-rule"><div class="gr-dot"></div><div>
          <div class="gr-name">The ultimate goal</div>
          <div class="gr-desc">Having a workforce that is completely integrated with safety — where the behavior of each individual contributes positively to the safety of everyone around them.</div>
        </div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div>
          <div class="gr-name">WorkSafe & ActSafe programs</div>
          <div class="gr-desc">All Bates Electric safety programs are stepping stones toward behavior-based safety. It is a goal that requires constant effort to maintain.</div>
        </div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div>
          <div class="gr-name">Safety observation</div>
          <div class="gr-desc">Any worker, at any time, has the right and responsibility to observe and correct unsafe behavior. There shall be no reprisals for bringing a safety concern to management.</div>
        </div></div>
      </div>

      <div class="doc-section">
        <div class="doc-section-title">Employee responsibilities</div>
        <ul>
          <li>Place safety and health as first importance in all work duties</li>
          <li>Notify your supervisor of any violation or safety deficiency immediately</li>
          <li>Notify supervisor of every injury, accident, or near miss — no matter how trivial</li>
          <li>Obey all safety instructions, rules, policies, and procedures</li>
          <li>Do not modify any safety equipment</li>
          <li>Do not use defective tools or equipment without proper guarding</li>
          <li>All injuries — including minor first aid — must be reported in writing to your supervisor</li>
          <li>Good conduct is expected — horseplay will not be tolerated</li>
          <li>Never work while impaired by alcohol or illegal drugs</li>
          <li>Failure to comply with Safety and Health Rules may result in disciplinary action up to dismissal</li>
        </ul>
      </div>

      <div class="doc-section">
        <div class="doc-section-title">Bates Electric responsibilities</div>
        <ul>
          <li>Develop and maintain an effective occupational safety and health program</li>
          <li>Never require an employee to work in hazardous conditions without proper training and PPE</li>
          <li>Conduct frequent and regular workplace inspections</li>
          <li>Tag, lock, or remove unsafe tools, materials, or equipment from the workplace</li>
          <li>Provide training on how to recognize and avoid unsafe conditions</li>
          <li>Provide access to all medical services required for on-the-job injuries or illnesses</li>
          <li>Provide appropriate PPE and conduct hazard assessments</li>
        </ul>
      </div>

      <div class="contact-card" style="margin-top:8px;">
        <div class="contact-name">Christopher Bates</div>
        <div class="contact-role">President & CEO — Personal commitment to SHEQ policy</div>
        <div class="contact-info"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg> cbates@bates-electric.com</div>
      </div>
    `
  },

  'full-manual-pdf': {
    title: 'Full Safety Manual PDF',
    desc: 'Complete 2026 Employee Safety Handbook',
    icon: '📖',
    html: `
      <div class="policy-card">
        <strong>Complete 2026 Safety Handbook</strong>
        <p>The full Employee Safety Manual is hosted on Bates Electric SharePoint. Access it below for the most up-to-date comprehensive safety guide.</p>
      </div>

      <div class="doc-section">
        <div class="doc-section-title">Manual sections</div>
        <ul>
          <li>Introduction — Golden Rules of Safety (p.1)</li>
          <li>SHEQ Policy & Behavior Based Safety (p.2–5)</li>
          <li>Safety & Health Rules — Employee & Company (p.6–7)</li>
          <li>Incident Reporting Process (p.8–10)</li>
          <li>Facility Safety Rules: Asbestos, Biological Hazards, Confined Space (p.11–13)</li>
          <li>Early Return to Work Program (p.14)</li>
          <li>Emergency Response Plan (p.15)</li>
          <li>Electrical Safety & LO/TO (p.16–17, 32–33)</li>
          <li>Fall Protection, Fire Prevention, First Aid (p.18–21)</li>
          <li>Housekeeping, Hazard Communication, Health Hazards (p.22–27)</li>
          <li>Hot Work, Laboratory Safety, Lifting (p.28–31)</li>
          <li>PPE, Portable Ladders, Scaffolds (p.39–42)</li>
          <li>Tools, Trenching, Workplace Injuries (p.45–50)</li>
          <li>Ergonomics, Office Safety (p.51–55)</li>
          <li>Off-the-Job Safety & Emergency Planning (p.56–57)</li>
        </ul>
      </div>

      <div class="alert-box info">ℹ️ <div>This document is hosted on Bates Electric SharePoint. An internet connection is required to view it. Contact your supervisor if you have trouble accessing it.</div></div>
    `
  },

  'sds-info': {
    title: 'Safety Data Sheets',
    desc: 'Chemical hazards & safe handling information',
    icon: '🧪',
    html: `
      <div class="policy-card"><strong>How to Access SDS Files</strong><p>Safety Data Sheets describe the hazards, safe handling, and emergency procedures for every chemical used on Bates Electric job sites.</p></div>

      <div class="doc-section"><div class="doc-section-title">Option 1 — Company SDS Link</div>
        <div class="golden-rule"><div style="font-size:20px;flex-shrink:0;">📁</div><div>
          <div class="gr-name">Open Full SDS Document</div>
          <div class="gr-desc">Your supervisor or Safety Manager can provide the direct link or file location for the master SDS binder.</div>
        </div></div>
      </div>

      <div class="doc-section"><div class="doc-section-title">Option 2 — Add SDS Link to This App</div>
        <ul>
          <li>Upload your SDS PDF to Google Drive, Dropbox, or OneDrive</li>
          <li>Share the link with your app administrator</li>
          <li>The link will be embedded directly in this document for one-tap access</li>
        </ul>
      </div>

      <div class="doc-section"><div class="doc-section-title">What SDS sheets contain</div>
        <ul>
          <li>Chemical identification and hazard classification</li>
          <li>Safe handling and storage procedures</li>
          <li>Personal protective equipment required</li>
          <li>First aid measures and emergency response</li>
          <li>Spill cleanup and disposal procedures</li>
          <li>Physical and health hazard data</li>
        </ul>
      </div>

      <div class="alert-box warning">⚠️ <div>If you encounter a chemical not in the SDS binder, stop work and contact your supervisor or Safety Manager immediately.</div></div>
    `
  },

  'emergency': {
    title: 'Emergency Response',
    desc: 'Procedures for immediate threats & incidents',
    icon: '🚨',
    html: `
      <div class="alert-box danger">⚠️ <div><strong>If there is immediate danger to life — call 911 first.</strong> Then notify your Site Lead or Facility Manager.</div></div>

      <div class="doc-section"><div class="doc-section-title">Immediate steps</div>
        <ul>
          <li>Take actions needed to immediately protect life safety</li>
          <li>Call 911 if medical emergency or fire</li>
          <li>Report to Site Lead or Facility Manager immediately</li>
          <li>Facility Managers must call the OSC within 2 hours: <strong>636-561-9444</strong></li>
          <li>Do not disturb the scene unless necessary to prevent further injury</li>
        </ul>
      </div>

      <div class="doc-section"><div class="doc-section-title">Investigation timeline</div>
        <ul>
          <li><strong>Within 2 hours:</strong> Facility Manager contacts OSC at 636-561-9444</li>
          <li><strong>Within 72 hours:</strong> Complete investigation report with root cause analysis</li>
          <li><strong>Within 4 working days:</strong> Conference call with Safety Coordinator, Corporate Safety Manager, HR, and Director of Operations</li>
        </ul>
      </div>

      <div class="doc-section"><div class="doc-section-title">Fire / evacuation</div>
        <ul>
          <li>If fire alarm sounds — immediately evacuate the building</li>
          <li>Do NOT run. Do NOT use elevators. Use stairwells.</li>
          <li>Report to your designated meeting area outside</li>
          <li>Do not re-enter until instructed by management</li>
        </ul>
      </div>

      <div class="contact-card"><div class="contact-name">Operations Support Center</div><div class="contact-role">24-hour staffed</div><div class="contact-info"><a href="tel:6365619444"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.77 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l.91-.91a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg> 636-561-9444</a></div></div>
    `
  },

  'golden-rules': {
    title: 'Golden Rules of Safety',
    desc: 'The 7 critical safety rules all workers must follow',
    icon: '⭐',
    html: `
      <div class="policy-card"><strong>The Golden Rules</strong><p>Must be adhered to at all times by everyone. These cover the critical areas presenting the highest risk of serious injury or fatality.</p></div>

      <div class="doc-section"><div class="doc-section-title">The 7 Golden Rules</div>
        <div class="golden-rule"><div class="gr-dot"></div><div><div class="gr-name">1. Incident Reporting</div><div class="gr-desc">Report all incidents so causes can be identified, corrected, and learning shared.</div></div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div><div class="gr-name">2. Driving and Vehicles</div><div class="gr-desc">Drive safely and responsibly at all times. Use all provided safety equipment.</div></div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div><div class="gr-name">3. Permit to Work</div><div class="gr-desc">Assess hazards and risks before starting any work. Put appropriate controls in place.</div></div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div><div class="gr-name">4. Working at Height</div><div class="gr-desc">Always apply and use required safety measures when working at heights.</div></div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div><div class="gr-name">5. Lifting Operations</div><div class="gr-desc">Safely control all lifting operations using cranes or other lifting devices.</div></div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div><div class="gr-name">6. Engineering Management of Change</div><div class="gr-desc">Temporary or permanent changes require a completed Engineering Management of Change process before proceeding.</div></div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div><div class="gr-name">7. Contractor Management</div><div class="gr-desc">Select and manage contractors to a level dependent on the risk of the work being carried out.</div></div></div>
      </div>

      <div class="doc-section"><div class="doc-section-title">General principles</div>
        <ul>
          <li>Work will not be conducted without a pre-job risk assessment</li>
          <li>All persons will be trained and competent in the work they conduct</li>
          <li>PPE will be worn as defined by risk assessment and local site requirements</li>
          <li>Everyone has an obligation to stop work they consider unsafe</li>
          <li>We will not work under the influence of drugs or alcohol</li>
        </ul>
      </div>
    `
  },

  'ppe': {
    title: 'Personal Protective Equipment',
    desc: 'PPE requirements by job and hazard type',
    icon: '🪖',
    html: `
      <div class="alert-box info">ℹ️ <div>Your supervisor's annual hazard assessment will identify the specific PPE required for your job. Always confirm with your supervisor before starting work.</div></div>

      <div class="doc-section"><div class="doc-section-title">PPE by type</div>
        <div class="golden-rule"><div style="font-size:20px;flex-shrink:0;">🪖</div><div><div class="gr-name">Head Protection</div><div class="gr-desc">Required where there is danger of head injury. Class A for general construction. Class B required for high voltage electrical work. (ANSI-Z-89.1-1986)</div></div></div>
        <div class="golden-rule"><div style="font-size:20px;flex-shrink:0;">👂</div><div><div class="gr-name">Ear Protection</div><div class="gr-desc">Required when engineering controls cannot reduce noise to acceptable OSHA levels.</div></div></div>
        <div class="golden-rule"><div style="font-size:20px;flex-shrink:0;">🥽</div><div><div class="gr-name">Eye & Face Protection</div><div class="gr-desc">Required when exposed to flying particles, molten metal, dust, chemicals, gases, radiation, or other harmful exposures.</div></div></div>
        <div class="golden-rule"><div style="font-size:20px;flex-shrink:0;">😷</div><div><div class="gr-name">Respiratory Protection</div><div class="gr-desc">Required when airborne contaminants exceed OSHA Threshold Limit Values. Must be part of a formal respiratory protection program.</div></div></div>
        <div class="golden-rule"><div style="font-size:20px;flex-shrink:0;">👟</div><div><div class="gr-name">Foot Protection</div><div class="gr-desc">Required in areas with danger from falling/rolling objects, piercing, or electrical/chemical hazards. (ANSI-Z-41-1991)</div></div></div>
        <div class="golden-rule"><div style="font-size:20px;flex-shrink:0;">🧤</div><div><div class="gr-name">Hand Protection</div><div class="gr-desc">Required for physical, biological, chemical, radiation, or electrical hazards. Electrical gloves must meet ASTM D-120-87.</div></div></div>
        <div class="golden-rule"><div style="font-size:20px;flex-shrink:0;">🪢</div><div><div class="gr-name">Fall Protection</div><div class="gr-desc">Required at 6 ft or more not protected by guardrails. Includes harness, lifelines, and lanyards.</div></div></div>
      </div>
    `
  },

  'electrical': {
    title: 'Electrical Safety',
    desc: 'Lockout/Tagout, GFCIs, and power safety',
    icon: '⚡',
    html: `
      <div class="alert-box danger"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> <div><strong>To the maximum extent possible, all electrical work shall be done with the power OFF.</strong></div></div>

      <div class="doc-section"><div class="doc-section-title">Core requirements</div>
        <ul>
          <li>All work shall follow Federal and Bates Electric requirements and good industry practices</li>
          <li>A LO/TO system shall be used to ensure all power is removed before work begins</li>
          <li>Circuits shall be checked with proper equipment to verify no voltage is present</li>
          <li>Extension cords used with portable tools must be 3-wire grounded and GFCI protected</li>
          <li>Worn, frayed, or damaged cords shall NOT be used — tag and discard immediately</li>
          <li>Extension cords are temporary wiring — 90-day maximum per NEC</li>
        </ul>
      </div>

      <div class="doc-section"><div class="doc-section-title">Lockout / Tagout — removal from service</div>
        <ul>
          <li>1. Prepare for shutdown — notify all affected employees</li>
          <li>2. Shut down the equipment or system</li>
          <li>3. Isolate the equipment or system</li>
          <li>4. Apply LO/TO device (lock + tag)</li>
          <li>5. Dissipate all stored energy</li>
          <li>6. Verify isolation before proceeding</li>
        </ul>
      </div>

      <div class="doc-section"><div class="doc-section-title">GFCIs</div>
        <ul>
          <li>Required on all circuits in damp, wet, or outdoor locations</li>
          <li>Required at all construction site receptacles not part of permanent wiring</li>
          <li>Temporary wiring shall be de-energized when not in use</li>
        </ul>
      </div>
    `
  },

  'reporting': {
    title: 'Incident Reporting',
    desc: 'Report injuries, near misses, and unsafe conditions',
    icon: '📝',
    html: `
      <div class="policy-card"><strong>Why We Report</strong><p>Incidents are rarely caused by a single event. Reporting breaks the chain of behaviors before they cause serious injury. The goal is prevention — not blame.</p></div>

      <div class="doc-section"><div class="doc-section-title">What to report</div>
        <ul>
          <li>All injuries — including minor first aid</li>
          <li>Near misses — no matter how minor</li>
          <li>Fires, property damage, vehicle accidents</li>
          <li>Hazardous material spills</li>
          <li>Any unsafe conditions or behaviors</li>
        </ul>
      </div>

      <div class="doc-section"><div class="doc-section-title">Reporting timeline</div>
        <ul>
          <li><strong>Immediately:</strong> Notify your supervisor</li>
          <li><strong>Within 2 hours:</strong> Facility Manager calls OSC — 636-561-9444</li>
          <li><strong>Within 72 hours:</strong> Complete investigation report with root cause</li>
          <li><strong>Within 4 working days:</strong> Conference call with all stakeholders</li>
        </ul>
      </div>

      <div class="alert-box warning">⚠️ <div>There shall be NO retaliation against any employee for reporting a safety concern in good faith.</div></div>
    `
  },

  'falls': {
    title: 'Fall Protection',
    desc: 'Ladder, scaffold, and heights safety',
    icon: '🪜',
    html: `
      <div class="alert-box danger">⚠️ <div><strong>OSHA requires fall protection at 6 ft in construction</strong> and 4 ft in general industry. Working over dangerous equipment requires protection at ANY height.</div></div>

      <div class="doc-section"><div class="doc-section-title">Ladder rules</div>
        <ul>
          <li>Inspect all ladders before daily use — defective ladders must be tagged and removed</li>
          <li>Do NOT use aluminum ladders near power lines — use fiberglass only for electrical work</li>
          <li>Extension ladders must be tied-off and secured</li>
          <li>Ladder must extend 3 feet above the point of support</li>
          <li>Set at correct angle: base distance = ¼ of working length</li>
          <li>One person on a ladder at a time</li>
          <li>Do not stand on the top step of a stepladder</li>
        </ul>
      </div>

      <div class="doc-section"><div class="doc-section-title">Scaffold rules</div>
        <ul>
          <li>Only competent, authorized employees shall erect scaffolds</li>
          <li>Must support at least 4x maximum intended load</li>
          <li>Guardrails and toe boards required on all open sides above 6 feet</li>
          <li>Lock scaffold wheels when employees are on it</li>
          <li>Do not move a scaffold while occupied</li>
        </ul>
      </div>
    `
  },

  'loto': {
    title: 'Lockout / Tagout',
    desc: 'Energy isolation procedures for equipment maintenance',
    icon: '🔒',
    html: `
      <div class="alert-box danger">⚠️ <div><strong>NEVER service or maintain a machine without implementing LO/TO.</strong> OSHA 29 CFR 1910.147.</div></div>

      <div class="doc-section"><div class="doc-section-title">Removal from service</div>
        <ul>
          <li>1. Prepare for shutdown — notify all affected employees</li>
          <li>2. Shut down the equipment or system</li>
          <li>3. Isolate the equipment or system</li>
          <li>4. Apply LO/TO device (lock + tag)</li>
          <li>5. Dissipate all stored energy</li>
          <li>6. Verify isolation before proceeding</li>
        </ul>
      </div>

      <div class="doc-section"><div class="doc-section-title">Release from LO/TO</div>
        <ul>
          <li>1. Inspect the area — confirm work is complete</li>
          <li>2. Notify all affected employees</li>
          <li>3. Remove LO/TO devices</li>
          <li>4. Restore energy — operate energy isolation devices</li>
        </ul>
      </div>

      <div class="alert-box info">ℹ️ <div>Locks are provided by your supervisor and used ONLY for lockout. Tags must read "DO NOT OPERATE" and be applied by hand.</div></div>
    `
  },

  'hotwork': {
    title: 'Hot Work Program',
    desc: 'Welding, cutting, brazing & fire safety',
    icon: '🔥',
    html: `
      <div class="policy-card">
        <strong>Permit Required — Before Every Job</strong>
        <p>All hot work requires a permit obtained from the Director of Safety or your site supervisor before work begins. This program protects you and everyone on site from fire, explosion, and burn hazards.</p>
      </div>

      <div class="alert-box danger"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c0 2 1 3.5 2.5 5C16 8.5 17 10 17 12a5 5 0 0 1-10 0c0-2 1-3.5 2.5-5 .5.7.5 1.5.5 2"/></svg> <div><strong>OSHA Definition:</strong> Hot work includes welding, soldering, brazing, flame cutting, thawing pipes, heat guns, torch-applied roofing, chipping, grinding, drilling, and any spark-producing operation — including mechanical friction and static discharge.</div></div>

      <div class="doc-section">
        <div class="doc-section-title">Before you begin — required steps</div>
        <ul>
          <li>Obtain a Hot Work Permit from the Director of Safety or site supervisor</li>
          <li>Inspect all equipment — ensure everything is in good operating order before starting</li>
          <li>Inspect the work area for combustible materials in partitions, walls, and ceilings</li>
          <li>Move all flammable and combustible materials at least <strong>20–35 feet</strong> from the hot work area</li>
          <li>If combustibles cannot be moved, cover with fire-resistant blankets or shields</li>
          <li>Protect gas lines and equipment from falling sparks and hot materials</li>
          <li>Remove any spilled grease, oil, or other combustible liquids from the area</li>
          <li>Sweep clean all combustible debris from floors around the work zone</li>
          <li>Combustible floors must be kept wet with water — <strong>only when electrical circuits are de-energized</strong></li>
          <li>Block off cracks between floorboards, along baseboards and walls, and under door openings with fire-resistant material</li>
          <li>Close all doors and windows to contain sparks</li>
          <li>Cover wall and ceiling surfaces with fire-resistant, heat-insulating material</li>
          <li>Secure, isolate, and vent pressurized vessels, piping, and equipment</li>
          <li>Eliminate explosive atmospheres — if you cannot eliminate vapors or combustible dust, do not proceed</li>
          <li>Shut down any process that produces combustible atmospheres in the work zone</li>
        </ul>
      </div>

      <div class="doc-section">
        <div class="doc-section-title">During hot work</div>
        <ul>
          <li>Post a <strong>trained fire watcher</strong> within the work area at all times during operations, including during breaks</li>
          <li>Continuously monitor the area for accumulation of combustible gases</li>
          <li>Use water only if electrical circuits have been de-energized</li>
          <li>Schedule hot work during shutdown periods whenever possible</li>
          <li>Comply with all applicable legislation and workplace standards</li>
        </ul>
      </div>

      <div class="doc-section">
        <div class="doc-section-title">After hot work — inspection required</div>
        <ul>
          <li>Fire watcher must remain for at least <strong>30–60 minutes after work stops</strong> — up to 3 hours depending on the job</li>
          <li>Inspect the area — ensure wall surfaces, studs, wires, and materials have not heated up</li>
          <li>Vacuum combustible debris from ventilation and service duct openings</li>
          <li>Seal any cracks in ducts and cover duct openings with a fire-resistant barrier</li>
          <li>Inspect ductwork after all hot work has concluded</li>
        </ul>
      </div>

      <div class="doc-section">
        <div class="doc-section-title">Required PPE</div>
        <ul>
          <li><strong>Welding:</strong> Welding helmet, leather gloves, flame-resistant clothing, leather boots</li>
          <li><strong>Torch cutting / brazing:</strong> Face shield, leather gloves, flame-resistant jacket</li>
          <li><strong>Grinding / cutting:</strong> Safety glasses with side shields, face shield, cut-resistant gloves</li>
          <li><strong>All hot work:</strong> No synthetic clothing — fire-resistant or natural fiber only near arc or flame</li>
        </ul>
      </div>

      <div class="doc-section">
        <div class="doc-section-title">Safer alternatives — avoid hot work when possible</div>
        <div class="golden-rule"><div class="gr-dot"></div><div><div class="gr-name">Instead of saw or torch cutting</div><div class="gr-desc">Use manual hydraulic shears</div></div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div><div class="gr-name">Instead of welding</div><div class="gr-desc">Use mechanical bolting where possible</div></div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div><div class="gr-name">Instead of sweat soldering</div><div class="gr-desc">Use screwed or flanged pipe connections</div></div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div><div class="gr-name">Instead of torch or radial saw cutting</div><div class="gr-desc">Use a mechanical pipe cutter</div></div></div>
      </div>

      <div class="doc-section">
        <div class="doc-section-title">Emergency contacts</div>
        <div class="contact-card">
          <div class="contact-name">Fire emergency</div>
          <div class="contact-role">If fire ignites — evacuate and call immediately</div>
          <div class="contact-info"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.77 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l.91-.91a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg> 911</div>
        </div>
        <div class="contact-card">
          <div class="contact-name">Bates Electric Safety Dept.</div>
          <div class="contact-role">Hot Work Permits & Incident reporting</div>
          <div class="contact-info"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.77 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l.91-.91a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg> (636) 464-3939</div>
        </div>
        <div class="contact-card">
          <div class="contact-name">Operations Support Center</div>
          <div class="contact-role">24-hour staffed — Must call within 2 hrs of any incident</div>
          <div class="contact-info"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.77 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l.91-.91a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg> 636-561-9444</div>
        </div>
      </div>

      <div class="alert-box warning">⚠️ <div>Failure to obtain a Hot Work Permit or follow this program may result in disciplinary action up to and including dismissal.</div></div>
    `
  },

  'confined': {
    title: 'Confined Space Entry',
    desc: 'Atmospheric testing and rescue procedures',
    icon: '⛔',
    html: `
      <div class="policy-card">
        <strong>Permit Required — Entry Is Prohibited Without One</strong>
        <p>No employee shall enter a confined space or break the plane of entry with any part of their body without being trained and having fully implemented the confined space entry procedure. Governed by OSHA 29 CFR 1910.146.</p>
      </div>

      <div class="alert-box danger">⚠️ <div><strong>OSHA estimates 66% of confined space deaths result from rescue attempts.</strong> If someone collapses inside, do NOT enter to rescue unless you are trained and equipped. Call 911 immediately.</div></div>

      <div class="doc-section">
        <div class="doc-section-title">What is a confined space?</div>
        <ul>
          <li>Large enough for an employee to enter or break the plane of entry</li>
          <li>Has restricted means of entry or exit</li>
          <li>Has unfavorable natural ventilation</li>
          <li>Not designed for continuous employee occupancy</li>
        </ul>
      </div>

      <div class="doc-section">
        <div class="doc-section-title">Common examples at Bates Electric job sites</div>
        <ul>
          <li>Manholes and vaults</li>
          <li>Trenches deeper than 4 feet</li>
          <li>Underground utility tunnels</li>
          <li>Tanks, silos, and digesters</li>
          <li>Sewers and storm drains</li>
        </ul>
      </div>

      <div class="doc-section">
        <div class="doc-section-title">Atmospheric hazards — test before entry</div>
        <ul>
          <li><strong>Oxygen deficiency:</strong> Normal air is 20.9% O₂ — below 19.5% is immediately dangerous</li>
          <li><strong>Flammable gases/vapors:</strong> Test for LEL (lower explosive limit) before any ignition source</li>
          <li><strong>Toxic gases:</strong> H₂S, CO, and other gases can accumulate in enclosed spaces</li>
          <li><strong>Carbon monoxide:</strong> Never run gas-powered equipment near a confined space entry</li>
        </ul>
      </div>

      <div class="doc-section">
        <div class="doc-section-title">Required before entry — permit process</div>
        <ul>
          <li>Obtain a signed Confined Space Entry Permit from your supervisor</li>
          <li>Identify and test for all atmospheric hazards using calibrated equipment</li>
          <li>Ventilate the space continuously throughout the entire operation</li>
          <li>Assign an <strong>Attendant</strong> who remains outside at all times and monitors the entrant</li>
          <li>Establish a rescue plan — contact 911 and local fire rescue before entry if required</li>
          <li>Ensure all energy sources are isolated via Lockout/Tagout (LO/TO) before entry</li>
          <li>Verify oxygen level, flammable gas level, and toxic gas levels are within safe limits</li>
        </ul>
      </div>

      <div class="doc-section">
        <div class="doc-section-title">Roles</div>
        <div class="golden-rule"><div class="gr-dot"></div><div>
          <div class="gr-name">Entry Supervisor</div>
          <div class="gr-desc">Authorizes the permit, verifies safe conditions, can cancel entry at any time.</div>
        </div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div>
          <div class="gr-name">Entrant</div>
          <div class="gr-desc">The worker who enters the space. Must communicate continuously with the Attendant.</div>
        </div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div>
          <div class="gr-name">Attendant (Hole Watch)</div>
          <div class="gr-desc">Stays outside. Monitors the entrant, maintains the permit log, and initiates rescue if needed. Never enters the space.</div>
        </div></div>
      </div>

      <div class="doc-section">
        <div class="doc-section-title">Required PPE</div>
        <ul>
          <li>Full-body harness with retrieval line attached to a mechanical retrieval device</li>
          <li>Supplied air respirator or SCBA if atmosphere is not confirmed safe</li>
          <li>Continuous gas monitor (personal 4-gas monitor recommended)</li>
          <li>Intrinsically safe lighting — no standard flashlights in potentially flammable atmospheres</li>
          <li>Hard hat, safety glasses, gloves appropriate to the hazard</li>
        </ul>
      </div>

      <div class="doc-section">
        <div class="doc-section-title">Immediate evacuation required if</div>
        <ul>
          <li>Gas monitor alarm activates for any hazard</li>
          <li>Entrant shows signs of distress</li>
          <li>Communication with Attendant is lost</li>
          <li>Condition inside changes unexpectedly</li>
          <li>Attendant cannot perform duties</li>
        </ul>
      </div>

      <div class="alert-box warning">⚠️ <div>Detailed Bates Electric confined space entry procedures and permit forms are in a separate document. Contact your supervisor or the Safety Department at (636) 464-3939 before any confined space work.</div></div>

      <div class="contact-card">
        <div class="contact-name">Bates Electric Safety Dept.</div>
        <div class="contact-role">Confined space permits and procedures</div>
        <div class="contact-info"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.77 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l.91-.91a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg> (636) 464-3939</div>
      </div>
    `
  },

  'safety-manual': {
    title: 'Safety Manual 2026',
    desc: 'Quick links to key safety topics',
    icon: '📚',
    html: `
      <div class="policy-card"><strong>Bates Electric Safety Goal</strong><p>Every employee or contractor should have the expectation that they will complete each workday — and their entire career — without a job-related injury or illness.</p></div>

      <div class="doc-section"><div class="doc-section-title">Manual topics in this app</div>
        <div class="golden-rule"><div class="gr-dot"></div><div><div class="gr-name">Golden Rules of Safety</div><div class="gr-desc">The 7 critical safety rules required of all workers — incident reporting, driving, permit to work, heights, lifting, management of change, and contractor management.</div></div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div><div class="gr-name">Electrical Safety</div><div class="gr-desc">Power-off work standards, Lockout/Tagout procedures, extension cord safety, and GFCI requirements.</div></div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div><div class="gr-name">Fall Protection</div><div class="gr-desc">Ladder inspection, angle, tie-off, and scaffold safety rules to prevent falls from heights.</div></div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div><div class="gr-name">Lockout / Tagout</div><div class="gr-desc">Energy isolation procedures to prevent machine startups during maintenance and repair work.</div></div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div><div class="gr-name">Hot Work Procedures</div><div class="gr-desc">Permits, fire watch, combustible material clearance, and post-work inspection for welding and cutting.</div></div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div><div class="gr-name">Confined Space Entry</div><div class="gr-desc">Atmospheric testing, rescue procedures, attendant duties, and permit requirements for enclosed spaces.</div></div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div><div class="gr-name">PPE Requirements</div><div class="gr-desc">Head, eye, ear, respiratory, hand, foot, and fall protection requirements by job type and hazard.</div></div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div><div class="gr-name">Incident Reporting</div><div class="gr-desc">Why we report, what to report, and the timeline from immediate notification through investigation.</div></div></div>
        <div class="golden-rule"><div class="gr-dot"></div><div><div class="gr-name">Emergency Response</div><div class="gr-desc">Immediate life safety, evacuation procedures, investigation timeline, and emergency contacts.</div></div></div>
      </div>

      <div class="alert-box info">ℹ️ <div>This app contains key sections of the 2026 handbook. For the full physical document, see your supervisor.</div></div>
    `
  }
};

// Initialize page
document.addEventListener('DOMContentLoaded', function() {
  renderDocCards();
  setupSearch();
});

function renderDocCards() {
  const grid = document.getElementById('docs-grid');
  grid.innerHTML = '';

  Object.entries(SAFETY_DOCS).forEach(([key, doc]) => {
    const card = document.createElement('button');
    card.className = 'doc-card';
    card.onclick = () => openDoc(key);
    card.innerHTML = `
      <div class="doc-icon">${doc.icon}</div>
      <div class="doc-title">${doc.title}</div>
      <div class="doc-desc">${doc.desc}</div>
    `;
    grid.appendChild(card);
  });
}

function setupSearch() {
  const searchInput = document.getElementById('search-input');
  const grid = document.getElementById('docs-grid');
  const empty = document.getElementById('docs-empty');

  searchInput.addEventListener('input', function(e) {
    const query = e.target.value.toLowerCase().trim();
    let visibleCount = 0;

    grid.querySelectorAll('.doc-card').forEach((card, index) => {
      const key = Object.keys(SAFETY_DOCS)[index];
      const doc = SAFETY_DOCS[key];
      const matches = doc.title.toLowerCase().includes(query) ||
                      doc.desc.toLowerCase().includes(query);

      if (query === '' || matches) {
        card.classList.remove('hidden');
        visibleCount++;
      } else {
        card.classList.add('hidden');
      }
    });

    empty.style.display = visibleCount === 0 ? 'block' : 'none';
  });
}

function openDoc(key) {
  const doc = SAFETY_DOCS[key];
  if (!doc) return;

  document.getElementById('modalTitle').textContent = doc.title;
  document.getElementById('modalBody').innerHTML = doc.html;
  document.getElementById('docModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  document.getElementById('docModal').classList.remove('open');
  document.body.style.overflow = '';
}

function goBack() {
  window.location.href = 'home.html';
}

// Close modal on overlay click
document.addEventListener('DOMContentLoaded', function() {
  const modal = document.getElementById('docModal');
  if (modal) {
    modal.addEventListener('click', function(e) {
      if (e.target === modal) {
        closeModal();
      }
    });
  }
});
