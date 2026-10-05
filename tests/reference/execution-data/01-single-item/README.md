# 01-single-item

Trigger emits one item `{json:{id:0}}`; `Pass` returns its input unchanged.

Asserts (observed from n8n 2.9.4 runtime):
- every stored item has `json` and an engine-assigned `pairedItem: {item: 0}`
- `Pass` task `source` = `[{previousNode:'Trigger', previousNodeOutput:0, previousNodeRun:0}]`
- `lastNodeExecuted` = `Pass`, status `success`
