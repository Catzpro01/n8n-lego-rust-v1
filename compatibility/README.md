# Compatibility Oracle Test Suite (`compatibility/`)

Framework pengujian semantik untuk memverifikasi keselarasan 100% antara official n8n (Truth Oracle) dan implementasi Rust.

## Topologi Pengujian

```
               Workflow Definition (compatibility/workflows/*.json)
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                     ▼
        Official n8n Oracle (:5680)               Rust Engine (:5678)
                    │                                     │
                    ▼                                     ▼
         Output Golden Result                     Candidate Result
         (compatibility/expected/)                        │
                    │                                     │
                    └──────────────────┬──────────────────┘
                                       ▼
                             Semantic Diff Engine
                                       │
                                       ▼
                    Audit Report (compatibility/reports/)
```

## Struktur Direktori
- `workflows/`: Definisi workflow uji (JSON).
- `fixtures/`: Data input mentah untuk triggering atau webhook mocking.
- `expected/`: Hasil eksekusi resmi n8n (Oracle port 5680).
- `reports/`: Hasil komparasi diff semantik (node execution sequence, pairedItem, data mutations).
