  /* ---- Surveying and geospatial engineering ---- */
  skill('skill:land-surveying-and-error-budgets', 'Land surveying and error budgets', 'beginner', [25, 60], {
    summary: 'Measuring ground positions and heights, then proving the result is good enough: traverses, levelling, closures and accuracy standards.',
    description:
      'Surveying is applied error management. You learn how instruments measure angles, distances and height differences, how a traverse or levelling loop is computed and adjusted, how misclosure is judged against a standard rather than a feeling, and how a set of measurements becomes a coordinate with an uncertainty attached to it.',
    practice: [
      'Run a closed traverse or levelling loop over a small site and compute the misclosure and adjustment.',
      'Convert a set of manual measurements into coordinates and state the accuracy you are prepared to defend.',
    ],
    criteria: [
      'You can state what a closure check proves and what it does not prove.',
      'You can explain why a precise instrument does not rescue a badly designed survey.',
    ],
    tags: ['geospatial', 'surveying', 'measurement'],
  }),
  skill('skill:geodesy-and-coordinate-systems', 'Geodesy, datums and coordinate systems', 'intermediate', [25, 60], {
    summary: 'Reference frames, projections and transformations: why coordinates must carry their datum, and how to move between them correctly.',
    description:
      'The choice of ellipsoid, datum and projection changes every position, distance and area you compute. You work with geographic and projected coordinates, grid versus ground distances, scale factors, and the transformation problem that appears when two data sets disagree by a few metres and both call themselves correct.',
    practice: [
      'Take one location in two datums or projections and compute how far apart the answers land on the ground.',
      'Reproject a data set and compare distances and areas before and after.',
    ],
    criteria: [
      'You can explain why vector data without a coordinate reference system is useless rather than merely imprecise.',
      'You can say why a transformation between datums is looked up and verified, never guessed.',
    ],
    tags: ['geospatial', 'geodesy', 'projections'],
  }),
  skill('skill:gnss-positioning', 'GNSS positioning', 'intermediate', [20, 50], {
    summary: 'How satellite positioning actually works, why a phone is not a survey instrument, and what correction changes.',
    description:
      'Global navigation satellite systems derive position from ranges and timing, so their error is geometric as much as electronic. You learn the constellation and the signal, dilution of precision, multipath and atmospheric delay, the difference between standalone, differential and real-time kinematic positioning, and what must be true before a GNSS position is survey-grade.',
    practice: [
      'Log a static GNSS record and analyse its scatter, then repeat under tree cover or between buildings.',
      'Compare a GNSS-derived position against a known point and report the error in the right units.',
    ],
    criteria: [
      'You can explain why a perfect signal with poor satellite geometry still gives a poor position.',
      'You can say what a correction service upgrades and what it cannot fix.',
    ],
    tags: ['geospatial', 'gnss', 'positioning'],
  }),
  skill('skill:gis-and-spatial-analysis', 'GIS and spatial analysis', 'beginner', [30, 70], {
    summary: 'Vector and raster data, joins, overlays and the projection pitfalls that quietly make good analysis wrong.',
    description:
      'A GIS is where spatial questions become answerable: which parcels intersect a flood zone, how far the nearest school is, what changed between two dates. You learn the two fundamental data models, attribute and spatial joins, buffers, overlays and selections, map layout — and the coordinate-system mistakes that produce a confident wrong answer.',
    practice: [
      'Answer three spatial questions about your own neighbourhood from open data.',
      'Run the same distance analysis in two coordinate systems and explain where the difference comes from.',
    ],
    criteria: [
      'You can choose vector or raster for a question and defend the choice.',
      'You can look at a finished map and say what its scale and projection hide.',
    ],
    tags: ['geospatial', 'gis', 'analysis'],
  }),
  skill('skill:remote-sensing-and-imagery', 'Remote sensing and imagery', 'intermediate', [30, 80], {
    summary: 'Reading the planet from above: bands, resolution, reflectance, indices and the limits of what an image can tell you.',
    description:
      'Satellites measure reflected and emitted radiation, not photographs of the world. You learn the electromagnetic spectrum and band design, spatial, spectral, radiometric and temporal resolution, atmospheric effects, cloud masking, index calculation such as NDVI, classification, and the validation of anything you claim to have detected.',
    practice: [
      'Compute a vegetation or water index for two dates and explain the change you see.',
      'Classify a small area and check part of the result against something you know on the ground.',
    ],
    criteria: [
      'You can state the ground size of your smallest pixel and the smallest object you can honestly detect.',
      'You can explain why a change in reflectance is not automatically a change on the ground.',
    ],
    tags: ['geospatial', 'remote-sensing', 'imagery'],
  }),
  skill('skill:terrain-and-surface-modelling', 'Terrain and surface modelling', 'intermediate', [25, 60], {
    summary: 'Elevation data as a product: DEMs, slope, flow direction, contours and the error the surface carries.',
    description:
      'A digital elevation model answers questions about drainage, sight lines and cut and fill — at a stated resolution, with a stated vertical accuracy, and it is not the bare earth unless someone made it so. You work with surface and terrain models, slope and aspect, flow accumulation, contouring, profile extraction and vertical error.',
    practice: [
      'Derive slope and a flow-accumulation raster from an open DEM and identify the drainage lines.',
      'Extract a profile between two points and compare it with a known elevation at one of them.',
    ],
    criteria: [
      'You can explain the difference between a surface model and a bare-earth model with an example of where it changes the answer.',
      'You can state the vertical accuracy of your data and what it prohibits you from concluding.',
    ],
    tags: ['geospatial', 'terrain', 'elevation'],
  }),
  skill('skill:geospatial-data-quality-and-standards', 'Geospatial data quality and standards', 'intermediate', [20, 50], {
    summary: 'Metadata, accuracy, topology and interoperability: why spatial data outlives the tools that made it.',
    description:
      'Spatial data is expensive to make and easy to ruin, so it moves between organisations under standards and licences. You learn metadata that means something, positional and attribute accuracy, data quality elements, topology and validity checks, the common exchange formats, and the open standards that let two systems understand each other ten years from now.',
    practice: [
      'Write a metadata record for a data set you produced and audit one you obtained from elsewhere.',
      'Run validity and topology checks on a polygon layer and fix what fails.',
    ],
    criteria: [
      'You can tell an accuracy statement from an accuracy claim and give an example of each.',
      'You can explain what a standard buys you that a file format does not.',
    ],
    tags: ['geospatial', 'standards', 'data-quality'],
  }),


