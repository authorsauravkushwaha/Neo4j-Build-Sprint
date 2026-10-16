  /* ---- Chemical and process engineering ---- */
  skill('skill:material-and-energy-balances', 'Material and energy balances', 'beginner', [30, 80], {
    summary: 'Accounting for every kilogram and every joule that crosses a process boundary.',
    description:
      'The first real process skill. You pick a control volume, write down what enters and what leaves, and use conservation to find what you do not know — recycle, purge, yield, steam demand. Almost every later calculation is this same balance with more terms.',
    practice: [
      'Close a balance around a two-unit process with a recycle stream, and state your basis explicitly.',
      'Calculate the cooling duty of a reactor from an energy balance, then sanity-check it against the measured temperature rise.',
    ],
    criteria: [
      'You state your basis, units and assumption set before doing arithmetic.',
      'Your balance closes to a tolerance you chose and defended, not to a rounding accident.',
    ],
    tags: ['chemical', 'foundation', 'calculation'],
  }),
  skill('skill:process-thermodynamics', 'Process thermodynamics and phase equilibria', 'advanced', [40, 100], {
    summary: 'How phases split, what a separation really costs, and where the thermodynamic limit sits.',
    description:
      'Property data and phase behaviour decide whether a separation is feasible and what it costs to run. You work with vapour-liquid equilibrium, activity models, equations of state and enthalpy departures, and you learn to distrust a property estimate that arrives without a source.',
    practice: [
      'Flash a binary mixture by hand and with a property library, then explain any disagreement between them.',
      'Estimate the minimum energy of a separation from thermodynamics and compare it with a real design.',
    ],
    criteria: [
      'You can say which model you used for a non-ideal mixture, and why that model.',
      'You can state the thermodynamic limit of a proposed separation and how far the design is from it.',
    ],
    tags: ['chemical', 'thermodynamics', 'properties'],
  }),
  skill('skill:heat-transfer', 'Heat transfer', 'intermediate', [35, 90], {
    summary: 'Conduction, convection and radiation applied to exchanger duty, insulation and cooling.',
    description:
      'The transport side of thermal design: resistances in series, overall heat-transfer coefficients, log-mean temperature difference, fouling margins, and why a real exchanger rarely behaves like the datasheet. It is also the reason a plant has a cooling water system at all.',
    practice: [
      'Size a shell-and-tube exchanger for a stated duty and check the result against a manufacturer catalogue.',
      'Calculate the surface temperature of an insulated pipe and compare it with the safety limit you were given.',
    ],
    criteria: [
      'You can explain a sizing as a resistance network instead of reciting a formula.',
      'You state the fouling assumption you used and what it costs in surface area.',
    ],
    tags: ['chemical', 'transport', 'thermal'],
  }),
  skill('skill:mass-transfer-and-separations', 'Mass transfer and separation processes', 'advanced', [45, 110], {
    summary: 'Distillation, absorption, extraction, drying and membranes — and how to choose between them.',
    description:
      'Separations consume most of a plant’s energy and a large share of its capital. You learn staged and rate-based methods, reflux and stage efficiency, solvent selection, and the trade-offs that decide whether a column, a membrane or a crystalliser is the right answer.',
    practice: [
      'Design a binary distillation column to a stated purity and calculate reflux ratio and stage count.',
      'Compare two separation routes for the same duty on energy, capital and complexity.',
    ],
    criteria: [
      'You can explain why the reflux ratio you chose is not simply the minimum.',
      'You can defend a separation choice against two alternatives with numbers.',
    ],
    tags: ['chemical', 'separations', 'design'],
  }),
  skill('skill:reaction-engineering', 'Reaction engineering', 'advanced', [40, 100], {
    summary: 'Kinetics, reactor types and the operating point that sets conversion, selectivity and safety.',
    description:
      'Reactions rarely give you exactly what you want. You work with rate laws, residence time, CSTR and plug-flow behaviour, heat release and hot spots, and the difference between what a flask does and what a continuous reactor does at scale.',
    practice: [
      'Fit a rate law to published conversion data and state the confidence you have in the fit.',
      'Size a CSTR and a plug-flow reactor for the same duty and explain why the volumes differ.',
    ],
    criteria: [
      'You can explain why a hot spot forms and how you would remove that heat.',
      'You state the assumptions behind your kinetics model rather than presenting the fit as truth.',
    ],
    tags: ['chemical', 'reactors', 'kinetics'],
  }),
  skill('skill:process-instrumentation-and-control', 'Process instrumentation and control', 'intermediate', [35, 80], {
    summary: 'Sensors, control loops, tuning, and reading a P&ID as the working document it is.',
    description:
      'A process is only as good as the loop holding it steady. You learn what instruments measure and what they actually report, how transmitters, controllers, control valves and interlocks combine into a loop, and how to tune one without destabilising the unit next door.',
    practice: [
      'Trace one control loop on a real P&ID from sensor to final element and write your own loop description.',
      'Tune a simulated flow or level loop and record how the response changes with each gain change.',
    ],
    criteria: [
      'You can read a P&ID and say what each instrument tag is for.',
      'You can explain the difference between a control loop and a safety interlock, with an example of each.',
    ],
    tags: ['chemical', 'control', 'instrumentation'],
  }),
  skill('skill:process-safety-and-hazards', 'Process safety and hazard analysis', 'intermediate', [25, 60], {
    summary: 'Finding the ways a process can injure people or destroy equipment, before it does.',
    description:
      'Safety is a design activity, not a paragraph at the end of a report. You learn hazard identification, deviation-based studies such as HAZOP, layer-of-protection thinking, relief and flare basics, and how real incidents trace back to design and management decisions rather than one bad component.',
    practice: [
      'Run a small hazard study on a published flowsheet and record deviations, causes, consequences and safeguards.',
      'Read one investigation report from a public safety board and list the design changes it recommended.',
    ],
    criteria: [
      'You can distinguish a hazard from a risk, and a safeguard from an administrative control.',
      'You can name the inherently safer option you would choose before adding another instrument.',
    ],
    tags: ['chemical', 'safety', 'risk'],
  }),
  skill('skill:process-simulation', 'Steady-state process simulation', 'intermediate', [30, 70], {
    summary: 'Building a flowsheet in a simulator, making it converge, and knowing when not to trust it.',
    description:
      'A simulator closes balances that would take days by hand, and it will supply a confident answer to a badly posed question. The skill is problem definition: property package, specification set, degrees of freedom, convergence, and reconciling the output against reality.',
    practice: [
      'Build and converge a two-column flowsheet, then reconcile its outlet stream against a hand balance.',
      'Break your own simulation deliberately — remove a specification or choose the wrong property package — and describe the failure mode.',
    ],
    criteria: [
      'You can count the degrees of freedom and say what each specification means physically.',
      'You can list which results you verified independently and which you accepted from the simulator.',
    ],
    tags: ['chemical', 'simulation', 'tools'],
  }),


