  project('project:ecg-signal-study', 'ECG analysis of a public dataset', 'intermediate', {
    summary: 'Take one real ECG record, clean it, measure it and say honestly what the measurement can and cannot support.',
    description:
      'An actual biomedical signal, worked end to end on public data instead of a synthetic sine wave: baseline wander, mains interference, beat detection, heart-rate variability and the artefact that ruins the result if you ignore it. No patient, no risk and no hardware required — and the workflow is the one used in a real device pipeline.',
    objectives: [
      'Load a public ECG record and document its sampling rate, gain and known artefacts',
      'Remove baseline wander and interference and show the before-and-after without hiding the damage',
      'Detect beats, compute a heart-rate measure, and state the uncertainty in it',
    ],
    deliverables: [
      'A notebook or script that runs from the raw record to the final measure',
      'A short report naming the artefacts and the filters used to remove them',
      'A statement of what the result does and does not show clinically',
    ],
    milestones: ['Record loaded and described', 'Filters applied with before-and-after evidence', 'Measure computed with the artefact limited stated'],
    testing: [
      'Apply the same pipeline to a second record and check nothing silently breaks',
      'Deliberately inject 50 Hz interference and confirm the notch filter removes it',
      'Compare detected beat count against the annotation file shipped with the record',
    ],
    extensions: [
      'Add a simple arrhythmia screen and report its false-positive rate on annotated data',
      'Port the detection step to a microcontroller and estimate its memory use',
      'Repeat the pipeline on an EMG record and discuss what changes',
    ],
    tools: ['Python', 'NumPy', 'SciPy', 'PhysioNet data'],
    skillIds: ['skill:biomedical-signals-and-instrumentation', 'skill:physiological-modelling'],
    safety: [
      'Recorded public data only. Never connect a homemade circuit to a person: mains-powered equipment on a human body is dangerous and requires medically rated, isolated front ends plus institutional approval.',
    ],
    hours: [20, 50],
    tags: ['intermediate', 'biomedical', 'signals'],
  }),
  project('project:gait-analysis-opensim', 'Gait analysis with an open musculoskeletal model', 'advanced', {
    summary: 'Simulate one movement in an open biomechanics model and quantify how much the answer depends on your assumptions.',
    description:
      'The body as a mechanism: scale a musculoskeletal model to a walk cycle, drive it with motion data, and inspect the joint moments it predicts. The honest part of the project is the sensitivity study — which joint, and by how much, moves the result.',
    objectives: [
      'Scale an open model to a subject and check it against published segment lengths',
      'Run an inverse kinematics and inverse dynamics analysis on one movement',
      'Quantify sensitivity to at least two assumptions, such as mass distribution or marker placement',
    ],
    deliverables: ['A working model and settings file', 'Plots of joint angles and moments over the cycle', 'A sensitivity table naming the assumptions that matter most'],
    milestones: ['Model scaled and validated', 'Analysis run on real motion data', 'Sensitivity study written'],
    testing: [
      'Re-run with perturbed marker positions and check the joint moment changes as expected',
      'Compare your model output with a published dataset for a comparable movement',
      'Check that the model is in equilibrium where it should be, rather than drifting',
    ],
    extensions: [
      'Compare a movement before and after a change in load or footwear',
      'Add a simple assistive device to the model and estimate its effect on joint load',
      'Repeat for a second subject and report inter-subject variation',
    ],
    tools: ['OpenSim', 'Python', 'Motion capture or public motion datasets'],
    skillIds: ['skill:biomechanics', 'skill:physiological-modelling', 'skill:programming-fundamentals'],
    safety: [
      'Simulation on public or consented motion data. If you collect your own video, obtain consent from everyone in frame, and do not ask participants to perform movements that could injure them.',
    ],
    hours: [25, 60],
    tags: ['advanced', 'biomedical', 'biomechanics'],
  }),
  project('project:medical-device-risk-file', 'Risk file for a simple assistive device', 'intermediate', {
    summary: 'Design a small assistive device on paper and produce the risk documentation a reviewer would ask for.',
    description:
      'The part of medical engineering that is not a calculation: intended use, users and environments, hazard analysis, risk controls with evidence, and the residual risk you accept in writing. The device can be deliberately simple — a pill organiser, a walking aid, a grip attachment — because the documentation is the deliverable.',
    objectives: [
      'Write an intended use and user profile that excludes the cases you cannot support',
      'Identify hazards and hazardous situations from use, misuse and foreseeable abuse',
      'Specify risk controls and the verification evidence for each control',
    ],
    deliverables: [
      'An intended-use and user-profile statement',
      'A risk table: hazard, sequence of events, harm, severity, controls, verification',
      'A short statement of residual risk and the open questions you would need a clinician to answer',
    ],
    milestones: ['Intended use and user profile written', 'Hazard analysis complete against a checklist', 'Controls traced to verification evidence'],
    testing: [
      'Ask someone unfamiliar with the device to attempt the task and record what they did wrong',
      'Check every control has an evidence reference, and delete any control you cannot verify',
      'Re-read the intended use and confirm nothing in the file claims more than it allows',
    ],
    extensions: [
      'Add a usability test with five participants and summarise the failures',
      'Compare your file structure against a published regulatory guidance outline',
      'Draft the labelling and instructions for use, including the limits',
    ],
    tools: ['Spreadsheet or document editor'],
    skillIds: ['skill:medical-device-regulation-and-quality', 'skill:assistive-and-rehab-technology'],
    safety: [
      'A documentation exercise, not a regulatory submission. Nothing in this project authorises making a medical claim or supplying a device: check the rules that apply where you live before building anything for a person to use.',
    ],
    hours: [15, 35],
    tags: ['intermediate', 'biomedical', 'documentation'],
  }),


