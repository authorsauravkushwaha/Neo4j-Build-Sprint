  /* ---- Industrial and manufacturing engineering ---- */
  skill('skill:manufacturing-systems-and-lean', 'Manufacturing systems and lean thinking', 'intermediate', [30, 70], {
    summary: 'Flow, takt, pull and the seven wastes — improving the system rather than pushing harder.',
    description:
      'Lean is a measurement discipline, not a set of posters. You calculate takt time from demand, map a value stream, find where the work waits, distinguish a bottleneck from a busy station, and pick improvements by their effect on flow instead of by how visible they are.',
    practice: [
      'Map the value stream for a process you can observe and mark every point where work waits.',
      'Calculate takt time for a stated demand and compare it with your measured cycle times.',
    ],
    criteria: [
      'You can say which station constrains the whole line, and why.',
      'You can propose an improvement and predict its effect on throughput before you make it.',
    ],
    tags: ['industrial', 'lean', 'flow'],
  }),
  skill('skill:quality-engineering-and-spc', 'Quality engineering and statistical process control', 'intermediate', [30, 70], {
    summary: 'Control charts, capability and sampling: detecting when a process changed rather than when a part was bad.',
    description:
      'Inspection finds defects after the cost is spent; control charts find the change that causes them. You learn variable and attribute charts, the difference between control limits and specification limits, capability indices, and how to design a sampling plan that gives you a defensible answer.',
    practice: [
      'Build a control chart from a real measurement series and identify every out-of-control signal.',
      'Calculate capability for a process and state whether the specification is realistic for it.',
    ],
    criteria: [
      'You can explain why a point inside the specification limits can still be a signal.',
      'You can say which chart suits an attribute measurement and why the others do not.',
    ],
    tags: ['industrial', 'quality', 'statistics'],
  }),
  skill('skill:production-planning-and-scheduling', 'Production planning and scheduling', 'intermediate', [25, 60], {
    summary: 'Turning demand into a feasible plan: capacity, sequencing, queues and the cost of changeovers.',
    description:
      'A plan that ignores capacity is a wish. You work with demand and forecasting, aggregate capacity, bottleneck scheduling and setup trade-offs, and you learn the queueing intuition that tells you why utilisation above about eighty per cent makes lead times explode.',
    practice: [
      'Sequence a small order book through a two-machine shop and compare makespan across two rules.',
      'Show how lead time responds as utilisation rises, using a simple queueing model.',
    ],
    criteria: [
      'You can explain why a schedule that maximises machine utilisation can make delivery worse.',
      'You can state your planning assumptions and what breaks them.',
    ],
    tags: ['industrial', 'planning', 'operations'],
  }),
  skill('skill:industrial-automation-and-plc', 'Industrial automation and PLC logic', 'intermediate', [35, 80], {
    summary: 'Machine control, interlocks and safety circuits — and the difference between what works and what is safe.',
    description:
      'Automation is logic plus the physical world: sensors that lie, actuators that stick, and people who will eventually reach into the machine. You learn ladder logic and state machines for control, the separation between control and safety functions, and why a simulation is the only responsible place to start.',
    practice: [
      'Write and simulate a conveyor interlock with a start/stop chain and an emergency stop.',
      'List the failure modes of your own logic and say which ones need a hard-wired safeguard.',
    ],
    criteria: [
      'You can explain why a software interlock is not a substitute for a safety-rated circuit.',
      'You can describe what happens in your logic when a sensor sticks at its last value.',
    ],
    tags: ['industrial', 'automation', 'control', 'safety'],
  }),
  skill('skill:work-design-and-ergonomics', 'Work design, ergonomics and human factors', 'intermediate', [20, 50], {
    summary: 'Designing the task around a person who is tired, interrupted and built like an actual body.',
    description:
      'The cheapest improvement is often a change in how the work is arranged. You learn work measurement and standard time, task analysis, lifting and posture risk, attention and error, and how to change a workstation so the work is both faster and less damaging to the person doing it.',
    practice: [
      'Analyse one repetitive task for posture and force risk and propose two changes that remove the risk rather than the symptom.',
      'Time-study a task and state the allowances and rating assumptions behind your standard time.',
    ],
    criteria: [
      'You can distinguish a human error from a system that made the error likely.',
      'You can justify a workstation change on both output and injury-risk grounds.',
    ],
    tags: ['industrial', 'ergonomics', 'human-factors'],
  }),
  skill('skill:maintenance-and-reliability', 'Maintenance and reliability engineering', 'intermediate', [25, 60], {
    summary: 'Making failure predictable: failure modes, preventive and predictive maintenance, and spares policy.',
    description:
      'Equipment fails in patterns, and some of those patterns reward waiting while others punish it. You learn failure modes and effects analysis, mean time between failures, condition monitoring and the economics that decide whether to replace, inspect or run to failure — with the safety case on top.',
    practice: [
      'Run a failure-modes exercise on one machine and rank the modes by consequence and detectability.',
      'Decide a maintenance policy for three components with different failure patterns and justify each.',
    ],
    criteria: [
      'You can say why a scheduled replacement can increase failures for some components.',
      'You can state what a condition-monitoring system must measure to be worth installing.',
    ],
    tags: ['industrial', 'reliability', 'maintenance'],
  }),
  skill('skill:supply-chain-and-inventory', 'Supply chain and inventory management', 'intermediate', [25, 60], {
    summary: 'Lead times, safety stock and the bullwhip effect: why the order you place is bigger than the demand you saw.',
    description:
      'Inventory exists because supply and demand do not arrive together. You learn lot sizing, reorder points and safety stock under uncertain demand, the amplification that runs up a supply chain, and how supplier quality and lead-time variability dominate almost everything else you do.',
    practice: [
      'Set a reorder point and safety stock for one item from its demand and lead-time variability.',
      'Simulate the bullwhip effect in a four-tier chain and explain the amplification you see.',
    ],
    criteria: [
      'You can explain why reducing lead-time variability can cut inventory more than cutting the average lead time.',
      'You can state the service level your stock policy implies and what it costs.',
    ],
    tags: ['industrial', 'supply-chain', 'inventory'],
  }),


