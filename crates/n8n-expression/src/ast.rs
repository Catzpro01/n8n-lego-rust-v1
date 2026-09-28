//! AST definitions for the n8n expression evaluator (Phase 3 Rust runtime).
//!
//! Design notes (TASK-EXP-EVAL-01 / graph ⇄ expression contract):
//! - The base variants (`Literal`, `JsonPath`, `NodeLookup`, `ItemIndex`,
//!   `Variable`, `BinaryOp`, `UnaryOp`, `Template`) are the ratified Phase-3
//!   pilot set and are kept stable for cross-crate consumers.
//! - The extended variants (`Ternary`, `ArrayLiteral`, `ObjectLiteral`,
//!   `GetProperty`, `GetIndex`, `MethodCall`, `FunctionCall`, `NodeHandle`)
//!   close the gap to the n8n v2.9.4 expression contract: extension-method
//!   calls (`.isEmpty()`, `.first()`, …), `$('Node')` handles, extended
//!   functions (`$if`, `$min`, …), ternary expressions and literals.
//!   They only appear when the corresponding syntax is actually used, so
//!   previously supported expressions keep their exact old AST shape.

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum PathSegment {
    Field(String),
    Index(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryOperator {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Eq,
    NotEq,
    Lt,
    Lte,
    Gt,
    Gte,
    And,
    Or,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnaryOperator {
    Not,
    Neg,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TemplateSegment {
    Text(String),
    Expression(Box<ExprAst>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ExprAst {
    // ------------------------------------------------------------------
    // Phase-3 pilot variants (ratified, stable shape).
    // ------------------------------------------------------------------
    Literal(Value),
    JsonPath(Vec<PathSegment>),
    NodeLookup {
        node_name: String,
        path: Vec<PathSegment>,
    },
    ItemIndex,
    Variable(String),
    BinaryOp {
        left: Box<ExprAst>,
        op: BinaryOperator,
        right: Box<ExprAst>,
    },
    UnaryOp {
        op: UnaryOperator,
        expr: Box<ExprAst>,
    },
    Template(Vec<TemplateSegment>),

    // ------------------------------------------------------------------
    // Extended contract variants (added for TASK-EXP-EVAL-01 hardening).
    // ------------------------------------------------------------------
    /// `cond ? then : otherwise`
    Ternary {
        cond: Box<ExprAst>,
        then_expr: Box<ExprAst>,
        else_expr: Box<ExprAst>,
    },
    /// `[a, b, ...]` array literal.
    ArrayLiteral(Vec<ExprAst>),
    /// `{key: expr, ...}` object literal. Key order is preserved.
    ObjectLiteral(Vec<(String, ExprAst)>),
    /// `expr.<identifier>` on an arbitrary (non-path) expression.
    GetProperty {
        object: Box<ExprAst>,
        property: String,
    },
    /// `expr[<dynamic>]` on an arbitrary (non-path) expression.
    GetIndex {
        object: Box<ExprAst>,
        index: Box<ExprAst>,
    },
    /// `expr.method(arg, ...)` — n8n extension methods and JS-native
    /// pass-through methods, resolved by `extensions` (see E12).
    MethodCall {
        target: Box<ExprAst>,
        name: String,
        args: Vec<ExprAst>,
    },
    /// `$if(...)` / `$min(...)` / … — n8n extended functions callable in
    /// expression scope, resolved by `extensions::eval_extended_function`.
    FunctionCall {
        name: String,
        args: Vec<ExprAst>,
    },
    /// `$runIndex` — the run number of the current evaluation. Context-supplied
    /// (not a literal), and the reason a `run_index` accessor exists on the
    /// expression-side context resolver; the ratified `EvaluationContext` trait
    /// cannot express it, so it is resolved by downcast in `evaluator.rs`.
    RunIndex,
    /// `$('Node Name')` handle. Must be followed by a member access
    /// (`.json`, `.first()`, …) before it can become a JSON value.
    NodeHandle(String),
}
