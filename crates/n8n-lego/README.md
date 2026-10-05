# n8n-lego facade

This crate is the simple entry point for the Rust side of LEGO V2.

It deliberately does not re-implement the runtime loop. Instead it composes the already-tested internal crates behind a small public API.

~~~rust
use n8n_lego::LegoRuntime;

let runtime = LegoRuntime::new();

println!("built-in nodes: {}", runtime.node_count());
~~~

As more of the execution/control plane moves to Rust, this facade becomes the stable composition point for the application.

## Beginner path

1. Start with LegoRuntime::new().
2. Learn RuntimeConfig.
3. Learn the Workflow runtime.
4. Add Tools/Agent Runtime only when you need them.
