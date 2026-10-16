  /* ---- Biomedical engineering ---- */
  skill('skill:biomedical-signals-and-instrumentation', 'Biomedical signals and instrumentation', 'intermediate', [30, 70], {
    summary: 'Acquiring tiny physiological signals safely: electrodes, amplifiers, filtering and patient isolation.',
    description:
      'An ECG is a millivolt signal on a body that is also a conductor sitting in a room full of mains wiring. You learn electrode behaviour, differential amplification, common-mode rejection, bandwidth and anti-alias filtering, and the electrical safety rules that decide what may be connected to a person at all.',
    practice: [
      'Take one public ECG record, remove baseline wander and mains interference, and show the before and after.',
      'Calculate the common-mode rejection you need to keep mains hum below the amplitude of the signal you want.',
    ],
    criteria: [
      'You can explain why a differential amplifier is used instead of a better single-ended one.',
      'You can state the isolation and leakage-current limits that apply before anything touches a patient.',
    ],
    tags: ['biomedical', 'signals', 'instrumentation', 'safety'],
  }),
  skill('skill:biomechanics', 'Biomechanics', 'intermediate', [35, 80], {
    summary: 'Statics and dynamics of the body: joint loads, gait, and what a replacement part has to survive.',
    description:
      'The human body is a mechanism with unusual materials. You estimate forces at joints from free-body diagrams, examine gait cycles and ground reaction forces, and learn why an implant’s loading history, not just its strength, decides whether it survives.',
    practice: [
      'Estimate the knee joint reaction force in a single-leg stance from a free-body diagram and state your assumptions.',
      'Break one gait cycle into phases and say which muscles and moments dominate each phase.',
    ],
    criteria: [
      'You can defend a simplified body model, including what it leaves out.',
      'You can describe the load cycle an implant sees over a million steps.',
    ],
    tags: ['biomedical', 'mechanics', 'human-body'],
  }),
  skill('skill:biomaterials-and-biocompatibility', 'Biomaterials and biocompatibility', 'advanced', [30, 80], {
    summary: 'Choosing a material that the body will tolerate, and proving it will not fail quietly.',
    description:
      'Inside the body, metals corrode, polymers release additives and every surface provokes a response. You work with the material classes used in implants, corrosion and wear mechanisms, sterilisation effects, and the tests that stand in for years of service.',
    practice: [
      'Compare three candidate materials for one implant application on strength, corrosion and cost, and pick one.',
      'Design a screening test that would reject a bad surface finish before an animal study.',
    ],
    criteria: [
      'You can explain why a material that is inert in air may not be inert in tissue.',
      'You can name the failure mode you were most worried about and how you tested for it.',
    ],
    tags: ['biomedical', 'materials', 'implants'],
  }),
  skill('skill:medical-device-regulation-and-quality', 'Medical device regulation and quality systems', 'intermediate', [25, 60], {
    summary: 'Risk management, design controls and the evidence trail that lets a device reach a patient.',
    description:
      'A device is not finished when it works — it is finished when there is traceable evidence that it works and that its risks are controlled. You learn the shape of a quality management system for medical devices, risk management in the ISO 14971 sense, the main approval routes and what post-market surveillance actually obliges you to do.',
    practice: [
      'Write a risk file outline for one simple device: intended use, hazards, controls, and the evidence for each control.',
      'Take a published device and identify which classification route it would take in two different jurisdictions.',
    ],
    criteria: [
      'You can distinguish a hazard, a hazardous situation and a risk, with an example of each.',
      'You can state what a design change does to a risk file and which parts must be re-verified.',
    ],
    tags: ['biomedical', 'regulation', 'quality', 'risk'],
  }),
  skill('skill:medical-imaging-basics', 'Medical imaging basics', 'advanced', [35, 90], {
    summary: 'How X-ray, CT, MRI and ultrasound form an image, and what limits what you can see in it.',
    description:
      'Each modality trades off contrast, resolution, dose and time. You learn the physical interaction behind each one, the reconstruction idea that turns measurements into a picture, and the honest limits: artefacts, noise and the difference between a bright pixel and a diagnosis.',
    practice: [
      'Take one public image dataset and describe the artefacts you can see and what caused them.',
      'Compare two modalities for one clinical question on contrast, dose and practicality.',
    ],
    criteria: [
      'You can explain in one paragraph how an MRI signal is made to depend on tissue.',
      'You can state the resolution, noise and artefact limits for a modality you are working with.',
    ],
    tags: ['biomedical', 'imaging', 'physics'],
  }),
  skill('skill:physiological-modelling', 'Physiological modelling', 'advanced', [30, 80], {
    summary: 'Turning a body system into equations you can simulate, calibrate and doubt.',
    description:
      'Compartmental models, first-order kinetics and transport models make physiology computable. The craft is the same as any modelling: choose the structure for the question, state the parameters with their variation, and check the model against measurements it was not fitted to.',
    practice: [
      'Fit a two-compartment pharmacokinetic model to public data and report the residuals.',
      'Change one parameter by 20 % and report how much the prediction moves.',
    ],
    criteria: [
      'You can describe what your model deliberately leaves out and why that is acceptable for your question.',
      'You can validate against data you did not fit on, or say clearly that you could not.',
    ],
    tags: ['biomedical', 'modelling', 'physiology'],
  }),
  skill('skill:assistive-and-rehab-technology', 'Assistive and rehabilitation technology', 'intermediate', [25, 70], {
    summary: 'Devices that restore function, designed with the people who will use them rather than for them.',
    description:
      'Assistive technology only works if it fits a real body, a real routine and a real budget. You learn user-centred design with disabled users, prosthetics and orthotics basics, seating and mobility, and how to evaluate a device on function achieved rather than on engineering elegance.',
    practice: [
      'Interview or observe one assistive device in use and document three failures a designer would not have predicted.',
      'Propose a modification and define how you would measure whether it helped.',
    ],
    criteria: [
      'You can describe a device’s limitations from the user’s perspective, not the spec sheet.',
      'You can state which outcome measure you would use and why it is the right one.',
    ],
    tags: ['biomedical', 'accessibility', 'human-factors'],
  }),


