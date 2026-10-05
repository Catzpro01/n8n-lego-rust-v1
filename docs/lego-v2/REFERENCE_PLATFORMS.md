# Open-source projects to learn from

LEGO V2 should borrow ideas and interfaces, not copy implementation code.

| Project | What to learn | LEGO V2 adaptation |
|---|---|---|
| Windmill | OpenFlow, worker model, flows, approvals, suspend/resume, low-code + code | Use a declarative runtime IR and isolated worker pools |
| Temporal | Durable execution and crash recovery | Make wait/resume, retries and execution journals first-class |
| Kestra | Control/data plane separation and declarative orchestration | Separate control-plane API from worker execution |
| Activepieces | Small reusable integration pieces, sandboxed workers, approachable builder | Make Node/Tool packages easy to scaffold and run |
| Node-RED | Extremely simple mental model: flow, node, message, context | Keep Workflow/Node/Item as the beginner vocabulary |
| LangGraph | Durable agent state, streaming, persistence, human-in-the-loop | Build Agent Runtime on top of the same workflow/tool contracts |

## Recommended order

1. Windmill — best reference for low-code workflows, code execution, workers and an explicit flow specification.
2. Temporal — best reference for durable execution semantics.
3. Activepieces — best reference for a beginner-friendly integration ecosystem.
4. Kestra — best reference for clean control-plane/data-plane separation.
5. Node-RED — best reference for teaching and simple flow concepts.
6. LangGraph — best reference for the Agent Runtime layer.

## What LEGO should NOT imitate blindly

- Distributed infrastructure that is unnecessary on a local developer laptop.
- Everything-is-a-worker designs for purely in-process Rust execution.
- A separate queue/broker for every internal event.
- A huge plugin SDK before the core execution contract is stable.
