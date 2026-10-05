# 06-binary-reference

Default binary mode (`N8N_DEFAULT_BINARY_DATA_MODE` unset): data lives inline as base64 in `IBinaryData.data`; there is no `id`.

In `filesystem` mode (verified manually, see docs/isolation/execution-data.md) the same item becomes
`{ data: 'filesystem-v2', id: 'filesystem-v2:workflows/<wf>/executions/<exec>/binary_data/<uuid>', ... }`
and `getBinaryDataBuffer` resolves the id through BinaryDataService. That path needs a configured BinaryDataService + executionId, so it is documented rather than snapshotted here.

Note the expression-side difference:
- `$node['X'].binary` strips the `data` property (metadata only)
- `$('X').item.binary` returns the full IBinaryData including `data`
