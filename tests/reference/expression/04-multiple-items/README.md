# 04-multiple-items

Graph: Start -> IF -(0)-> TrueBranch -> Code, IF -(1)-> FalseBranch (never ran).

Shows that item resolution is per `itemIndex`, that `.item` follows the pairedItem chain across two hops and across the branch index recorded in `source.previousNodeOutput`, and how the default output branch is chosen from the graph.
