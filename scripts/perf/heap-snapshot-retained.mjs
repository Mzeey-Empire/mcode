/**
 * Retained sizes from a V8 heap snapshot. A set of objects retains every object that stays
 * reachable from the GC roots only through that set, which is what removing the set would free.
 */

function readGraph(snapshot) {
  const meta = snapshot.snapshot.meta;
  const nodeFieldCount = meta.node_fields.length;
  const edgeFieldCount = meta.edge_fields.length;
  const nodeCount = snapshot.nodes.length / nodeFieldCount;
  const firstEdge = new Uint32Array(nodeCount + 1);
  const edgeCountOffset = meta.node_fields.indexOf("edge_count");
  for (let node = 0; node < nodeCount; node += 1) {
    firstEdge[node + 1] = firstEdge[node] + snapshot.nodes[node * nodeFieldCount + edgeCountOffset] * edgeFieldCount;
  }
  return {
    snapshot,
    nodeFieldCount,
    edgeFieldCount,
    nodeCount,
    firstEdge,
    selfSizeOffset: meta.node_fields.indexOf("self_size"),
    edgeTypeOffset: meta.edge_fields.indexOf("type"),
    edgeNameOffset: meta.edge_fields.indexOf("name_or_index"),
    edgeToOffset: meta.edge_fields.indexOf("to_node"),
    edgeTypes: meta.edge_types[meta.edge_fields.indexOf("type")],
  };
}

function edgeTypeName(graph, edge) {
  return graph.edgeTypes[graph.snapshot.edges[edge + graph.edgeTypeOffset]];
}

function edgeTarget(graph, edge) {
  return graph.snapshot.edges[edge + graph.edgeToOffset] / graph.nodeFieldCount;
}

function edgeName(graph, edge) {
  const type = edgeTypeName(graph, edge);
  const value = graph.snapshot.edges[edge + graph.edgeNameOffset];
  return type === "element" || type === "hidden" ? null : graph.snapshot.strings[value];
}

function* outgoingEdges(graph, node) {
  for (let edge = graph.firstEdge[node]; edge < graph.firstEdge[node + 1]; edge += graph.edgeFieldCount) yield edge;
}

// Weak edges do not keep their target alive, so they never count toward retention.
function markReachable(graph, excluded) {
  const reached = new Uint8Array(graph.nodeCount);
  const stack = [0];
  reached[0] = 1;
  while (stack.length > 0) {
    const node = stack.pop();
    for (const edge of outgoingEdges(graph, node)) {
      if (edgeTypeName(graph, edge) === "weak") continue;
      const target = edgeTarget(graph, edge);
      if (reached[target] || excluded.has(target)) continue;
      reached[target] = 1;
      stack.push(target);
    }
  }
  return reached;
}

/** Returns the node an object property edge named `name` points to from `node`, or null. */
function propertyTarget(graph, node, name) {
  for (const edge of outgoingEdges(graph, node)) {
    if (edgeTypeName(graph, edge) === "property" && edgeName(graph, edge) === name) return edgeTarget(graph, edge);
  }
  return null;
}

function findPropertyHolder(graph, name) {
  for (let node = 0; node < graph.nodeCount; node += 1) {
    const target = propertyTarget(graph, node, name);
    if (target !== null) return target;
  }
  return null;
}

function findNodeWithProperties(graph, required, wanted) {
  for (let node = 0; node < graph.nodeCount; node += 1) {
    const found = propertyTarget(graph, node, wanted);
    if (found !== null && Object.entries(required).every(([name, target]) => propertyTarget(graph, node, name) === target)) return found;
  }
  return null;
}

/** Creates a calculator that sums the bytes each set of snapshot nodes retains. */
export function createRetainedSizeCalculator(snapshot) {
  const graph = readGraph(snapshot);
  const baseline = markReachable(graph, new Set());
  return {
    graph,
    /** Bytes freed if every node in `nodes` were dropped. */
    retainedBytes(nodes) {
      const excluded = new Set(nodes.filter((node) => node !== null));
      if (excluded.size === 0) return null;
      const reached = markReachable(graph, excluded);
      let bytes = 0;
      for (let node = 0; node < graph.nodeCount; node += 1) {
        if (baseline[node] && !reached[node]) bytes += snapshot.nodes[node * graph.nodeFieldCount + graph.selfSizeOffset];
      }
      return bytes;
    },
    /** The node an object property named `name` points to, from the first object that has it. */
    findProperty(name) {
      return findPropertyHolder(graph, name);
    },
    /** The node `owner.wanted` points to, for the first object whose properties match `required`. */
    findSibling(required, wanted) {
      return findNodeWithProperties(graph, required, wanted);
    },
    propertyTarget(node, name) {
      return node === null ? null : propertyTarget(graph, node, name);
    },
  };
}

/**
 * Measures the M5 bar from a snapshot taken while `window.<probeName>` holds the store's threads
 * array, the sidebar facts array, and the thread index map. The facts cache's id map has no
 * public handle, so it is found as the `byId` sibling of the cached `facts` array.
 */
export function measureSidebarRetained(snapshot, probeName) {
  const calculator = createRetainedSizeCalculator(snapshot);
  const probe = calculator.findProperty(probeName);
  const threads = calculator.propertyTarget(probe, "threads");
  const facts = calculator.propertyTarget(probe, "facts");
  const index = calculator.propertyTarget(probe, "index");
  const factsById = facts === null ? null : calculator.findSibling({ facts }, "byId");
  const caches = [facts, factsById, index];
  return {
    found: { probe: probe !== null, threads: threads !== null, facts: facts !== null, factsById: factsById !== null, index: index !== null },
    threadsExclusiveBytes: calculator.retainedBytes([threads]),
    cachesBytes: calculator.retainedBytes(caches),
    threadsAndCachesBytes: calculator.retainedBytes([threads, ...caches]),
  };
}
