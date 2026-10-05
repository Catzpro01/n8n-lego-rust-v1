# 02-input-access

`$input` reads ONLY `connectionInputData` (the main input the node is executing on). `params`/`context` additionally need `executeData.source.main[0]` to know the previous node.
