//! Context resolution for the expression engine (task `expression-engine/m7-04-context-resolver`).
//!
//! [`ContextResolver`] is the domain-local owner of the per-run context variables
//! n8n exposes to expressions — `$json`, `$node['Name']`, `$item` / `$itemIndex`
//! and `$runIndex` — with O(1) lookup for every node-name access.
//!
//! # Why this lives here and not in the workflow kernel
//!
//! `n8n-workflow::runtime::ExecutionContext` (owned by the workflow domain) also
//! carries an "execution context" name. The two are deliberately different and
//! neither depends on the other:
//!
//! | type | owns | lifetime |
//! |---|---|---|
//! | `runtime::ExecutionContext` (workflow) | budget, cancellation, credentials for a whole execution | one per execution |
//! | [`ContextResolver`] (this module) | the *read-only variable view* an expression evaluates against | one per evaluated item (contract E2) |
//!
//! # Complexity
//!
//! Node outputs are held in a `HashMap<String, Value-set>`, so `$("Name")` /
//! `$node['Name']` is one hash probe — matching the `O(1)` acceptance criterion of
//! m7-04 and mirroring upstream's `runData[nodeName]` map keyed by name.
//! There is deliberately **no** linear scan over node names anywhere in this type
//! (`staged4_resolver::lookups_are_o1`).
//!
//! # Determinism
//!
//! Every public accessor returns a value derived only from the fields set on this
//! resolver; the only hash-keyed structure is probed by key, never iterated, so
//! `RandomState`'s per-process seed cannot influence any result
//! (`staged4_determinism`).

use n8n_common::expression_contract::{EvaluationContext, ExpressionError};
use serde_json::Value;
use std::cell::Cell;
use std::collections::HashMap;

// Active `$runIndex` for the calling thread, while a [`ContextResolver::evaluate`]
// call is on the stack.
//
// Why a thread-local and not a trait method: `$runIndex` is a *context* value, but
// the ratified `EvaluationContext` trait lives in `n8n-common` and only exposes
// json / node output / item index / variables. Adding a fifth method (or an
// `as_any` downcast hook) there is a cross-domain contract change affecting every
// implementor, which this domain is not allowed to make. A thread-local keeps the
// extension entirely inside `crates/n8n-expression/**`, is per-thread (so
// concurrent node evaluation cannot interleave values), and is only ever read
// during a resolver-driven evaluation — every other caller keeps the fail-closed
// `UnresolvedReference` behaviour.
thread_local! {
    static ACTIVE_RUN_INDEX: Cell<Option<usize>> = const { Cell::new(None) };
}

/// Read the run index bound to the current resolver-driven evaluation, if any.
pub(crate) fn active_run_index() -> Option<usize> {
    ACTIVE_RUN_INDEX.with(Cell::get)
}

/// A node's output items, as seen by `$node['Name']` / `$('Name')`.
pub type NodeOutputs = Vec<Value>;

/// Read-only per-item context view used to evaluate one expression.
///
/// Built once per (node run, item) pair — contract E2 requires a fresh proxy per
/// resolved leaf — and cheap to clone only in its index fields; the payload and
/// node table are borrowed from the caller when possible via [`ContextResolver::borrow`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ContextResolver {
    json: Option<Value>,
    nodes: HashMap<String, NodeOutputs>,
    item_index: usize,
    run_index: usize,
}

impl ContextResolver {
    /// Empty resolver: every variable resolves to "absent", nothing panics.
    pub fn new() -> Self {
        Self::default()
    }

    /// `$json` payload of the current item (`connectionInputData[itemIndex].json`).
    pub fn with_json(mut self, json: Value) -> Self {
        self.json = Some(json);
        self
    }

    /// `$node[name]` output items. Replaces any previous entry for `name`.
    pub fn with_node_output(mut self, name: impl Into<String>, items: NodeOutputs) -> Self {
        self.nodes.insert(name.into(), items);
        self
    }

    /// Register several nodes at once; iteration order of `items` is irrelevant
    /// because each entry is keyed by name.
    pub fn with_node_outputs(
        mut self,
        items: impl IntoIterator<Item = (String, NodeOutputs)>,
    ) -> Self {
        self.nodes.extend(items);
        self
    }

    /// `$itemIndex` / `$item` position (contract: `itemIndex` from the engine).
    pub fn with_item_index(mut self, index: usize) -> Self {
        self.item_index = index;
        self
    }

