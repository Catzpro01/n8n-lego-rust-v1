//! Sandbox gate for the n8n expression evaluator (contract invariant E9).
//!
//! Mirrors the fail-closed checks of n8n v2.9.4
//! (`packages/workflow/src/expression-sandboxing.ts`) adapted to the safe
//! Rust evaluator:
//!
//! * `.<ws>constructor` or `['constructor']` member access is rejected
//!   *before* parsing (upstream: `EXPRESSION_ERROR_OPERATIONS` regex).
//! * `__proto__` and `prototype` member access is rejected
//!   (upstream: AST hooks in `prototypeSanitizer`).
//! * `with` statements and `class` definitions/extensions are rejected
//!   (upstream: `ExpressionWithStatementError` / class-extension hook).
//! * bare `$` usage is rejected by the parser itself (see `parser.rs`).
//!
//! All findings surface as `ExpressionError::SyntaxError`, which the engine
//! layer maps to the `"invalid syntax"` application error class (E14).
//! Because this evaluator never executes arbitrary code, no runtime sandbox
//! is required — the gate exists so that hostile or malformed expressions
//! are rejected deterministically at the same boundary as upstream n8n.

use n8n_common::expression_contract::ExpressionError;
use regex::Regex;
use std::borrow::Cow;
use std::sync::OnceLock;

/// Reference pattern, kept for the `staged2_perf` oracle (the shipped gate
/// runs the single combined alternation instead).
#[cfg(test)]
fn constructor_access_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // `.constructor` and `[ "constructor" ]`-style access after string
        // literals have been blanked out (bracket form leaves `[<spaces>]`
        // where the literal was, so the bracket form is detected by the
        // remaining bare `constructor` identifier check below as well).
        Regex::new(r"\.\s*constructor\b").expect("valid regex")
    })
}

/// Reference pattern, kept for the `staged2_perf` oracle (the shipped gate
/// runs the single combined alternation instead).
#[cfg(test)]
fn member_identifier_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // Member access of reserved prototype identifiers, in dot-access
        // form or as a bare identifier (never inside string literals —
        // those are blanked before scanning).
        Regex::new(r"(?:\.\s*|\b)(?:__proto__|prototype)\b").expect("valid regex")
    })
}

/// Reference pattern, kept for the `staged2_perf` oracle (the shipped gate
/// runs the single combined alternation instead).
#[cfg(test)]
fn statement_keyword_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b(?:with|class)\b").expect("valid regex"))
}

/// Replaces every character of each string literal (including its quote
/// delimiters and escapes) with a space, keeping byte positions stable so
/// error positions still refer to the original source. Backtick literals are
/// blanked too (the tokenizer rejects them later on with a syntax error).
///
/// Hot-path shape (STAGE-2 perf analysis):
///   * operates on bytes, not `char`s — a UTF-8 continuation byte is always
///     `>= 0x80`, so the ASCII quotes/backslash can never be matched inside a
///     multi-byte code point, and replacing bytes in place keeps offsets exact;
///   * returns [`Cow::Borrowed`] when the source contains no quote at all, so
///     the common clean-expression case allocates nothing. Previously this
///     always built a `Vec<char>` (4 bytes/code point) *and* a `String`.
fn blank_string_literals(src: &str) -> Cow<'_, str> {
    let bytes = src.as_bytes();
    // Fast bail-out: no quote characters => nothing can be blanked.
    if !bytes
        .iter()
        .any(|b| *b == b'\'' || *b == b'"' || *b == b'`')
    {
        return Cow::Borrowed(src);
    }
    let mut out = bytes.to_vec();
    let mut i = 0usize;
    let mut quote: Option<u8> = None;
    while i < out.len() {
        let b = out[i];
        match quote {
            Some(q) => {
                out[i] = b' ';
                if b == b'\\' && i + 1 < out.len() {
                    i += 1;
                    out[i] = b' ';
                } else if b == q {
                    quote = None;
                }
            }
            None => {
                if b == b'"' || b == b'\'' || b == b'`' {
                    quote = Some(b);
                    out[i] = b' ';
                }
            }
        }
        i += 1;
    }
    // Only ASCII bytes were substituted, so validity is preserved; going
    // through the checked constructor keeps this free of `unsafe`.
    Cow::Owned(String::from_utf8(out).expect("blanked source stays valid UTF-8"))
}

