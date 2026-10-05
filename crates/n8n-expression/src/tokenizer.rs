//! Zero-copy tokenizer for n8n template expressions (M7 `m7-tokenizer`).
//!
//! This module is the dedicated lexical layer of the expression engine. It
//! operates in two stages, mirroring the surface defined in
//! `contracts/expression.contract.md`:
//!
//! 1. **Template layer** — [`split_template`] scans a raw parameter string
//!    and distinguishes plain string-literal text from `{{ ... }}`
//!    expression blocks ([`TemplateChunk::Text`] vs
//!    [`TemplateChunk::Expression`]). The scan is quote-aware: a `}}`
//!    sequence inside a string literal does **not** close the block
//!    (`{{ 'a}}b' }}` is one expression whose source is `'a}}b'`).
//!    [`whole_block_inner`] answers the "exactly one block spanning the
//!    whole body" question (contract §3: raw-type preservation).
//!
//! 2. **Expression layer** — [`tokenize`] / [`Tokenizer`] turn the inner
//!    source of one block into a stream of [`Token`]s. Tokens borrow
//!    `&str` slices of the input: operators, identifiers, numbers and
//!    string literals are tokenized **without allocating strings**
//!    (acceptance criterion). String escape decoding is deferred to
//!    [`decode_string_escapes`], which returns `Cow::Borrowed` for the
//!    common escape-free literal.
//!
//! # Semantics & parity
//!
//! The lexical grammar is byte-for-byte behaviour-compatible with the
//! ratified inline lexer of `parser.rs` (TASK-EXP-EVAL-01), including its
//! fail-closed edges:
//!
//! * `===` / `!==` are consumed as a single [`Token::EqEq`] /
//!   [`Token::BangEq`] (strict aliases — the grammar maps both to the same
//!   structural equality).
//! * `=` (single), `&` (single), `|` (single), backticks and any other
//!   character outside the grammar are [`LexError`]s
//!   (`Unexpected character: '…'`). The sandbox gate additionally blanks
//!   string literals before this stage (see `sandbox.rs`).
//! * Numbers: `42`, `3.14`, `.5`, `1e3`, `2.5e-2`, `1E+3`. A dot is part
//!   of the number only when a digit follows (`1.` → `Number(1)` + `Dot`,
//!   `.5e3` → `Number(0.5)` + `Ident("e3")` — parity with the ratified
//!   lexer; the grammar rejects the remainder downstream).
//! * Identifiers start with a Unicode-alphabetic char, `$` or `_` and
//!   continue with Unicode-alphanumeric chars, `$`, `_` or ASCII digits
//!   (`$json`, `$if`, `café`, `_x1`).
//! * Strings: single/double quotes, escapes `\n \t \r \0 \b \f \\ \' \" \/
//!   \uXXXX`; an unknown escape keeps the escaped character literally
//!   (JS-compatible: `"\q" === "q"`). `\uXXXX` is validated eagerly at lex
//!   time (fail-closed timing parity); decoding happens later.
//!
//! # Positions
//!
//! All `pos` values are **byte offsets** into the scanned input (the legacy
//! inline lexer used char indexes; for ASCII — the overwhelmingly common
//! case — the two coincide). `LexError::pos` maps 1:1 onto
//! `ExpressionError::SyntaxError { pos, message }` at the parser boundary.
//!
//! # Integration note (cross-boundary dependency)
//!
//! This file is the exclusive deliverable of task
//! `expression-engine/m7-tokenizer`. Wiring it into the crate requires the
//! single additive line `pub mod tokenizer;` in `crates/n8n-expression/src/lib.rs`,
//! which is a *shared read* file for this task and owned by the crate-root
//! boundary; the declaration is intentionally NOT made here. Until it is
//! added, the module compiles standalone (it has no `crate::` or external
//! dependencies) and is consumed by `expression-engine/m7-parser`.

use std::borrow::Cow;
use std::fmt;

// ======================================================================
// Error type
// ======================================================================

/// Lexical error with a byte-offset position into the scanned source.
///
/// Deliberately dependency-free: the parser layer maps it onto
/// `n8n_common::ExpressionError::SyntaxError { pos, message }` (E14
/// fail-closed surface) without any semantic loss.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LexError {
    /// Byte offset of the offending construct in the scanned input.
    pub pos: usize,
    /// Human-readable, deterministic message (parity with the ratified
    /// inline lexer's messages where one exists).
    pub message: String,
}

impl LexError {
    pub fn new(pos: usize, message: impl Into<String>) -> Self {
        Self {
            pos,
            message: message.into(),
        }
    }
}

impl fmt::Display for LexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "expression syntax error at byte {}: {}",
            self.pos, self.message
        )
    }
}

impl std::error::Error for LexError {}

// ======================================================================
// Template layer: text vs {{ ... }} expression blocks
// ======================================================================

/// One chunk of a parameter-string template scan.
///
/// Distinguishes literal text (rendered verbatim, contract §3) from an
/// expression block (evaluated, raw-type preserving when it spans the
/// whole body).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TemplateChunk<'a> {
    /// Literal text outside any `{{ ... }}` block.
    Text {
        /// Byte offset of the first text byte.
        start: usize,
        /// Borrowed text slice (never empty).
        text: &'a str,
    },
    /// A complete `{{ ... }}` block.
    Expression {
        /// Byte offset of the opening `{{`.
        open: usize,
        /// Borrowed inner source between `{{` and the quote-aware `}}`
        /// (may be empty for `{{}}`). Starts at `open + 2`.
        source: &'a str,
    },
}

/// Byte-scans `src` from byte offset `from` for the first `}}` that lies
/// OUTSIDE of any single/double-quoted string literal.
///
/// UTF-8 safe: `}`, the quote characters and the backslash are ASCII and
/// can never appear inside a multi-byte sequence. Mirrors
/// `parser::find_handlebars_close` exactly (including the escape handling
/// inside quotes).
pub fn find_block_close(src: &str, from: usize) -> Option<usize> {
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

/// Splits a parameter string into literal-text and expression-block chunks.
///
/// * Every `{{` opens a block; the block ends at the first quote-aware
///   `}}` (a `}}` inside `'...'` / `"..."` does not close it).
/// * An unclosed `{{` is a fail-closed [`LexError`] with the ratified
///   message `Unclosed expression delimiter '{{'` positioned at the `{{`.
/// * Text chunks are never empty; zero chunks are returned for the empty
///   input.
///
/// Zero-copy: every chunk borrows from `input`.
pub fn split_template(input: &str) -> Result<Vec<TemplateChunk<'_>>, LexError> {
    let mut chunks = Vec::new();
    let mut cursor = 0usize;

    while let Some(rel) = input[cursor..].find("{{") {
        let open = cursor + rel;
        if open > cursor {
            chunks.push(TemplateChunk::Text {
                start: cursor,
                text: &input[cursor..open],
            });
        }

        let expr_start = open + 2;
        match find_block_close(input, expr_start) {
            Some(close) => {
                chunks.push(TemplateChunk::Expression {
                    open,
                    source: &input[expr_start..close],
                });
                cursor = close + 2;
            }
            None => {
                return Err(LexError::new(open, "Unclosed expression delimiter '{{'"));
            }
        }
    }

    if cursor < input.len() {
        chunks.push(TemplateChunk::Text {
            start: cursor,
            text: &input[cursor..],
        });
    }

    Ok(chunks)
}

