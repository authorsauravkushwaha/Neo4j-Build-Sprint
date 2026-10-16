# -*- coding: utf-8 -*-
"""Second precision pass on the resource library.

Two additions per resource, both designed to be *checkable*:

  estimatedHoursLow/High  a range in hours, calibrated against the skill
                          estimates already in the dataset (a resource that
                          teaches a 30–75 h skill should land in the same
                          band, not claim to do it in an afternoon)
  assumesSkillIds         the prerequisites as graph skills rather than prose,
                          so "Assumes: Calculus" becomes a link to the skill
                          page and, in live mode, a queryable ASSUMES edge

Only prerequisites that are genuinely required are listed. An empty list is a
correct answer for a resource that assumes nothing in the curriculum.
"""

# id -> (hoursLow, hoursHigh, assumesSkillIds)
DETAIL = {
    # --- mathematics and science ---
    'resource:khan-academy-calculus': (80, 150, []),
    'resource:khan-academy-physics': (100, 200, []),
    'resource:openstax-university-physics': (150, 300, ['skill:calculus-for-engineering']),
    'resource:openstax-calculus': (100, 200, []),
    'resource:mit-ocw-linear-algebra': (80, 130, []),
    'resource:mit-ocw-differential-equations': (80, 130, ['skill:calculus-for-engineering', 'skill:linear-algebra']),
    'resource:mechanocs-not-used': (0, 0, []),
    'resource:mechanics-map': (80, 150, ['skill:physics-mechanics']),
    'resource:mit-ocw-statistics': (80, 130, ['skill:calculus-for-engineering']),
    'resource:interactive-linear-algebra': (70, 120, []),

    # --- design, manufacturing, materials ---
    'resource:mit-ocw-solids': (70, 120, ['skill:engineering-mechanics-statics', 'skill:strength-of-materials']),
    'resource:mit-ocw-structures': (70, 120, ['skill:engineering-mechanics-statics', 'skill:calculus-for-engineering']),
    'resource:mit-ocw-design-manufacturing': (70, 120, ['skill:engineering-mechanics-statics']),
    'resource:gdt-basics': (2, 8, []),
    'resource:engineering-toolbox': (1, 4, []),
    'resource:cad-freecad': (0, 0, []),
    'resource:freecad-docs': (30, 80, []),
    'resource:onshape-learn': (20, 60, []),

    # --- electrical, electronics, signals ---
    'resource:all-about-circuits-textbook': (80, 160, []),
    'resource:mit-ocw-circuits': (80, 130, ['skill:calculus-for-engineering']),
    'resource:circuitverse': (15, 50, []),
    'resource:mit-ocw-signals-systems': (80, 130, ['skill:calculus-for-engineering', 'skill:linear-algebra']),
    'resource:mit-ocw-power-electronics': (70, 120, ['skill:circuit-analysis', 'skill:control-systems-fundamentals']),
    'resource:mit-ocw-power-electronics-2023': (80, 130, ['skill:circuit-analysis', 'skill:control-systems-fundamentals']),
    'resource:mit-ocw-power-systems': (80, 130, ['skill:circuit-analysis', 'skill:calculus-for-engineering']),
    'resource:kicad-docs': (20, 50, ['skill:circuit-analysis']),
    'resource:battery-university': (3, 8, ['skill:circuit-analysis']),

    # --- programming and software ---
    'resource:python-tutorial': (4, 10, ['skill:programming-fundamentals']),
    'resource:freecodecamp-python': (200, 350, []),
    'resource:cs50x': (100, 200, []),
    'resource:mdn-web-docs': (20, 80, []),
    'resource:react-learn': (15, 40, ['skill:programming-fundamentals']),
    'resource:typescript-handbook': (12, 30, ['skill:programming-fundamentals', 'skill:web-frontend-development']),
    'resource:pro-git': (10, 20, []),
    'resource:sqlite-docs': (8, 20, []),
    'resource:postgresql-tutorial': (5, 12, []),
    'resource:neo4j-cypher-manual': (6, 25, ['skill:databases-and-sql']),
    'resource:cp-algorithms': (20, 60, ['skill:data-structures-and-algorithms']),
    'resource:pytest-docs': (6, 15, ['skill:python-programming']),
    'resource:practical-test-pyramid': (1, 3, ['skill:testing-and-debugging']),
    'resource:refactoring-guru-patterns': (8, 20, []),
    'resource:cosmic-python': (40, 80, ['skill:python-programming', 'skill:testing-and-debugging']),
    'resource:react-native-docs': (20, 60, ['skill:web-frontend-development']),
    'resource:flutter-docs': (20, 60, []),
    'resource:azure-api-design': (2, 5, ['skill:api-design-and-integration']),
    'resource:opencv-python-tutorials': (15, 40, ['skill:python-programming']),

    # --- systems, networks, cloud ---
    'resource:linux-journey': (30, 60, []),
    'resource:linux-from-scratch': (60, 120, ['skill:operating-systems-and-linux']),
    'resource:mit-ocw-networks': (80, 130, ['skill:operating-systems-and-linux']),
    'resource:docker-get-started': (15, 40, ['skill:operating-systems-and-linux']),
    'resource:kubernetes-tutorials': (25, 70, ['skill:containers-and-docker']),
    'resource:github-actions-docs': (10, 30, ['skill:version-control-git']),
    'resource:gitlab-ci-docs': (10, 30, ['skill:version-control-git']),
    'resource:terraform-tutorials': (15, 40, ['skill:cloud-fundamentals']),
    'resource:mslearn-cloud-computing': (3, 8, []),
    'resource:google-cloud-training': (10, 30, []),
    'resource:prometheus-docs': (10, 25, ['skill:operating-systems-and-linux']),
    'resource:opentelemetry-docs': (10, 25, []),

    # --- data and machine learning ---
    'resource:pandas-user-guide': (15, 40, ['skill:python-programming']),
    'resource:python-for-data-analysis': (30, 60, ['skill:python-programming']),
    'resource:data-to-viz': (1, 4, []),
    'resource:wilke-dataviz': (15, 35, ['skill:probability-statistics']),
    'resource:seeing-theory': (3, 8, []),
    'resource:openstax-intro-statistics': (80, 150, []),
    'resource:isl-statistical-learning': (100, 200, ['skill:probability-statistics', 'skill:linear-algebra', 'skill:python-programming']),
    'resource:scikit-learn-user-guide': (20, 50, ['skill:python-programming', 'skill:probability-statistics']),
    'resource:pytorch-tutorials': (25, 70, ['skill:python-programming', 'skill:machine-learning-fundamentals']),
    'resource:tensorflow-tutorials': (20, 60, ['skill:python-programming', 'skill:machine-learning-fundamentals']),
    'resource:google-machine-learning-crash-course': (10, 20, []),
    'resource:model-cards-toolkit': (1, 4, ['skill:machine-learning-fundamentals']),
    'resource:nist-ai-rmf': (8, 20, ['skill:machine-learning-fundamentals']),

    # --- security ---
    'resource:owasp-top-ten': (2, 6, []),
    'resource:owasp-juice-shop': (30, 80, []),
    'resource:portswigger-web-security-academy': (60, 150, []),
    'resource:nist-csf': (8, 25, []),
    'resource:nist-sp-800-115': (6, 15, ['skill:cybersecurity-fundamentals']),
    'resource:nist-sp-800-61': (5, 12, ['skill:cybersecurity-fundamentals']),
    'resource:wireshark-users-guide': (10, 25, ['skill:computer-networks']),
    'resource:cryptopals': (60, 150, ['skill:programming-fundamentals']),
    'resource:practical-cryptography': (15, 30, ['skill:programming-fundamentals']),

    # --- embedded, robotics ---
    'resource:arduino-docs': (20, 60, ['skill:circuit-analysis']),
    'resource:nptel-embedded': (60, 110, ['skill:embedded-c', 'skill:digital-logic-design']),
    'resource:adafruit-learn': (20, 60, []),
    'resource:the-things-network-docs': (10, 25, ['skill:embedded-c', 'skill:computer-networks']),
    'resource:esp-idf-low-power': (10, 30, ['skill:embedded-c']),
    'resource:ros2-docs': (20, 50, ['skill:python-programming', 'skill:operating-systems-and-linux']),
    'resource:gazebo-docs': (12, 30, ['skill:robotics-ros2']),
    'resource:modern-robotics': (150, 300, ['skill:linear-algebra', 'skill:calculus-for-engineering']),
    'resource:mit-ocw-robotics': (80, 130, ['skill:linear-algebra', 'skill:engineering-mechanics-statics']),

    # --- energy and aerospace ---
    'resource:nrel-solar-resource': (2, 6, []),
    'resource:energy-gov-solar': (1, 3, []),
    'resource:global-solar-atlas': (1, 4, []),
    'resource:nptel-renewable': (60, 110, ['skill:circuit-analysis']),
    'resource:energy-star-guidelines': (4, 12, ['skill:thermodynamics-basics']),
    'resource:bee-india': (4, 12, ['skill:thermodynamics-basics']),
    'resource:mit-ocw-aero': (120, 200, ['skill:physics-mechanics', 'skill:calculus-for-engineering']),
    'resource:nasa-glenn-aero': (2, 6, []),

    # --- study skills ---
    'resource:coursera-learning-how-to-learn': (12, 20, []),
    'resource:github-student-pack': (1, 2, []),
}

# helper keys that were placeholders, not resources
_IGNORE = ('resource:mechanocs-not-used', 'resource:cad-freecad')

DETAIL = {k: v for k, v in DETAIL.items() if k not in _IGNORE}

if __name__ == '__main__':
    import json
    print(len(DETAIL), 'resources with hours + prerequisites')


