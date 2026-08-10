# Gap Analysis: Blueprint LLM Gateway vs Implementasi Saat Ini

## Dokumen Dibandingkan
- **Blueprint TOGAF:** `/Volumes/Data/Anti Gravity/Blueprint-llm-gw.md` (v0.1, 20 Juli 2026)
- **Requirement Detail Fase 1:** `/Volumes/Data/Anti Gravity/llm-gw-rd.md` (PCM/04 — IT Requirement Document)
- **Implementasi Aktual:** `/Volumes/Data/Anti Gravity/beexexity/readme.md` (Siap Ditanya, per Agustus 2026)

---

## Ringkasan Eksekutif

Siap Ditanya (beexexity) mencakup **~55% ruang lingkup Fase 1 MVP** blueprint. Fondasi gateway sudah solid — single entry point, Bedrock integration, PII masking, audit logging, SSE streaming — tapi komponen arsitektur kunci yang membedakan platform ini dari chat wrapper biasa belum ada: **Guardrail Konstitusi, MCP knowledge layer, tier routing, dan SSO korporat.**

---

## Gap Detail per Domain

### 1. Guardrail Konstitusi — ❌ Tidak Ada
| Requirement | Status | Gap |
|:---|:---|:---|
| FR-GUARD-001: Deteksi ingress/egress PII & sensitivitas | ⚠️ Partial | PII masking ada (`pii-masker.service.ts`), tapi hanya deteksi regex — tidak ada klasifikasi tier (BLOCK/REDACT/HALT), tidak ada NER/ML, tidak ada feedback ke user saat diblokir |
| FR-GUARD-002: Blocking konservatif (false-positive-biased) | ❌ | Tidak ada blocking — PII di-mask, bukan di-block. Request tetap lanjut. |
| FR-GUARD-003: Feedback eksplisit saat request diblokir | ❌ | Tidak ada feedback blocking. User tidak tahu request-nya dimask atau mengandung PII. |
| FR-GUARD-005: Eskalasi pelanggaran berulang | ❌ | Tidak ada threshold eskalasi. |
| "Satu-satunya titik kontrol wajib tanpa bypass" | ❌ | Tidak ada enforcement point terpusat. PII masker bisa di-skip (fail-open di beberapa path). |

**Dampak:** Tanpa Guardrail Konstitusi, platform ini belum memenuhi prinsip arsitektur #1 blueprint. Ini gap paling kritis.

### 2. MCP / Knowledge Layer (Tier 2) — ❌ Tidak Ada
| Requirement | Status | Gap |
|:---|:---|:---|
| FR-MCP-001: Search & retrieval tools | ❌ | Tidak ada retrieval/RAG sama sekali. Dokumen user dilampirkan ke prompt mentah. |
| FR-MCP-002: Korpus awal (SOP, memo, risk/compliance, audit, FAQ produk) | ❌ | Tidak ada knowledge corpus terkurasi. |
| FR-MCP-003: Kemampuan sitasi | ❌ | Tidak ada source citation. |
| Skema metadata MCP (id, domain, sensitivity, source_type, binding_level) | ❌ | Tidak ada metadata schema. |

**Dampak:** Chat app tanpa MCP = chat wrapper biasa. Nilai unik platform bagi bank (pengetahuan internal terstruktur) belum tersedia.

### 3. Tier Routing — ⚠️ Partial
| Requirement | Status | Gap |
|:---|:---|:---|
| FR-T1-001: Tier 1 via AWS Bedrock privat | ✅ | Semua model melalui Bedrock ap-southeast-3 |
| FR-T1-002: Tier 3 tidak diaktifkan di MVP | ✅ | Tidak ada Tier 3 (sesuai) |
| FR-T2-001: MCP knowledge layer | ❌ | Tidak ada Tier 2 |
| Routing otomatis berdasarkan klasifikasi data, bukan pilihan user | ❌ | User memilih model secara manual. Tidak ada automated tier routing. |
| 3-tier AI Sovereignty | ❌ | Hanya 1 tier. Tidak ada pemilahan PII→Tier1, internal→Tier2, publik→Tier3. |

### 4. Autentikasi & RBAC — ⚠️ Partial
| Requirement | Status | Gap |
|:---|:---|:---|
| FR-CHAT-001: SSO korporat | ❌ | JWT + Google OAuth — bukan SSO bank. Tidak ada integrasi LDAP/SAML/Azure AD. |
| FR-POL-001: Profil pengguna per role/divisi/use case | ⚠️ | Role admin/user ada. Divisi/use case/tier eligibility tidak ada. |
| FR-POL-002: Administrasi via API | ✅ | Admin API untuk user management |
| FR-POL-003: Klasifikasi false-positive-biased | ❌ | Tidak ada preference untuk over-block. |
| FR-ADM-001: Admin hanya via API (IT only) | ⚠️ | Ada admin.html UI. API ada tapi tidak eksklusif. |