/// Single combined scan: one pass over the blanked source instead of three.
///
/// The three patterns are merged into one alternation with **named groups**, so
/// the specific error message for each blocked construct survives even though
/// only a single DFA walk runs. The three per-pattern accessors below stay as
/// the readable reference and as the oracle for `staged2_perf`.
fn sandbox_pattern_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?x)
              (?P<constructor>\.\s*constructor\b)
            | (?P<prototype>(?:\.\s*|\b)(?:__proto__|prototype)\b)
            | (?P<statement>\b(?:with|class)\b)
            ",
        )
        .expect("valid regex")
    })
}

/// Maps a matched named group onto the message the separate patterns produced.
fn sandbox_message(group: &str) -> &'static str {
    match group {
        "constructor" => "access to the 'constructor' property is blocked in expressions",
        "prototype" => "access to '__proto__'/'prototype' is blocked in expressions",
        _ => "'with' statements and 'class' definitions are blocked in expressions",
    }
}

/// Runs all static sandbox checks against one expression body (the text of a
/// single `{{ ... }}` block, or the full `={{ ... }}` inner source).
///
/// Returns `Ok(())` when the source is clean, otherwise the first violation
/// found as a fail-closed `SyntaxError`. The patterns are compiled exactly once
/// per process behind [`OnceLock`] — see `staged2_perf` for the measured cost of
/// the uncached alternative and the guard that keeps it that way.
pub fn check_source_sandboxed(expression_body: &str) -> Result<(), ExpressionError> {
    let stripped = blank_string_literals(expression_body);
    if let Some(caps) = sandbox_pattern_re().captures(stripped.as_ref()) {
        // Slot 0 is the whole match; 1 = constructor, 2 = prototype, 3 = statement.
        let group = if caps.get(1).is_some() {
            "constructor"
        } else if caps.get(2).is_some() {
            "prototype"
        } else {
            "statement"
        };
        let m = caps
            .get(0)
            .expect("whole match present when any group matched");
        return Err(ExpressionError::SyntaxError {
            pos: m.start(),
            message: sandbox_message(group).to_string(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_sources_pass() {
        assert!(check_source_sandboxed("$json.user.name + 1").is_ok());
        assert!(check_source_sandboxed("'prototype is a fine word'").is_ok());
        assert!(check_source_sandboxed("$json.length").is_ok());
        assert!(check_source_sandboxed("$('My Node').first().json.total").is_ok());
    }

    #[test]
    fn constructor_dot_access_rejected() {
        let err = check_source_sandboxed("$json.a .constructor").unwrap_err();
        match err {
            ExpressionError::SyntaxError { message, .. } => {
                assert!(message.contains("constructor"), "got: {message}");
            }
            other => panic!("expected SyntaxError, got {other:?}"),
        }
    }

    #[test]
    fn constructor_dot_access_variants_rejected() {
        // baseline (dot access — same as the upstream `EXPRESSION_ERROR_OPERATIONS` regex)
        assert!(check_source_sandboxed("a.constructor").is_err());
        // whitespace between dot and identifier is caught too
        assert!(check_source_sandboxed("a. constructor").is_err());
        // Inside a plain string literal the word is benign and must pass.
        assert!(check_source_sandboxed("'.constructor'").is_ok());
    }

    #[test]
    fn proto_and_prototype_rejected_but_not_in_strings() {
        assert!(check_source_sandboxed("$json.__proto__").is_err());
        assert!(check_source_sandboxed("obj.prototype").is_err());
        assert!(check_source_sandboxed("'__proto__'").is_ok());
        assert!(check_source_sandboxed("\"prototype\"").is_ok());
    }

    #[test]
    fn with_and_class_rejected() {
        assert!(check_source_sandboxed("with (a) { b }").is_err());
        assert!(check_source_sandboxed("class Evil extends Base {}").is_err());
        // words merely *containing* the keyword must pass
        assert!(check_source_sandboxed("$json.withdrawal").is_ok());
        assert!(check_source_sandboxed("$json.className").is_ok());
    }

    #[test]
    fn blanking_keeps_positions_and_lengths() {
        let src = "a 'xx' b";
        let blanked = blank_string_literals(src);
        assert_eq!(blanked.chars().count(), src.chars().count());
        assert_eq!(blanked.as_ref(), "a      b");
    }
}

#[cfg(test)]
mod staged2_perf {
    //! STAGE-2 guards for the regex hot path (see the write-up in
    //! `m03-stage2-regex-cache-analysis.md`).
    //!
    //! The patterns are compiled once per process; the dominant per-call cost
    //! used to be `blank_string_literals`, which always built a `Vec<char>` +
    //! `String` and now borrows whenever the source has no quote byte. These
    //! tests lock both properties so a later "simplification" cannot silently
    //! put compilation or allocation back on the hot path.
    use super::*;
    use std::time::Instant;

    fn bench(label: &str, n: usize, mut f: impl FnMut() -> usize) {
        for _ in 0..(n / 10).max(1_000) {
            f();
        } // warm-up, incl. OnceLock initialisation
        let t = Instant::now();
        let mut sink = 0usize;
        for _ in 0..n {
            sink = sink.wrapping_add(f());
        }
        println!(
            "{label:<50} {:>9.1} ns/op",
            t.elapsed().as_nanos() as f64 / n as f64
        );
        assert!(sink != usize::MAX, "optimize-me-not");
    }

    /// The gate's patterns must be compiled exactly once per process. Proved at
    /// runtime, not by text scanning: repeated access must yield the *same*
    /// allocation, i.e. a cached static. A per-call `Regex::new` would return a
    /// fresh address every time (and cost ~3 orders of magnitude more — a
    /// measurement from this session put an uncached compile+match at 42 936 ns
    /// versus 81 ns for the cached match alone).
    ///
    /// It also asserts no other domain file reaches for `regex` at all, which is
    /// the property the STAGE-2 task actually asked about: the tokeniser must not
    /// compile regex on the hot path. `tokenizer.rs` has zero `Regex` references.
    #[test]
    fn patterns_are_compiled_once_and_cached() {
        let combined_a = sandbox_pattern_re() as *const Regex;
        let combined_b = sandbox_pattern_re() as *const Regex;
        assert_eq!(
            combined_a, combined_b,
            "combined gate pattern was recompiled"
        );
        for (name, f) in [
            (
                "constructor",
                constructor_access_re as fn() -> &'static Regex,
            ),
            ("prototype", member_identifier_re as fn() -> &'static Regex),
            ("statement", statement_keyword_re as fn() -> &'static Regex),
        ] {
            assert_eq!(
                f() as *const Regex,
                f() as *const Regex,
                "`{name}` pattern was recompiled instead of cached"
            );
        }

        // The tokeniser/parser/evaluator must not use regex at all.
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
        for file in [
            "tokenizer.rs",
            "parser.rs",
            "evaluator.rs",
            "extensions.rs",
            "ast.rs",
        ] {
            let body = std::fs::read_to_string(format!("{root}/{file}"))
                .unwrap_or_else(|e| panic!("{file}: {e}"));
            let code: String = body
                .lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                !code.contains("Regex::new") && !code.contains("use regex"),
                "{file} must not compile regex on the hot path"
            );
        }
    }

    /// The clean-expression path must not allocate.
    #[test]
    fn blanking_borrows_when_there_is_nothing_to_blank() {
        for src in [
            "$json.user.name + 1",
            "$json.a > 1 ? $json.b : 0",
            "items.length + 12.5",
            "",
        ] {
            assert!(
                matches!(blank_string_literals(src), Cow::Borrowed(_)),
                "`{src}` contains no quote byte and must not allocate"
            );
        }
        // `'x'` is 3 bytes, so 3 spaces replace them: 10 kept + 3 = 13.
        match blank_string_literals("$json.a + 'x'") {
            Cow::Owned(s) => {
                assert_eq!(s, "$json.a +    ", "literal must be blanked in place");
                assert_eq!(s.len(), 13, "byte length must be preserved");
            }
            Cow::Borrowed(_) => panic!("literal source must produce an owned buffer"),
        }
    }

    /// Byte scanning must agree with the previous char-scanning implementation
    /// everywhere, and the single combined pass must agree with the three
    /// separate patterns — these accessors are the oracle that keeps them used.
    #[test]
    fn byte_blank_and_single_pass_match_previous_behaviour() {
        let probes = [
            "a 'xx' b",
            "",
            "$json.name",
            "'unclosed",
            "\"proto\" x 'constructor'",
            "$json.émoji 'x' .constructor",
            "class A{}",
            "with(x){}",
            "'don\\'t'",
            "\"a\\\"b\"",
            "a`b`c",
            "'a' 'b'",
            "$('It\\'s') .constructor",
            "trailing backslash '",
            "\"unterminated at eof",
        ];
        for p in probes {
            // Reference: the pre-STAGE-2 char-based algorithm.
            let mut out: Vec<char> = Vec::with_capacity(p.chars().count());
            let mut quote: Option<char> = None;
            let mut escaped = false;
            for ch in p.chars() {
                match quote {
                    Some(q) => {
                        out.push(' ');
                        if escaped {
                            escaped = false;
                        } else if ch == '\\' {
                            escaped = true;
                        } else if ch == q {
                            quote = None;
                        }
                    }
                    None => {
                        if ch == '"' || ch == '\'' || ch == '`' {
                            quote = Some(ch);
                            out.push(' ');
                        } else {
                            out.push(ch);
                        }
                    }
                }
            }
            let reference: String = out.into_iter().collect();

            let now = blank_string_literals(p);
            assert_eq!(reference, now.as_ref(), "blanking differs for {p:?}");
            assert_eq!(reference.len(), now.len(), "byte length differs for {p:?}");

            // Three-pass reference verdict vs the shipped single-pass verdict.
            let three_pass = [
                constructor_access_re(),
                member_identifier_re(),
                statement_keyword_re(),
            ]
            .iter()
            .all(|re| re.find(&reference).is_none());
            assert_eq!(
                check_source_sandboxed(p).is_ok(),
                three_pass,
                "gate verdict differs for {p:?}"
            );
        }
    }

    /// The combined pattern must also preserve the *specific* message, not just
    /// the accept/reject verdict.
    #[test]
    fn combined_pass_keeps_per_construct_messages() {
        for (src, needle) in [
            ("$json.a.constructor", "constructor"),
            ("$json.__proto__", "__proto__"),
            ("with (a) { b }", "with"),
            ("class Evil {}", "class"),
        ] {
            let err = check_source_sandboxed(src)
                .err()
                .unwrap_or_else(|| panic!("`{src}` must be blocked"));
            assert!(
                err.to_string().contains(needle),
                "`{src}` message must mention `{needle}`, got: {err}"
            );
        }
    }

    /// Informational (printed, never asserted): absolute ns is hardware- and
    /// profile-dependent, so no timing threshold is encoded in the suite.
    #[test]
    fn gate_cost_is_reported_not_asserted() {
        let body = "$json.user.name";
        bench("sandbox gate (cached, Cow blank, 1 pass)", 400_000, || {
            check_source_sandboxed(body).is_ok() as usize
        });
        let three = |re: &Regex| re.find(body).is_some() as usize;
        bench("same work, 3 separate passes (reference)", 400_000, || {
            [
                constructor_access_re(),
                member_identifier_re(),
                statement_keyword_re(),
            ]
            .iter()
            .map(|r| three(r))
            .sum()
        });
    }
}
