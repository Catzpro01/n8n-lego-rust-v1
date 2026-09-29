//! Recursive-descent parser for n8n expressions.
//!
//! Grammar coverage (aligned with `contracts/expression.contract.md`):
//!
//! * Whole-string `={{ ... }}` keeps the raw evaluated type (contract §3).
//! * Mixed templates (`"Hello {{ $json.name }}!"`) render as strings.
//! * A leading `=` marks an expression context and is stripped
//!   (`"=text"` → `"text"`, `"="` → `""`).
//! * Paths: `$json.a[0].b`, `$node['Node'].json.x`, `$vars.key`, `$env.KEY`.
//! * Handles: `$('Node Name')` (paired family member access).
//! * Operators: `+ - * / %`, `== != === !== < <= > >=`, `&& ||`, unary `! -`,
//!   ternary `cond ? a : b` (right-associative).
//! * Literals: numbers (floats & exponents), single/double-quoted strings
//!   with escapes, `true` / `false` / `null`, arrays `[a, b]`, objects
//!   `{key: value, "key": value}`.
//! * Calls: `expr.method(args...)` (n8n extensions + native pass-through,
//!   see `extensions.rs`) and extended functions `$if`, `$min`, `$max`,
//!   `$average`, `$avg`, `$not`, `$ifEmpty`.
//!
//! Everything unrecognised fails closed with `ExpressionError::SyntaxError`
//! (the engine maps this to the `"invalid syntax"` application error, E14).

use crate::ast::{BinaryOperator, ExprAst, PathSegment, TemplateSegment, UnaryOperator};
use crate::extensions::is_extended_function;
use crate::sandbox::check_source_sandboxed;
use n8n_common::ExpressionError;
use serde_json::Value;

/// Recursion budget for nested primaries (`((((…))))`, deep ternaries,
/// long argument lists). Prevents stack exhaustion on hostile input;
/// exhaustion itself fails closed as a syntax error.
const MAX_DEPTH: usize = 128;

/// Parses a full parameter string into an `ExprAst`.
///
/// Dispatch rules (contract §3 / E1):
/// 1. Leading `=` → expression context; the marker is stripped.
/// 2. Exactly one handlebars block spanning the whole body keeps raw types.
/// 3. Any handlebars block with surrounding literal text → string template.
/// 4. `"="` alone → `""`; `"=text"` (no block) → `"text"`.
/// 5. No `=` and no handlebars → literal string, unchanged (identity).
pub fn parse(input: &str) -> Result<ExprAst, ExpressionError> {
    let trimmed = input.trim();

    let body: &str = if let Some(rest) = trimmed.strip_prefix('=') {
        rest
    } else if trimmed.contains("{{") && trimmed.contains("}}") {
        trimmed
    } else {
        return Ok(ExprAst::Literal(Value::String(input.to_string())));
    };

    // "=" alone evaluates to the empty string.
    if body.is_empty() {
        return Ok(ExprAst::Literal(Value::String(String::new())));
    }

    // Exactly one block spanning the whole body preserves the raw type.
    if let Some(inner) = spanning_expression_body(body) {
        return parse_single_expression(inner);
    }

    if body.contains("{{") {
        return parse_template(body);
    }

    // "=text" without handlebars → literal text with the marker stripped.
    Ok(ExprAst::Literal(Value::String(body.to_string())))
}

/// Returns the inner source when `body` consists of exactly one handlebars
/// block (`{{ ... }}` and nothing else). Quoted `}}` sequences inside the
/// expression do not terminate the block (e.g. `{{ "a}}b" }}`).
fn spanning_expression_body(body: &str) -> Option<&str> {
    if !(body.starts_with("{{") && body.ends_with("}}")) {
        return None;
    }
    match find_handlebars_close(body, 2) {
        Some(close) if close + 2 == body.len() => Some(&body[2..close]),
        _ => None,
    }
}

