  project('project:pfd-and-mass-balance', 'Process flow diagram with a closed mass balance', 'beginner', {
    summary: 'Pick a real process, draw the flow diagram and prove every kilogram is accounted for.',
    description:
      'A complete piece of process work at the smallest honest scale: one unit on a page, a stated basis, a balance that closes, and assumptions written where a reviewer can argue with them. A flow diagram is also the artifact a hiring manager can actually read.',
    objectives: [
      'Choose and state the process basis: feed rate, composition and operating conditions',
      'Draw a legible process flow diagram with stream numbers, equipment tags and utilities',
      'Close the overall mass balance and reconcile it against a published description of the process',
    ],
    deliverables: [
      'A readable process flow diagram',
      'A balance table with the closing error stated as a percentage',
      'A short note listing every assumption and what would falsify it',
    ],
    milestones: [
      'Flowsheet sketched and basis fixed',
      'Balance closed to within 2 %, with any residual explained',
      'Recycle and utility streams added without breaking the balance',
    ],
    testing: [
      'Re-close the balance from your own table without looking at your working',
      'Ask another person to read the diagram and tell you which stream is the feed and which is the product',
      'Check units on every number: a row without units is a defect',
    ],
    extensions: [
      'Add an energy balance and size the largest heater or cooler',
      'Enter the same flowsheet in a simulator and compare the two balances',
      'Add the control scheme for the most important variable in the process',
    ],
    tools: ['Spreadsheet', 'Drawing tool of your choice', 'DWSIM (optional)'],
    skillIds: ['skill:material-and-energy-balances', 'skill:process-safety-and-hazards'],
    safety: [
      'A paper exercise on published process descriptions. Do not build or run the process: even a scaled-down version of a real flowsheet needs a supervised laboratory, a chemical hazard assessment and a relief path.',
    ],
    hours: [10, 25],
    tags: ['beginner', 'chemical', 'design'],
  }),
  project('project:heat-exchanger-sizing', 'Heat exchanger sizing workbook', 'intermediate', {
    summary: 'Size an exchanger from a duty, a fouling allowance and a temperature programme, then check it three ways.',
    description:
      'One piece of equipment, done to the standard an employer would recognise: duty, log-mean temperature difference, an overall coefficient built from individual resistances, an area, and then cross-checks against a catalogue and a simulator. The interesting result is how far the answer moves when an assumption moves.',
    objectives: [
      'Compute the duty and temperature programme for a stated process stream',
      'Build the overall coefficient from a resistance network including fouling factors',
      'Report an area and geometry, plus the sensitivity to the fouling and coefficient assumptions',
    ],
    deliverables: [
      'A workbook with every term exposed, not only the final number',
      'A one-page datasheet for the chosen geometry',
      'A sensitivity table of area against fouling allowance',
    ],
    milestones: [
      'Duty and terminal temperatures fixed',
      'Overall coefficient reproduced from published correlations',
      'Sensitivity study and independent cross-check completed',
    ],
    testing: [
      'Recalculate one line of the workbook by hand and confirm the spreadsheet agrees',
      'Compare against an independent online calculator and explain any difference over 10 %',
      'Move the fouling factor by ±50 % and report how the area responds',
    ],
    extensions: [
      'Add pressure drop and check it against an allowable',
      'Replace constant properties with a property library and see what changes',
      'Build the same exchanger in a simulator and reconcile the two answers',
    ],
    tools: ['Spreadsheet', 'CoolProp', 'DWSIM'],
    skillIds: ['skill:heat-transfer', 'skill:material-and-energy-balances', 'skill:process-thermodynamics'],
    safety: [
      'Steady-state calculation only. If you later test a physical exchanger, hot water above 60 °C, pressurised loops and steam need supervision, a pressure-relief path and a written risk assessment.',
    ],
    hours: [15, 40],
    tags: ['intermediate', 'chemical', 'thermal'],
  }),
  project('project:kinetics-and-reactor-sizing', 'Kinetics fit and reactor sizing study', 'advanced', {
    summary: 'Fit a rate law to published data, then size two reactor types for the same duty and explain the difference.',
    description:
      'Reaction engineering done without a laboratory: published conversion-versus-time data, a fitted rate law with stated uncertainty, and then a CSTR and a plug-flow reactor sized for the same production rate. Comparing the two volumes is where the learning lands.',
    objectives: [
      'Fit a rate law to published data and report residuals rather than a single R² value',
      'Derive the design equations for the chosen reactor type',
      'Compare CSTR, plug-flow and batch volumes for an identical duty and explain the gap',
    ],
    deliverables: [
      'A fitting notebook or script with the data source cited',
      'Design calculations for two reactor types',
      'A written comparison naming the assumptions that drive the difference',
    ],
    milestones: ['Data source selected and cited', 'Rate law fitted with residuals reported', 'Reactor comparison written and checked'],
    testing: [
      'Refit with a subset of the data and report how much the parameters move',
      'Check that the units in the rate constant are consistent with the rate law as written',
      'Reproduce the numerical solution with a second method, such as an analytical limit case',
    ],
    extensions: [
      'Add temperature dependence through an Arrhenius term and discuss the extra uncertainty',
      'Add a simple heat balance and locate the hot spot',
      'Run the same kinetics in a kinetics library and compare the predictions',
    ],
    tools: ['Python', 'Cantera (optional)', 'Spreadsheet'],
    skillIds: ['skill:reaction-engineering', 'skill:process-simulation', 'skill:process-thermodynamics'],
    safety: [
      'Published data and simulation only. Do not attempt an exothermic reaction experiment outside a supervised laboratory with proper cooling, shielding and waste handling.',
    ],
    hours: [20, 50],
    tags: ['advanced', 'chemical', 'reactors'],
  }),


