# n8n lego — license

`n8n-lego` is a distribution wrapper. It ships **no** n8n source code; it consumes
the published `n8n-editor-ui` package as a normal npm dependency and serves it.

- **n8n lego code** (`bin/`, `src/`, `scripts/`) — same terms as the parent
  repository.
- **Editor UI** (`n8n-editor-ui`, a dependency of this package) — n8n's
  [Sustainable Use License](https://github.com/n8n-io/n8n/blob/master/LICENSE.md).
  Read it before using this in a commercial offering: it permits internal
  business use, but not reselling n8n-based products as a service.
- **Node catalog** (`n8n-nodes-base`, fetched at first boot by
  `n8n-lego catalog`) — same Sustainable Use License. It is downloaded from the
  npm registry onto your machine, not redistributed here.
- **Third-party components** keep their original licenses.

Reference copies of the upstream license live in the repository at
`reference/n8n/LICENSE.md`.