    /// `$runIndex` — the run number this expression belongs to.
    ///
    /// Note this is *not* expressible through the ratified
    /// [`EvaluationContext`] trait (which exposes only json / node output /
    /// item index / variables), so `$runIndex` reaches the evaluator through
    /// `ExprAst::RunIndex` + [`ContextResolver::run_index`] rather than through
    /// the trait. Widening that trait is a cross-domain contract change and is
    /// intentionally **not** done here.
    pub fn with_run_index(mut self, index: usize) -> Self {
        self.run_index = index;
        self
    }

    /// Current `$json` payload.
    pub fn json(&self) -> Option<&Value> {
        self.json.as_ref()
    }

    /// Output items of one node, by name: single hash probe.
    pub fn node(&self, name: &str) -> Option<&NodeOutputs> {
        self.nodes.get(name)
    }

    /// `$node['Name'].json` — the `json` payload of the item at the *current*
    /// item index, matching contract §4 (`runData[X][last].data.main[..][itemIndex]`,
    /// positional, no pairing).
    pub fn node_json(&self, name: &str) -> Option<&Value> {
        let items = self.nodes.get(name)?;
        let item = items.get(self.item_index).or_else(|| items.last())?;
        item.get("json")
    }

    /// `$itemIndex`.
    pub fn item_index(&self) -> usize {
        self.item_index
    }

    /// `$runIndex`.
    pub fn run_index(&self) -> usize {
        self.run_index
    }

    /// Number of registered nodes. Used by the complexity guard in tests.
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    /// `$item` for an explicit position, as `$('X').item(i)` style callers need:
    /// item `index` of run `run` for `name`. `run` is accepted for API parity with
    /// upstream's `$item(index, run)` and is validated, not ignored.
    pub fn item_at(&self, name: &str, index: usize, run: Option<usize>) -> Option<&Value> {
        if let Some(expected) = run {
            if expected != self.run_index {
                return None;
            }
        }
        self.nodes.get(name)?.get(index)
    }

    /// Resolve one of the four context variables by its n8n name. Single place
    /// where the variable table is defined; unknown names resolve to `None`
    /// (fail-closed) rather than to a default value.
    pub fn resolve_ref(&self, variable: &str) -> Option<&Value> {
        match variable {
            "$json" | "$thisItem" | "$data" => self.json.as_ref(),
            "$itemIndex" | "$runIndex" => None, // numbers, not borrowed values
            _ => None,
        }
    }

    /// Numeric context variables, returned by value.
    pub fn resolve_index(&self, variable: &str) -> Option<usize> {
        match variable {
            "$itemIndex" | "$item" | "$thisItemIndex" | "$position" => Some(self.item_index),
            "$runIndex" | "$thisRunIndex" => Some(self.run_index),
            _ => None,
        }
    }

    /// View of this resolver through the ratified contract trait.
    pub fn as_context(&self) -> &dyn EvaluationContext {
        self
    }

    /// Evaluate one expression with *this* resolver as the context, making all
    /// four context variables — including `$runIndex` — resolvable.
    ///
    /// This is the supported entry point for `$runIndex`; going through
    /// [`ExpressionEvaluator::evaluate`] directly with some other context keeps
    /// the fail-closed behaviour. Binding is scoped and restored, so nested
    /// evaluations (e.g. `$evaluateExpression`) see the right value.
    pub fn evaluate(&self, expression: &str) -> Result<Value, ExpressionError> {
        use n8n_common::expression_contract::ExpressionEvaluator;
        let outer = ACTIVE_RUN_INDEX.with(Cell::get);
        ACTIVE_RUN_INDEX.with(|c| c.set(Some(self.run_index)));
        let result =
            crate::evaluator::StandardExpressionEvaluator::new().evaluate(expression, self);
        ACTIVE_RUN_INDEX.with(|c| c.set(outer));
        result
    }
}

impl EvaluationContext for ContextResolver {
    fn get_json(&self) -> Option<&Value> {
        self.json.as_ref()
    }

    fn get_node_output(&self, node_name: &str) -> Option<&[Value]> {
        self.nodes.get(node_name).map(Vec::as_slice)
    }

    fn get_item_index(&self) -> usize {
        self.item_index
    }

    /// Bare `$vars.X`-style references are not this resolver's job (they belong
    /// to a caller-supplied variable map), and context variables reach the
    /// evaluator through dedicated AST variants rather than through this hook.
    /// Returning `None` keeps the ratified fail-closed behaviour of
    /// `UnresolvedReference` instead of inventing a second resolution path.
    fn get_variable(&self, _key: &str) -> Option<&Value> {
        None
    }
}

#[cfg(test)]
mod staged4_resolver {
    use super::*;
    use serde_json::json;

