# Auto-layout benchmark and recommendation

Measured on 2026-10-03. The production portfolio measurements below follow implementation; the later prototype sections preserve the earlier research behind [the algorithm research](auto-layout-research.md). Do not mix their timings or counts.

## Production portfolio: does more compute time help?

Production **Automatic** runs Raster and PackingSolver 0.1.1056 concurrently,
with a shared deadline covering startup, preparation, search and original-outline
validation. Explicit overrides and budget semantics are documented in the
[layout API](api.md#bins).

**Keep the 5-second default.** In this corpus, increasing it to 10 or 20 seconds
mostly increased waiting, not quality. None of the 15 paired 5→10-second comparisons
improved bbox area. One of the 15 paired 5→20-second comparisons improved by 4.17%;
the other 14 were unchanged. All five per-case median areas were unchanged beyond
5 seconds.

The production experiment made **60 real HTTP requests**: five fixed rectangular
cases × budgets 2/5/10/20 seconds × three repetitions. Requests were serial;
each Automatic request ran its two engines in parallel. Cases used the original
anonymous outlines, 2 mm pair clearance, stacking lip, 2 mm walls, no pins and
`auto_width=false`. Grid sizes match the corpus below. This measures fixed-target
bbox compactness, not auto-width sizing, connected-cell savings or printed geometry.

Median enclosing bbox area in mm², excluding failed requests:

| Case | All-fit responses at 2 s | 2 s | 5 s | 10 s | 20 s |
|---|---:|---:|---:|---:|---:|
| concave_interlock | 2/3 | 4,784.0 | 4,784.0 | 4,784.0 | 4,784.0 |
| angle_long | 2/3 | 4,144.0 | 4,144.0 | 4,144.0 | 4,144.0 |
| real_narrow | 3/3 | 13,915.1 | 12,907.5 | 12,907.5 | 12,907.5 |
| real_dense | 3/3 | 38,222.7 | 38,222.7 | 38,222.7 | 38,222.7 |
| stress8 | 3/3 | 49,817.7 | 48,642.9 | 48,642.9 | 48,642.9 |

At 5, 10 and 20 seconds, every case returned all tools in all three repetitions
(15/15 per budget). All **58 successful responses** independently passed original
rigid-transform/area, interior, nonoverlap, pair-clearance and response-bounds checks.
The two 2-second failures returned HTTP 503 because the deadline expired before
any safe incumbent was ready; they are reported, not treated as valid layouts or
mathematical infeasibility.

Going from 2 to 5 seconds reduced median area by 7.24% on `real_narrow` and 2.36%
on `stress8`. The worst 2-second `stress8` result improved by 23.24% in its paired
5-second run. The concave case's 5/10-second area ranged from 4,784 to 4,992 mm²;
its 20-second runs all reached 4,784. The other four cases had identical areas
across all 5/10/20-second repetitions. This small sample supports the default,
not a promise that longer budgets cannot help harder layouts.

Observed HTTP medians/ranges were 2.030 s [2.011–2.302], 5.015 s [5.010–5.063],
10.021 s [10.010–10.105] and 20.084 s [20.010–20.303]. They include transport and
cleanup, unlike the prototype solve-call timings below. The shared budget is
not an exact client-latency promise. Host: Linux x64, AMD Ryzen 5 PRO 4650U,
6 cores/12 logical CPUs, unrestricted affinity, numerical threads limited to one
inside each worker. No tests or active UI verification ran concurrently, and the
private frontend server was stopped. Two earlier managed browser tabs remained
registered until cleanup; their background load was not measured. The user's
other desktop workload and dynamic clocks were also uncontrolled.

A separate maximum-budget smoke sent a real native request through the bundled
Next.js proxy: HTTP 200 after 60.261 seconds, with all three original outlines
independently validated. The proxy now allows 65 seconds rather than Next's
30-second default. This verifies transport support, not a 60-second Automatic
quality comparison.

Private reproducibility artifacts are in gitignored
`.implement-review/036a5df-auto-layout-portfolio/`: `portfolio-corpus.json`,
`measure-production-budgets.py`, `portfolio-timing-results.json`,
`portfolio-timing-analysis.json`, `timing-source-manifest.json` and
`production-source/` plus the anonymous `storage-fixture/`. Source hashes were
unchanged across measurement.
Raw-result SHA256: `1d91c125179020a4c643593123bc131da2689727487890f7482bfc6f1e3dacc1`.
With `STORAGE_PATH` pointing to the absolute private `storage-fixture` directory,
run the recorded backend in open development mode on 127.0.0.1:8012. From the
repository root, run
`backend/venv/bin/python .implement-review/036a5df-auto-layout-portfolio/measure-production-budgets.py`.
Original coordinates remain private; no geometry corpus is committed or uploaded.

## Historical prototype recommendation

**The prototype recommendation was a 1 mm raster/bitset primary candidate for the new auto-sizing modes, with exact validation against original outlines.** It handled the dense traces better than the then-current placer and used already-installed NumPy/OpenCV. It was not a universal quality winner or a hard-deadline production solver. The implemented default is now the Automatic portfolio measured above.

| Requested mode | Recommendation | Evidence and boundary |
|---|---|---|
| Fix X or Y; calculate the other supported dimension | Raster 1 mm plus budgeted supported-size feasibility evaluation | Verified dense case X=6 → Y=4.5 and Y=8 → X=3.5. Preserve the specified side. Failed searches do not certify impossibility. |
| Both sides are maximum limits; minimize the enclosing rectangle | Raster 1 mm for the quality-oriented implementation; coarse-to-fine angles for the smallest current-placer change | Dense-real bbox area fell about 20.2% at approximately baseline runtime with raster. Coarse-to-fine never lost to baseline in confirmation and needs no second collision engine. |
| Minimize connected enabled-cell count | Cell-aware placement is promising, but validate the mask-aware STL geometry before exposing this as a printable-bin optimizer | Cell counts below are conservative 2D proxies. Existing partial-cell cutting does not rebuild exposed walls/lips. |

Do **not** start with custom GA/memetic/beam search around the current decoder. On the 8-tool case, its first complete decode consumed the whole budget: GA/memetic performed no crossovers or local improvements. Small order search still helps small fixtures, but was not a reliable 5-second improvement on real traces.

PackingSolver with **ratio 0.05** was recommended as a secondary native engine, especially for fixed-height narrow-tool sizing. It was not the general prototype winner: it often produced larger rectangles/cell masks, required Python >=3.12, and its native objective did not directly minimize our constrained bbox or connected mask. A combined portfolio was **not** measured in that prototype matrix; it is measured separately in the production section above.

## Protocol and scope

There were **1,609 solver evaluations**:1,404 matrix runs plus 205 supplementary objective/strip calls. Implementations were isolated in scratch storage, with independent algorithm, methodology, empirical-data and adoption reviews.

| Stage | Matrix | Cooperative solve budget | Repetition |
|---|---|---:|---|
| Broad screen |18 variants ×8 cases ×4 objectives =576 |2 s |1, seed 1729 |
| Confirmation |12 selected variants ×5 cases ×4 objectives =720 |5 s |3 fresh processes, seeds 1729/1730/1731 |
| Native simplification sensitivity |3 settings of the **same** engine ×9 cases ×4 objectives =108 |2 s |1, seed 1729 |
| Actual supported dimensions |4 cases ×3 solvers;24 fixed-axis tracks,181 candidate calls, plus 24 rectangle/cell calls |15 s total per strip;15 s each direct rectangle/cell solve |1, seed 1729 |

- Host: Linux x64, AMD Ryzen 5 PRO4650U,6 cores/12 logical CPUs. Every formal run was serial with affinity CPU 11; numerical thread environment was 1. Native directional threads could still interleave on that one CPU. Shared desktop load and dynamic clocks were not controlled.
- Runtime: Python 3.12.12, Shapely 2.1.2, NumPy 2.5.2. No warm cross-request cache, cross-platform execution, HTTP/UI latency or production percentile claim.
- Same original outlines, IDs,2 mm pair clearance, absolute non-mirrored rotations and original-outline minimum-corner x/y convention. No scaling or replacing concave tools with hulls/rectangles. Independent geometry validation reconstructs the requested rigid transforms rather than trusting returned polygons.
- All returned metric-bearing results had zero invalid-transform/outline or pair-clearance violations. Partial/missing/outside tools remain visible and are excluded from complete-layout quality comparisons. This is not proof that every run fitted every tool.
- Solver preprocessing, incumbent seeding, conversions and its own validation were timed. Final independent validation/conversion and imports/startup/transport were separately recorded. On-time columns refer to the **solve call**, not end-to-end request latency. None of the quality-eligible on-time rows crossed its budget solely because of final independent validation.
- Budgets are cooperative. Uncancellable operations can overrun; fresh child-process bounds prevent indefinite hangs. External workers share the parent's original deadline, rather than receiving a fresh duration after import. Zero outer hard timeouts does not mean zero native internal timeouts.
- Rectangles enforce the supplied interior limits. Fixed-axis domains permit the free side to grow beyond the original other dimension, within supported bounds. Grid sizing uses 42 mm pitch,0.5-unit steps, minimum 1 unit, maximum 25 per axis and `ceil(X)*ceil(Y)<=100`. These fixtures use a 5.7 mm total default lip/wall inset deficit; custom bin parameters change capacities.

### Corpus

| Case | Tools / original vertices | Purpose |
|---|---:|---|
| order_loose |3 /14 |Order sensitivity;100×80 mm synthetic interior |
| order_tight |3 /14 |Same objects,80×60 mm synthetic interior; no rectangle success found |
| concave_interlock |3 /18 |Concavity/contact placements;3×2 nominal grid |
| angle_long |3 /12 |Three initially angled bars;3×2 grid |
| cell_L |3 /14 |Long L and two small parts;3×3 grid |
| real_narrow |4 /202 |Anonymized original narrow-tool outlines;5×6 grid |
| real_dense |3 /810 |Anonymized original dense outlines;6×8 grid |
| oversized |2 /8 |A 200×160 mm object in an 80×60 mm interior; impossible full fit |
| stress8 |8 /1,016 |All 7 existing real outlines plus a synthetic bar;10×8 grid |

Confirmation used angle_long, concave_interlock, real_narrow, real_dense and stress8. Stress8 adds no new real observations: the dataset contains only **seven unique real outlines**. The unsupported synthetic interior dimensions are geometry stress fixtures, not literal supported Gridfinity bins. Inputs have outer rings only, matching the current auto-layout route; hole-bearing tool input was not studied.

## Complete 2-second screen

Each objective column is **Q/D** out of 8: complete mode-eligible quality results / those also within the solve budget. For cells, eligibility means the 2D proxy, not manufacturability. Median is across supported returned calls, including partial/infeasible outcomes and heterogeneous cases; it is not a production latency percentile. Overruns/errors count all 32 attempts.

| Variant | Rectangle | Fixed X | Fixed Y | Connected cells | Median solve (s) | Overruns | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline5deg | 6/6 | 6/5 | 6/6 | 5/5 | 0.295 | 3 | 0 |
| baseline1deg | 6/4 | 6/4 | 6/4 | 5/3 | 1.224 | 10 | 0 |
| coarsefine | 6/5 | 6/5 | 6/5 | 5/4 | 0.644 | 6 | 0 |
| multistart | 6/4 | 7/5 | 7/5 | 5/3 | 1.713 | 12 | 0 |
| order_neighborhood | 6/4 | 7/5 | 7/5 | 5/3 | 1.652 | 12 | 0 |
| beam | 6/3 | 7/5 | 7/5 | 5/2 | 1.242 | 12 | 0 |
| compaction | 6/5 | 6/5 | 6/5 | 5/4 | 0.419 | 6 | 0 |
| sa | 6/4 | 7/5 | 7/5 | 5/3 | 1.723 | 12 | 0 |
| ga | 6/4 | 7/5 | 7/5 | 5/3 | 1.724 | 12 | 0 |
| memetic | 6/4 | 7/5 | 7/5 | 5/3 | 1.724 | 12 | 0 |
| nfp_concave | 4/4 | 4/4 | 5/5 | 3/3 | 0.131 | 8 | 0 |
| nfp_order_search | 4/4 | 5/5 | 5/5 | 3/3 | 0.552 | 8 | 0 |
| raster_1mm | 6/5 | 7/6 | 7/6 | 5/3 | 0.474 | 5 | 0 |
| raster_0_5mm | 6/4 | 7/6 | 7/6 | 5/3 | 0.803 | 6 | 0 |
| packingsolver_irregular | 4/4 | 4/4 | 4/4 | 3/3 | 1.390 | 10 | 0 |
| svgnest_orbital_source | 3/0 | 2/0 | 2/0 | 2/0 | 2.113 | 32 | 12 |
| svgnest_minkowski_source | 4/0 | 3/0 | 3/0 | 2/0 | 2.063 | 32 | 8 |
| libnest2d_convex_native | 1/1 | 0/0 | 1/1 | 1/1 | 0.035 | 0 | 24 |

The 44 errors are 24 explicit convex-only exclusions and 20 SVGnest no-incumbent failures (16 internal timeouts on real cases,4 orbital failures on the concave fixture). libnest2d's median covers only its 8 supported returned calls; it is not a comparable fast concave-tool result. SVGnest returned no complete on-time result in this adapted headless configuration. Native wrappers are pinned adaptations, not evidence about every upstream configuration.

## Repeated 5-second confirmation

Q/D is out of 15 per objective (5 cases ×3 repeats); overruns/errors are out of 60 per variant. Deterministic algorithms may ignore the supplied seed. `approx_001` means numeric ratio**0.01**, and `approx_005` means**0.05**, not 0.001/0.005 or new solver families.

| Variant | Rectangle | Fixed X | Fixed Y | Connected cells | Median solve (s) | Overruns | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline5deg | 15/12 | 15/12 | 15/12 | 15/12 | 0.723 | 12 | 0 |
| coarsefine | 15/12 | 15/12 | 15/12 | 15/12 | 1.675 | 12 | 0 |
| multistart | 15/6 | 15/6 | 15/6 | 15/6 | 5.132 | 36 | 0 |
| order_neighborhood | 15/6 | 15/6 | 15/6 | 15/6 | 5.447 | 36 | 0 |
| ga | 15/6 | 15/6 | 15/6 | 15/6 | 5.241 | 36 | 0 |
| memetic | 15/6 | 15/6 | 15/6 | 15/6 | 5.257 | 36 | 0 |
| nfp_order_search | 9/6 | 9/6 | 9/6 | 9/6 | 5.000 | 36 | 0 |
| raster_1mm | 15/12 | 15/12 | 15/12 | 15/11 | 1.112 | 13 | 0 |
| raster_0_5mm | 12/11 | 12/12 | 12/10 | 12/7 | 2.124 | 20 | 0 |
| packingsolver_irregular | 6/6 | 6/6 | 6/6 | 6/6 | 5.214 | 36 | 0 |
| packingsolver_irregular_approx_001 | 9/9 | 9/9 | 9/9 | 9/9 | 3.111 | 24 | 0 |
| packingsolver_irregular_approx_005 | 15/13 | 15/9 | 15/9 | 15/12 | 1.710 | 17 | 0 |

624/720 runs produced complete mode-eligible layouts; 406 also met the solve deadline.314 calls overran 5 s. No solver errors or outer hard timeouts occurred; some native workers recorded internal hard timeouts and returned incomplete outcomes.

### Representative paired objective values

- **Dense-real rectangle:** baseline 47,881 mm² at 1.872 s median; coarse-to-fine 40,444 mm² at 3.593 s; raster 1 mm 38,223 mm² at 1.916 s; native ratio 0.05 about 42,163 mm² at 2.870 s. Raster's reduction versus baseline is **20.2%**, with 3/3 complete on-time rectangle runs.
- **Angle-sensitive rectangle:** coarse-to-fine and native ratio 0.05 reached about 4,144 mm² versus baseline 5,037 mm² (**17.7% smaller**). Raster 1 mm produced 6,083 mm²: its 15-degree proposal set is not fine angular optimization. Finer angles therefore have a real, fixture-specific payoff.
- **Order-sensitive loose fixture,2-second screen:** multi-start reduced 6,320 to 4,836 mm² (**23.5%**) and completed in 1.66 s. This did not generalize to a strict-budget win on the real or 8-tool cases.
- **Resolution tradeoff:**0.5 mm raster reached 37,645 mm² on dense-real rectangles, but 2/3 were on time and the 8-tool cases never returned all tools. Its finer pixel area costs roughly 4×; it is not an automatic upgrade over 1 mm.
- **Eight tools:** current-placer variants fitted all 8 but took roughly 6–8 s. Raster 1 mm fitted all 8 in 12/12 mode/repeat runs at roughly 5.004–5.012 s, **none strictly on time**. Native ratio 0.05 also fitted 8 in 12/12, with only 1/12 strictly on time; its rectangle bbox was larger. No tested method established a reliable hard 5-second solution for all modes.

Across 15 paired rows, raster 1 mm won/tied/lost versus baseline: rectangle 11/0/4, fixed-X 12/3/0, fixed-Y 15/0/0, cells-proxy 12/3/0. Coarse-to-fine's rectangle comparison was 9 wins/6 ties/no losses. These compare validated objective values, not the raw stored containment-first score. Small sample sizes and repeated reused geometry preclude a universal/significance claim.

## Actual supported fixed-axis sizing

A single large-domain placement's bbox is **not** a strip minimum. Each candidate below was solved and validated in the actual supported interior, preserving the specified side. Every strip shared 15 s of charged work across its ascending candidates; imports/startup were outside that charge but inside a 25 s whole-strip bound. Equal small allocations are a limitation, particularly for a native engine needing startup/preprocessing.

Each entry is free Y when X is fixed / free X when Y is fixed, in nominal Gridfinity units. Fixed X/Y respectively: angle 3/2, concave 3/2, narrow 5/6, dense 6/8.

| Case; fixed X/Y | Current 5° free Y / free X | Raster 1 mm free Y / free X | Native ratio 0.05 free Y / free X |
|---|---:|---:|---:|
| angle_long | 1.5 / 3.0 | 1.5 / 3.0 | 1.5 / 3.0 |
| concave_interlock | 1.5 / 2.5 | 1.5 / 2.5 | 1.5 / 2.0 |
| real_narrow | 2.0 / 2.0 | 2.0 / 2.0 | 2.0 / 1.5 |
| real_dense | not found / not found | 4.5 / 3.5 | not found / not found |

These are **smallest evaluated feasible**, not certified minima.20 of 24 tracks found a complete feasible strip;181 candidates were attempted.17 candidates were unvisited, all in baseline dense tracks. Five tracks exceeded the shared budget: baseline dense X/Y by 2.078/3.075 s, raster dense Y by 0.007 s, native dense X/Y by 0.451/0.624 s. No candidate errors, hard timeouts, unsupported fixed sides, invalid geometry or clearance violations occurred.

The native narrow fixed-Y track found 1.5 rather than raster's 2.0, but charged about 13.8 s across candidates versus about 1.98 s for raster. It is a useful secondary option, not a general runtime win. Baseline/native dense `not found` is a **search/budget outcome**, not impossibility.

For angle_long, baseline's large-domain outputs suggested free Y=3 and free X=8; solving actual constrained strips found 1.5 and 3. Do not present the former bbox trim as the minimum. Preserve a validated incumbent, avoid mandatory expensive baseline-first passes, and never binary-search/prune based on an uncertified heuristic failure.

## Connected-cell results and physical limitation

The scorer covers original tools plus a 2.85 mm exposed-boundary support envelope, tries at most 9 grid phases, adds greedy 4-neighbor connectors and fills enclosed holes. Those added cells count toward the objective. This study uses full 42 mm cells and zero additional pocket allowance; it does not optimize half-cell masks or certify a minimum Steiner connection.

- Concave fixture: baseline 6 cells, raster 5, NFP/order 4; the latter completed in about 1.69 s median in confirmation.
- Narrow-real: baseline 11, raster 9; raster was on time 3/3. GA found 8 but exceeded 5 s in all 3 runs.
- Dense-real: baseline 28, raster 24–25 with 2/3 on time. Finer raster found 23–24 but exceeded 5 s in all 3 runs.
- 8-tool case: baseline 36, raster 32, native 41–42; none was strictly on time for cells.
- L fixture: baseline postprocessing already gives 5 cells versus its 3×3 enclosing rectangle's 9. That saving does not require a new global-search algorithm.

**No scored mask is a generated-bin proof.** The current [partial-bin generator](stl-generation.md#partial-bins) removes disabled cells from a rectangular shell; it does not rebuild perimeter walls/lips on newly exposed edges. `_interior_clip_rect` remains rectangular. Connect-base retains the original rectangular footprint, so it does not meet this objective. Rounded boundaries, pocket allowances/finger holes/depth, seating, walls/lips and actual 3D connectivity must be validated against generated geometry before calling this a printable minimum-cell bin. “Proxy valid” is deliberately not “manufactured geometry verified.”

## External-engine adoption

| Engine | Decision |
|---|---|
| PackingSolver 0.1.1056 | Serious conditional alternative in the prototype. Ratio 0.05 made 60/60 confirmation results complete-valid, versus 24/60 exact and 36/60 ratio 0.01; only 43/60 ratio 0.05 were on time. MIT; binding requires Python >=3.12, versus README's then-current 3.11+ minimum. Production now pins this package and requires 3.12. PyPI lists Linux x64/arm64,macOS x64/arm64,Windows 32/x64 wheels; only local Linux x64 executed. |
| SVGnest orbital/Minkowski | Not an interactive default from these results. Real upstream GA/NFP/placement ran through adapted headless transport and common objective fitness. Source adaptation plus atomic NFP calls and no on-time complete screen result are substantial costs. MIT with bundled third-party notices. This is not a claim that every untouched upstream release fails. |
| libnest2d | Reject as a direct traced-concave-tool backend: explicitly convex-only,24/32 screen attempts unsupported. LGPL-3.0 with Clipper/NLopt/Boost distribution obligations. The native adapter executed real NFP/selection work on admissible inputs, not hull substitutions. |
| Project concave NFP prototype | Good on small concave fixtures, not dense/general coverage. Uses constrained triangulation available in Shapely >=2.1; current requirements allow 2.0.7. Its real-outline preparation/search losses need resolution before adoption. |

PackingSolver ratios are **aggregate copy-weighted area simplification budgets**, not per-tool percentages, millimetre tolerances or Hausdorff bounds. Final original-outline validation was unchanged. Knapsack used one bin and unit profits, not default area profits. Fixed modes used native open-dimension X/Y plus bounded knapsack fallback; rectangle/cell modes reranked emitted incumbents, but their requested minimum bbox/mask is not a native objective. The library can stop exploring equally full but more compact layouts; do not generalize this adapter to all native objectives.

The 2-second paired sensitivity control also matters: among 36 attempts per setting, exact yielded 15 complete-valid/15 on-time, ratio 0.01 yielded 19/17, ratio 0.05 yielded 21/19. Approximation improved dense preparation/coverage, but did not establish a 2-second full 8-tool solution across all modes.

## Ranking audit and reproducibility

The measured prototype ordered raw outside area before sizing quality even when geometry was already accepted within tolerance.46/624 eligible confirmation rows had positive leakage below 1e-8 mm² (maximum 9.18e-12). This changed 7/60 raw-score group winners, all on angle_long. In the supplementary selection, a 4144 mm²native layout lost to 5037 mm²baseline because of about 2.9e-13 mm²floating leakage.

**This report compares objective values only after complete feasibility filtering, and does not use those stored selections or mean-rank claims.** The private shared scorer was subsequently corrected to zero that score component for accepted feasible layouts, preserving raw diagnostics and the unchanged validator. An actual-geometry regression failed before/passed after; recorded angle solver layouts then selected the 4144 mm²native result in both rectangle and tied-cell/bbox scoring. No comparative run or result JSON was rewritten after this correction, and its smoke timings are excluded. Future runs of the corrected helper can select different incumbents.

Private anonymized geometry is not committed or uploaded. Reproducibility archives live in gitignored `.implement-review/036a5df-packing-benchmark/`:

- `screen-benchmark.tar.gz`: original screen sources/results before approximation variants.
- `measured-benchmark.tar.gz`: all frozen measured results and subsequent sources **before** the post-run ranking correction, pinned external setup/helpers and production-placer snapshot. SHA256 `d2507769948ead44e5099667e568d57e74637e50924b7966b3103df38d797c1b`.
- `ranking-fix.tar.gz`: corrected private common helper with runnable geometry regression. SHA256 `038c61dff702f1c267f2b404dafff8af81913946417251b160e67fd37d820c95`.
- `ledger.md`: source/finding dispositions. Vendored builds/venvs are not archived; pinned setup and native/source hashes are recorded.

Result checksums:

| File | SHA256 |
|---|---|
| screen.json |55ec10accebc75b38b6f91e8f7c698a8939cd54a6b7017529074712a94925013 |
| confirmation.json |ac09d57988d4bfa103ecc638b165e324d753fac7c551eb22da81456292d583b8 |
| native-sensitivity.json |642fc64230fdc756e7c8f8c1a20f7b6d374652d173903f464e052fcd3ce0ee89 |
| objectives-verification.json |bf32429a3968f336ab3ce8065971a9a9fb757de80c8eecb33fb8f175fe44451e |

The shared runner exposes `--modules`, `--solver`, `--cases`, `--objectives`, `--budget`, `--repeats`, `--seed`, `--corpus` and `--output`. The supplied artifacts retain exact commands/manifests. Run stages serially withCPU 11 affinity and thread variables 1, use the recorded interpreter/dependencies and matching snapshots, and do not mix smoke outputs into performance tables. The strip driver has `--solvers`, `--cases`, `--seeds`, `--budget`, `--timeout-slack`; its budget is shared per strip, not per candidate.

### Primary implementation references

- [OpenCV shifted template correlation](https://docs.opencv.org/4.x/df/dfb/group__imgproc__object.html), [NumPy bit packing](https://numpy.org/doc/stable/reference/generated/numpy.packbits.html), [Shapely buffer approximation](https://shapely.readthedocs.io/en/stable/reference/shapely.buffer.html).
- [PackingSolver pinned 0.1.1056 package metadata](https://pypi.org/pypi/packingsolver/0.1.1056/json) and [benchmarked source revision](https://github.com/fontanf/packingsolver/tree/94020d1f5d0d3166464b0bad673885f887e930b7).
- [SVGnest source revision](https://github.com/Jack000/SVGnest/tree/1248dc21efd3f90d1aa52ba5785e27e5217ed2c9), [libnest2d source revision](https://github.com/tamasmeszaros/libnest2d/tree/663daa69e1d7478669f714218e27681edbc96640).
- [Initial research and papers](auto-layout-research.md#primary-sources), [repository geometry guidance](stl-generation.md), [gotchas](gotchas.md).
