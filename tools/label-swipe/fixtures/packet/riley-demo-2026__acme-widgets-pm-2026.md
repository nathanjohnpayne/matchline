# riley-demo-2026__acme-widgets-pm-2026

Synthetic sheet for the label-swipe tests. Every name, employer and number below is invented.

Label provenance (from the fixture files): invented for tests.

## a. Extraction review

One block of two rows per expected Unit (3 expected).

| expected Unit | arm | extracted `raw_text` | extracted `normalized_summary` | score (overlap / skills) | ≥0.5? | fact correct? (Y/N/partial) | verbatim? (Y/N) | note |
|---|---|---|---|---|---|---|---|---|
| **u_gizmo_launch**: Launched the Gizmo 3 widget line to 40 retailers | A | A1 (aaaa0001): Launched the Gizmo 3 widget line to 40 retailers in 2024, growing revenue 12%. | Launched Gizmo 3 to 40 retailers in 2024, growing revenue 12%. | 0.700 (0.900 / 0.400) | Y |  |  |  |
| ″ | B | B1 (bbbb0001): Launched the Gizmo 3 widget line to 40 retailers in 2024, growing revenue 12%. | Launched Gizmo 3 at 40 retailers, revenue up 12%. | 0.650 (0.850 / 0.350) | Y |  |  |  |
| **u_sprocket_api**: Built the Sprocket partner API used by 9 \| teams | A | A2 (aaaa0002): Built the Sprocket partner API, adopted by 9 internal teams. | Built the Sprocket partner API adopted by 9 teams. | 0.600 (1.000 / 0.000) | Y |  |  |  |
| ″ | B | B2 (bbbb0002): Built the Sprocket partner API, adopted by 9 internal teams. | Built Sprocket API for 9 teams. | 0.550 (0.900 / 0.000) | Y |  |  |  |
| **u_mentoring**: Mentored 5 associate product managers | A | *(no extracted Unit assigned: every remaining Unit scored 0)* |  |  |  |  |  |  |
| ″ | B | B3 (bbbb0003): Mentored five associate product managers at Acme Widgets. | Mentored 5 APMs. | 0.500 (0.800 / 0.000) | Y |  |  |  |

### Extracted Units the scorer left unmatched

These extracted Units were not assigned to any expected Unit.

**Arm A**: 1 of 3 extracted Units unmatched.

| Unit | `raw_text` | `normalized_summary` | skills | closest label (score) | keep? (Y/N) | note |
|---|---|---|---|---|---|---|
| A3 (aaaa0003) | Won the 2023 Acme hackathon with a widget recycler prototype. | Won the 2023 Acme hackathon with a widget recycler prototype. | prototyping | u_gizmo_launch (0.050) |  |  |

**Arm B**: 1 of 4 extracted Units unmatched.

| Unit | `raw_text` | `normalized_summary` | skills | closest label (score) | keep? (Y/N) | note |
|---|---|---|---|---|---|---|
| B4 (bbbb0004) | Acme Widgets, Springfield. | Worked at Acme Widgets. | none | u_mentoring (0.010) |  |  |

## b. Requirements review

The table uses arm A's parse.

| expected requirement (must-have) | parsed `normalized_requirement` | parsed `raw_text` | parsed must-have | overlap | ≥0.3? | correct? (Y/N/partial) | must-have right? (Y/N) | note |
|---|---|---|---|---|---|---|---|---|
| **r_5yr_pm** (must): 5 years of product management experience | R1: 5+ years product management experience. | 5 years of product management experience in consumer hardware. | must | 1.000 | Y |  |  |  |
| **r_api_design** (nice): Experience designing partner APIs | R2: Experience designing partner-facing APIs. | Experience designing partner-facing APIs is a plus. | nice | 0.800 | Y |  |  |  |

### Parsed Requirements the scorer left unmatched (arm A's parse)

1 of 3 parsed Requirements unmatched.

| Requirement | `normalized_requirement` | `raw_text` | category | must-have | keep? (Y/N) | note |
|---|---|---|---|---|---|---|
| R3 (cccc0003) | Comfortable presenting to executive stakeholders. | Comfortable presenting roadmaps to executive stakeholders every quarter. | skill | nice |  |  |

## c. Match review

The 2 expected matches.

| # | expected pair | Unit label | Requirement label (must-have) | endpoints mapped A / B | still agree? (Y/N) | note |
|---|---|---|---|---|---|---|
| 1 | `u_gizmo_launch:r_5yr_pm` | Launched the Gizmo 3 widget line to 40 retailers | 5 years of product management experience (must) | U✓ R✓ / U✓ R✓ |  |  |
| 2 | `u_sprocket_api:r_api_design` | Built the Sprocket partner API used by 9 teams | Experience designing partner APIs (nice) | U✓ R✓ / U✗ R✓ |  |  |

## Source text (public fixtures)

### Résumé `riley-demo-2026`

```text
Riley Demo

Senior Product Manager

Acme Widgets, Springfield — 2019 to present
- Launched the Gizmo 3 widget line to 40 retailers in 2024, growing revenue 12%.
- Built the Sprocket partner API, adopted by 9 internal teams across three business units.
- Mentored five associate product managers at Acme Widgets over four years.
- Won the 2023 Acme hackathon with a widget recycler prototype that cut scrap by 30%.
```

### JD `acme-widgets-pm-2026`

```text
Product Manager, Widgets

Minimum qualifications
- 5 years of product management experience in consumer hardware.

Preferred qualifications
- Experience designing partner-facing APIs is a plus.
- Comfortable presenting roadmaps to executive stakeholders every quarter.
- Shipped at least 2 physical products from concept through retail launch.
```
