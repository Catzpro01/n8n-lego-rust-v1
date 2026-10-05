# 03-node-data-access

- `$('X').first/last/all(branch?, run?)` -> `runData[X][run].data.main[branch]`; default branch = the output X is connected to towards the active node (`getNodeConnectionIndexes`), default run = latest.
- `$('X').item` / `.pairedItem(i)` / `.itemMatching(i)` -> recursive pairedItem walk `getPairedItem()` starting from `executeData.source.main[input]`.
- `$node['X'].json` -> item at the CURRENT `itemIndex` in X's output (no pairing).
- Error taxonomy captured in expected.json (nodeNotFound, no_execution_data, paired_item_no_info, ...).