/// Returns the inner source when `body` consists of exactly one `{{ ... }}`
/// block spanning the whole string (contract §3 raw-type preservation),
/// otherwise `None`. Mirrors `parser::spanning_expression_body`.
///
/// The caller is responsible for the `=`-marker dispatch (that belongs to
/// the parser layer); this helper only classifies the block structure.
pub fn whole_block_inner(body: &str) -> Option<&str> {
    if !(body.starts_with("{{") && body.ends_with("}}")) {
        return None;
    }
    match find_block_close(body, 2) {
        Some(close) if close + 2 == body.len() => Some(&body[2..close]),
        _ => None,
    }
}

// ======================================================================
// Expression layer: JS token stream (zero-copy)
// ======================================================================

/// One lexical token of an expression body. All payload slices borrow the
/// scanned source — tokenizing never allocates strings (the `Vec` that
/// collects tokens, or a [`LexError`] message, are the only allocations).
///
/// `pos` is the byte offset of the token's first byte.
#[derive(Debug, Clone, PartialEq)]
pub enum Token<'a> {
    /// Numeric literal. `raw` is the source slice, `value` the parsed
    /// `f64` (parsing allocates nothing).
    Number {
        raw: &'a str,
        value: f64,
        pos: usize,
    },
    /// String literal. `raw` is the slice **between** the quotes, exactly
    /// as written (escapes NOT yet decoded). `escaped` is `true` when the
    /// raw slice contains a backslash; decode with
    /// [`decode_string_escapes`] (or [`Token::decoded_str`]) only when the
    /// consumer needs the value.
    Str {
        raw: &'a str,
        pos: usize,
        escaped: bool,
    },
    /// Identifier or keyword candidate (`$json`, `_x`, `true`, `café`, …).
    /// Keyword interpretation (`true` / `false` / `null`) is the parser's
    /// job, matching the ratified grammar split.
    Ident {
        name: &'a str,
        pos: usize,
    },

    // Arithmetic / punctuation (single-byte tokens).
    Plus(usize),
    Minus(usize),
    Star(usize),
    Slash(usize),
    Percent(usize),
    Dot(usize),
    Comma(usize),
    Colon(usize),
    Question(usize),
    LParen(usize),
    RParen(usize),
    LBracket(usize),
    RBracket(usize),
    LBrace(usize),
    RBrace(usize),

    // Comparison / logical operators. `EqEq` also covers `===` and
    // `BangEq` also covers `!==` (strict aliases, parity with the
    // ratified lexer — the grammar treats them identically).
    EqEq(usize),
    BangEq(usize),
    Lt(usize),
    Lte(usize),
    Gt(usize),
    Gte(usize),
    AndAnd(usize),
    OrOr(usize),
    Bang(usize),
}

impl<'a> Token<'a> {
    /// Byte offset of the token's first byte in the scanned source.
    pub fn pos(&self) -> usize {
        match self {
            Token::Number { pos, .. }
            | Token::Str { pos, .. }
            | Token::Ident { pos, .. }
            | Token::Plus(pos)
            | Token::Minus(pos)
            | Token::Star(pos)
            | Token::Slash(pos)
            | Token::Percent(pos)
            | Token::Dot(pos)
            | Token::Comma(pos)
            | Token::Colon(pos)
            | Token::Question(pos)
            | Token::LParen(pos)
            | Token::RParen(pos)
            | Token::LBracket(pos)
            | Token::RBracket(pos)
            | Token::LBrace(pos)
            | Token::RBrace(pos)
            | Token::EqEq(pos)
            | Token::BangEq(pos)
            | Token::Lt(pos)
            | Token::Lte(pos)
            | Token::Gt(pos)
            | Token::Gte(pos)
            | Token::AndAnd(pos)
            | Token::OrOr(pos)
            | Token::Bang(pos) => *pos,
        }
    }

    /// Identifier payload, when this token is an [`Token::Ident`].
    pub fn as_ident(&self) -> Option<&'a str> {
        match self {
            Token::Ident { name, .. } => Some(name),
            _ => None,
        }
    }

    /// Parsed numeric value, when this token is a [`Token::Number`].
    pub fn as_number(&self) -> Option<f64> {
        match self {
            Token::Number { value, .. } => Some(*value),
            _ => None,
        }
    }

    /// Raw (still-escaped) string payload, when this token is a
    /// [`Token::Str`].
    pub fn as_str_raw(&self) -> Option<&'a str> {
        match self {
            Token::Str { raw, .. } => Some(raw),
            _ => None,
        }
    }

    /// Convenience: decoded string value for [`Token::Str`] tokens.
    ///
    /// `base_pos` should be the source offset of the raw payload's first
    /// byte (`token.pos() + 1`, i.e. just past the opening quote) so that
    /// escape errors report absolute positions. Returns `Cow::Borrowed`
    /// (zero allocation) for escape-free literals.
    pub fn decoded_str(&self, base_pos: usize) -> Option<Result<Cow<'a, str>, LexError>> {
        match self {
            Token::Str { raw, escaped, .. } => {
                if *escaped {
                    Some(decode_string_escapes(raw, base_pos))
                } else {
                    Some(Ok(Cow::Borrowed(raw)))
                }
            }
            _ => None,
        }
    }
}

