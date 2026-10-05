# 01-json-access

`$json` resolves to `connectionInputData[itemIndex].json` via `nodeDataGetter(contextNodeName, shortSyntax=true)`.

Key observed rules:
- value not starting with `=` is returned untouched (`isExpression`)
- exactly one `{{ }}` covering the whole string keeps the JS type; mixed text always yields a string
- item index beyond input length -> `ExpressionError` `pairedItemInvalidIndex`
- empty input -> `ExpressionError` `Node 'End' hasn't been executed` (`no_execution_data`)
