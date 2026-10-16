# Resource link verification

Run at: 2026-10-14T12:15:22.273Z

This report contains **measured** results from `npm run verify:resources` on the machine and
network where it ran. It is a maintenance aid, not a guarantee: providers change URLs, move
content behind logins, or retire courses. The dataset itself marks each resource with an
`accessModel` and a `lastVerified` date, and the app shows those labels next to every link.

## Summary

| Outcome | Count |
| --- | --- |
| Reachable, no redirect | 136 |
| Reachable, redirected | 14 |
| Blocked (401/403/429 from this network) | 4 |
| Failed (4xx/5xx) | 0 |
| Timed out | 0 |

## Per-resource results

| Resource | Provider | URL | HTTP | Outcome | Note |
| --- | --- | --- | --- | --- | --- |
| APMonitor: Process Dynamics and Control | Brigham Young University (APMonitor) | <https://apmonitor.com/pdc> | 200 | ok | HTTP 200 |
| NASA Applied Remote Sensing Training (ARSET) | NASA Applied Sciences | <https://appliedsciences.nasa.gov/arset> | 200 | redirected | Redirects to https://science.nasa.gov/earth-science/earth-action/ |
| Model Cards for Model Reporting | arXiv | <https://arxiv.org/abs/1810.03993> | 200 | ok | HTTP 200 |
| Bureau of Energy Efficiency (India) | Bureau of Energy Efficiency, Government of India | <https://beeindia.gov.in/> | 200 | ok | HTTP 200 |
| Cantera: chemical kinetics and reactor library | Cantera open-source project | <https://cantera.org/> | 200 | ok | HTTP 200 |
| CircuitVerse | CircuitVerse (open source) | <https://circuitverse.org/> | 200 | ok | HTTP 200 |
| Fundamentals of Data Visualization | Claus O. Wilke | <https://clauswilke.com/dataviz/> | 200 | ok | HTTP 200 |
| Google Cloud Training | Google Cloud | <https://cloud.google.com/learn/training> | 200 | ok | HTTP 200 |
| CP Algorithms | CP Algorithms (open source) | <https://cp-algorithms.com/> | 200 | ok | HTTP 200 |
| Practical Cryptography for Developers | Svetlin Nakov | <https://cryptobook.nakov.com/> | 200 | ok | HTTP 200 |
| The Cryptopals Crypto Challenges | Cryptopals | <https://cryptopals.com/> | 200 | ok | HTTP 200 |
| CS50x: Introduction to Computer Science | Harvard University (edX) | <https://cs50.harvard.edu/x/> | 200 | ok | HTTP 200 |
| NIST SP 800-115: Technical Guide to Information Security Testing and Assessment | NIST | <https://csrc.nist.gov/pubs/sp/800/115/final> | 200 | ok | HTTP 200 |
| NIST SP 800-61: Incident Response Recommendations | NIST | <https://csrc.nist.gov/pubs/sp/800/61/r2/final> | 200 | ok | HTTP 200 |
| Copernicus Data Space Ecosystem | European Commission and European Space Agency | <https://dataspace.copernicus.eu/> | 200 | ok | HTTP 200 |
| Terraform Tutorials | HashiCorp | <https://developer.hashicorp.com/terraform/tutorials> | 200 | ok | HTTP 200 |
| MDN Web Docs | Mozilla | <https://developer.mozilla.org/en-US/docs/Learn> | 200 | redirected | Redirects to https://developer.mozilla.org/en-US/docs/Learn_web_development |
| Google Machine Learning Crash Course | Google Developers | <https://developers.google.com/machine-learning/crash-course> | 200 | redirected | Redirects to https://developers.google.com/machine-learning/crash-course?hl=pt-br |
| Arduino Documentation | Arduino | <https://docs.arduino.cc/learn/> | 200 | ok | HTTP 200 |
| Docker: Get Started | Docker | <https://docs.docker.com/get-started/> | 200 | ok | HTTP 200 |
| ESP-IDF: Low Power Mode | Espressif | <https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-guides/low-power-mode/index.html> | 200 | ok | HTTP 200 |
| Flutter Documentation | Google | <https://docs.flutter.dev/> | 200 | ok | HTTP 200 |
| GitHub Actions Documentation | GitHub | <https://docs.github.com/en/actions> | 200 | ok | HTTP 200 |
| GitLab CI/CD Documentation | GitLab | <https://docs.gitlab.com/ci/> | 200 | ok | HTTP 200 |
| KiCad Documentation | KiCad | <https://docs.kicad.org/> | 200 | ok | HTTP 200 |
| OpenCV: Python Tutorials | OpenCV | <https://docs.opencv.org/4.13.0/d6/d00/tutorial_py_root.html> | 200 | ok | HTTP 200 |
| OpenDroneMap documentation (ODM) | OpenDroneMap community | <https://docs.opendronemap.org/> | 200 | ok | HTTP 200 |
| pytest Documentation | pytest project | <https://docs.pytest.org/en/stable/> | 200 | ok | HTTP 200 |
| The Python Tutorial | Python Software Foundation | <https://docs.python.org/3/tutorial/> | 200 | ok | HTTP 200 |
| QGIS Training Manual | QGIS project | <https://docs.qgis.org/latest/en/docs/training_manual/> | 200 | redirected | Redirects to https://docs.qgis.org/3.44/en/docs/training_manual/ |
| QGIS Documentation: User Manual | QGIS project | <https://docs.qgis.org/latest/en/docs/user_manual/> | 200 | redirected | Redirects to https://docs.qgis.org/3.44/en/docs/user_manual/ |
| ROS 2 Documentation | Open Robotics | <https://docs.ros.org/en/jazzy/Tutorials.html> | 200 | ok | HTTP 200 |
| DWSIM open-source process simulator | DWSIM open-source project | <https://dwsim.org/> | 200 | ok | HTTP 200 |
| GitHub Student Developer Pack | GitHub Education | <https://education.github.com/pack> | 200 | ok | HTTP 200 |
| LibreTexts: Chemical Engineering bookshelf | LibreTexts | <https://eng.libretexts.org/Bookshelves/Chemical_Engineering> | 200 | ok | HTTP 200 |
| LibreTexts: Chemical Process Dynamics and Controls | LibreTexts (originally University of Michigan course material) | <https://eng.libretexts.org/Bookshelves/Industrial_and_Systems_Engineering/Chemical_Process_Dynamics_and_Controls_(Woolf)> | 200 | ok | HTTP 200 |
| EU Medical Device Regulation 2017/745 (EUR-Lex) | European Union (EUR-Lex) | <https://eur-lex.europa.eu/eli/reg/2017/745/oj> | 202 | ok | HTTP 202 |
| Gazebo simulation tutorials | Open Robotics | <https://gazebosim.org/docs> | 200 | ok | HTTP 200 |
| GDAL documentation | GDAL developers | <https://gdal.org/> | 200 | redirected | Redirects to https://gdal.org/en/stable/ |
| LibreTexts Geosciences library | LibreTexts | <https://geo.libretexts.org/> | 200 | ok | HTTP 200 |
| GeoPandas documentation | GeoPandas developers | <https://geopandas.org/en/stable/> | 200 | ok | HTTP 200 |
| Pro Git (2nd edition) | Scott Chacon and Ben Straub | <https://git-scm.com/book/en/v2> | 200 | ok | HTTP 200 |
| Global Solar Atlas | World Bank Group / Solargis | <https://globalsolaratlas.info/> | 200 | ok | HTTP 200 |
| ESA Navipedia | European Space Agency | <https://gssc.esa.int/navipedia/index.php/Main_Page> | 200 | ok | HTTP 200 |
| Modern Robotics: Mechanics, Planning, and Control | Northwestern University (Lynch and Park) | <https://hades.mech.northwestern.edu/index.php/Modern_Robotics> | 200 | ok | HTTP 200 |
| IAEA Human Health Campus | International Atomic Energy Agency | <https://humanhealth.iaea.org/> | 200 | ok | HTTP 200 |
| Kubernetes Tutorials | Cloud Native Computing Foundation | <https://kubernetes.io/docs/tutorials/> | 200 | ok | HTTP 200 |
| Adafruit Learning System | Adafruit | <https://learn.adafruit.com/> | 200 | ok | HTTP 200 |
| Esri Learn: free tutorials and courses | Esri | <https://learn.arcgis.com/en/> | 200 | ok | HTTP 200 |
| Azure Architecture Center: API Design Best Practices | Microsoft | <https://learn.microsoft.com/en-us/azure/architecture/best-practices/api-design> | 200 | ok | HTTP 200 |
| Microsoft Learn: Describe Cloud Computing | Microsoft | <https://learn.microsoft.com/en-us/training/modules/describe-cloud-compute/> | 200 | ok | HTTP 200 |
| Onshape Learning Resources | Onshape (PTC) | <https://learn.onshape.com/> | 200 | ok | HTTP 200 |
| LearnChemE: Chemical engineering screencasts and exercises | University of Colorado Boulder (LearnChemE) | <https://learncheme.com/> | 200 | ok | HTTP 200 |
| The Linux Command Line (free online book) | William Shotts (linuxcommand.org) | <https://linuxcommand.org/tlcl.php> | 200 | ok | HTTP 200 |
| The Practical Test Pyramid | Martin Fowler (article by Ham Vocke) | <https://martinfowler.com/articles/practical-test-pyramid.html> | 200 | ok | HTTP 200 |
| Mechanics Map | Penn State (open textbook) | <https://mechanicsmap.org/> | 200 | ok | HTTP 200 |
| Neo4j Cypher Manual | Neo4j | <https://neo4j.com/docs/cypher-manual/current/> | 200 | redirected | Redirects to https://neo4j.com/docs/cypher-manual/current/introduction/ |
| NPTEL: Renewable Energy (IIT) | NPTEL (IIT Roorkee) | <https://nptel.ac.in/courses/103107082> | 200 | ok | HTTP 200 |
| NPTEL: Embedded Systems Design (IIT) | NPTEL (IIT Kharagpur) | <https://nptel.ac.in/courses/108105057> | 200 | ok | HTTP 200 |
| MIT OCW 1.050: Solid Mechanics | MIT OpenCourseWare | <https://ocw.mit.edu/courses/1-050-solid-mechanics-fall-2004/> | 200 | ok | HTTP 200 |
| MIT OpenCourseWare: Transport Processes (10.302) | MIT OpenCourseWare | <https://ocw.mit.edu/courses/10-302-transport-processes-fall-2004/> | 200 | ok | HTTP 200 |
| MIT OpenCourseWare: Separation Processes (10.32) | MIT OpenCourseWare | <https://ocw.mit.edu/courses/10-32-separation-processes-spring-2005/> | 200 | ok | HTTP 200 |
| MIT OpenCourseWare: Chemical and Biological Reaction Engineering (10.37) | MIT OpenCourseWare | <https://ocw.mit.edu/courses/10-37-chemical-and-biological-reaction-engineering-spring-2007/> | 200 | ok | HTTP 200 |
| MIT OpenCourseWare: Introduction to Operations Management (15.761) | MIT OpenCourseWare (Sloan School of Management) | <https://ocw.mit.edu/courses/15-761-introduction-to-operations-management-spring-2013/> | 200 | ok | HTTP 200 |
| MIT OpenCourseWare: Supply Chain Planning (15.762J) | MIT OpenCourseWare | <https://ocw.mit.edu/courses/15-762j-supply-chain-planning-spring-2011/> | 200 | ok | HTTP 200 |
| MIT OCW 16.01: Unified Engineering | MIT OpenCourseWare | <https://ocw.mit.edu/courses/16-01-unified-engineering-i-ii-iii-iv-fall-2005-spring-2006/> | 200 | ok | HTTP 200 |
| MIT OCW 18.03: Differential Equations | MIT OpenCourseWare | <https://ocw.mit.edu/courses/18-03-differential-equations-spring-2010/> | 200 | ok | HTTP 200 |
| MIT OCW 18.05: Probability and Statistics | MIT OpenCourseWare | <https://ocw.mit.edu/courses/18-05-introduction-to-probability-and-statistics-spring-2022/> | 200 | ok | HTTP 200 |
| MIT OCW 18.06: Linear Algebra | MIT OpenCourseWare | <https://ocw.mit.edu/courses/18-06-linear-algebra-spring-2010/> | 200 | ok | HTTP 200 |
| MIT OCW 2.007: Design and Manufacturing I | MIT OpenCourseWare | <https://ocw.mit.edu/courses/2-007-design-and-manufacturing-i-spring-2009/> | 200 | ok | HTTP 200 |
| MIT OCW 2.12: Introduction to Robotics | MIT OpenCourseWare | <https://ocw.mit.edu/courses/2-12-introduction-to-robotics-fall-2005/> | 200 | ok | HTTP 200 |
| MIT OpenCourseWare: Introduction to Manufacturing Systems (2.854) | MIT OpenCourseWare | <https://ocw.mit.edu/courses/2-854-introduction-to-manufacturing-systems-fall-2016/> | 200 | ok | HTTP 200 |
| MIT OCW 3.032: Mechanical Behavior of Materials | MIT OpenCourseWare | <https://ocw.mit.edu/courses/3-032-mechanical-behavior-of-materials-fall-2007/> | 200 | ok | HTTP 200 |
| MIT OpenCourseWare: Materials for Biomedical Applications (3.051J) | MIT OpenCourseWare | <https://ocw.mit.edu/courses/3-051j-materials-for-biomedical-applications-spring-2006/> | 200 | ok | HTTP 200 |
| MIT OCW 6.002: Circuits and Electronics | MIT OpenCourseWare | <https://ocw.mit.edu/courses/6-002-circuits-and-electronics-spring-2007/> | 200 | ok | HTTP 200 |
| MIT OCW 6.003: Signals and Systems | MIT OpenCourseWare | <https://ocw.mit.edu/courses/6-003-signals-and-systems-fall-2011/> | 200 | ok | HTTP 200 |
| MIT OpenCourseWare: Quantitative Physiology: Cells and Tissues (6.021J) | MIT OpenCourseWare | <https://ocw.mit.edu/courses/6-021j-quantitative-physiology-cells-and-tissues-fall-2004/> | 200 | ok | HTTP 200 |
| MIT OCW 6.033: Computer System Engineering | MIT OpenCourseWare | <https://ocw.mit.edu/courses/6-033-computer-system-engineering-spring-2018/> | 200 | ok | HTTP 200 |
| MIT OCW 6.061: Introduction to Electric Power Systems | MIT OpenCourseWare | <https://ocw.mit.edu/courses/6-061-introduction-to-electric-power-systems-spring-2011/> | 200 | ok | HTTP 200 |
| MIT OCW 6.334: Power Electronics | MIT OpenCourseWare | <https://ocw.mit.edu/courses/6-334-power-electronics-spring-2007/> | 200 | ok | HTTP 200 |
| MIT OCW 6.622: Power Electronics | MIT OpenCourseWare | <https://ocw.mit.edu/courses/6-622-power-electronics-spring-2023/> | 200 | ok | HTTP 200 |
| MIT OpenCourseWare: Biomedical Signal and Image Processing (HST.582J) | MIT OpenCourseWare (Harvard-MIT Health Sciences and Technology) | <https://ocw.mit.edu/courses/hst-582j-biomedical-signal-and-image-processing-spring-2007/> | 200 | ok | HTTP 200 |
| OpenSim: musculoskeletal modelling and simulation | Stanford University (OpenSim project, US National Center for Simulation in Rehabilitation Research) | <https://opensim.stanford.edu/> | 200 | ok | HTTP 200 |
| OpenStax: Anatomy and Physiology 2e | OpenStax (Rice University) | <https://openstax.org/details/books/anatomy-and-physiology-2e> | 200 | ok | HTTP 200 |
| OpenStax: Calculus Volume 1 | OpenStax (Rice University) | <https://openstax.org/details/books/calculus-volume-1> | 200 | ok | HTTP 200 |
| OpenStax: Chemistry 2e | OpenStax (Rice University) | <https://openstax.org/details/books/chemistry-2e> | 200 | ok | HTTP 200 |
| OpenStax: Introductory Statistics 2e | OpenStax (Rice University) | <https://openstax.org/details/books/introductory-statistics-2e> | 200 | ok | HTTP 200 |
| OpenStax: University Physics | OpenStax (Rice University) | <https://openstax.org/details/books/university-physics-volume-1> | 200 | ok | HTTP 200 |
| OpenTelemetry Documentation | OpenTelemetry (CNCF) | <https://opentelemetry.io/docs/> | 200 | ok | HTTP 200 |
| OpenTopography | OpenTopography (University of California San Diego) | <https://opentopography.org/> | 200 | ok | HTTP 200 |
| OWASP Juice Shop | OWASP Foundation | <https://owasp.org/www-project-juice-shop/> | 200 | redirected | Redirects to https://owasp.org/projects/juice-shop |
| OWASP Top 10 | OWASP Foundation | <https://owasp.org/www-project-top-ten/> | 200 | redirected | Redirects to https://owasp.org/projects/top-ten |
| pandas User Guide | pandas development team | <https://pandas.pydata.org/docs/user_guide/> | 200 | ok | HTTP 200 |
| PhysioNet: physiological signal databases and tutorials | PhysioNet (MIT Laboratory for Computational Physiology and partners) | <https://physionet.org/> | 200 | ok | HTTP 200 |
| PortSwigger Web Security Academy | PortSwigger | <https://portswigger.net/web-security> | 200 | ok | HTTP 200 |
| PROJ documentation | PROJ developers | <https://proj.org/> | 200 | redirected | Redirects to https://proj.org/en/stable/ |
| Prometheus Documentation | Prometheus (CNCF) | <https://prometheus.io/docs/introduction/overview/> | 200 | ok | HTTP 200 |
| PyTorch Tutorials | PyTorch Foundation | <https://pytorch.org/tutorials/> | 200 | redirected | Redirects to https://docs.pytorch.org/tutorials/ |
| PVGIS Solar Radiation Database | European Commission Joint Research Centre | <https://re.jrc.ec.europa.eu/pvg_tools/en/tools.html> | 200 | ok | HTTP 200 |
| React: Learn | Meta / React team | <https://react.dev/learn> | 200 | ok | HTTP 200 |
| React Native Documentation | Meta and the React Native community | <https://reactnative.dev/docs/getting-started> | 200 | ok | HTTP 200 |
| Refactoring Guru: Design Patterns | Refactoring Guru | <https://refactoring.guru/design-patterns> | 200 | ok | HTTP 200 |
| Robot Academy (QUT): free robotics and automation lectures | Queensland University of Technology (Peter Corke) | <https://robotacademy.net.au/> | 200 | ok | HTTP 200 |
| scikit-learn User Guide | scikit-learn developers | <https://scikit-learn.org/stable/user_guide.html> | 200 | ok | HTTP 200 |
| Seeing Theory | Brown University | <https://seeing-theory.brown.edu/> | 200 | ok | HTTP 200 |
| 3D Slicer: medical image analysis platform | 3D Slicer open-source project (Brigham and Women’s Hospital and contributors) | <https://slicer.readthedocs.io/en/latest/> | 200 | ok | HTTP 200 |
| Interactive Linear Algebra | Georgia Tech (Margalit and Rabinoff) | <https://textbooks.math.gatech.edu/ila/> | 200 | ok | HTTP 200 |
| MIT 2.810: Manufacturing Processes and Systems (course site) | MIT Department of Mechanical Engineering | <https://web.mit.edu/2.810/www/> | 200 | ok | HTTP 200 |
| NIST Chemistry WebBook | NIST (United States National Institute of Standards and Technology) | <https://webbook.nist.gov/chemistry/> | 200 | ok | HTTP 200 |
| Python for Data Analysis (3rd edition) | Wes McKinney | <https://wesmckinney.com/book/> | 200 | ok | HTTP 200 |
| FreeCAD Documentation | FreeCAD community | <https://wiki.freecad.org/Manual:Introduction> | 200 | ok | HTTP 200 |
| All About Circuits: Textbook | All About Circuits | <https://www.allaboutcircuits.com/textbook/> | 403 | blocked | HTTP 403 |
| Battery University | Battery University (Cadex) | <https://www.batteryuniversity.com/> | 200 | ok | HTTP 200 |
| CoolProp: thermophysical property library | CoolProp open-source project | <https://www.coolprop.org/> | 200 | redirected | Redirects to https://coolprop.org/ |
| Architecture Patterns with Python | Percival and Gregory | <https://www.cosmicpython.com/book/preface.html> | 200 | redirected | Redirects to https://www.cosmicpython.com/book/preface |
| Learning How to Learn | McMaster University / UC San Diego (Coursera) | <https://www.coursera.org/learn/learning-how-to-learn> | 200 | ok | HTTP 200 |
| U.S. Chemical Safety Board: investigation reports | U.S. Chemical Safety Board | <https://www.csb.gov/investigations/> | 200 | ok | HTTP 200 |
| U.S. Chemical Safety Board: video library | U.S. Chemical Safety Board | <https://www.csb.gov/videos/> | 200 | ok | HTTP 200 |
| From Data to Viz | Yan Holtz | <https://www.data-to-viz.com/> | 200 | ok | HTTP 200 |
| DoITPoMS: Teaching and Learning Packages (University of Cambridge) | University of Cambridge (Department of Materials Science and Metallurgy) | <https://www.doitpoms.ac.uk/tlplib/index.php> | 200 | ok | HTTP 200 |
| The Scientist and Engineer’s Guide to Digital Signal Processing | Steven W. Smith (free online edition) | <https://www.dspguide.com/> | 200 | ok | HTTP 200 |
| U.S. Department of Energy: How Does Solar Work? | U.S. Department of Energy | <https://www.energy.gov/cmei/systems/how-does-solar-work> | 200 | ok | HTTP 200 |
| ENERGY STAR: Benchmarking and Energy Management | U.S. Environmental Protection Agency | <https://www.energystar.gov/buildings/benchmark> | 200 | ok | HTTP 200 |
| Engineering ToolBox | Engineering ToolBox | <https://www.engineeringtoolbox.com/> | 200 | ok | HTTP 200 |
| US FDA: Device Advice — regulatory assistance for medical devices | United States Food and Drug Administration | <https://www.fda.gov/medical-devices/device-advice-comprehensive-regulatory-assistance> | 200 | ok | HTTP 200 |
| freeCodeCamp: Scientific Computing with Python | freeCodeCamp | <https://www.freecodecamp.org/learn/scientific-computing-with-python/> | 200 | ok | HTTP 200 |
| GD&T Basics: Symbols and Rules | GD&T Basics | <https://www.gdandtbasics.com/gdt-symbols/> | 200 | ok | HTTP 200 |
| GPS.gov: official information about the GPS constellation | United States government | <https://www.gps.gov/> | 200 | ok | HTTP 200 |
| UK HSE: Musculoskeletal disorders | United Kingdom Health and Safety Executive | <https://www.hse.gov.uk/msd/> | 200 | ok | HTTP 200 |
| NIST/SEMATECH e-Handbook of Statistical Methods | NIST (United States National Institute of Standards and Technology) and SEMATECH | <https://www.itl.nist.gov/div898/handbook/> | 200 | ok | HTTP 200 |
| Khan Academy: Calculus | Khan Academy | <https://www.khanacademy.org/math/calculus-1> | 200 | ok | HTTP 200 |
| Khan Academy: Human anatomy and physiology | Khan Academy | <https://www.khanacademy.org/science/health-and-medicine/human-anatomy-and-physiology> | 200 | ok | HTTP 200 |
| Khan Academy: Physics | Khan Academy | <https://www.khanacademy.org/science/physics> | 200 | ok | HTTP 200 |
| Linux From Scratch | Gerard Beekmans and the LFS community | <https://www.linuxfromscratch.org/> | 200 | ok | HTTP 200 |
| NOAA National Geodetic Survey | United States National Oceanic and Atmospheric Administration | <https://www.ngs.noaa.gov/> | 200 | ok | HTTP 200 |
| NIST Cybersecurity Framework | NIST | <https://www.nist.gov/cyberframework> | 200 | ok | HTTP 200 |
| NIST AI Risk Management Framework | NIST | <https://www.nist.gov/itl/ai-risk-management-framework> | 200 | ok | HTTP 200 |
| Open Geospatial Consortium standards | Open Geospatial Consortium | <https://www.ogc.org/> | 200 | ok | HTTP 200 |
| OSHA: Ergonomics | United States Occupational Safety and Health Administration | <https://www.osha.gov/ergonomics> | 403 | blocked | HTTP 403 |
| OSHA: Machine guarding | United States Occupational Safety and Health Administration | <https://www.osha.gov/machine-guarding> | 403 | blocked | HTTP 403 |
| OSHA: Process Safety Management standard | United States Occupational Safety and Health Administration | <https://www.osha.gov/process-safety-management> | 403 | blocked | HTTP 403 |
| PostgreSQL Tutorial | PostgreSQL Global Development Group | <https://www.postgresql.org/docs/current/tutorial.html> | 200 | ok | HTTP 200 |
| Reliable Plant: maintenance and reliability library | Reliable Plant (Noria Corporation) | <https://www.reliableplant.com/> | 200 | ok | HTTP 200 |
| RESNA: Rehabilitation Engineering and Assistive Technology Society of North America | RESNA | <https://www.resna.org/> | 200 | ok | HTTP 200 |
| SPC for Excel: statistical process control knowledge base | SPC for Excel (KnowWare International) | <https://www.spcforexcel.com/knowledge/basic-statistics/> | 200 | ok | HTTP 200 |
| SQLite documentation | SQLite | <https://www.sqlite.org/docs.html> | 200 | ok | HTTP 200 |
| An Introduction to Statistical Learning | James, Witten, Hastie and Tibshirani | <https://www.statlearning.com/> | 200 | ok | HTTP 200 |
| TensorFlow / Keras Tutorials | Google | <https://www.tensorflow.org/tutorials> | 200 | redirected | Redirects to https://www.tensorflow.org/tutorials?hl=zh-cn |
| The Things Network Documentation | The Things Network | <https://www.thethingsnetwork.org/docs/> | 200 | ok | HTTP 200 |
| TypeScript Handbook | Microsoft | <https://www.typescriptlang.org/docs/handbook/intro.html> | 200 | ok | HTTP 200 |
| USGS National Geospatial Program | United States Geological Survey | <https://www.usgs.gov/programs/national-geospatial-program> | 200 | ok | HTTP 200 |
| WHO: Assistive technology fact sheet | World Health Organization | <https://www.who.int/news-room/fact-sheets/detail/assistive-technology> | 200 | ok | HTTP 200 |
| Wireshark User’s Guide | Wireshark Foundation | <https://www.wireshark.org/docs/wsug_html_chunked/> | 200 | ok | HTTP 200 |
| NASA: Aerodynamics and Flight | NASA Glenn Research Center | <https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/> | 200 | ok | HTTP 200 |

## How to act on this report

- `redirected` — update the URL in `src/data/seed/knowledgeGraph.ts` so the learner skips the hop.
- `blocked` — many free providers reject datacentre IPs or automated clients; a maintainer should
  open the link in a browser and confirm before changing anything.
- `failed` / `timeout` — re-run once; if it repeats, replace the resource or mark it in the dataset.
- After editing the dataset: `npm run validate:seed && npm run emit:cypher`.