/// Streaming, allocation-free (per token) lexer over one expression body.
///
/// Use [`Tokenizer::next_token`] in a loop (`Ok(None)` = end of input) or
/// the [`tokenize`] convenience for a materialized `Vec`.
#[derive(Debug, Clone)]
pub struct Tokenizer<'a> {
    src: &'a str,
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Tokenizer<'a> {
    pub fn new(src: &'a str) -> Self {
        Self {
            src,
            bytes: src.as_bytes(),
            pos: 0,
        }
    }

    /// Current byte offset (start of the next token, or end of input).
    pub fn pos(&self) -> usize {
        self.pos
    }

    /// True when the whole input has been consumed.
    pub fn is_at_end(&self) -> bool {
        self.pos >= self.bytes.len()
    }

    /// Lexes the next token; `Ok(None)` at end of input. Never panics on
    /// arbitrary (valid UTF-8) input — every ungrammatical byte sequence
    /// fails closed with [`LexError`].
    pub fn next_token(&mut self) -> Result<Option<Token<'a>>, LexError> {
        loop {
            if self.pos >= self.bytes.len() {
                return Ok(None);
            }
            let b = self.bytes[self.pos];
            match b {
                // ------------------------------------------------ whitespace
                b' ' | b'\t' | b'\n' | b'\r' | 0x0B | 0x0C => {
                    self.pos += 1;
                }
                // ------------------------------------------- single-char ops
                b'+' => return Ok(Some(self.bump(Token::Plus))),
                b'-' => return Ok(Some(self.bump(Token::Minus))),
                b'*' => return Ok(Some(self.bump(Token::Star))),
                b'/' => return Ok(Some(self.bump(Token::Slash))),
                b'%' => return Ok(Some(self.bump(Token::Percent))),
                b'?' => return Ok(Some(self.bump(Token::Question))),
                b':' => return Ok(Some(self.bump(Token::Colon))),
                b',' => return Ok(Some(self.bump(Token::Comma))),
                b'(' => return Ok(Some(self.bump(Token::LParen))),
                b')' => return Ok(Some(self.bump(Token::RParen))),
                b'[' => return Ok(Some(self.bump(Token::LBracket))),
                b']' => return Ok(Some(self.bump(Token::RBracket))),
                b'{' => return Ok(Some(self.bump(Token::LBrace))),
                // A single '}' can still appear here (e.g. an unbalanced
                // tail); it is a plain token — the grammar rejects it.
                b'}' => return Ok(Some(self.bump(Token::RBrace))),
                // ------------------------------------------------------ dot
                b'.' => {
                    if self.peek_at(1).is_some_and(|n| n.is_ascii_digit()) {
                        return self.lex_leading_dot_number().map(Some);
                    }
                    return Ok(Some(self.bump(Token::Dot)));
                }
                // ------------------------------------------------ equality
                b'=' => {
                    if self.peek_at(1) == Some(b'=') {
                        let pos = self.pos;
                        // '===' is accepted and behaves identically (strict
                        // structural equality — parity with ratified lexer).
                        let len = if self.peek_at(2) == Some(b'=') { 3 } else { 2 };
                        self.pos += len;
                        return Ok(Some(Token::EqEq(pos)));
                    }
                    return Err(self.unexpected_char());
                }
                b'!' => {
                    let pos = self.pos;
                    if self.peek_at(1) == Some(b'=') {
                        let len = if self.peek_at(2) == Some(b'=') { 3 } else { 2 };
                        self.pos += len;
                        return Ok(Some(Token::BangEq(pos)));
                    }
                    self.pos += 1;
                    return Ok(Some(Token::Bang(pos)));
                }
                b'<' => {
                    let pos = self.pos;
                    if self.peek_at(1) == Some(b'=') {
                        self.pos += 2;
                        return Ok(Some(Token::Lte(pos)));
                    }
                    self.pos += 1;
                    return Ok(Some(Token::Lt(pos)));
                }
                b'>' => {
                    let pos = self.pos;
                    if self.peek_at(1) == Some(b'=') {
                        self.pos += 2;
                        return Ok(Some(Token::Gte(pos)));
                    }
                    self.pos += 1;
                    return Ok(Some(Token::Gt(pos)));
                }
                b'&' => {
                    if self.peek_at(1) == Some(b'&') {
                        let pos = self.pos;
                        self.pos += 2;
                        return Ok(Some(Token::AndAnd(pos)));
                    }
                    return Err(self.unexpected_char());
                }
                b'|' => {
                    if self.peek_at(1) == Some(b'|') {
                        let pos = self.pos;
                        self.pos += 2;
                        return Ok(Some(Token::OrOr(pos)));
                    }
                    return Err(self.unexpected_char());
                }
                // -------------------------------------------------- strings
                b'"' | b'\'' => return self.lex_string().map(Some),
                // -------------------------------------------------- numbers
                b'0'..=b'9' => return self.lex_number().map(Some),
                // ----------------------------------------------- identifiers
                b'a'..=b'z' | b'A'..=b'Z' | b'$' | b'_' => return self.lex_ident().map(Some),
                // --------------------------------------------- non-ASCII byte
                _ => {
                    let ch = self.char_at(self.pos);
                    if ch.is_whitespace() {
                        self.pos += ch.len_utf8();
                    } else if ch.is_alphabetic() {
                        return self.lex_ident().map(Some);
                    } else {
                        return Err(self.unexpected_char());
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------- helpers

    fn peek_at(&self, offset: usize) -> Option<u8> {
        self.bytes.get(self.pos + offset).copied()
    }

    /// Decodes the char starting at byte `i` (always valid: `&str` input).
    fn char_at(&self, i: usize) -> char {
        self.src[i..]
            .chars()
            .next()
            .expect("&str boundary yields a char")
    }

    fn bump(&mut self, make: impl FnOnce(usize) -> Token<'a>) -> Token<'a> {
        let tok = make(self.pos);
        self.pos += 1;
        tok
    }

    fn unexpected_char(&self) -> LexError {
        let ch = self.char_at(self.pos);
        LexError::new(self.pos, format!("Unexpected character: '{ch}'"))
    }

    /// `.5`-style leading-dot number. Parity note: the ratified lexer does
    /// not attach an exponent to leading-dot numbers (`.5e3` → `Number`
    /// then `Ident("e3")`), and neither do we.
    fn lex_leading_dot_number(&mut self) -> Result<Token<'a>, LexError> {
        let start = self.pos;
        let mut j = self.pos + 1; // past '.'
        while j < self.bytes.len() && self.bytes[j].is_ascii_digit() {
            j += 1;
        }
        self.finish_number(start, j)
    }

    /// `42`, `3.14`, `1e3`, `2.5e-2`, `1E+3`. A dot joins the number only
    /// when a digit follows; an exponent joins only when at least one digit
    /// follows the optional sign (otherwise the scan rewinds — parity).
    fn lex_number(&mut self) -> Result<Token<'a>, LexError> {
        let start = self.pos;
        let mut i = start;
        let mut seen_dot = false;
        while i < self.bytes.len() {
            let b = self.bytes[i];
            if b.is_ascii_digit() {
                i += 1;
            } else if b == b'.'
                && !seen_dot
                && self.bytes.get(i + 1).is_some_and(|n| n.is_ascii_digit())
            {
                seen_dot = true;
                i += 1;
            } else {
                break;
            }
        }
        // Optional exponent.
        if i < self.bytes.len() && (self.bytes[i] == b'e' || self.bytes[i] == b'E') {
            let mark = i;
            i += 1;
            if i < self.bytes.len() && (self.bytes[i] == b'+' || self.bytes[i] == b'-') {
                i += 1;
            }
            if i < self.bytes.len() && self.bytes[i].is_ascii_digit() {
                while i < self.bytes.len() && self.bytes[i].is_ascii_digit() {
                    i += 1;
                }
            } else {
                // Not an exponent after all — rewind.
                i = mark;
            }
        }
        self.finish_number(start, i)
    }

    fn finish_number(&mut self, start: usize, end: usize) -> Result<Token<'a>, LexError> {
        let raw = &self.src[start..end];
        let value: f64 = raw
            .parse()
            .map_err(|_| LexError::new(start, format!("Invalid number: {raw}")))?;
        self.pos = end;
        Ok(Token::Number {
            raw,
            value,
            pos: start,
        })
    }

    /// Identifier / keyword-candidate scan (Unicode-aware, zero-copy).
    fn lex_ident(&mut self) -> Result<Token<'a>, LexError> {
        let start = self.pos;
        let mut i = start;
        while i < self.bytes.len() {
            let b = self.bytes[i];
            let keep = if b.is_ascii() {
                b.is_ascii_alphanumeric() || b == b'$' || b == b'_'
            } else {
                self.char_at(i).is_alphanumeric()
            };
            if !keep {
                break;
            }
            i += if b.is_ascii() {
                1
            } else {
                self.char_at(i).len_utf8()
            };
        }
        let name = &self.src[start..i];
        self.pos = i;
        Ok(Token::Ident { name, pos: start })
    }

    /// Single/double-quoted string. The raw slice between the quotes is
    /// returned as-is (no decoding, no allocation); `\uXXXX` escapes are
    /// validated eagerly so malformed code points fail closed at lex time
    /// (parity with the ratified lexer).
    fn lex_string(&mut self) -> Result<Token<'a>, LexError> {
        let start = self.pos;
        let quote = self.bytes[start];
        let mut i = start + 1;
        let mut escaped = false;
        loop {
            if i >= self.bytes.len() {
                return Err(LexError::new(start, "Unclosed string literal"));
            }
            let b = self.bytes[i];
            if b == b'\\' {
                escaped = true;
                if i + 1 >= self.bytes.len() {
                    // Trailing backslash: the quote can never close now.
                    return Err(LexError::new(start, "Unclosed string literal"));
                }
                let e = self.bytes[i + 1];
                if e == b'u' {
                    // Char-aware lookahead (parity: the ratified lexer works
                    // on chars). Fewer than 4 chars after 'u' → unknown
                    // escape, 'u' kept literally. Non-ASCII hex digits or
                    // invalid hex → fail-closed error (never a slice panic).
                    let mut it = self.src[i + 2..].chars();
                    match (it.next(), it.next(), it.next(), it.next()) {
                        (Some(c1), Some(c2), Some(c3), Some(c4))
                            if c1.is_ascii() && c2.is_ascii() && c3.is_ascii() && c4.is_ascii() =>
                        {
                            let hex = &self.src[i + 2..i + 6];
                            let code = u32::from_str_radix(hex, 16).map_err(|_| {
                                LexError::new(i, format!("Invalid unicode escape '\\u{hex}'"))
                            })?;
                            if char::from_u32(code).is_none() {
                                return Err(LexError::new(
                                    i,
                                    format!("Invalid unicode code point '\\u{hex}'"),
                                ));
                            }
                            i += 6;
                        }
                        (Some(c1), Some(c2), Some(c3), Some(c4)) => {
                            let hex: String = [c1, c2, c3, c4].iter().collect();
                            return Err(LexError::new(
                                i,
                                format!("Invalid unicode escape '\\u{hex}'"),
                            ));
                        }
                        _ => {
                            i += 2;
                        }
                    }
                } else if e.is_ascii() {
                    i += 2;
                } else {
                    // Escaped non-ASCII char: consume it whole.
                    i += 1 + self.char_at(i + 1).len_utf8();
                }
            } else if b == quote {
                let raw = &self.src[start + 1..i];
                self.pos = i + 1;
                return Ok(Token::Str {
                    raw,
                    pos: start,
                    escaped,
                });
            } else {
                i += 1;
            }
        }
    }
}