/// Byte-scans `src` from byte offset `from` for the first `}}` OUTSIDE of
/// any string literal. UTF-8 safe: `}` and the quote characters are ASCII
/// and can never appear inside a multi-byte sequence.
fn find_handlebars_close(src: &str, from: usize) -> Option<usize> {
    let bytes = src.as_bytes();
    let mut quote: Option<u8> = None;
    let mut escaped = false;
    let mut i = from;
    while i + 1 < bytes.len() {
        let b = bytes[i];
        match quote {
            Some(q) => {
                if escaped {
                    escaped = false;
                } else if b == b'\\' {
                    escaped = true;
                } else if b == q {
                    quote = None;
                }
            }
            None => {
                if b == b'"' || b == b'\'' {
                    quote = Some(b);
                } else if b == b'}' && bytes[i + 1] == b'}' {
                    return Some(i);
                }
            }
        }
        i += 1;
    }
    None
}

fn parse_template(input: &str) -> Result<ExprAst, ExpressionError> {
    let mut segments = Vec::new();
    let mut cursor = 0;

    while let Some(start_idx) = input[cursor..].find("{{") {
        let abs_start = cursor + start_idx;
        if abs_start > cursor {
            segments.push(TemplateSegment::Text(input[cursor..abs_start].to_string()));
        }

        let expr_start = abs_start + 2;
        match find_handlebars_close(input, expr_start) {
            Some(abs_end) => {
                let expr_str = &input[expr_start..abs_end];
                let parsed_expr = parse_single_expression(expr_str)?;
                segments.push(TemplateSegment::Expression(Box::new(parsed_expr)));
                cursor = abs_end + 2;
            }
            None => {
                return Err(ExpressionError::SyntaxError {
                    pos: abs_start,
                    message: "Unclosed expression delimiter '{{'".to_string(),
                });
            }
        }
    }

    if cursor < input.len() {
        segments.push(TemplateSegment::Text(input[cursor..].to_string()));
    }

    Ok(ExprAst::Template(segments))
}

fn parse_single_expression(input: &str) -> Result<ExprAst, ExpressionError> {
    // Contract E9: sandbox gate runs before tokenization, fail-closed.
    check_source_sandboxed(input)?;
    let tokens = tokenize(input)?;
    let mut parser = TokenParser::new(tokens);
    let ast = parser.parse_ternary()?;
    if !parser.is_at_end() {
        return Err(ExpressionError::SyntaxError {
            pos: parser.current_pos(),
            message: format!("Unexpected token after expression: {:?}", parser.peek()),
        });
    }
    Ok(ast)
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Number(f64, usize),
    String(String, usize),
    Ident(String, usize),
    Plus(usize),
    Minus(usize),
    Star(usize),
    Slash(usize),
    Percent(usize),
    EqEq(usize),
    BangEq(usize),
    Lt(usize),
    Lte(usize),
    Gt(usize),
    Gte(usize),
    And(usize),
    Or(usize),
    Bang(usize),
    Question(usize),
    Colon(usize),
    Comma(usize),
    LParen(usize),
    RParen(usize),
    LBracket(usize),
    RBracket(usize),
    LBrace(usize),
    RBrace(usize),
    Dot(usize),
}

impl Token {
    fn pos(&self) -> usize {
        match self {
            Token::Number(_, p)
            | Token::String(_, p)
            | Token::Ident(_, p)
            | Token::Plus(p)
            | Token::Minus(p)
            | Token::Star(p)
            | Token::Slash(p)
            | Token::Percent(p)
            | Token::EqEq(p)
            | Token::BangEq(p)
            | Token::Lt(p)
            | Token::Lte(p)
            | Token::Gt(p)
            | Token::Gte(p)
            | Token::And(p)
            | Token::Or(p)
            | Token::Bang(p)
            | Token::Question(p)
            | Token::Colon(p)
            | Token::Comma(p)
            | Token::LParen(p)
            | Token::RParen(p)
            | Token::LBracket(p)
            | Token::RBracket(p)
            | Token::LBrace(p)
            | Token::RBrace(p)
            | Token::Dot(p) => *p,
        }
    }
}

