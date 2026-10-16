  assessment('assessment:datum-and-projection-check', 'Datums, projections and coordinates check', {
    skillId: 'skill:geodesy-and-coordinate-systems',
    summary: 'Reference frames, reprojection and the units a map is really in.',
    difficulty: 'intermediate',
    questions: [
      ['A list of coordinates with no coordinate reference system is…', ['precise to within one metre', 'useless, because the numbers could belong to any datum', 'the same as WGS 84', 'always latitude and longitude'], 1],
      ['Reprojecting data from a geographic to a projected coordinate system…', ['improves its accuracy', 'changes the coordinates and can change computed distances and areas', 'always increases precision', 'drops the attribute fields'], 1],
      ['A datum and a projection differ in that…', ['a datum is a reference frame for the Earth and a projection maps it onto a plane', 'a projection defines the shape of the Earth and a datum flattens it', 'they are two names for one thing', 'a projection is always more accurate'], 0],
      ['A distance measured on a projected map differs from the ground distance because…', ['the map is wrong', 'the projection imposes a scale factor that varies with location', 'the ground moves between measurements', 'the survey was imprecise'], 1],
    ],
  }),
  assessment('assessment:gis-analysis-check', 'GIS analysis and projection pitfalls check', {
    skillId: 'skill:gis-and-spatial-analysis',
    summary: 'Data models, joins and the mistakes that produce confident wrong answers.',
    difficulty: 'intermediate',
    questions: [
      ['Which question suits a raster data model better than a vector one?', ['who owns this parcel', 'how slope varies across a hillside', 'where the nearest school is', 'which streets are one-way'], 1],
      ['A buffer of 0.01 applied in a geographic coordinate system will…', ['produce a correct 10-metre buffer', 'produce a buffer whose real size changes with latitude because degrees are not a fixed ground distance', 'fail immediately with an error', 'double the number of polygons'], 1],
      ['A spatial join differs from an attribute join in that it…', ['is always faster', 'matches records by their position rather than by a shared key', 'needs no data cleaning', 'only works on point layers'], 1],
      ['The main purpose of a validity or topology check is to…', ['speed up rendering', 'find geometry that breaks rules and would corrupt later analysis', 'convert between formats', 'simplify polygons for display'], 1],
    ],
  }),