/// Materializes the full token stream of one expression body.
///
/// Fails closed on the first lexical error; on success every token borrows
/// `src` (zero-copy — see [`Token`]).
pub fn tokenize(src: &str) -> Result<Vec<Token<'_>>, LexError> {
    let mut lexer = Tokenizer::new(src);
    let mut out = Vec::new();
    while let Some(tok) = lexer.next_token()? {
        out.push(tok);
    }
    Ok(out)
}

/// Decodes the escapes of a string-literal payload (the slice between the
/// quotes, as carried by [`Token::Str::raw`]).
///
/// * No backslash → `Cow::Borrowed` (**zero allocation**, the common case).
/// * `\n \t \r \0 \b \f \\ \' \" \/` → the corresponding character.
/// * `\uXXXX` → the Unicode scalar (invalid hex / invalid code point →
///   [`LexError`], same messages as the lexer-stage validation).
/// * Any other escape keeps the escaped character literally
///   (JS-compatible: `"\q" === "q"`).
///
/// `base_pos` is the source byte offset of `raw`'s first byte; it is added
/// to in-`raw` offsets so error positions stay absolute.
pub fn decode_string_escapes(raw: &str, base_pos: usize) -> Result<Cow<'_, str>, LexError> {
    if !raw.contains('\\') {
        return Ok(Cow::Borrowed(raw));
    }
    let bytes = raw.as_bytes();
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b != b'\\' {
            // Copy the whole char (ASCII fast path, multi-byte otherwise).
            if b.is_ascii() {
                out.push(b as char);
                i += 1;
            } else {
                let ch = raw[i..]
                    .chars()
                    .next()
                    .expect("&str boundary yields a char");
                out.push(ch);
                i += ch.len_utf8();
            }
            continue;
        }
        // Escape sequence.
        if i + 1 >= bytes.len() {
            // Trailing lone backslash (cannot occur in lexer-produced raws).
            out.push('\\');
            i += 1;
            continue;
        }
        let esc_pos = base_pos + i;
        let e = bytes[i + 1];
        match e {
            b'n' => {
                out.push('\n');
                i += 2;
            }
            b't' => {
                out.push('\t');
                i += 2;
            }
            b'r' => {
                out.push('\r');
                i += 2;
            }
            b'0' => {
                out.push('\0');
                i += 2;
            }
            b'b' => {
                out.push('\u{0008}');
                i += 2;
            }
            b'f' => {
                out.push('\u{000C}');
                i += 2;
            }
            b'\\' => {
                out.push('\\');
                i += 2;
            }
            b'\'' => {
                out.push('\'');
                i += 2;
            }
            b'"' => {
                out.push('"');
                i += 2;
            }
            b'/' => {
                out.push('/');
                i += 2;
            }
            b'u' => {
                // Char-aware lookahead (parity with the ratified lexer);
                // never slices mid-char, so no panic on exotic input.
                let mut it = raw[i + 2..].chars();
                match (it.next(), it.next(), it.next(), it.next()) {
                    (Some(c1), Some(c2), Some(c3), Some(c4))
                        if c1.is_ascii() && c2.is_ascii() && c3.is_ascii() && c4.is_ascii() =>
                    {
                        let hex = &raw[i + 2..i + 6];
                        let code = u32::from_str_radix(hex, 16).map_err(|_| {
                            LexError::new(esc_pos, format!("Invalid unicode escape '\\u{hex}'"))
                        })?;
                        match char::from_u32(code) {
                            Some(uc) => {
                                out.push(uc);
                                i += 6;
                            }
                            None => {
                                return Err(LexError::new(
                                    esc_pos,
                                    format!("Invalid unicode code point '\\u{hex}'"),
                                ))
                            }
                        }
                    }
                    (Some(c1), Some(c2), Some(c3), Some(c4)) => {
                        let hex: String = [c1, c2, c3, c4].iter().collect();
                        return Err(LexError::new(
                            esc_pos,
                            format!("Invalid unicode escape '\\u{hex}'"),
                        ));
                    }
                    // Fewer than 4 chars remain: literal 'u' (parity).
                    _ => {
                        out.push('u');
                        i += 2;
                    }
                }
            }
            // Unknown escape: keep the escaped character literally
            // (JS-compatible).
            _ => {
                if e.is_ascii() {
                    out.push(e as char);
                    i += 2;
                } else {
                    let ch = raw[i + 1..]
                        .chars()
                        .next()
                        .expect("&str boundary yields a char");
                    out.push(ch);
                    i += 1 + ch.len_utf8();
                }
            }
        }
    }
    Ok(Cow::Owned(out))
}

