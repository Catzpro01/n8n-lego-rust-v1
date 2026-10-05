# 03-item-pairing

Start: 3 items.

| node | in -> out | explicit pairedItem? | observed pairedItem |
|---|---|---|---|
| MapNoPair | 3 -> 3 | no | `{item:i}` (same-count rule) |
| Aggregate | 3 -> 1 | no | `{item:0}` (single-output rule) |
| ExplodeNoPair1 | 1 -> 2 | no | `{item:0}` x2 (single-input rule) |
| ExplodeNoPairN | 3 -> 6 | no | **undefined** (no rule applies) |
| ExplodePaired | 3 -> 6 | yes | preserved `{item:0,0,1,1,2,2}` |
| Echo | 6 -> 6 | reads `$input.item.pairedItem` | `{item:i}` for i in 0..5 – the engine re-indexes INPUT pairedItem to the input position before execution |