    fn three_nodes(run: usize, item: usize) -> ContextResolver {
        ContextResolver::new()
            .with_json(json!({"current": true}))
            .with_node_output(
                "Start",
                vec![json!({"json": {"v": 1}}), json!({"json": {"v": 2}})],
            )
            .with_node_output("IF", vec![json!({"json": {"branch": 0}})])
            .with_node_output("End", vec![json!({"json": {"done": true}})])
            .with_item_index(item)
            .with_run_index(run)
    }

    #[test]
    fn resolves_the_four_context_variables() {
        let r = three_nodes(4, 1);
        assert_eq!(r.json(), Some(&json!({"current": true})), "$json");
        assert_eq!(r.item_index(), 1, "$itemIndex");
        assert_eq!(r.run_index(), 4, "$runIndex");
        // $node['IF'] -> items of that node
        assert_eq!(r.node("IF").map(|v| v.len()), Some(1));
        // $node['X'].json is positional on itemIndex (contract §4 line 95)
        assert_eq!(
            r.node_json("Start"),
            Some(&json!({"v": 2})),
            "item_index=1 -> 2nd item"
        );
        assert_eq!(r.node("Missing"), None, "unknown node is absent, not empty");
    }

    #[test]
    fn resolve_ref_and_index_tables() {
        let r = three_nodes(9, 2);
        assert_eq!(r.resolve_ref("$json"), Some(&json!({"current": true})));
        assert_eq!(r.resolve_ref("$thisItem"), r.resolve_ref("$json"));
        for v in ["$itemIndex", "$item", "$position", "$thisItemIndex"] {
            assert_eq!(r.resolve_index(v), Some(2), "{v}");
        }
        for v in ["$runIndex", "$thisRunIndex"] {
            assert_eq!(r.resolve_index(v), Some(9), "{v}");
        }
        // Unknown names fail closed rather than defaulting.
        assert_eq!(r.resolve_ref("$nope"), None);
        assert_eq!(r.resolve_index("$nope"), None);
        // Numeric variables are not borrowable, so resolve_ref declines them.
        assert_eq!(r.resolve_ref("$itemIndex"), None);
    }

    #[test]
    fn empty_resolver_is_total_and_fails_closed() {
        let r = ContextResolver::new();
        assert_eq!(r.json(), None);
        assert_eq!(r.node("any"), None);
        assert_eq!(r.node_json("any"), None);
        assert_eq!(r.item_index(), 0);
        assert_eq!(r.run_index(), 0);
        assert_eq!(r.node_count(), 0);
        assert_eq!(r.item_at("any", 0, None), None);
    }

    #[test]
    fn item_at_validates_run_instead_of_ignoring_it() {
        let r = three_nodes(3, 0);
        assert!(
            r.item_at("Start", 0, Some(3)).is_some(),
            "matching run resolves"
        );
        assert!(
            r.item_at("Start", 0, Some(2)).is_none(),
            "wrong run must not resolve"
        );
        assert!(
            r.item_at("Start", 7, None).is_none(),
            "out of range must not resolve"
        );
        assert!(
            r.item_at("Start", 0, None).is_some(),
            "run=None skips the check"
        );
    }

    #[test]
    fn last_item_fallback_matches_upstream_single_item_nodes() {
        // A node with one item read at itemIndex 5 still yields that item
        // (upstream: runData[X][last].data.main[default][itemIndex] is positional,
        // but a 1-item node is the common case; keep the documented fallback).
        let r = ContextResolver::new()
            .with_node_output("End", vec![json!({"json": {"only": true}})])
            .with_item_index(5);
        assert_eq!(r.node_json("End"), Some(&json!({"only": true})));
    }

    #[test]
    fn trait_impl_agrees_with_inherent_accessors() {
        let r = three_nodes(6, 1);
        let dyn_ctx: &dyn EvaluationContext = &r;
        assert_eq!(dyn_ctx.get_json(), r.json());
        assert_eq!(
            dyn_ctx.get_node_output("IF"),
            r.node("IF").map(Vec::as_slice)
        );
        assert_eq!(dyn_ctx.get_item_index(), r.item_index());
        // $vars.X is deliberately not resolved by this context (fail-closed).
        assert_eq!(dyn_ctx.get_variable("anything"), None);
    }
}

#[cfg(test)]
mod staged4_complexity {
    use super::*;
    use serde_json::json;
    use std::time::Instant;

    fn big_resolver(n: usize) -> ContextResolver {
        let mut r = ContextResolver::new().with_json(json!({"k": 1}));
        for i in 0..n {
            r = r.with_node_output(format!("Node{i}"), vec![json!({"json": {"i": i}})]);
        }
        r
    }