### 5. Aplikasi Chat — ⚠️ Partial
| Requirement | Status | Gap |
|:---|:---|:---|
| FR-CHAT-002: Standard Mode & Research Mode | ❌ | Hanya satu mode. Research Mode dengan pemikiran mendalam (sequential reasoning) ada tapi tidak dipisahkan sebagai mode eksplisit. |
| FR-CHAT-004: Bilingual (ID default, EN) | ⚠️ | UI bilingual, tapi system prompt selalu English. Tidak ada dynamic language switching di prompt. |
| FR-CHAT-005: Feedback eksplisit saat request diblokir/diredaksi | ❌ | Tidak ada. |

### 6. Monitoring & Observability — ⚠️ Partial
| Requirement | Status | Gap |
|:---|:---|:---|
| FR-OBS-001: Metrik ke Grafana | ❌ | Tidak ada Grafana. Hanya console logging. |
| FR-OBS-002: Atribusi usage per user/team/direktorat | ⚠️ | Per-user cost tracking ada. Per-team/direktorat tidak ada. |
| FR-OBS-003: Pelaporan berbasis API | ✅ | Admin usage/cost API ada |
| Immutable WORM audit logs | ❌ | PostgreSQL standar. Bisa di-DELETE. |
| PII hash/tokenized di log | ❌ | PII di-mask (placeholder), tapi tidak di-hash. Placeholder bisa direkonstruksi. |

### 7. Arsitektur Teknis — ⚠️ Partial
| Requirement | Status | Gap |
|:---|:---|:---|
| FR-CORE-001: REST + gRPC + async | ⚠️ | REST + SSE saja. Tidak ada gRPC. |
| FR-CORE-003: Canonical request model | ⚠️ | Dua format berbeda (JSON + multipart) — belum unified. |
| FR-CORE-005: Tool/function calling | ❌ | Tidak ada. |
| FR-CORE-006: Streaming (SSE/WebSocket) | ✅ | SSE streaming |
| Secrets management sesuai standar bank | ⚠️ | Environment variables. Secret Manager hanya di production (cloudbuild.yaml). |

---

## Matriks Kesenjangan Kritis

| # | Gap | Severity | Fase Target Blueprint | Estimasi Effort |
|:---|:---|:---|:---|:---|
| 1 | Guardrail Konstitusi (klasifikasi + BLOCK/REDACT/HALT) | 🔴 Critical | Fase 1 | 3-4 minggu |
| 2 | MCP v0 (knowledge retrieval + sitasi) | 🔴 Critical | Fase 1 | 4-6 minggu |
| 3 | Tier routing otomatis | 🟡 High | Fase 1 | 2-3 minggu |
| 4 | SSO korporat | 🟡 High | Fase 1 | 2-4 minggu |
| 5 | RBAC per divisi/tier eligibility | 🟡 High | Fase 1 | 2-3 minggu |
| 6 | Grafana monitoring | 🟡 High | Fase 1 | 1-2 minggu |
| 7 | Immutable WORM audit | 🟠 Medium | Fase 1 | 1-2 minggu |
| 8 | Research Mode | 🟠 Medium | Fase 1 | 1 minggu |
| 9 | Guardrail user feedback | 🟠 Medium | Fase 1 | 1 minggu |
| 10 | gRPC endpoint | 🟢 Low | Fase 1 | 2-3 minggu |
| 11 | Tool/function calling | 🟢 Low | Fase 1 | 2-3 minggu |
| 12 | PII hash di log | 🟠 Medium | Fase 1 | 1 minggu |

---

## Yang SUDAH Melampaui Requirement MVP

| Fitur | Status | Catatan |
|:---|:---|:---|
| Multi-tenant API key management | ✅ | Aplikasi + API key per consumer — tidak ada di requirement Fase 1. Kesiapan untuk Fase 3-4. |
| PDF/PPTX generation | ✅ | Document generation pipeline — tidak ada di requirement. |
| Sequential reasoning | ✅ | Multi-step orchestration — setara Research Mode. |
| Semantic judge (LLM-as-judge) | ✅ | Verifikasi faktualitas otomatis — tidak ada di requirement. |
| Progressive streaming render | ✅ | UI optimized — tidak ada di requirement. |
| Admin dashboard (UI) | ⚠️ | Melampaui FR-ADM-001 (admin API-only), tapi justru melebihi requirement. |

---

## Rekomendasi Urutan Penutupan Gap

1. **Guardrail Konstitusi** — gap paling kritis. Tanpa ini, platform hanya chat wrapper. Mulai dengan klasifikasi PII→tier + BLOCK threshold.  
2. **MCP v0** — tanpa knowledge layer, chat app kurang bernilai bagi bank. Mulai dengan 3-5 dokumen SOP/regulasi.  
3. **Tier routing** — hubungkan hasil klasifikasi Guardrail ke pemilihan model/tier otomatis.  
4. **SSO + RBAC** — integrasi SSO korporat + role per divisi untuk production readiness.  
5. **Grafana + WORM** — monitoring & immutable audit untuk kepatuhan.
