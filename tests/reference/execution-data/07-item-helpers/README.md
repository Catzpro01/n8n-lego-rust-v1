# 07-item-helpers (extra)

`normalizeItems([{a:1},{a:2}])` -> `[{json:{a:1}},{json:{a:2}}]`; `returnJsonArray([{a:1},{json:{a:2}}])` -> both wrapped, no double wrapping.