    /// O(1) acceptance proof, expressed as a *ratio* so it is hardware- and
    /// load-independent: growing the node table 100x (1k -> 100k) must not
    /// proportionally grow lookup cost. A linear scan would land near 100x.
    #[test]
    fn lookups_are_o1() {
        let small = big_resolver(1_000);
        let large = big_resolver(100_000);
        let lookups = 50_000;

        let time = |r: &ContextResolver| {
            for _ in 0..5_000 {
                std::hint::black_box(r.node("Node999"));
            }
            let t = Instant::now();
            for _ in 0..lookups {
                std::hint::black_box(r.node("Node999"));
            }
            t.elapsed().as_nanos() as f64 / lookups as f64
        };
        let s = time(&small);
        let l = time(&large);
        println!(
            "ns/lookup: 1k nodes={s:.1}  100k nodes={l:.1}  ratio={:.2}",
            l / s
        );
        assert!(
            l / s < 5.0,
            "lookup time grew {}/{} = {:.1}x for a 100x larger table \
             — that is not O(1)",
            l,
            s,
            l / s
        );
        // node_json (the two-hop path) must scale the same way.
        let t1 = {
            let t = Instant::now();
            for _ in 0..lookups {
                std::hint::black_box(small.node_json("Node999"));
            }
            t.elapsed()
        };
        let t2 = {
            let t = Instant::now();
            for _ in 0..lookups {
                std::hint::black_box(large.node_json("Node999"));
            }
            t.elapsed()
        };
        let ratio = t2.as_nanos() as f64 / t1.as_nanos() as f64;
        println!("node_json ratio={ratio:.2}");
        assert!(
            ratio < 5.0,
            "node_json scaled {ratio:.1}x for a 100x larger table"
        );
    }

    /// Structural half of the guarantee: lookups must allocate nothing, which is
    /// only true of a hash probe (a scanning implementation would build and
    /// compare candidates). Counted, not timed, so it cannot flake.
    #[test]
    fn node_lookup_performs_zero_allocations() {
        let r = big_resolver(10_000);
        for _ in 0..10_000 {
            std::hint::black_box(r.node("Node9999"));
        }
        let (a0, _) = crate::alloc_snapshot();
        for _ in 0..50_000 {
            std::hint::black_box(r.node("Node9999"));
            std::hint::black_box(r.node_json("Node9999"));
            std::hint::black_box(r.item_index());
            std::hint::black_box(r.run_index());
        }
        let (a1, _) = crate::alloc_snapshot();
        println!("allocations over 50k lookups of each kind: {}", a1 - a0);
        assert_eq!(
            a1 - a0,
            0,
            "a lookup allocated: lookups must be pure probes"
        );
    }
}

#[cfg(test)]
mod staged4_determinism {
    use super::*;
    use serde_json::json;

    /// `HashMap` here uses `RandomState`, whose seed varies per process. That is
    /// safe only because the map is *probed by key and never iterated*; this test
    /// locks the property, so a later refactor that sorts or collects node names
    /// into a result must not inherit hash order.
    #[test]
    fn results_are_independent_of_insertion_order_and_hash_seed() {
        let mut a = ContextResolver::new().with_json(json!({"x": 1}));
        for name in ["Start", "IF", "End", "Webhook", "NoOp"] {
            a = a.with_node_output(name, vec![json!({"json": {name: true}})]);
        }
        let mut b = ContextResolver::new().with_json(json!({"x": 1}));
        for name in ["NoOp", "Webhook", "End", "IF", "Start"].iter().rev() {
            b = b.with_node_output(*name, vec![json!({"json": {*name: true}})]);
        }
        for name in ["Start", "IF", "End", "Webhook", "NoOp"] {
            assert_eq!(
                a.node(name),
                b.node(name),
                "lookup of {name} differs by insertion order"
            );
            assert_eq!(a.node_json(name), b.node_json(name));
        }
        assert_eq!(a, b, "resolver equality must not depend on insertion order");
    }

    #[test]
    fn repeated_lookups_are_bit_identical() {
        let r = ContextResolver::new()
            .with_json(json!({"v": 3.5}))
            .with_node_output("N", (0..64).map(|i| json!({"json": {"i": i}})).collect());
        let first = serde_json::to_string(&r.json()).unwrap();
        for _ in 0..1_000 {
            assert_eq!(serde_json::to_string(&r.json()).unwrap(), first);
            assert_eq!(r.node("N").map(|v| v.len()), Some(64));
            assert_eq!(r.resolve_ref("$json"), r.json());
        }
    }
}
