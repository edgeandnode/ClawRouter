# ClawRouter v0.10.5 - OpenClaw 2026.2.22 Alignment

**Release Date:** 2026-02-22

---

## 🎉 Highlights

- ✅ **9-Language Router** - Added ES/PT/KO/AR to all 12 scoring dimensions
- ✅ **OpenClaw 2026.2.22 Compatible** - Aligned with multilingual memory update
- ✅ **Updated Metadata** - Model counts corrected to 41+ across all docs

---

## 🌍 Multilingual Keyword Expansion: 5 → 9 Languages

**Before:** EN, ZH, JA, RU, DE (5 languages)
**After:** EN, ZH, JA, RU, DE, **ES, PT, KO, AR** (9 languages)

OpenClaw 2026.2.22 added multilingual memory search for Spanish, Portuguese, Japanese, Korean, and Arabic. ClawRouter's 14-dimension routing scorer now matches — users querying in these languages get properly classified task complexity and correct tier routing.

### Keywords Added Across All 12 Dimensions

| Dimension              | ES  | PT  | KO  | AR  |
| ---------------------- | --- | --- | --- | --- |
| codeKeywords           | ✅  | ✅  | ✅  | ✅  |
| reasoningKeywords      | ✅  | ✅  | ✅  | ✅  |
| simpleKeywords         | ✅  | ✅  | ✅  | ✅  |
| technicalKeywords      | ✅  | ✅  | ✅  | ✅  |
| creativeKeywords       | ✅  | ✅  | ✅  | ✅  |
| imperativeVerbs        | ✅  | ✅  | ✅  | ✅  |
| constraintIndicators   | ✅  | ✅  | ✅  | ✅  |
| outputFormatKeywords   | ✅  | ✅  | ✅  | ✅  |
| referenceKeywords      | ✅  | ✅  | ✅  | ✅  |
| negationKeywords       | ✅  | ✅  | ✅  | ✅  |
| domainSpecificKeywords | ✅  | ✅  | ✅  | ✅  |
| agenticTaskKeywords    | ✅  | ✅  | ✅  | ✅  |

---

## 📝 Metadata Updates

| File                   | Change                                |
| ---------------------- | ------------------------------------- |
| `package.json`         | Version 0.10.4 → 0.10.5               |
| `package.json`         | Description: "41 models" → "41+"      |
| `openclaw.plugin.json` | "30+ models, 78%" → "41+ models, 92%" |
| `README.md`            | All model counts: 38+/30+ → 41+       |

---

## 📋 OpenClaw 2026.2.22 Compatibility Notes

| OpenClaw Feature         | ClawRouter Impact | Status                                   |
| ------------------------ | ----------------- | ---------------------------------------- |
| Mistral provider support | Add models        | ⏳ Pending (blocked on BlockRun backend) |
| Multilingual memory      | Keyword expansion | ✅ Done                                  |
| Auto-updater             | No impact         | ✅ N/A                                   |
| Cron parallel runs       | Proxy handles it  | ✅ OK                                    |
| 40+ security fixes       | No impact         | ✅ N/A                                   |

---

## 🔢 Stats

- **Files changed:** 6
- **Lines added:** 444
- **Lines removed:** 23
- **Tests:** 214 passed, 3 skipped
