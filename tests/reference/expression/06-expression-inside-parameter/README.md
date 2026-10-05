# 06-expression-inside-parameter

`getParameterValue` recursion: objects and arrays are walked, every leaf is passed to `resolveSimpleParameterValue`; non-string and non-`=` leaves are returned as-is.
