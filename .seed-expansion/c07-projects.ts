  project('project:spc-control-chart-study', 'Control chart study on a real measurement series', 'intermediate', {
    summary: 'Take a real process measurement series, chart it properly and say which signals matter.',
    description:
      'A quality-engineering exercise with no laboratory needed: a public or self-collected measurement series, a chart chosen for the data type, control limits computed from the process rather than the specification, and a written judgement on what each out-of-control signal means — including the ones you decide are ordinary variation.',
    objectives: [
      'Choose the right chart for the measurement type and justify the choice',
      'Compute control limits from the data and mark every signal against the standard rules',
      'Separate the signals that indicate a real change from the ones you judge to be routine',
    ],
    deliverables: [
      'A chart with limits, signals and the rule cited for each signal',
      'A capability calculation with its assumption on normality stated',
      'A short written judgement on what you would investigate first on the shop floor',
    ],
    milestones: ['Data source documented', 'Limits and signals computed', 'Investigation plan written with causes ranked'],
    testing: [
      'Recompute limits on the first half of the data and check the second half behaves as expected',
      'Introduce a deliberate shift into a copy of the data and confirm your rules catch it',
      'Check whether a single outlier is driving your limits, and say what you did about it',
    ],
    extensions: [
      'Add an exponentially weighted moving average chart and compare its sensitivity',
      'Design a sampling plan for the same process and cost it against full inspection',
      'Repeat on an attribute measurement and discuss why the charts differ',
    ],
    tools: ['Spreadsheet or R', 'Public process datasets'],
    skillIds: ['skill:quality-engineering-and-spc', 'skill:probability-statistics'],
    safety: [
      'Analysis of existing data only. Do not intervene in a live production process to generate data: any change on a running line needs the owner’s authority, a risk assessment and a plan for what happens if the change degrades quality.',
    ],
    hours: [12, 30],
    tags: ['intermediate', 'industrial', 'quality'],
  }),
  project('project:line-balance-and-layout', 'Line balancing and layout for a small assembly', 'intermediate', {
    summary: 'Design a real assembly line on paper: takt time, station content, staffing and the bottleneck.',
    description:
      'Choose a product you can describe with ten to thirty assembly steps — a lamp, a bike, a control panel — estimate the work content of each step honestly, and balance them into stations against a takt time derived from demand. Then state what it costs, who does what, and where the line will break first.',
    objectives: [
      'Break a product into work elements with realistic time estimates',
      'Compute takt time from demand and balance the elements into stations',
      'Design a layout, staffing level and buffer policy that can actually run',
    ],
    deliverables: [
      'A precedence diagram and a station balance table',
      'A layout drawing at scale with flow direction and buffer locations',
      'A one-page explanation of the bottleneck and your contingency for it',
    ],
    milestones: ['Work elements and times documented with sources', 'Balance achieved within the takt time', 'Layout and staffing costed'],
    testing: [
      'Re-balance with a 20 % demand increase and report how many stations you must add',
      'Check the balance against a variability assumption rather than against perfect times',
      'Ask someone to walk your layout on paper and find where they get stuck',
    ],
    extensions: [
      'Add changeover between two product variants and quantify the cost',
      'Introduce a kanban sizing rule for the buffers you designed',
      'Redesign one station for ergonomics and re-time it',
    ],
    tools: ['Spreadsheet', 'Drawing tool', 'FreeCAD or any CAD (optional)'],
    skillIds: ['skill:manufacturing-systems-and-lean', 'skill:production-planning-and-scheduling', 'skill:work-design-and-ergonomics'],
    safety: [
      'A paper design exercise. If you trial it physically, the work area needs an assessment for manual handling, machine guarding and electrical risk before anyone stands in it, and the people doing the work must be involved in the design.',
    ],
    hours: [15, 35],
    tags: ['intermediate', 'industrial', 'design'],
  }),
  project('project:plc-interlock-simulation', 'Conveyor interlock logic, simulated', 'intermediate', {
    summary: 'Write and simulate machine control logic, then argue why the safety function does not live in the software.',
    description:
      'Automation without a factory: a simulated conveyor with start, stop, jam detection and an emergency stop, written as ladder or state-machine logic, tested against a fault list you write yourself. The point is not the simulation — it is the reasoning about what the logic may control and what must be hard-wired.',
    objectives: [
      'Write control logic for a simple machine with defined states and transitions',
      'Test the logic against a written fault list, including stuck sensors and power restoration',
      'Set out which functions must be safety-rated hardware and why',
    ],
    deliverables: [
      'Simulated logic with a readable state description',
      'A fault-injection table with the observed response for each fault',
      'A safety rationale separating control functions from protective functions',
    ],
    milestones: ['Logic runs in simulation', 'Fault list tested and results recorded', 'Safety rationale written and reviewed'],
    testing: [
      'Restore power mid-cycle and confirm the machine does not restart itself',
      'Force a sensor to stick at its last value and record what your logic does',
      'Press emergency stop during the fastest part of the cycle and check the safe state',
    ],
    extensions: [
      'Add a second conveyor and an interlock between them',
      'Add production counting and a simple efficiency calculation',
      'Rewrite the safety function as a risk assessment with a required performance level',
    ],
    tools: ['PLC simulator', 'FreeCAD (optional, for the cell layout)'],
    skillIds: ['skill:industrial-automation-and-plc', 'skill:sensors-and-actuators'],
    safety: [
      'Simulation only. Do not wire, program or interfere with a real machine control panel: that work needs lock-out/tag-out training, arc-flash protection, employer authorisation and supervision, and it kills people who improvise it.',
    ],
    hours: [15, 40],
    tags: ['intermediate', 'industrial', 'automation'],
  }),


