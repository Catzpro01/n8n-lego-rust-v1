# Audit Progres Harian — 2026-09-27

Register kanonik: `docs/n8n-lego/milestones.json` (executionPointer) — dokumen ini
sekadar catatan audit; sumber kebenaran = register + riwayat git. File ini pernah
hilang bersama wipe workspace (tidak pernah ter-commit sebelumnya) lalu
direkonstruksi dari session log + `git log`; SHA commit adalah catatan otoritatif.

## Update 19 — REPAIR AKUNTANSI GLOBAL P0–P11 (PR #373, merge 25a9c9ae) + R1/R2

- **DRY-RUN gate (LOLOS)**: simulasi independen (`audit/dryrun-accounting.py`) atas register beku `f419cfba` — BEFORE 171/200=85.5% → AFTER 170/199=85.4%; delta tepat 1 baris (`P2.27` counted→excluded, aggregate-parent, delivery diwakili children PR 197); ambiguity 0; cross-check vs implementasi = 0 mismatch (identik). Peta klasifikasi 200 baris di `audit/DRYRUN-ACCOUNTING-2026-09-28.md`.
- **Repair (PPA-1..5, derivatif — register rows TIDAK diubah)**: `tools/lego/governance-register.mjs` kini punya `aggregateParentIds/progressRoleOf/accountingRows/excludedRows/isVerifiedRow/accountingBreakdown`; `completionTally`/`deliverySummary` memakai `accountingRows`. P2.27 (aggregate parent dari `P2.27.0..`, PR 197 = `P2.27.10`) di-exclude dari denominator — satu-satunya double-count (6 pasang `(pr,mergeSha)` duplikat diaudit; 5 sisanya shared-delivery sah PPA-4). Gates A–J: `test/progress-accounting.test.mjs` 17/17.
- **Delivery**: PR #373 (head `8b3c12ce`) CI 9/9 (sempat 3 job mati oleh shutdown runner WSL — `runner lost communication`/`shutdown signal`, bukan defect; dire-run sah setelah pool `MDMTEST-n8n-wsl*` 5/5 online) → merge `25a9c9ae`. Post-merge battery main: lego 3088/3088, engine 19/19, runtime 79/79, frontend 694/0 (1 skip), gates 7/7, GOV-OK, accounting A–J 17/17.
- **R1 `f398f998`** (HARD GUARD queue-unchanged in-memory pre-write LULUS: plannedQueue 18 [P2-S12..] / activeSlices [P2-S11] / blockedSlices [P2-S03] / latestCompletedSlice P2-S10 byte-identik; delta progres 0 = pekerjaan governance) + **R2 `ed8f328d`** (tail pointer-only `lastVerifiedMain` → `f398f998`) + **resync `1f7e6983`** (README/.ai; fingerprint register ikut pointer).
- **Catatan zero-silent-error (slip, DITUTUP)**: battery pra-push R2 sempat 111/6 — 6 kegagalan = gerbang freshness proyeksi (README basi antara write pointer & resync: test 52/59/60/81/83/109), bukan defect; gerbang bekerja sesuai desain. Ditutup oleh commit resync `1f7e6983`; pasca-resync 117/117 + battery penuh hijau. Klaim "pre-push battery" pada message R2 merujuk konten register (JSON valid, GOV-OK, guard lulus); setengah rantai proyeksi diselesaikan commit resync.
- **Angka kanonik pasca-repair**: global 170/199=85.4% (verified 2: P2-S01, FUTURE-RELIABILITY-S01), current P0–P11 169/193=87.6%, P2 39/59=66.1%; README == derived (gate E), .ai == derived.
- **NEXT**: rantai PR #372 (P2-S11 delivery → merge + R1 flip `in-progress`→`implemented` pada basis baru: P2 39→40/59) → **P2-S12** (queue head) → … → P2-S29.

## Update 18 — P2-S10 SELESAI (pr 368, merge 60763a5e)