// ======================================================================
// Tests
// ======================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Shorthand: kind sequence of a token stream (positions checked
    /// separately where relevant).
    fn kinds(src: &str) -> Vec<String> {
        tokenize(src)
            .unwrap_or_else(|e| panic!("tokenize({src:?}) failed: {e}"))
            .iter()
            .map(|t| match t {
                Token::Number { value, .. } => format!("Num({value})"),
                Token::Str { raw, escaped, .. } => format!("Str({raw:?},esc={escaped})"),
                Token::Ident { name, .. } => format!("Id({name})"),
                Token::Plus(_) => "Plus".into(),
                Token::Minus(_) => "Minus".into(),
                Token::Star(_) => "Star".into(),
                Token::Slash(_) => "Slash".into(),
                Token::Percent(_) => "Percent".into(),
                Token::Dot(_) => "Dot".into(),
                Token::Comma(_) => "Comma".into(),
                Token::Colon(_) => "Colon".into(),
                Token::Question(_) => "Question".into(),
                Token::LParen(_) => "LParen".into(),
                Token::RParen(_) => "RParen".into(),
                Token::LBracket(_) => "LBracket".into(),
                Token::RBracket(_) => "RBracket".into(),
                Token::LBrace(_) => "LBrace".into(),
                Token::RBrace(_) => "RBrace".into(),
                Token::EqEq(_) => "EqEq".into(),
                Token::BangEq(_) => "BangEq".into(),
                Token::Lt(_) => "Lt".into(),
                Token::Lte(_) => "Lte".into(),
                Token::Gt(_) => "Gt".into(),
                Token::Gte(_) => "Gte".into(),
                Token::AndAnd(_) => "AndAnd".into(),
                Token::OrOr(_) => "OrOr".into(),
                Token::Bang(_) => "Bang".into(),
            })
            .collect()
    }

    // ==================================================================
    // Template layer — distinguishing text from expression blocks.
    // ==================================================================

    #[test]
    fn template_plain_text_only() {
        let chunks = split_template("Hello world").unwrap();
        assert_eq!(
            chunks,
            vec![TemplateChunk::Text {
                start: 0,
                text: "Hello world"
            }]
        );
    }

    #[test]
    fn template_empty_input() {
        assert_eq!(split_template("").unwrap(), vec![]);
    }

    #[test]
    fn template_single_whole_block() {
        let chunks = split_template("{{ $json.a }}").unwrap();
        assert_eq!(
            chunks,
            vec![TemplateChunk::Expression {
                open: 0,
                source: " $json.a "
            }]
        );
    }

    #[test]
    fn template_mixed_text_and_blocks() {
        let chunks = split_template("Hello {{ $json.name }}! Bye {{ 1 }}.").unwrap();
        assert_eq!(
            chunks,
            vec![
                TemplateChunk::Text {
                    start: 0,
                    text: "Hello "
                },
                TemplateChunk::Expression {
                    open: 6,
                    source: " $json.name "
                },
                TemplateChunk::Text {
                    start: 22,
                    text: "! Bye "
                },
                TemplateChunk::Expression {
                    open: 28,
                    source: " 1 "
                },
                TemplateChunk::Text {
                    start: 35,
                    text: "."
                },
            ]
        );
    }

    #[test]
    fn template_adjacent_blocks_no_text_between() {
        let chunks = split_template("{{a}}{{b}}").unwrap();
        assert_eq!(
            chunks,
            vec![
                TemplateChunk::Expression {
                    open: 0,
                    source: "a"
                },
                TemplateChunk::Expression {
                    open: 5,
                    source: "b"
                },
            ]
        );
    }

    #[test]
    fn template_empty_block() {
        let chunks = split_template("x{{}}y").unwrap();
        assert_eq!(
            chunks,
            vec![
                TemplateChunk::Text {
                    start: 0,
                    text: "x"
                },
                TemplateChunk::Expression {
                    open: 1,
                    source: ""
                },
                TemplateChunk::Text {
                    start: 5,
                    text: "y"
                },
            ]
        );
    }

    #[test]
    fn template_quoted_close_does_not_end_block() {
        // Ratified regression: `={{ 'a}}b' }}` → the `}}` inside the string
        // literal must not terminate the block (lib.rs test
        // `test_quoted_handlebars_do_not_close_template`).
        let chunks = split_template("{{ 'a}}b' }}").unwrap();
        assert_eq!(chunks.len(), 1);
        match &chunks[0] {
            TemplateChunk::Expression { open, source } => {
                assert_eq!(*open, 0);
                assert_eq!(*source, " 'a}}b' ");
            }
            other => panic!("expected one Expression, got {other:?}"),
        }
        // Same with double quotes and an escaped quote inside.
        let chunks = split_template(r#"{{ "a\"}}b" }}"#).unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(
            chunks[0],
            TemplateChunk::Expression {
                open: 0,
                source: r#" "a\"}}b" "#
            }
        );
    }

    #[test]
    fn template_unclosed_block_fails_closed() {
        let err = split_template("Hello {{ $json.a").unwrap_err();
        assert_eq!(err.pos, 6);
        assert_eq!(err.message, "Unclosed expression delimiter '{{'");
        // A `}}` that only exists inside an unterminated string does not
        // rescue the block.
        assert!(split_template("{{ '}}").is_err());
    }

    #[test]
    fn template_single_braces_are_text() {
        let chunks = split_template("a { b } c {{d}}").unwrap();
        assert_eq!(
            chunks,
            vec![
                TemplateChunk::Text {
                    start: 0,
                    text: "a { b } c "
                },
                TemplateChunk::Expression {
                    open: 10,
                    source: "d"
                },
            ]
        );
    }

    #[test]
    fn template_utf8_byte_offsets_are_exact() {
        // Multi-byte text before/after blocks: slices and offsets must be
        // byte-exact (UTF-8 safe scanning).
        let input = "héllo {{ $json.a }} ✓";
        let chunks = split_template(input).unwrap();
        assert_eq!(chunks.len(), 3);
        assert_eq!(
            chunks[0],
            TemplateChunk::Text {
                start: 0,
                text: "héllo "
            }
        );
        assert_eq!(
            chunks[1],
            TemplateChunk::Expression {
                open: "héllo ".len(),
                source: " $json.a "
            }
        );
        assert_eq!(
            chunks[2],
            TemplateChunk::Text {
                start: input.len() - " ✓".len(),
                text: " ✓"
            }
        );
        // Slices point into the original input (zero-copy).
        if let TemplateChunk::Text { text, .. } = &chunks[0] {
            assert!(text.as_ptr() == input.as_ptr());
        }
    }

    #[test]
    fn whole_block_inner_classification() {
        // Contract §3: exactly one block spanning the whole body keeps raw
        // types; anything else is a string template.
        assert_eq!(whole_block_inner("{{ 1 + 2 }}"), Some(" 1 + 2 "));
        assert_eq!(whole_block_inner("{{}}"), Some(""));
        assert_eq!(whole_block_inner("{{ 'a}}b' }}"), Some(" 'a}}b' "));
        assert_eq!(whole_block_inner("x{{ 1 }}"), None);
        assert_eq!(whole_block_inner("{{ 1 }}x"), None);
        assert_eq!(whole_block_inner("{{1}}{{2}}"), None);
        assert_eq!(whole_block_inner("plain"), None);
        assert_eq!(whole_block_inner(""), None);
        assert_eq!(whole_block_inner("{{ unclosed"), None);
    }

    // ==================================================================
    // Expression layer — valid token streams.
    // ==================================================================

    #[test]
    fn empty_and_whitespace_only_input() {
        assert_eq!(tokenize("").unwrap(), vec![]);
        assert_eq!(tokenize("   \t\n\r ").unwrap(), vec![]);
        // Unicode whitespace (U+00A0) is skipped too (char::is_whitespace
        // parity with the ratified lexer).
        assert_eq!(
            tokenize("\u{A0}1\u{A0}").unwrap(),
            vec![Token::Number {
                raw: "1",
                value: 1.0,
                pos: 2
            }]
        );
    }

    #[test]
    fn arithmetic_stream_with_positions() {
        // Ratified regression source: `={{ $json.a * 2 + $json.b }}` inner.
        let src = "$json.a * 2 + $json.b";
        let toks = tokenize(src).unwrap();
        assert_eq!(
            toks,
            vec![
                Token::Ident {
                    name: "$json",
                    pos: 0
                },
                Token::Dot(5),
                Token::Ident { name: "a", pos: 6 },
                Token::Star(8),
                Token::Number {
                    raw: "2",
                    value: 2.0,
                    pos: 10
                },
                Token::Plus(12),
                Token::Ident {
                    name: "$json",
                    pos: 14
                },
                Token::Dot(19),
                Token::Ident { name: "b", pos: 20 },
            ]
        );
    }

    #[test]
    fn all_operators_and_punctuation() {
        let src = "+ - * / % == === != !== < <= > >= && || ! ? : , . ( ) [ ] { }";
        assert_eq!(
            kinds(src),
            vec![
                "Plus", "Minus", "Star", "Slash", "Percent", "EqEq", "EqEq", "BangEq", "BangEq",
                "Lt", "Lte", "Gt", "Gte", "AndAnd", "OrOr", "Bang", "Question", "Colon", "Comma",
                "Dot", "LParen", "RParen", "LBracket", "RBracket", "LBrace", "RBrace",
            ]
        );
        // `===` / `!==` consume exactly three bytes (next token starts after).
        let toks = tokenize("a===b").unwrap();
        assert_eq!(toks[1], Token::EqEq(1));
        assert_eq!(toks[2], Token::Ident { name: "b", pos: 4 });
        let toks = tokenize("a!==b").unwrap();
        assert_eq!(toks[1], Token::BangEq(1));
        assert_eq!(toks[2], Token::Ident { name: "b", pos: 4 });
    }

    #[test]
    fn identifiers_unicode_and_dollar() {
        // Ratified sources: $json, $node, $vars, $if(...), $('Webhook').
        assert_eq!(
            kinds("$json $node['X'] $if(a,b,'c') _x1 a$b café $"),
            vec![
                "Id($json)",
                "Id($node)",
                "LBracket",
                "Str(\"X\",esc=false)",
                "RBracket",
                "Id($if)",
                "LParen",
                "Id(a)",
                "Comma",
                "Id(b)",
                "Comma",
                "Str(\"c\",esc=false)",
                "RParen",
                "Id(_x1)",
                "Id(a$b)",
                "Id(café)",
                "Id($)",
            ]
        );
        // Byte-exact positions for a multi-byte identifier.
        let toks = tokenize("café").unwrap();
        assert_eq!(
            toks,
            vec![Token::Ident {
                name: "café",
                pos: 0
            }]
        );
        let toks = tokenize("a + café.x").unwrap();
        assert_eq!(
            toks[2],
            Token::Ident {
                name: "café",
                pos: 4
            }
        );
        assert_eq!(toks[3], Token::Dot(9)); // 'é' is 2 bytes: 4+4+1
    }

    #[test]
    fn numbers_all_ratified_shapes() {
        assert_eq!(
            kinds("42 3.14 1e3 2.5e-2 1E+3 .5 0"),
            vec![
                "Num(42)",
                "Num(3.14)",
                "Num(1000)",
                "Num(0.025)",
                "Num(1000)",
                "Num(0.5)",
                "Num(0)",
            ]
        );
        // Raw slices are borrowed verbatim (zero-copy, no normalization).
        let toks = tokenize("2.5e-2").unwrap();
        assert_eq!(
            toks[0],
            Token::Number {
                raw: "2.5e-2",
                value: 0.025,
                pos: 0
            }
        );
    }

    #[test]
    fn number_edge_parity_with_ratified_lexer() {
        // `1.` → Number(1) + Dot (a dot joins only when a digit follows).
        assert_eq!(kinds("1."), vec!["Num(1)", "Dot"]);
        assert_eq!(kinds("1.x"), vec!["Num(1)", "Dot", "Id(x)"]);
        // `1e` → the exponent rewinds: Number(1) + Ident("e").
        assert_eq!(kinds("1e"), vec!["Num(1)", "Id(e)"]);
        // `2e+` → Number(2) + Ident("e") + Plus.
        assert_eq!(kinds("2e+"), vec!["Num(2)", "Id(e)", "Plus"]);
        // `1.5.2` → the second dot has a digit after it → leading-dot
        // number `.2` (exact parity with the ratified lexer).
        assert_eq!(kinds("1.5.2"), vec!["Num(1.5)", "Num(0.2)"]);
        assert_eq!(kinds("1.5.x"), vec!["Num(1.5)", "Dot", "Id(x)"]);
        // `.5e3` → leading-dot numbers take no exponent (documented parity).
        assert_eq!(kinds(".5e3"), vec!["Num(0.5)", "Id(e3)"]);
    }

    #[test]
    fn strings_borrowed_raw_and_escape_flag() {
        let toks = tokenize("'abc' \"d'e\" ").unwrap();
        assert_eq!(
            toks[0],
            Token::Str {
                raw: "abc",
                pos: 0,
                escaped: false
            }
        );
        // A quote of the other kind is plain content.
        assert_eq!(
            toks[1],
            Token::Str {
                raw: "d'e",
                pos: 6,
                escaped: false
            }
        );

        let toks = tokenize(r"'a\'b'").unwrap();
        assert_eq!(
            toks[0],
            Token::Str {
                raw: r"a\'b",
                pos: 0,
                escaped: true
            }
        );
        assert_eq!(
            toks[0].decoded_str(1).unwrap().unwrap(),
            Cow::Borrowed("a'b")
        );

        // Escape-free literals decode with zero allocation (Cow::Borrowed).
        let toks = tokenize("'plain'").unwrap();
        let decoded = toks[0].decoded_str(1).unwrap().unwrap();
        assert!(matches!(decoded, Cow::Borrowed("plain")));
    }

    #[test]
    fn string_escape_decoding_js_compatible() {
        // Full ratified escape set.
        assert_eq!(
            decode_string_escapes(r#"a\nb\tc\rd\0e\bf\\g\'h\"i\/j"#, 0).unwrap(),
            "a\nb\tc\rd\0e\u{8}f\\g'h\"i/j"
        );
        // \uXXXX.
        assert_eq!(decode_string_escapes(r"\u0041\u00e9", 0).unwrap(), "Aé");
        // Unknown escape keeps the character literally ("\q" === "q").
        assert_eq!(decode_string_escapes(r"\q\z", 0).unwrap(), "qz");
        // '\u' with fewer than 4 chars left → literal 'u' (parity).
        assert_eq!(decode_string_escapes(r"a\u12", 0).unwrap(), "au12");
        // Invalid hex / invalid code point fail closed with absolute pos.
        let err = decode_string_escapes(r"x\uZZZZ", 10).unwrap_err();
        assert_eq!(err.pos, 11); // base_pos + offset of the backslash
        assert!(err.message.contains("Invalid unicode escape"), "{err}");
        // Lone surrogate → not a char (parity with the ratified lexer).
        let err = decode_string_escapes(r"\uD83D", 0).unwrap_err();
        assert!(err.message.contains("Invalid unicode code point"), "{err}");
        // Escaped non-ASCII char decodes to itself.
        assert_eq!(decode_string_escapes("a\\é b", 0).unwrap(), "aé b");
    }

    #[test]
    fn unicode_escape_validation_happens_at_lex_time() {
        // Parity: the ratified lexer rejects malformed \uXXXX while
        // tokenizing (fail-closed timing), not only at decode time.
        let err = tokenize(r"'a\uZZZZb'").unwrap_err();
        assert!(err.message.contains("Invalid unicode escape"), "{err}");
        let err = tokenize(r"'\uD800'").unwrap_err();
        assert!(err.message.contains("Invalid unicode code point"), "{err}");
        // A valid one passes lexing and decodes later.
        let toks = tokenize(r"'\u0041'").unwrap();
        assert_eq!(
            toks[0],
            Token::Str {
                raw: r"\u0041",
                pos: 0,
                escaped: true
            }
        );
        assert_eq!(toks[0].decoded_str(1).unwrap().unwrap(), "A");
        let toks = tokenize(r"'\u00e9x'").unwrap();
        assert_eq!(toks[0].decoded_str(1).unwrap().unwrap(), "éx");
    }

    #[test]
    fn exotic_unicode_never_panics() {
        // Fewer than 4 chars after `\u` → parity fallback: the 'u' stays
        // literal (ratified lexer behaves identically).
        let toks = tokenize("'\\u12'").unwrap();
        assert_eq!(
            toks[0],
            Token::Str {
                raw: "\\u12",
                pos: 0,
                escaped: true
            }
        );
        assert_eq!(toks[0].decoded_str(1).unwrap().unwrap(), "u12");
        // Non-ASCII right after `\u` with <4 chars → same literal-'u'
        // fallback, and the multi-byte char is plain content (no
        // mid-char slicing anywhere).
        let toks = tokenize("'\\ué'").unwrap();
        assert_eq!(
            toks[0],
            Token::Str {
                raw: "\\ué",
                pos: 0,
                escaped: true
            }
        );
        assert_eq!(toks[0].decoded_str(1).unwrap().unwrap(), "ué");
        assert_eq!(decode_string_escapes("\\ué", 0).unwrap(), "ué");
        // Non-ASCII hex digits (4 chars available) → deterministic error,
        // not a mid-char slice panic.
        let err = tokenize("'\\uéab'").unwrap_err();
        assert!(err.message.contains("Invalid unicode escape"), "{err}");
        let err = decode_string_escapes("\\u00é9", 0).unwrap_err();
        assert!(err.message.contains("Invalid unicode escape"), "{err}");
        // Fuzz-ish sweep: every single char + a quote wrapper must either
        // lex or fail closed — never panic.
        for c in [
            '\0', '\u{7f}', '\u{a0}', 'é', '✓', '²', '日', '`', '#', '\\', '"', '\'',
        ] {
            let _ = tokenize(&format!("a{c}b"));
            let _ = tokenize(&format!("'{c}'"));
            let _ = tokenize(&format!("'\\{c}'"));
            let _ = decode_string_escapes(&format!("\\{c}"), 0);
            let _ = split_template(&format!("x{{{{ '{c}' }}}}y"));
        }
    }

    #[test]
    fn complex_ratified_expression_streams() {
        // Regression sources taken verbatim from the ratified lib.rs tests:
        // they must lex cleanly and with the exact expected shapes so the
        // future parser task is a drop-in replacement.
        assert_eq!(
            kinds("$node['TriggerNode'].json.token"),
            vec![
                "Id($node)",
                "LBracket",
                "Str(\"TriggerNode\",esc=false)",
                "RBracket",
                "Dot",
                "Id(json)",
                "Dot",
                "Id(token)",
            ]
        );
        assert_eq!(
            kinds("$('Webhook').first().json.id"),
            vec![
                "Id($)",
                "LParen",
                "Str(\"Webhook\",esc=false)",
                "RParen",
                "Dot",
                "Id(first)",
                "LParen",
                "RParen",
                "Dot",
                "Id(json)",
                "Dot",
                "Id(id)",
            ]
        );
        assert_eq!(
            kinds("$if($json.b > 5, 'yes', 'no')"),
            vec![
                "Id($if)",
                "LParen",
                "Id($json)",
                "Dot",
                "Id(b)",
                "Gt",
                "Num(5)",
                "Comma",
                "Str(\"yes\",esc=false)",
                "Comma",
                "Str(\"no\",esc=false)",
                "RParen",
            ]
        );
        assert_eq!(
            kinds("' hello '.trim().toUpperCase()"),
            vec![
                "Str(\" hello \",esc=false)",
                "Dot",
                "Id(trim)",
                "LParen",
                "RParen",
                "Dot",
                "Id(toUpperCase)",
                "LParen",
                "RParen",
            ]
        );
        assert_eq!(
            kinds("$json[$vars.key]"),
            vec![
                "Id($json)",
                "LBracket",
                "Id($vars)",
                "Dot",
                "Id(key)",
                "RBracket",
            ]
        );
        assert_eq!(
            kinds("false && $json.missing.deep"),
            vec![
                "Id(false)",
                "AndAnd",
                "Id($json)",
                "Dot",
                "Id(missing)",
                "Dot",
                "Id(deep)",
            ]
        );
        assert_eq!(
            kinds("cond ? a : b"),
            vec!["Id(cond)", "Question", "Id(a)", "Colon", "Id(b)",]
        );
        assert_eq!(
            kinds(r#"{ key: 1, "k2": [2, 3] }"#),
            vec![
                "LBrace",
                "Id(key)",
                "Colon",
                "Num(1)",
                "Comma",
                "Str(\"k2\",esc=false)",
                "Colon",
                "LBracket",
                "Num(2)",
                "Comma",
                "Num(3)",
                "RBracket",
                "RBrace",
            ]
        );
        // The quoted-handlebars regression at both layers.
        let chunks = split_template("{{ 'a}}b' }}").unwrap();
        match &chunks[0] {
            TemplateChunk::Expression { source, .. } => {
                assert_eq!(kinds(source), vec!["Str(\"a}}b\",esc=false)"]);
            }
            other => panic!("expected Expression, got {other:?}"),
        }
    }

    #[test]
    fn streaming_tokenizer_matches_vec_api() {
        let src = "$json.a >= 2 && 'x' !== \"y\" ? [1] : {b: .5}";
        let mut lexer = Tokenizer::new(src);
        let mut streamed = Vec::new();
        while let Some(tok) = lexer.next_token().unwrap() {
            streamed.push(tok);
        }
        assert!(lexer.is_at_end());
        assert_eq!(streamed, tokenize(src).unwrap());
        assert_eq!(lexer.pos(), src.len());
    }

    #[test]
    fn tokens_borrow_the_source_zero_copy() {
        // Acceptance criterion proof: identifier / string / number payloads
        // are slices of the input buffer — no per-token string allocation.
        let src = String::from("$json.name + 'literal' + 12.5");
        let toks = tokenize(&src).unwrap();
        let base = src.as_ptr() as usize;
        let end = base + src.len();
        let mut payload_tokens = 0;
        for t in &toks {
            let slice = match t {
                Token::Ident { name, .. } => *name,
                Token::Str { raw, .. } => *raw,
                Token::Number { raw, .. } => *raw,
                _ => continue,
            };
            payload_tokens += 1;
            let p = slice.as_ptr() as usize;
            assert!(
                p >= base && p + slice.len() <= end,
                "payload not inside source: {slice:?}"
            );
        }
        // $json, name, 'literal' raw, 12.5 raw → 4 borrowed payloads.
        assert_eq!(payload_tokens, 4);
    }

    #[test]
    fn long_input_is_iterative_no_stack_growth() {
        // The lexer is a flat loop: 5000 chained additions (10k+ tokens)
        // must succeed without recursion.
        let src = "1+".repeat(5000) + "1";
        let toks = tokenize(&src).unwrap();
        assert_eq!(toks.len(), 10001);
        assert_eq!(
            toks[0],
            Token::Number {
                raw: "1",
                value: 1.0,
                pos: 0
            }
        );
        assert_eq!(toks.last().unwrap().as_number(), Some(1.0));
    }

    // ==================================================================
    // Expression layer — invalid input fails closed (never panics).
    // ==================================================================

    #[test]
    fn unterminated_string_fails_closed() {
        let err = tokenize("'abc").unwrap_err();
        assert_eq!(err.pos, 0);
        assert_eq!(err.message, "Unclosed string literal");
        // Trailing backslash keeps the string open.
        assert!(tokenize(r"'abc\").is_err());
        // Wrong closing quote does not terminate.
        assert!(tokenize("'abc\"").is_err());
    }

    #[test]
    fn unexpected_characters_fail_closed() {
        // Parity with the ratified lexer: single '=', '&', '|' and any
        // non-grammar character are errors, positioned exactly.
        for (src, pos) in [
            ("a = b", 2),
            ("a & b", 2),
            ("a | b", 2),
            ("#", 0),
            ("a@", 1),
            ("`x`", 0),
        ] {
            let err = tokenize(src).unwrap_err();
            assert_eq!(err.pos, pos, "src={src:?} got {err}");
            assert!(err.message.starts_with("Unexpected character:"), "{err}");
        }
        // '====' → EqEq consumes 3, the 4th '=' is unexpected (parity).
        let err = tokenize("====").unwrap_err();
        assert_eq!(err.pos, 3);
    }

    #[test]
    fn lex_error_surface() {
        let err = LexError::new(7, "boom");
        assert_eq!(err.to_string(), "expression syntax error at byte 7: boom");
        // Clone/Eq for cheap propagation & assertions.
        assert_eq!(err.clone(), err);
    }

    // ==================================================================
    // End-to-end: template layer feeding the expression layer.
    // ==================================================================

    #[test]
    fn template_then_expression_pipeline() {
        // Full parameter string → chunks → per-block token streams.
        let input = "Total: {{ $json.a * 2 }} ({{ 'fixed}}text' }})";
        let chunks = split_template(input).unwrap();
        assert_eq!(chunks.len(), 5); // Text, Expr, Text, Expr, Text

        let mut exprs = chunks.iter().filter_map(|c| match c {
            TemplateChunk::Expression { source, .. } => Some(*source),
            _ => None,
        });
        assert_eq!(
            kinds(exprs.next().unwrap()),
            vec!["Id($json)", "Dot", "Id(a)", "Star", "Num(2)",]
        );
        assert_eq!(
            kinds(exprs.next().unwrap()),
            vec!["Str(\"fixed}}text\",esc=false)",]
        );
        assert!(exprs.next().is_none());
    }
}