fn tokenize(input: &str) -> Result<Vec<Token>, ExpressionError> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        let ch = chars[i];
        if ch.is_whitespace() {
            i += 1;
            continue;
        }

        match ch {
            '+' => {
                tokens.push(Token::Plus(i));
                i += 1;
            }
            '-' => {
                tokens.push(Token::Minus(i));
                i += 1;
            }
            '*' => {
                tokens.push(Token::Star(i));
                i += 1;
            }
            '/' => {
                tokens.push(Token::Slash(i));
                i += 1;
            }
            '%' => {
                tokens.push(Token::Percent(i));
                i += 1;
            }
            '?' => {
                tokens.push(Token::Question(i));
                i += 1;
            }
            ':' => {
                tokens.push(Token::Colon(i));
                i += 1;
            }
            ',' => {
                tokens.push(Token::Comma(i));
                i += 1;
            }
            '(' => {
                tokens.push(Token::LParen(i));
                i += 1;
            }
            ')' => {
                tokens.push(Token::RParen(i));
                i += 1;
            }
            '[' => {
                tokens.push(Token::LBracket(i));
                i += 1;
            }
            ']' => {
                tokens.push(Token::RBracket(i));
                i += 1;
            }
            '{' => {
                tokens.push(Token::LBrace(i));
                i += 1;
            }
            '}' => {
                tokens.push(Token::RBrace(i));
                i += 1;
            }
            '.' if i + 1 < chars.len() && chars[i + 1].is_ascii_digit() => {
                // Leading-dot number literal (".5").
                let start_pos = i;
                let mut j = i + 1;
                while j < chars.len() && chars[j].is_ascii_digit() {
                    j += 1;
                }
                let num_str = input_slice_chars(&chars, start_pos, j);
                let val: f64 = num_str.parse().map_err(|_| ExpressionError::SyntaxError {
                    pos: start_pos,
                    message: format!("Invalid number: {num_str}"),
                })?;
                tokens.push(Token::Number(val, start_pos));
                i = j;
            }
            '.' => {
                tokens.push(Token::Dot(i));
                i += 1;
            }
            '=' if i + 1 < chars.len() && chars[i + 1] == '=' => {
                tokens.push(Token::EqEq(i));
                // '===' is accepted and behaves identically (strict
                // structural equality on JSON values — no JS coercion).
                i += if i + 2 < chars.len() && chars[i + 2] == '=' {
                    3
                } else {
                    2
                };
            }
            '!' if i + 1 < chars.len() && chars[i + 1] == '=' => {
                tokens.push(Token::BangEq(i));
                i += if i + 2 < chars.len() && chars[i + 2] == '=' {
                    3
                } else {
                    2
                };
            }
            '!' => {
                tokens.push(Token::Bang(i));
                i += 1;
            }
            '<' if i + 1 < chars.len() && chars[i + 1] == '=' => {
                tokens.push(Token::Lte(i));
                i += 2;
            }
            '<' => {
                tokens.push(Token::Lt(i));
                i += 1;
            }
            '>' if i + 1 < chars.len() && chars[i + 1] == '=' => {
                tokens.push(Token::Gte(i));
                i += 2;
            }
            '>' => {
                tokens.push(Token::Gt(i));
                i += 1;
            }
            '&' if i + 1 < chars.len() && chars[i + 1] == '&' => {
                tokens.push(Token::And(i));
                i += 2;
            }
            '|' if i + 1 < chars.len() && chars[i + 1] == '|' => {
                tokens.push(Token::Or(i));
                i += 2;
            }
            '"' | '\'' => {
                let quote = ch;
                let start_pos = i;
                i += 1;
                let mut s = String::new();
                let mut closed = false;
                while i < chars.len() {
                    let c = chars[i];
                    if c == '\\' && i + 1 < chars.len() {
                        let esc = chars[i + 1];
                        match esc {
                            'n' => {
                                s.push('\n');
                                i += 2;
                            }
                            't' => {
                                s.push('\t');
                                i += 2;
                            }
                            'r' => {
                                s.push('\r');
                                i += 2;
                            }
                            '0' => {
                                s.push('\0');
                                i += 2;
                            }
                            'b' => {
                                s.push('\u{0008}');
                                i += 2;
                            }
                            'f' => {
                                s.push('\u{000C}');
                                i += 2;
                            }
                            '\\' => {
                                s.push('\\');
                                i += 2;
                            }
                            '\'' => {
                                s.push('\'');
                                i += 2;
                            }
                            '"' => {
                                s.push('"');
                                i += 2;
                            }
                            '/' => {
                                s.push('/');
                                i += 2;
                            }
                            'u' if i + 6 <= chars.len() => {
                                let hex: String = chars[i + 2..i + 6].iter().collect();
                                let code = u32::from_str_radix(&hex, 16).map_err(|_| {
                                    ExpressionError::SyntaxError {
                                        pos: i,
                                        message: format!("Invalid unicode escape '\\u{hex}'"),
                                    }
                                })?;
                                match char::from_u32(code) {
                                    Some(uc) => {
                                        s.push(uc);
                                        i += 6;
                                    }
                                    None => {
                                        return Err(ExpressionError::SyntaxError {
                                            pos: i,
                                            message: format!(
                                                "Invalid unicode code point '\\u{hex}'"
                                            ),
                                        })
                                    }
                                }
                            }
                            // Unknown escape: keep the escaped character
                            // literally (JS-compatible: "\q" === "q").
                            other => {
                                s.push(other);
                                i += 2;
                            }
                        }
                    } else if c == quote {
                        closed = true;
                        i += 1;
                        break;
                    } else {
                        s.push(c);
                        i += 1;
                    }
                }
                if !closed {
                    return Err(ExpressionError::SyntaxError {
                        pos: start_pos,
                        message: "Unclosed string literal".to_string(),
                    });
                }
                tokens.push(Token::String(s, start_pos));
            }
            ch if ch.is_ascii_digit() => {
                let start_pos = i;
                let mut num_str = String::new();
                let mut seen_dot = false;
                while i < chars.len() {
                    if chars[i].is_ascii_digit() {
                        num_str.push(chars[i]);
                        i += 1;
                    } else if chars[i] == '.'
                        && !seen_dot
                        && i + 1 < chars.len()
                        && chars[i + 1].is_ascii_digit()
                    {
                        seen_dot = true;
                        num_str.push('.');
                        i += 1;
                    } else {
                        break;
                    }
                }
                // Optional exponent: 1e3, 2.5e-2, ...
                if i < chars.len() && (chars[i] == 'e' || chars[i] == 'E') {
                    let mark = i;
                    i += 1;
                    if i < chars.len() && (chars[i] == '+' || chars[i] == '-') {
                        i += 1;
                    }
                    if i < chars.len() && chars[i].is_ascii_digit() {
                        while i < chars.len() && chars[i].is_ascii_digit() {
                            i += 1;
                        }
                        num_str = input_slice_chars(&chars, start_pos, i);
                    } else {
                        // Not an exponent after all — rewind.
                        i = mark;
                        num_str = input_slice_chars(&chars, start_pos, i);
                    }
                }
                let val: f64 = num_str.parse().map_err(|_| ExpressionError::SyntaxError {
                    pos: start_pos,
                    message: format!("Invalid number: {num_str}"),
                })?;
                tokens.push(Token::Number(val, start_pos));
            }
            ch if ch.is_alphabetic() || ch == '$' || ch == '_' => {
                let start_pos = i;
                let mut ident = String::new();
                while i < chars.len()
                    && (chars[i].is_alphanumeric() || chars[i] == '$' || chars[i] == '_')
                {
                    ident.push(chars[i]);
                    i += 1;
                }
                tokens.push(Token::Ident(ident, start_pos));
            }
            other => {
                return Err(ExpressionError::SyntaxError {
                    pos: i,
                    message: format!("Unexpected character: '{other}'"),
                });
            }
        }
    }

    Ok(tokens)
}

