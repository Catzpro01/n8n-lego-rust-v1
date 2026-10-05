# 04-cycle

**n8n does not reject cycles.** No function in `common/` or `graph/` raises on a cycle; all traversals carry a visited set. Cycle *handling* for partial executions (`DirectedGraph.getStronglyConnectedComponents`, `handleCycles`) lives in `packages/core` (forbidden path for this LEGO) and is only referenced.