- **P2-S10 full cycle (delivery `9f558cdb`, PR #368, CI 9/9, merge `60763a5e`)**: Settings panels pilot (instance + personal) di atas hand-over boundary P2-S02. `frontend-lego/src/settings.mjs` — surface `settings` (message slot `settings`), entry shape `{id,panel,section,value}` dengan **secret material ditolak eksplisit** di boundary (SECRET_BEARING_KEYS + non-scalar -> security error; `carriesSecrets:false`), REGION_STATES/panel/action/request vocabularies tertutup, parity fail-closed terhadap shared-rule reference fixtures, a11y derived-once, bounded list + explicit failure + degraded mode. `ui.settings.pages` reference-only -> pilot-available (rollback `pilot-not-primary`); capability `settings` dideklarasikan (degrades `native-behavior`). 21 focused tests.
- **Temuan (di evidence)**: (1) deklarasi frontend men-shadow backend-advertised `settings` di negotiation merge (dual-origin ambiguity -> fixture test 14/23 dialihkan ke `workflow`, ikut preceden P2-S09 `credentials`; semantics dirapikan oleh shared-rule reference, TANPA mengubah negotiator shared) (2) em-dash literal `—` vs escape `\u2014` di register text; START commit hanya divalidasi register suite; diperbaiki via writer round-trip gate.
- **R1 `f1a11902`** (HARD GUARD queue-unchanged in-memory pre-write LULUS; pins di-refresh 171/200=85.5, current 170/194 dengan evidence; proyeksi README + .ai diregen) + **R2 `5e55e066`** (tail pointer-only). Battery pasca-merge: lego 3071/3071, engine 19/19, runtime 79/79, frontend 694/0 (1 skip), gates 7/7, register suite 100/100.
- **Provenance check (temuan operasional, DITUTUP)**: 79 tests follow-up P2-S03 dari siklus sebelumnya ("63-66" dalam catatan sementara) ternyata sudah berada di dalam file yang ter-commit (`live-progress` 30 decl + `governance-register` 35 decl + frontend 45/46); jumlah lego:test 3071 konsisten sebelum & sesudah wipe ke-8; TIDAK ada yang hilang.
- **NEXT**: P2-S11..S29 (urutan kanonik; q0 = P2-S11) -> evaluasi final P2-S03 (gated, TIDAK otomatis).

## Update 17 — P5-M06 SELESAI (pr 367, merge 49103ac9) + P2-S10 STARTED

- **P5-M06 full cycle (delivery `eea5a4d6`, PR #367, CI 9/9, merge `49103ac9`)**: DEC-0028 rev 2 option A (A-injected-transport, decidedBy OWNER). `auth/security/mail-transport.mjs` — kontrak MailTransport provider-neutral (pure values in, frozen values out; host does IO; closed error model INVALID_MESSAGE/UNAVAILABLE/TIMEOUT/REFUSED memetakan kode error terpublikasi; adapter console (body ter-redaksi) + recording fake; `redactMailSecrets` mask token=). `auth/password-reset-delivery.mjs` — compose deterministik (subject pinned upstream "n8n password reset", input = PasswordResetData) + delivery port utk accountRoutes. `server.mjs` — composition root `mailTransport` option (default console; produksi injeksi di luar bundle; `mailTransport:false` = rollback ke pinned upstream 500). 18 focused tests (contract, determinism, failure propagation, secret hygiene, E2E atas reset-token primitive, rollback; token tak pernah masuk log). Battery: lego 3071/3071, engine 19/19, runtime 79/79, frontend 672/0 (1 skip), gates 7/7.
- **R1 `72691ca9`** (HARD GUARD queue-unchanged in-memory pre-write LULUS; pins di-refresh 170/200=85.0, current 169/194 dengan evidence; 2 assertion independensi dua-sumbu dibuat clone-based sehingga tahan perubahan state) + **R2 `0d6e14b7`** (tail pointer-only). Insiden test: 4 ekspektasi basi didiagnosis (sendData('{}') bukan raw kosong; fingerprint token terikat secret+store per-harness; pin 84.5→85; pin `realtime!=100` & `percent!=100` = kebetulan state lama, diganti invarian turunan/clone).
- **Recovery wipe ke-7**: re-clone + node22 + catalog + setup-reference-runtime + npm install/workflow-lego build (deps hilang = 8 fail engine yang ternyata environment, bukan kode).
- **P2-S10 STARTED `d9adbbbf`** (PRE/POST assert: pop q0 P2-S10 -> activeSlices -> in-progress; queue 20->19, q0 kini P2-S11; blocked [P2-S03] tak berubah). Model CP sudah terpasang saat split (CP-01 contract 20; CP-02 pilot+rollback 20; CP-03 parity 25; CP-04 a11y 20; CP-05 budget+failure 15) — TIDAK di-reinstall.
- **NEXT**: delivery P2-S10 (Settings surface, pilot mode) -> P2-S11..S29 -> evaluasi final P2-S03 (gated, TIDAK otomatis).

---

## Update 16 — P5-M10 SELESAI (pr 366, merge c95a0fae) + P5-M06 STARTED

- **P5-M10 full cycle (delivery `324fd724`, PR #366, CI 9/9 tanpa insiden, merge `c95a0fae`)**: API mounting framework `public-api-backing.mjs` (26 route /api/v1 di atas model M11..M18; closed mapping INVALID->400/NOT_FOUND->404/CONFLICT->409/storage UNAVAILABLE|TIMEOUT->503; satu facade P8; BACKING_RESOURCE_ROUTES = satu sumber kebenaran utk mount+extractor+spec test) + rollback=unmount (models+history utuh, teruji). Surface: projects/audit/source-control/data-tables (rows filter engine fail-closed)/transfer/versions/retry/execution-tags. 39 focused tests baru; 5 fixture 'not mounted' basi di suite M08/M09 dipindah berdiagnosis (transfer/retry kini 405-utk-method-salah; spec equality 57 operasi); surface pin M11/M13/M14 diperpanjang utk 3 list verb + deleteTable (all-or-nothing applyBatch). Governance: 8 model factory dipublish di lego-foundation.public; 2 temuan scale-out dideklarasikan (S1 mount table, S3 persistence adapter).
- **Ekstensi model terdeklarasi**: M11 `listProjects`, M13 `listRepositories`, M14 `listTables`+`deleteTable`.
- **Post-merge hijau**: lego 3053/3053, engine 49/49, runtime 79/79, validate 0/0. **R1 `bc28eb69`** (HARD GUARD queue-unchanged in-memory sebelum write LULUS; pins 169/200=84.5, current 168/194; insiden bedah: tail generik null-null mengenai P5-M06 lebih dulu — TERTANGKAP assert pasca-tulis, direvert sebelum commit) + **R2 `5e0ab0f7`** (tail pointer-only). Queue head TETAP P5-M06 sampai START (guardrail owner).
- **P5-M06 STARTED `1c5ed9b3`** (PRE/POST assert: pop q0 P5-M06 -> activeSlices -> in-progress + 5 CP w20; q0 kini P2-S10; blocked [P2-S03]). Scope: /rest/forgot-password atas reset-token primitive + mail transport injected (DEC-0028 A).
- **NEXT**: delivery P5-M06 -> P2-S10..S29 (urutan kanonik) -> evaluasi final P2-S03 (gated, TIDAK otomatis).

---

## Update 15 — START P5-M10: execution API surface (2026-09-27)

- **P5-M18 terkunci penuh**: R1 `340d39f1` (latestCompletedSlice=P5-M18, pin 168/200=84%, HARD GUARD queue-unchanged in-memory sebelum write) + R2 `c2f43d74` (tail pointer-only).
- **P5-M10 unblock + START** (`eecf215f`): PRE lulus (blocked; M11..M18 semua implemented — umbrella queue-shaped terbuka kembali saat backing models tersisa tuntas; q0=P5-M06 tak berubah; tanpa mergeSha/evidence). Recovery blockedSlices=[P2-S03] + planned→in-progress satu aksi + `blockedBy` basi dihapus (validator: non-blocked tak boleh bawa blockedBy) + 5 CP (weight 20). NET queue unchanged (insert+pop atomik, assert in-memory).
- **2 fixture test dipindah dengan diagnosis** (ekspektasi terpin ke P5-M10=blocked, basi saat mulai sah): governance-register blocked-sample → P2-S03 (lintas program); live-progress blocked-row → derived `blockedSlices[0]` sesuai idiom 'Derived, not pinned'. Tanpa pelemahan assertion.
- **Waspada teknis**: stash pop gagal (konflik file evidence isolation yang ditulis ulang gate) → kerja sementara sempat nyaris hilang; pulih penuh.
- **Noise pre-existing**: workflow-isolation G06..G10 FAILED — identik di HEAD bersih (uji stash round-trip); tak disentuh. CI runner tidak sehat; belum ada run untuk `eecf215f`.
- Verifikasi `eecf215f`: register 0 errors 0 drift; battery 3014/3014; engine 49/49; runtime 79/79; lego:gate; ai:check; ai-pack sync.
- **NEXT**: implement P5-M10 (8 surface /api/v1 di atas model M11..M18) → PR → merge → R1/R2 → P5-M06 (DEC-0028 A) → P2-S10..S29 → evaluasi final P2-S03 (gated, tidak otomatis).

## Catatan rekam jejak singkat (dari git log)

- `97f03df9` merge P5-M18 (PR #365, CI 9/9) → `340d39f1` R1 → `c2f43d74` R2.
- `06256244` START P5-M18 → `0b3f03dc` delivery → merge `25a3b53b` (PR #354).
- `f6114837` START P5-M17 → `97a40f56` delivery → merge `b616be84` (PR #352).
- `e673e9a9` START P5-M16 → `78c4c413` delivery → merge `c4c76b3c` (PR #347).
- `e3b3e74c` START P5-M15 → `1cf9d8d7` delivery → merge `918746e0` (PR #342).
- `3821f765` START P5-M14 → `6a323ba4` delivery → merge `b3d6bc23` (PR #337).
- `5d19fa2b` START P5-M13 → `ca704a67` delivery → merge `7b8a4e75` (PR #330).
- `59e3787b` START P5-M12 → `b742b4c8` delivery → merge `648d633e` (PR #324).
- `2fa648d6` START P5-M11 → `74d13f9c` delivery → merge `32d164f4` (PR #318).
- `0e23ba93` START P5-M05 → `290614f8` delivery → merge `274225c6` (PR #310).
- M01..M04 (P5): merge `33b05a63` (PR #305), `600a2145` (PR #304), `a69584e2` (PR #302), `8e883a45` (PR #298).
