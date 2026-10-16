  assessment('assessment:biomedical-signals-check', 'Biomedical signals check', {
    skillId: 'skill:biomedical-signals-and-instrumentation',
    summary: 'Amplifiers, interference and the safety rules that come before the signal.',
    difficulty: 'intermediate',
    questions: [
      ['An ECG front end uses a differential amplifier mainly to…', ['increase gain', 'reject the mains interference common to both electrodes', 'remove baseline wander', 'protect the patient'], 1],
      ['A signal sampled at 250 Hz without an anti-alias filter can be corrupted by…', ['mains hum', 'higher-frequency content folding down into the band of interest', 'electrode drift', 'quantisation only'], 1],
      ['Which limit matters most before an electrode touches a patient?', ['The amplifier bandwidth', 'Leakage current through the patient', 'The ADC resolution', 'The display refresh rate'], 1],
      ['Baseline wander in an ECG usually comes from…', ['power line interference', 'patient movement and respiration', 'the ADC', 'aliasing'], 1],
    ],
  }),
  assessment('assessment:medical-device-regulation-check', 'Medical device regulation check', {
    skillId: 'skill:medical-device-regulation-and-quality',
    summary: 'Intended use, risk controls and what happens after a design change.',
    difficulty: 'intermediate',
    questions: [
      ['The intended use statement matters most because it…', ['is required for marketing', 'defines the population and conditions the evidence must cover', 'describes the software architecture', 'lists the materials used'], 1],
      ['In risk management terms, the sequence is…', ['hazard, hazardous situation, harm', 'harm, hazard, control', 'risk, hazard, complaint', 'control, harm, hazard'], 0],
      ['The most reliable order for reducing risk is…', ['inherently safe design, then protective measures, then information for safety', 'information, then training, then alarms', 'alarms, then procedures, then design', 'testing, then labelling, then design'], 0],
      ['After a design change that affects a risk control, you must…', ['ship it and monitor complaints', 're-verify that control and update the risk file', 'add a warning label', 'wait for the next audit'], 1],
    ],
  }),


