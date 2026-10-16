/*
 * FrontierOracle — a second, independent implementation of the skill-gap
 * "frontier" computation, written in Java, that recomputes every number the
 * TypeScript engine produces and diffs it line by line.
 *
 * Why this exists
 * ---------------
 * `supabase/functions/_shared/core/recommend.ts` §6 answers the two questions the
 * product is built around: for someone who knows nothing, "what can I actually
 * start today?", and for a specialist, "what exactly is my remaining delta, what
 * gates it, and what cannot be parallelised?". Those answers are numbers a user
 * acts on, and the failure mode of a graph walk is a plausible-looking wrong
 * number — the kind nobody notices. A test suite built from the same code can be
 * blind to the same misunderstanding twice, so this recomputes the whole thing
 * from the same inputs in a different language and compares the output.
 *
 * What is genuinely independent, and what is not
 * ---------------------------------------------
 * Independent: the graph construction and de-duplication, the transitive closure,
 * the "what does this unlock" walks, the gate selection and its union semantics,
 * Kahn's algorithm and the longest-path chain, the aggregation and ordering, and
 * every string and number in the canonical output below.
 *
 * NOT independent: the tuning policy. The met-threshold, the traversal budget,
 * the default hour range, the self-report mastery table and the caveat sentences
 * are read from the fixture as *declared inputs* rather than restated here, so
 * that this file tests algorithms and not constants. Those constants are pinned
 * by the TypeScript unit tests instead. A fixture that lied about them could not
 * make a broken traversal look correct; it could only move the goalposts in a way
 * the fixture itself would show.
 *
 * Known limit, stated rather than hidden: members of a prerequisite cycle are
 * ordered by the graph's cyclic tail, where JavaScript's `localeCompare` and
 * Java's `String.compareTo` may legitimately disagree. This oracle refuses to
 * pretend otherwise — see the cycle check in the driver — and the fixture
 * exporter refuses to emit a case whose closure contains a cycle at all.
 *
 * Build and run: npm run oracle   (plain javac/java, no build tool required)
 */
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class FrontierOracle {

  /* ------------------------------------------------------------------ model */

  static final class Skill {
    final String id;
    final String name;
    final String difficulty;
    final int low;
    final int high;

    Skill(String id, String name, String difficulty, int low, int high) {
      this.id = id;
      this.name = name;
      this.difficulty = difficulty;
      this.low = low;
      this.high = high;
    }
  }

  static final class Rating {
    final String skillId;
    final String state;
    final Double quiz;

    Rating(String skillId, String state, Double quiz) {
      this.skillId = skillId;
      this.state = state;
      this.quiz = quiz;
    }
  }

  static final class Constants {
    double prereqMetThreshold = 0.6;
    int maxTraversal = 4000;
    int maxSteps = 60;
    int defaultHoursLow = 4;
    int defaultHoursHigh = 10;
    final Map<String, Double> mastery = new LinkedHashMap<>();
    String caveatSelfReport = "";
    String caveatEstimates = "";
  }

  static final class Case {
    final String id;
    final String careerName;
    final List<String> targets = new ArrayList<>();
    final Map<String, Skill> skills = new LinkedHashMap<>();
    final List<String[]> edges = new ArrayList<>();
    final List<Rating> ratings = new ArrayList<>();
    Integer weeklyHours;
    final List<String> expected = new ArrayList<>();

    Case(String id, String careerName) {
      this.id = id;
      this.careerName = careerName;
    }
  }

  static final class Graph {
    final Map<String, List<String>> prerequisites = new LinkedHashMap<>();
    final Map<String, List<String>> dependents = new LinkedHashMap<>();
    final List<String> cyclic = new ArrayList<>();
  }

  static final class Node {
    final String skillId;
    final String name;
    final String difficulty;
    final int low;
    final int high;
    final int unlocks;
    final boolean meetsTarget;

    Node(String skillId, String name, String difficulty, int low, int high, int unlocks, boolean meetsTarget) {
      this.skillId = skillId;
      this.name = name;
      this.difficulty = difficulty;
      this.low = low;
      this.high = high;
      this.unlocks = unlocks;
      this.meetsTarget = meetsTarget;
    }
  }

  static final class Remaining {
    final Node node;
    final int depth;
    final List<String> needsNow;

    Remaining(Node node, int depth, List<String> needsNow) {
      this.node = node;
      this.depth = depth;
      this.needsNow = needsNow;
    }
  }

  /** The whole computed answer for one case, in the order the TS report builds it. */
  static final class Report {
    int targetCount;
    int closureCount;
    int knownInClosure;
    int remainingCount;
    List<Node> frontier = new ArrayList<>();
    List<Node> gates = new ArrayList<>();
    List<String[]> criticalChain = new ArrayList<>();
    List<Remaining> remaining = new ArrayList<>();
    List<String[]> pulledIn = new ArrayList<>();
    List<String> cyclic = new ArrayList<>();
    int hoursLow;
    int hoursHigh;
    Integer weeksLow;
    Integer weeksHigh;
    Integer weeklyHours;
    int gatesUnlock;
    List<String[]> depths = new ArrayList<>();
    List<String> caveats = new ArrayList<>();
    String summaryLine = "";
  }

  /* ---------------------------------------------------------------- helpers */

  /** Ordering everywhere: UTF-16 code units, which is what Java's compareTo does
   *  and what JavaScript's `<` does. Never locale collation — see class comment. */
  static int cmp(String a, String b) {
    return a.compareTo(b);
  }

  static double clamp(double value, double min, double max) {
    if (Double.isNaN(value)) return min;
    return Math.min(max, Math.max(min, value));
  }

  static List<String> sortedCopy(List<String> values) {
    List<String> copy = new ArrayList<>(values);
    copy.sort(FrontierOracle::cmp);
    return copy;
  }

  /* ------------------------------------------------- the engine, recomputed */

  static Graph buildGraph(List<String> skillIds, List<String[]> edges) {
    Set<String> allowed = new LinkedHashSet<>(skillIds);
    Graph graph = new Graph();
    for (String id : skillIds) {
      graph.prerequisites.put(id, new ArrayList<>());
      graph.dependents.put(id, new ArrayList<>());
    }
    for (String[] edge : edges) {
      String from = edge[0];
      String to = edge[1];
      if (!allowed.contains(from) || !allowed.contains(to)) continue;
      if (from.equals(to)) continue;

      List<String> prereqList = graph.prerequisites.get(from);
      if (!prereqList.contains(to)) prereqList.add(to);
      List<String> dependentList = graph.dependents.get(to);
      if (!dependentList.contains(from)) dependentList.add(from);
    }
    for (List<String> list : graph.prerequisites.values()) list.sort(FrontierOracle::cmp);
    for (List<String> list : graph.dependents.values()) list.sort(FrontierOracle::cmp);
    graph.cyclic.addAll(findCycles(graph.prerequisites, 4000));
    return graph;
  }

  /** Faithful port of the TypeScript DFS: explicit stack, frames carry their path. */
  static List<String> findCycles(Map<String, List<String>> prerequisites, int budgetStart) {
    Map<String, Integer> state = new HashMap<>();
    Set<String> inCycle = new LinkedHashSet<>();
    int budget = budgetStart;

    for (String start : prerequisites.keySet()) {
      if (state.getOrDefault(start, 0) != 0) continue;

      List<Object[]> stack = new ArrayList<>(); // {node, index, path}
      Set<String> onStack = new LinkedHashSet<>();
      stack.add(new Object[] { start, 0, new ArrayList<>(Collections.singletonList(start)) });
      onStack.add(start);
      state.put(start, 1);

      while (!stack.isEmpty() && budget-- > 0) {
        Object[] frame = stack.get(stack.size() - 1);
        String node = (String) frame[0];
        int index = (Integer) frame[1];
        @SuppressWarnings("unchecked")
        List<String> path = (List<String>) frame[2];
        List<String> neighbours = prerequisites.getOrDefault(node, Collections.emptyList());

        if (index >= neighbours.size()) {
          state.put(node, 2);
          onStack.remove(node);
          stack.remove(stack.size() - 1);
          continue;
        }
        frame[1] = index + 1;
        String next = neighbours.get(index);
        int nextState = state.getOrDefault(next, 0);
        if (nextState == 1 && onStack.contains(next)) {
          int from = path.indexOf(next);
          for (int i = from < 0 ? 0 : from; i < path.size(); i++) inCycle.add(path.get(i));
          inCycle.add(next);
          continue;
        }
        if (nextState == 0) {
          state.put(next, 1);
          onStack.add(next);
          List<String> nextPath = new ArrayList<>(path);
          nextPath.add(next);
          stack.add(new Object[] { next, 0, nextPath });
        }
      }
    }
    return sortedCopy(new ArrayList<>(inCycle));
  }

  /** Kahn's algorithm with the engine's ready-queue tie-break (rank, then id). */
  static List<String> topologicalOrder(List<String> skillIds, Graph graph) {
    Set<String> member = new LinkedHashSet<>(skillIds);
    Map<String, Integer> indegree = new LinkedHashMap<>();
    for (String id : skillIds) {
      int count = 0;
      for (String prereq : graph.prerequisites.getOrDefault(id, Collections.emptyList())) {
        if (member.contains(prereq)) count++;
      }
      indegree.put(id, count);
    }

    List<String> queue = new ArrayList<>();
    List<String> ready = new ArrayList<>();
    for (String id : skillIds) if (indegree.getOrDefault(id, 0) == 0) ready.add(id);
    ready.sort(FrontierOracle::cmp);
    queue.addAll(ready);

    List<String> order = new ArrayList<>();
    int guard = 0;
    while (!queue.isEmpty() && guard++ < 4000) {
      String current = queue.remove(0);
      order.add(current);
      List<String> newlyReady = new ArrayList<>();
      for (String dependent : graph.dependents.getOrDefault(current, Collections.emptyList())) {
        if (!member.contains(dependent)) continue;
        int left = indegree.getOrDefault(dependent, 0) - 1;
        indegree.put(dependent, left);
        if (left <= 0) newlyReady.add(dependent);
      }
      newlyReady.sort(FrontierOracle::cmp);
      queue.addAll(newlyReady);
    }

    Set<String> placed = new LinkedHashSet<>(order);
    List<String> cyclic = new ArrayList<>();
    for (String id : skillIds) if (!placed.contains(id)) cyclic.add(id);
    cyclic.sort(FrontierOracle::cmp);

    List<String> combined = new ArrayList<>(order);
    combined.addAll(cyclic);
    return combined;
  }

  static double masteryOf(Map<String, Rating> ratings, String skillId, Constants constants) {
    Rating rating = ratings.get(skillId);
    if (rating == null) return 0d;
    double base = constants.mastery.getOrDefault(rating.state, 0d);
    if (rating.quiz != null) {
      return clamp(base * 0.7 + clamp(rating.quiz, 0, 1) * 0.3, 0, 1);
    }
    return base;
  }

  static Report analyse(Case input, Constants constants) {
    Map<String, Skill> metaById = input.skills;
    Map<String, Rating> ratings = new LinkedHashMap<>();
    for (Rating rating : input.ratings) ratings.put(rating.skillId, rating);

    final List<String> targetIds = new ArrayList<>(new LinkedHashSet<>(input.targets));
    Set<String> targetSet = new LinkedHashSet<>(targetIds);
    List<String> allIds = new ArrayList<>(new LinkedHashSet<>(metaById.keySet()));
    for (String id : targetIds) if (!allIds.contains(id)) allIds.add(id);

    Graph graph = buildGraph(allIds, input.edges);

    /* --- transitive prerequisite closure of the targets ------------------ */
    Set<String> closure = new LinkedHashSet<>();
    Deque<String> queue = new ArrayDeque<>(targetIds);
    int guard = 0;
    while (!queue.isEmpty() && guard++ < constants.maxTraversal) {
      String current = queue.poll();
      if (closure.contains(current)) continue;
      closure.add(current);
      for (String prereq : graph.prerequisites.getOrDefault(current, Collections.emptyList())) {
        if (!closure.contains(prereq)) queue.add(prereq);
      }
    }

    List<String> closureIds = sortedCopy(new ArrayList<>(closure));
    List<String> remainingIds = new ArrayList<>();
    for (String id : closureIds) {
      if (masteryOf(ratings, id, constants) < constants.prereqMetThreshold) remainingIds.add(id);
    }
    Set<String> remainingSet = new LinkedHashSet<>(remainingIds);

    /* --- gates: how many remaining skills each remaining skill unblocks --- */
    final int maxTraversal = constants.maxTraversal;
    java.util.function.Function<String, Integer> unlocksCount = (id) -> {
      Set<String> seen = new LinkedHashSet<>();
      Deque<String> walk = new ArrayDeque<>(graph.dependents.getOrDefault(id, Collections.emptyList()));
      int steps = 0;
      while (!walk.isEmpty() && steps++ < maxTraversal) {
        String current = walk.poll();
        if (seen.contains(current)) continue;
        if (!remainingSet.contains(current)) continue;
        seen.add(current);
        for (String next : graph.dependents.getOrDefault(current, Collections.emptyList())) {
          if (!seen.contains(next)) walk.add(next);
        }
      }
      return seen.size();
    };

    java.util.function.Function<String, Node> toNode = (id) -> {
      Skill meta = metaById.get(id);
      String name = meta != null ? meta.name : id;
      String difficulty = meta != null ? meta.difficulty : "beginner";
      int low = meta != null ? meta.low : constants.defaultHoursLow;
      int high = meta != null ? meta.high : constants.defaultHoursHigh;
      return new Node(id, name, difficulty, low, high, unlocksCount.apply(id), targetSet.contains(id));
    };

    java.util.Comparator<Node> byUnlocks = (a, b) -> {
      if (b.unlocks != a.unlocks) return Integer.compare(b.unlocks, a.unlocks);
      int byName = cmp(a.name, b.name);
      return byName != 0 ? byName : cmp(a.skillId, b.skillId);
    };

    /* --- startable now: nothing unmet in front of it --------------------- */
    List<Node> frontier = new ArrayList<>();
    for (String id : remainingIds) {
      boolean blocked = false;
      for (String prereq : graph.prerequisites.getOrDefault(id, Collections.emptyList())) {
        if (remainingSet.contains(prereq)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) frontier.add(toNode.apply(id));
    }
    frontier.sort(byUnlocks);

    List<Node> gates = new ArrayList<>();
    for (String id : remainingIds) {
      Node node = toNode.apply(id);
      if (node.unlocks > 0) gates.add(node);
    }
    gates.sort(byUnlocks);
    if (gates.size() > 3) gates = new ArrayList<>(gates.subList(0, 3));

    /* --- what the gate set unblocks between them (a union, never a sum) --- */
    int gatesUnlock;
    {
      Set<String> seen = new LinkedHashSet<>();
      Deque<String> walk = new ArrayDeque<>();
      for (Node gate : gates) walk.addAll(graph.dependents.getOrDefault(gate.skillId, Collections.emptyList()));
      int steps = 0;
      while (!walk.isEmpty() && steps++ < maxTraversal) {
        String current = walk.poll();
        if (seen.contains(current)) continue;
        if (!remainingSet.contains(current)) continue;
        seen.add(current);
        for (String next : graph.dependents.getOrDefault(current, Collections.emptyList())) {
          if (!seen.contains(next)) walk.add(next);
        }
      }
      for (Node gate : gates) seen.remove(gate.skillId);
      gatesUnlock = seen.size();
    }

    /* --- depth of every remaining skill, and the longest chain ----------- */
    List<String> ordered = topologicalOrder(remainingIds, graph);
    Map<String, Integer> depthOf = new HashMap<>();
    Map<String, String> parentOf = new HashMap<>();
    for (String id : ordered) {
      if (!remainingSet.contains(id)) continue;
      int depth = 1;
      String parent = null;
      for (String prereq : graph.prerequisites.getOrDefault(id, Collections.emptyList())) {
        if (!remainingSet.contains(prereq)) continue;
        int candidate = depthOf.getOrDefault(prereq, 1) + 1;
        if (candidate > depth
            || (candidate == depth && parent != null && cmp(nodeName(metaById, prereq), nodeName(metaById, parent)) < 0)) {
          depth = candidate;
          parent = prereq;
        }
      }
      depthOf.put(id, depth);
      parentOf.put(id, parent);
    }

    String chainEnd = null;
    for (String id : sortedCopy(remainingIds)) {
      int depth = depthOf.getOrDefault(id, 1);
      if (chainEnd == null
          || depth > depthOf.getOrDefault(chainEnd, 1)
          || (depth == depthOf.getOrDefault(chainEnd, 1)
              && cmp(nodeName(metaById, id), nodeName(metaById, chainEnd)) < 0)) {
        chainEnd = id;
      }
    }
    List<String[]> criticalChain = new ArrayList<>();
    {
      String cursor = chainEnd;
      int chainGuard = 0;
      while (cursor != null && chainGuard++ < maxTraversal) {
        criticalChain.add(0, new String[] { cursor, nodeName(metaById, cursor) });
        cursor = parentOf.get(cursor);
      }
    }

    /* --- hours and the honest week estimate ------------------------------ */
    int low = 0;
    int high = 0;
    for (String id : remainingIds) {
      Skill meta = metaById.get(id);
      low += meta != null ? meta.low : constants.defaultHoursLow;
      high += meta != null ? meta.high : constants.defaultHoursHigh;
    }
    Integer weekly = input.weeklyHours != null && input.weeklyHours > 0 ? input.weeklyHours : null;

    List<Remaining> remaining = new ArrayList<>();
    for (String id : ordered) {
      if (!remainingSet.contains(id)) continue;
      List<String> needsNow = new ArrayList<>();
      for (String prereq : graph.prerequisites.getOrDefault(id, Collections.emptyList())) {
        if (remainingSet.contains(prereq)) needsNow.add(nodeName(metaById, prereq));
      }
      needsNow = sortedCopy(needsNow);
      remaining.add(new Remaining(toNode.apply(id), depthOf.getOrDefault(id, 1), needsNow));
    }
    remaining.sort((a, b) -> {
      if (a.depth != b.depth) return Integer.compare(a.depth, b.depth);
      if (a.node.unlocks != b.node.unlocks) return Integer.compare(b.node.unlocks, a.node.unlocks);
      return cmp(a.node.skillId, b.node.skillId);
    });

    List<String[]> pulledIn = new ArrayList<>();
    for (String id : closureIds) {
      if (!targetSet.contains(id)) pulledIn.add(new String[] { id, nodeName(metaById, id) });
    }

    List<String> cyclic = new ArrayList<>();
    for (String id : graph.cyclic) if (closure.contains(id)) cyclic.add(id);

    List<String> caveats = new ArrayList<>();
    caveats.add(constants.caveatSelfReport);
    caveats.add(constants.caveatEstimates);
    if (!cyclic.isEmpty()) {
      List<String> head = cyclic.subList(0, Math.min(4, cyclic.size()));
      caveats.add("The graph contains a prerequisite cycle (" + String.join(", ", head)
          + "), so the chain length and order for those items are approximate.");
    }
    if (!pulledIn.isEmpty()) {
      caveats.add(pulledIn.size()
          + " skill(s) in this delta are prerequisites of the career's requirements rather than requirements themselves.");
    }

    Report report = new Report();
    report.targetCount = targetIds.size();
    report.closureCount = closureIds.size();
    report.knownInClosure = closureIds.size() - remainingIds.size();
    report.remainingCount = remainingIds.size();
    report.frontier = frontier;
    report.gates = gates;
    report.criticalChain = criticalChain;
    report.remaining = remaining;
    report.pulledIn = pulledIn;
    report.cyclic = cyclic;
    report.hoursLow = low;
    report.hoursHigh = high;
    report.weeklyHours = weekly;
    report.weeksLow = weekly == null || remainingIds.isEmpty() ? null : (int) Math.ceil(low / (double) weekly);
    report.weeksHigh = weekly == null || remainingIds.isEmpty() ? null : (int) Math.ceil(high / (double) weekly);
    report.gatesUnlock = gatesUnlock;
    for (String id : sortedCopy(remainingIds)) {
      report.depths.add(new String[] { id, String.valueOf(depthOf.getOrDefault(id, 1)) });
    }
    report.caveats = caveats;
    report.summaryLine = remainingIds.isEmpty()
        ? "Nothing left in this route: all " + targetIds.size() + " target skills and their "
            + (closureIds.size() - targetIds.size()) + " prerequisites are already met."
        : remainingIds.size() + " skill(s) to go: " + frontier.size() + " startable now, "
            + (gates.isEmpty() ? "no gates left" : gates.size() + " gate(s) unblock " + gatesUnlock)
            + ", longest chain " + criticalChain.size() + " deep.";
    return report;
  }

  static String nodeName(Map<String, Skill> metaById, String id) {
    Skill meta = metaById.get(id);
    return meta != null ? meta.name : id;
  }

  /* ------------------------------------------------------- canonical output */

  /**
   * The canonical serialisation. `scripts/export-frontier-fixture.ts` writes the
   * same shapes from the TypeScript side; if the two printers ever drift, every
   * line differs and the diff says exactly where.
   */
  static List<String> canonicalise(String caseId, Report report) {
    List<String> lines = new ArrayList<>();
    lines.add("CASE\t" + caseId);
    lines.add("COUNT\ttargets=" + report.targetCount
        + "\tclosure=" + report.closureCount
        + "\tknown=" + report.knownInClosure
        + "\tremaining=" + report.remainingCount
        + "\tgates=" + report.gates.size()
        + "\tgatesUnlock=" + report.gatesUnlock);
    lines.add("SUMMARY\t" + report.summaryLine);
    lines.add("HOURS\t" + report.hoursLow + "\t" + report.hoursHigh);
    lines.add("WEEKS\t" + (report.weeksLow == null ? "none" : report.weeksLow)
        + "\t" + (report.weeksHigh == null ? "none" : report.weeksHigh)
        + "\t" + (report.weeklyHours == null ? "none" : report.weeklyHours));
    lines.add("FRONTIER\t" + shape(report.frontier));
    lines.add("GATES\t" + shape(report.gates));
    lines.add("CHAIN\t" + pairs(report.criticalChain));
    lines.add("DEPTHS\t" + pairs(report.depths));
    List<String> remainingShapes = new ArrayList<>();
    for (Remaining item : report.remaining) {
      remainingShapes.add(item.node.skillId + "|" + item.depth + "|" + item.node.unlocks + "|"
          + (item.node.meetsTarget ? "1" : "0") + "|" + String.join(";", item.needsNow));
    }
    lines.add("REMAINING\t" + String.join("\t", remainingShapes));
    lines.add("PULLED\t" + pairs(report.pulledIn));
    lines.add("CYCLIC\t" + String.join(";", report.cyclic));
    lines.add("CAVEATS\t" + String.join("\t", report.caveats));
    return lines;
  }

  static String shape(List<Node> nodes) {
    List<String> out = new ArrayList<>();
    for (Node node : nodes) {
      out.add(node.skillId + "|" + node.name + "|" + node.difficulty + "|" + node.low + "|" + node.high
          + "|" + node.unlocks + "|" + (node.meetsTarget ? "1" : "0"));
    }
    return String.join("\t", out);
  }

  static String pairs(List<String[]> rows) {
    List<String> out = new ArrayList<>();
    for (String[] row : rows) out.add(row[0] + "|" + row[1]);
    return String.join("\t", out);
  }

  /* ------------------------------------------------------------------ driver */

  static final String[] TAG_ORDER = { "CASE", "COUNT", "SUMMARY", "HOURS", "WEEKS", "FRONTIER", "GATES", "CHAIN",
      "DEPTHS", "REMAINING", "PULLED", "CYCLIC", "CAVEATS" };

  static boolean isCanonicalTag(String line) {
    int tab = line.indexOf('\t');
    String head = tab < 0 ? line : line.substring(0, tab);
    for (String tag : TAG_ORDER) if (tag.equals(head)) return true;
    return false;
  }

  static String parts(String raw) {
    int tab = raw.indexOf('\t');
    return tab < 0 ? raw : raw.substring(0, tab);
  }

  static List<Case> parse(Path fixture, Constants constants, List<String> warnings) throws IOException {
    List<Case> cases = new ArrayList<>();
    Case current = null;
    boolean expectedMode = false;

    for (String raw : Files.readAllLines(fixture, StandardCharsets.UTF_8)) {
      if (raw.isEmpty()) continue;
      if (raw.startsWith("#case ")) {
        expectedMode = false;
        continue;
      }
      if (parts(raw).equals("#EXPECTED")) {
        expectedMode = true;
        continue;
      }
      if (raw.startsWith("#")) continue;

      String[] parts = raw.split("\t", -1);
      if (parts[0].equals("CONST")) {
        String name = parts[1];
        String value = parts.length > 2 ? parts[2] : "";
        switch (name) {
          case "prereqMetThreshold": constants.prereqMetThreshold = Double.parseDouble(value); break;
          case "maxTraversal": constants.maxTraversal = Integer.parseInt(value); break;
          case "maxSteps": constants.maxSteps = Integer.parseInt(value); break;
          case "defaultHoursLow": constants.defaultHoursLow = Integer.parseInt(value); break;
          case "defaultHoursHigh": constants.defaultHoursHigh = Integer.parseInt(value); break;
          case "caveat.selfReport": constants.caveatSelfReport = value; break;
          case "caveat.estimates": constants.caveatEstimates = value; break;
          default:
            if (name.startsWith("mastery.")) constants.mastery.put(name.substring("mastery.".length()), Double.parseDouble(value));
            break;
        }
        continue;
      }
      if (!expectedMode && parts[0].equals("CASE")) {
        current = new Case(parts[1], parts.length > 2 ? parts[2] : parts[1]);
        cases.add(current);
        continue;
      }
      if (current == null) {
        warnings.add("Line outside any case, ignored: " + raw);
        continue;
      }
      if (expectedMode && isCanonicalTag(raw)) {
        current.expected.add(raw);
        continue;
      }
      switch (parts[0]) {
        case "TARGET": current.targets.add(parts[1]); break;
        case "SKILL":
          current.skills.put(parts[1], new Skill(parts[1], parts[2], parts[3], Integer.parseInt(parts[4]), Integer.parseInt(parts[5])));
          break;
        case "EDGE": current.edges.add(new String[] { parts[1], parts[2] }); break;
        case "RATING":
          current.ratings.add(new Rating(parts[1], parts[2], parts[3].equals("none") ? null : Double.parseDouble(parts[3])));
          break;
        case "WEEKLY": current.weeklyHours = Integer.parseInt(parts[1]); break;
        default: warnings.add("Unrecognised line, ignored: " + raw); break;
      }
    }
    return cases;
  }

  static final class Mismatch {
    final String caseId;
    final int line;
    final String expected;
    final String actual;
    final String reason;

    Mismatch(String caseId, int line, String expected, String actual, String reason) {
      this.caseId = caseId;
      this.line = line;
      this.expected = expected;
      this.actual = actual;
      this.reason = reason;
    }
  }

  static List<Mismatch> compare(List<Case> cases, Constants constants) {
    List<Mismatch> mismatches = new ArrayList<>();
    for (Case item : cases) {
      Report report = analyse(item, constants);
      List<String> actual = canonicalise(item.id, report);
      if (actual.size() != item.expected.size()) {
        mismatches.add(new Mismatch(item.id, -1, item.expected.size() + " line(s)", actual.size() + " line(s)",
            "the canonical block has a different number of lines"));
        continue;
      }
      for (int i = 0; i < actual.size(); i++) {
        if (!actual.get(i).equals(item.expected.get(i))) {
          mismatches.add(new Mismatch(item.id, i + 1, item.expected.get(i), actual.get(i), "line differs"));
        }
      }
    }
    return mismatches;
  }

  static int comparedLines(List<Case> cases) {
    int total = 0;
    for (Case item : cases) total += item.expected.size();
    return total;
  }

  public static void main(String[] args) throws IOException {
    Path fixture = args.length > 0 && !args[0].startsWith("--")
        ? Paths.get(args[0])
        : Paths.get("tools", "oracle", "fixtures", "frontier-oracle.tsv");
    boolean selfTest = false;
    boolean verbose = false;
    for (String arg : args) {
      if (arg.equals("--selftest")) selfTest = true;
      if (arg.equals("--verbose")) verbose = true;
    }

    if (!Files.exists(fixture)) {
      System.err.println("Fixture not found: " + fixture.toAbsolutePath());
      System.err.println("Generate it first: npm run oracle:export");
      System.exit(1);
    }

    System.out.println("Frontier oracle - tools/oracle/FrontierOracle.java (Java " + System.getProperty("java.version")
        + ", no dependencies)");
    Constants constants = new Constants();
    List<String> warnings = new ArrayList<>();
    List<Case> cases = parse(fixture, constants, warnings);
    System.out.println("Fixture: " + fixture + " (" + cases.size() + " case(s))");
    System.out.println("Declared by fixture: met-threshold " + constants.prereqMetThreshold
        + " | traversal budget " + constants.maxTraversal + " | default hours " + constants.defaultHoursLow + "-"
        + constants.defaultHoursHigh + " | mastery states " + constants.mastery.size());
    for (String warning : warnings) System.out.println("  note: " + warning);

    int cyclicCases = 0;
    for (Case item : cases) {
      List<String> closure = analyse(item, constants).cyclic;
      if (!closure.isEmpty()) cyclicCases++;
    }
    if (cyclicCases > 0) {
      System.out.println("  note: " + cyclicCases + " case(s) contain a prerequisite cycle; cycle members are ordered by");
      System.out.println("        the cyclic tail, where JS localeCompare and Java compareTo may legitimately differ.");
    }

    if (selfTest) {
      // Prove the diff can actually fail: inject one digit change into the expected
      // block and require that it is caught. A comparison that cannot fail is not a test.
      Case target = cases.get(0);
      int index = -1;
      for (int i = 0; i < target.expected.size(); i++) {
        if (target.expected.get(i).startsWith("DEPTHS\t")) { index = i; break; }
      }
      if (index < 0) {
        System.err.println("Self-test failed: no DEPTHS line in the first case to corrupt.");
        System.exit(1);
      }
      String original = target.expected.get(index);
      char[] chars = original.toCharArray();
      for (int i = chars.length - 1; i >= 0; i--) {
        if (Character.isDigit(chars[i])) {
          chars[i] = chars[i] == '9' ? '8' : (char) (chars[i] + 1);
          break;
        }
      }
      target.expected.set(index, new String(chars));
      List<Mismatch> injected = compare(cases, constants);
      System.out.println("Self-test: injected an error into " + target.id + " line " + (index + 1) + " (DEPTHS).");
      if (injected.isEmpty()) {
        System.out.println("Self-test FAILED: the diff did not notice an injected error, so a clean run would prove nothing.");
        System.exit(1);
      }
      System.out.println("Self-test OK: the diff caught it - " + describe(injected.get(0)));
      target.expected.set(index, original);
      System.exit(0);
    }

    List<Mismatch> mismatches = compare(cases, constants);

    Set<String> failing = new LinkedHashSet<>();
    for (Mismatch mismatch : mismatches) failing.add(mismatch.caseId);
    for (Case item : cases) {
      Report report = analyse(item, constants);
      boolean ok = !failing.contains(item.id);
      String detail = report.remainingCount + " remaining, " + report.frontier.size() + " startable, chain "
          + report.criticalChain.size() + ", " + report.hoursLow + "-" + report.hoursHigh + "h";
      System.out.println((ok ? "PASS  " : "FAIL  ") + pad(item.id, 42) + detail);
    }

    if (!mismatches.isEmpty()) {
      int shown = 0;
      int limit = verbose ? mismatches.size() : 10;
      for (Mismatch mismatch : mismatches) {
        if (shown++ >= limit) break;
        System.out.println();
        System.out.println("  " + mismatch.caseId + " line " + mismatch.line + " (" + mismatch.reason + ")");
        System.out.println("    TS:     " + window(mismatch.expected, mismatch.actual));
        System.out.println("    oracle: " + window(mismatch.actual, mismatch.expected));
      }
      if (mismatches.size() > limit) {
        System.out.println();
        System.out.println("  ... and " + (mismatches.size() - limit) + " more differing line(s); rerun with --verbose.");
      }
      System.out.println();
      System.out.println("MISMATCH: " + mismatches.size() + " line(s) differ across " + failing.size() + " case(s) of "
          + cases.size() + ". The Java and TypeScript engines disagree - investigate before trusting either number.");
      System.exit(1);
    }

    System.out.println();
    System.out.println("MATCH: " + cases.size() + " case(s), " + comparedLines(cases)
        + " canonical line(s) identical between the TypeScript engine and this Java implementation.");
    System.out.println("Scope: algorithms are independently implemented; tuning constants are declared by the fixture"
        + " and pinned by the TypeScript unit tests.");
  }

  static String describe(Mismatch mismatch) {
    return mismatch.caseId + " line " + mismatch.line + " at column " + firstDifference(mismatch.expected, mismatch.actual)
        + "\n      TS:     " + window(mismatch.expected, mismatch.actual)
        + "\n      oracle: " + window(mismatch.actual, mismatch.expected);
  }

  /** Index of the first differing character, or -1 when the two agree to the end. */
  static int firstDifference(String a, String b) {
    int limit = Math.min(a.length(), b.length());
    for (int i = 0; i < limit; i++) {
      if (a.charAt(i) != b.charAt(i)) return i;
    }
    return a.length() == b.length() ? -1 : limit;
  }

  /**
   * A window around the first difference rather than the first 160 characters.
   * A diff that prints two identical-looking prefixes is worse than useless: it
   * hides the one character that disagrees.
   */
  static String window(String value, String other) {
    int at = firstDifference(value, other);
    if (at < 0 && value.length() <= 200) return value;
    int from = Math.max(0, at - 70);
    int to = Math.min(value.length(), at + 70);
    return (from > 0 ? "..." : "") + value.substring(from, to) + (to < value.length() ? "..." : "");
  }

  static String truncate(String value) {
    return value.length() <= 200 ? value : value.substring(0, 197) + "...";
  }

  static String pad(String value, int width) {
    if (value.length() >= width) return value + " ";
    StringBuilder builder = new StringBuilder(value);
    while (builder.length() < width) builder.append(' ');
    return builder.toString();
  }
}