fn input_slice_chars(chars: &[char], start: usize, end: usize) -> String {
    chars[start..end].iter().collect()
}

struct TokenParser {
    tokens: Vec<Token>,
    cursor: usize,
    depth: usize,
}

impl TokenParser {
    fn new(tokens: Vec<Token>) -> Self {
        Self {
            tokens,
            cursor: 0,
            depth: 0,
        }
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.cursor)
    }

    fn advance(&mut self) -> Option<Token> {
        if self.cursor < self.tokens.len() {
            let tok = self.tokens[self.cursor].clone();
            self.cursor += 1;
            Some(tok)
        } else {
            None
        }
    }

    fn is_at_end(&self) -> bool {
        self.cursor >= self.tokens.len()
    }

    fn current_pos(&self) -> usize {
        self.peek()
            .map(|t| t.pos())
            .unwrap_or_else(|| self.tokens.last().map(|t| t.pos() + 1).unwrap_or(0))
    }

    /// Enters one level of potentially recursive descent. Fail-closed when
    /// the budget is exceeded (see `MAX_DEPTH`).
    fn enter(&mut self) -> Result<(), ExpressionError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            self.depth -= 1;
            return Err(ExpressionError::SyntaxError {
                pos: self.current_pos(),
                message: format!("Expression nesting exceeds maximum depth of {MAX_DEPTH}"),
            });
        }
        Ok(())
    }

    fn leave(&mut self) {
        self.depth = self.depth.saturating_sub(1);
    }

    /// Ternary layer (lowest precedence, right-associative).
    fn parse_ternary(&mut self) -> Result<ExprAst, ExpressionError> {
        self.enter()?;
        let result = self.parse_ternary_inner();
        self.leave();
        result
    }

    fn parse_ternary_inner(&mut self) -> Result<ExprAst, ExpressionError> {
        let cond = self.parse_binary(0)?;
        if let Some(Token::Question(_)) = self.peek() {
            self.advance();
            // Middle: full expression (matches JS AssignmentExpression).
            let then_expr = self.parse_ternary()?;
            match self.advance() {
                Some(Token::Colon(_)) => {}
                other => {
                    return Err(ExpressionError::SyntaxError {
                        pos: self.current_pos(),
                        message: format!("Expected ':' in ternary expression, found: {other:?}"),
                    })
                }
            }
            // Else branch: right-associative.
            let else_expr = self.parse_ternary()?;
            Ok(ExprAst::Ternary {
                cond: Box::new(cond),
                then_expr: Box::new(then_expr),
                else_expr: Box::new(else_expr),
            })
        } else {
            Ok(cond)
        }
    }

    /// Binary operator chain via precedence climbing.
    fn parse_binary(&mut self, min_precedence: u8) -> Result<ExprAst, ExpressionError> {
        let mut left = self.parse_primary_or_unary()?;

        while let Some(tok) = self.peek() {
            let (prec, op) = match tok {
                Token::Or(_) => (1, BinaryOperator::Or),
                Token::And(_) => (2, BinaryOperator::And),
                Token::EqEq(_) => (3, BinaryOperator::Eq),
                Token::BangEq(_) => (3, BinaryOperator::NotEq),
                Token::Lt(_) => (4, BinaryOperator::Lt),
                Token::Lte(_) => (4, BinaryOperator::Lte),
                Token::Gt(_) => (4, BinaryOperator::Gt),
                Token::Gte(_) => (4, BinaryOperator::Gte),
                Token::Plus(_) => (5, BinaryOperator::Add),
                Token::Minus(_) => (5, BinaryOperator::Sub),
                Token::Star(_) => (6, BinaryOperator::Mul),
                Token::Slash(_) => (6, BinaryOperator::Div),
                Token::Percent(_) => (6, BinaryOperator::Mod),
                _ => break,
            };

            if prec < min_precedence {
                break;
            }

            self.advance();
            let right = self.parse_binary(prec + 1)?;
            left = ExprAst::BinaryOp {
                left: Box::new(left),
                op,
                right: Box::new(right),
            };
        }

        Ok(left)
    }

    fn parse_primary_or_unary(&mut self) -> Result<ExprAst, ExpressionError> {
        self.enter()?;
        let result = self.parse_primary_or_unary_inner();
        self.leave();
        result
    }

    fn parse_primary_or_unary_inner(&mut self) -> Result<ExprAst, ExpressionError> {
        match self.peek() {
            Some(Token::Bang(_)) => {
                self.advance();
                let expr = self.parse_primary_or_unary()?;
                Ok(ExprAst::UnaryOp {
                    op: UnaryOperator::Not,
                    expr: Box::new(expr),
                })
            }
            Some(Token::Minus(_)) => {
                self.advance();
                let expr = self.parse_primary_or_unary()?;
                Ok(ExprAst::UnaryOp {
                    op: UnaryOperator::Neg,
                    expr: Box::new(expr),
                })
            }
            _ => self.parse_primary_with_postfix(),
        }
    }

    fn parse_primary_with_postfix(&mut self) -> Result<ExprAst, ExpressionError> {
        let mut expr = self.parse_primary()?;

        loop {
            match self.peek() {
                Some(Token::Dot(_)) => {
                    self.advance();
                    let prop = match self.advance() {
                        Some(Token::Ident(p, _)) => p,
                        other => {
                            return Err(ExpressionError::SyntaxError {
                                pos: self.current_pos(),
                                message: format!(
                                    "Expected property identifier after '.', found: {other:?}"
                                ),
                            })
                        }
                    };
                    if matches!(self.peek(), Some(Token::LParen(_))) {
                        let args = self.parse_call_args()?;
                        expr = ExprAst::MethodCall {
                            target: Box::new(expr),
                            name: prop,
                            args,
                        };
                    } else {
                        expr = attach_field(expr, prop);
                    }
                }
                Some(Token::LBracket(_)) => {
                    self.advance();
                    let index_ast = self.parse_ternary()?;
                    match self.advance() {
                        Some(Token::RBracket(_)) => {}
                        other => {
                            return Err(ExpressionError::SyntaxError {
                                pos: self.current_pos(),
                                message: format!(
                                    "Expected ']' closing index bracket, found: {other:?}"
                                ),
                            })
                        }
                    }
                    expr = attach_index(expr, index_ast);
                }
                _ => break,
            }
        }

        Ok(expr)
    }

    /// Parses `(a, b, …)` — the cursor must sit on the opening paren.
    fn parse_call_args(&mut self) -> Result<Vec<ExprAst>, ExpressionError> {
        self.advance(); // consume '('
        let mut args = Vec::new();
        if let Some(Token::RParen(_)) = self.peek() {
            self.advance();
            return Ok(args);
        }
        loop {
            args.push(self.parse_ternary()?);
            match self.advance() {
                Some(Token::Comma(_)) => continue,
                Some(Token::RParen(_)) => break,
                other => {
                    return Err(ExpressionError::SyntaxError {
                        pos: self.current_pos(),
                        message: format!("Expected ',' or ')' in argument list, found: {other:?}"),
                    })
                }
            }
        }
        Ok(args)
    }

    fn parse_primary(&mut self) -> Result<ExprAst, ExpressionError> {
        let pos_before = self.current_pos();
        let tok = self.advance().ok_or_else(|| ExpressionError::SyntaxError {
            pos: pos_before,
            message: "Unexpected end of expression".to_string(),
        })?;

        match tok {
            Token::Number(n, _) => {
                if n.fract() == 0.0 && n.abs() <= (i64::MAX as f64) {
                    Ok(ExprAst::Literal(Value::Number((n as i64).into())))
                } else {
                    Ok(ExprAst::Literal(
                        serde_json::Number::from_f64(n)
                            .map(Value::Number)
                            .unwrap_or(Value::Null),
                    ))
                }
            }
            Token::String(s, _) => Ok(ExprAst::Literal(Value::String(s))),
            Token::LBracket(_) => {
                // Array literal: [a, b, ...]
                let mut elements = Vec::new();
                if let Some(Token::RBracket(_)) = self.peek() {
                    self.advance();
                    return Ok(ExprAst::ArrayLiteral(elements));
                }
                loop {
                    elements.push(self.parse_ternary()?);
                    match self.advance() {
                        Some(Token::Comma(_)) => continue,
                        Some(Token::RBracket(_)) => break,
                        other => {
                            return Err(ExpressionError::SyntaxError {
                                pos: self.current_pos(),
                                message: format!(
                                    "Expected ',' or ']' in array literal, found: {other:?}"
                                ),
                            })
                        }
                    }
                }
                Ok(ExprAst::ArrayLiteral(elements))
            }
            Token::LBrace(_) => {
                // Object literal: {key: value, "key": value, ...}
                let mut pairs: Vec<(String, ExprAst)> = Vec::new();
                if let Some(Token::RBrace(_)) = self.peek() {
                    self.advance();
                    return Ok(ExprAst::ObjectLiteral(pairs));
                }
                loop {
                    let key = match self.advance() {
                        Some(Token::Ident(k, _)) => k,
                        Some(Token::String(k, _)) => k,
                        other => {
                            return Err(ExpressionError::SyntaxError {
                                pos: self.current_pos(),
                                message: format!(
                                    "Expected object key identifier or string, found: {other:?}"
                                ),
                            })
                        }
                    };
                    match self.advance() {
                        Some(Token::Colon(_)) => {}
                        other => {
                            return Err(ExpressionError::SyntaxError {
                                pos: self.current_pos(),
                                message: format!("Expected ':' after object key, found: {other:?}"),
                            })
                        }
                    }
                    let value = self.parse_ternary()?;
                    pairs.push((key, value));
                    match self.advance() {
                        Some(Token::Comma(_)) => continue,
                        Some(Token::RBrace(_)) => break,
                        other => {
                            return Err(ExpressionError::SyntaxError {
                                pos: self.current_pos(),
                                message: format!(
                                    "Expected ',' or '}}' in object literal, found: {other:?}"
                                ),
                            })
                        }
                    }
                }
                Ok(ExprAst::ObjectLiteral(pairs))
            }
            Token::LParen(_) => {
                let inner = self.parse_ternary()?;
                match self.advance() {
                    Some(Token::RParen(_)) => Ok(inner),
                    other => Err(ExpressionError::SyntaxError {
                        pos: self.current_pos(),
                        message: format!("Expected ')' closing parenthesis, found: {other:?}"),
                    }),
                }
            }
            Token::Ident(ident, pos) => match ident.as_str() {
                "true" => Ok(ExprAst::Literal(Value::Bool(true))),
                "false" => Ok(ExprAst::Literal(Value::Bool(false))),
                "null" => Ok(ExprAst::Literal(Value::Null)),
                "$itemIndex" | "$item" => Ok(ExprAst::ItemIndex),
                "$runIndex" | "$thisRunIndex" => Ok(ExprAst::RunIndex),
                "$json" => Ok(ExprAst::JsonPath(Vec::new())),
                "$node" => {
                    // Expect $node["NodeName"]
                    if let Some(Token::LBracket(_)) = self.peek() {
                        self.advance();
                        let node_name = match self.advance() {
                            Some(Token::String(s, _)) => s,
                            other => {
                                return Err(ExpressionError::SyntaxError {
                                    pos: self.current_pos(),
                                    message: format!(
                                        "Expected string node name in $node[...], found: {other:?}"
                                    ),
                                })
                            }
                        };
                        match self.advance() {
                            Some(Token::RBracket(_)) => {}
                            other => {
                                return Err(ExpressionError::SyntaxError {
                                    pos: self.current_pos(),
                                    message: format!(
                                        "Expected ']' after node name, found: {other:?}"
                                    ),
                                })
                            }
                        }
                        Ok(ExprAst::NodeLookup {
                            node_name,
                            path: Vec::new(),
                        })
                    } else {
                        Err(ExpressionError::SyntaxError {
                            pos,
                            message: "Expected bracket syntax $node['NodeName']".to_string(),
                        })
                    }
                }
                "$" => {
                    // The n8n node handle: $('Node Name'). A bare '$' is
                    // rejected by the sandbox rules (contract E9).
                    if let Some(Token::LParen(_)) = self.peek() {
                        self.advance();
                        let node_name = match self.advance() {
                            Some(Token::String(s, _)) => s,
                            other => {
                                return Err(ExpressionError::SyntaxError {
                                    pos: self.current_pos(),
                                    message: format!(
                                    "Expected string node name in $('Node Name'), found: {other:?}"
                                ),
                                })
                            }
                        };
                        match self.advance() {
                            Some(Token::RParen(_)) => {}
                            other => {
                                return Err(ExpressionError::SyntaxError {
                                    pos: self.current_pos(),
                                    message: format!(
                                        "Expected ')' after node name, found: {other:?}"
                                    ),
                                })
                            }
                        }
                        Ok(ExprAst::NodeHandle(node_name))
                    } else {
                        Err(ExpressionError::SyntaxError {
                            pos,
                            message: "Bare '$' is not allowed; use $('Node Name')".to_string(),
                        })
                    }
                }
                "$vars" | "$env" => {
                    if let Some(Token::Dot(_)) = self.peek() {
                        self.advance();
                        match self.advance() {
                            Some(Token::Ident(var_name, _)) => Ok(ExprAst::Variable(var_name)),
                            other => Err(ExpressionError::SyntaxError {
                                pos: self.current_pos(),
                                message: format!(
                                    "Expected variable name after $vars., found: {other:?}"
                                ),
                            }),
                        }
                    } else {
                        Ok(ExprAst::Variable(ident.clone()))
                    }
                }
                name if is_extended_function(name)
                    && matches!(self.peek(), Some(Token::LParen(_))) =>
                {
                    let args = self.parse_call_args()?;
                    Ok(ExprAst::FunctionCall {
                        name: name.to_string(),
                        args,
                    })
                }
                other => Err(ExpressionError::SyntaxError {
                    pos,
                    message: format!("Unknown identifier or keyword '{other}'"),
                }),
            },
            other => Err(ExpressionError::SyntaxError {
                pos: other.pos(),
                message: format!("Unexpected token in primary expression: {other:?}"),
            }),
        }
    }
}

