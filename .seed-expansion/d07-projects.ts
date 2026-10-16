  /* --- Surveying and geospatial engineering --- */
  project('project:qgis-neighbourhood-map', 'A real map of a place you know, from open data', 'beginner', {
    summary: 'Build a map that answers one question about your neighbourhood, with its projection and accuracy stated.',
    description:
      'Pick a small area — your neighbourhood, a campus, a route you use. Assemble a base map, at least one boundary layer, one point layer and one thematic layer from open data or your own field notes, put everything in one coordinate reference system on purpose, and produce a print layout at a stated scale. The map has to answer a question, not merely be colourful.',
    objectives: [
      'Assemble layers from at least two independent sources and record where each came from',
      'Choose and justify a coordinate reference system for the area and the scale',
      'Produce a legible map that answers one specific question',
    ],
    deliverables: [
      'A project file plus an exported map with title, scale bar, north arrow and data sources',
      'A one-page note on the projection chosen, the accuracy of each layer, and what you could not map',
      'A layer list with each field’s meaning and units',
    ],
    milestones: ['Area chosen and question defined', 'Source data downloaded with licences noted', 'Layers aligned in one CRS', 'Layout exported at a stated scale'],
    testing: [
      'Overlay two data sets that should line up and measure the disagreement',
      'Reproject the map and check that distances and areas still look sane',
      'Ask somebody unfamiliar to read the map and tell you what it answers',
    ],
    extensions: [
      'Publish the same content as an interactive web map and note what the web viewer loses',
      'Add a field-collected layer with an accuracy estimated from your own measurements',
      'Rebuild one layer from a second source and state which is better and why',
    ],
    tools: ['QGIS', 'Open data portals', 'OpenStreetMap export'],
    skillIds: ['skill:gis-and-spatial-analysis', 'skill:geodesy-and-coordinate-systems'],
    safety: [
      'Field collection: mind road traffic, weather and private property. Do not record people or enter sites without permission, and respect the licence and attribution terms of every data source you use.',
    ],
    hours: [12, 30],
    tags: ['beginner', 'geospatial', 'gis'],
  }),
  project('project:gnss-accuracy-field-study', 'How accurate is your GNSS, really? A field study', 'intermediate', {
    summary: 'Measure what your device can actually do in three environments, and explain the differences with the mechanism.',
    description:
      'A field study you can run with a phone or a cheap receiver. Occupy a point whose position you know, log positions over time, then repeat under open sky, tree cover and between buildings. Compute the horizontal scatter, look at the satellite geometry, and explain the differences through geometry, multipath and signal delay rather than a shrug.',
    objectives: [
      'Design a repeatable field procedure and log track or raw data honestly',
      'Compute error statistics against a known or independently measured point',
      'Explain each environment through dilution of precision, multipath and atmosphere',
    ],
    deliverables: [
      'A procedure somebody else could repeat, with the equipment named',
      'Scatter plots and error statistics per environment',
      'A written analysis separating what your method supports from what it cannot claim',
    ],
    milestones: ['Reference point measured or sourced', 'Logs collected in three environments', 'Statistics computed', 'Analysis written with DOP and multipath discussed'],
    testing: [
      'Repeat one environment on another day and see whether the statistics hold',
      'Test whether averaging a longer log reduces error, and whether it converges',
      'Compare the recorded positions in the datums your device reports',
    ],
    extensions: [
      'Compare a device using a correction service against standalone positioning',
      'Repeat with a second device and separate hardware differences from environmental ones',
    ],
    tools: ['Phone or GNSS receiver', 'Spreadsheet or Python', 'QGIS for plotting'],
    skillIds: ['skill:gnss-positioning', 'skill:land-surveying-and-error-budgets', 'skill:probability-statistics'],
    safety: [
      'Fieldwork: choose safe places and times, stay out of traffic, and do not obstruct anyone. Never use this study for legal boundary work — that needs a licensed surveyor and the legal framework of your country, and a phone is not a substitute.',
    ],
    hours: [10, 25],
    tags: ['intermediate', 'geospatial', 'gnss'],
  }),
  project('project:terrain-and-flood-screening', 'Terrain and low-lying-ground screening from open elevation data', 'intermediate', {
    summary: 'Derive slope and drainage from a real elevation model, then state in writing what the result cannot be used for.',
    description:
      'Download an elevation model for a catchment or town, derive slope and flow accumulation, identify low-lying ground relative to a river or coast, and produce a screening map. Then write the limitations section properly: vertical accuracy, resolution, the difference between a surface and bare earth, and the fact that this is not a hydraulic flood study.',
    objectives: [
      'Obtain and document an elevation data set with its resolution and stated accuracy',
      'Derive terrain attributes and drainage lines with a method you can defend',
      'Produce a screening map whose limits are stated in the same document',
    ],
    deliverables: [
      'A terrain map — hillshade, slope, flow accumulation — with sources cited',
      'A low-lying-ground map overlaid with a water course and known assets',
      'A limitations note explaining what a hydraulic study would add and who must sign one',
    ],
    milestones: ['DEM downloaded with metadata recorded', 'Terrain derivatives produced', 'Screening map drawn', 'Limitations and hand-off note written'],
    testing: [
      'Change the flow-accumulation threshold and watch how the drainage network changes',
      'Compare your screening against a documented flood event or a published flood map',
      'Check several points against a second elevation source and report the disagreement',
    ],
    extensions: [
      'Add published rainfall scenarios and show the sensitivity of the result',
      'Repeat with a lidar bare-earth model and compare it against the surface model',
      'Automate the workflow so it reruns on a new tile without manual steps',
    ],
    tools: ['QGIS with a terrain or hydrology plugin', 'OpenTopography or a national elevation portal', 'Python (rasterio or GDAL) if scripting'],
    skillIds: ['skill:terrain-and-surface-modelling', 'skill:gis-and-spatial-analysis', 'skill:geospatial-data-quality-and-standards'],
    safety: [
      'This is a screening exercise, not a flood risk assessment. Flood hazard, insurance and planning decisions need a licensed hydraulic study and the responsible authority. Do not publish the output as safety advice about anybody’s property.',
    ],
    hours: [15, 35],
    tags: ['intermediate', 'geospatial', 'terrain'],
  }),
  project('project:sentinel-change-detection', 'Change detection from satellite imagery, validated', 'advanced', {
    summary: 'Find a real change between two satellite dates — then validate it instead of asserting it.',
    description:
      'Pick an area and two dates either side of a change you have independent reason to expect: a construction site, a burn scar, a seasonal flood. Work with Sentinel imagery at its real resolution, mask cloud properly, compute an index or band difference, and then validate part of the result against something known. The deliverable pairs a map with an honest error discussion.',
    objectives: [
      'Search, download and document imagery with acquisition dates and processing level',
      'Mask cloud and shadow and explain what that removed',
      'Compute a change metric, then validate a sample of it against independent evidence',
    ],
    deliverables: [
      'Before and after composites plus the change map with legend and scale',
      'A validation table: sample points, what the map says, what the reference says, disagreements included',
      'An uncertainty note covering resolution, registration, seasonality, and what would strengthen the result',
    ],
    milestones: ['Area and reference event chosen', 'Imagery downloaded and documented', 'Cloud masking applied', 'Change metric computed and validated on a sample'],
    testing: [
      'Repeat with a different index or threshold and report how much the answer moves',
      'Shift one image by a pixel and check whether your result survives — registration matters',
      'Examine a known false-positive area such as open water or bare soil and say how you would separate it',
    ],
    extensions: [
      'Add a third date to separate permanent change from seasonal variation',
      'Classify the type of change rather than only detecting that it happened',
      'Automate the pipeline so the same result can be produced from the raw archive',
    ],
    tools: ['Copernicus Data Space browser and APIs', 'QGIS with raster tools', 'Python (rasterio, numpy) if scripting'],
    skillIds: ['skill:remote-sensing-and-imagery', 'skill:gis-and-spatial-analysis', 'skill:probability-statistics'],
    safety: [
      'Respect imagery licence and attribution terms, and do not publish claims about specific private sites or identifiable people. Satellite imagery can reveal sensitive locations: treat anything you can identify as personal data.',
    ],
    hours: [20, 45],
    tags: ['advanced', 'geospatial', 'remote-sensing'],
  }),