/// Folds `.field` postfix access into the compact path ASTs so previously
/// ratified expressions keep their exact old shape; anything else becomes
/// a generic `GetProperty`.
fn attach_field(expr: ExprAst, name: String) -> ExprAst {
    match expr {
        ExprAst::JsonPath(mut path) => {
            path.push(PathSegment::Field(name));
            ExprAst::JsonPath(path)
        }
        ExprAst::NodeLookup {
            node_name,
            mut path,
        } => {
            path.push(PathSegment::Field(name));
            ExprAst::NodeLookup { node_name, path }
        }
        other => ExprAst::GetProperty {
            object: Box::new(other),
            property: name,
        },
    }
}

/// `expr[i]` with a literal index folds into the compact path ASTs;
/// a dynamic index becomes a generic `GetIndex`.
fn attach_index(expr: ExprAst, index: ExprAst) -> ExprAst {
    let seg: Option<PathSegment> = match &index {
        ExprAst::Literal(Value::String(s)) => Some(PathSegment::Field(s.clone())),
        ExprAst::Literal(Value::Number(n)) => n
            .as_u64()
            .and_then(|v| usize::try_from(v).ok())
            .map(PathSegment::Index),
        _ => None,
    };
    match (expr, seg) {
        (ExprAst::JsonPath(mut path), Some(s)) => {
            path.push(s);
            ExprAst::JsonPath(path)
        }
        (
            ExprAst::NodeLookup {
                node_name,
                mut path,
            },
            Some(s),
        ) => {
            path.push(s);
            ExprAst::NodeLookup { node_name, path }
        }
        (other, _) => ExprAst::GetIndex {
            object: Box::new(other),
            index: Box::new(index),
        },
    }
}
