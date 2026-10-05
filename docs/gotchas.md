# Gotchas

Hard-won lessons. Read before making changes to coordinate mapping, 3D preview, or Docker.

## Y-axis inversion

SVG/layout/bin-space is Y-down (0 = top edge). Manifold3d is Y-up. Always negate Y when mapping: `-(y + offset_y)`.

- Flipping Y reverses polygon winding -- remove any `reversed()` calls if adding a Y-flip
- Text labels use a flipped Plane (z_dir down) so they negate Y separately
- BinPreview3D.tsx: rotation `[-PI/2, 0, 0]` converts Z-up to Y-up. Do NOT add `scale [1, -1, 1]` -- that was a compensating hack for un-flipped Y
- All three must match: layout editor, 3D preview, downloaded STL in slicer

## Cutout pipeline order

Smoothing/simplification runs BEFORE clearance (`prepare_for_generation`). Smoothing must cover the complete traced tool, including its sharp tips and the material around interior islands: inward rounding once left a wire stripper jaw resting on a printed ledge. Unioning the raw trace back into the smoothed contour fixed that fit problem but also restored every convex pixel stair-step, producing jagged pocket walls. The current pipeline simplifies with an absolute millimetre tolerance, adds support points 2mm from corners to preserve long straight segments, applies Chaikin subdivision, and cleans curve chords at 0.005mm. It then finds the smallest outward round buffer that covers the entire traced region, to a 0.005mm search bound. This conservative fit envelope can move straight edges outward, but they remain straight and parallel; interior islands can shrink, never grow into the tool. Requested clearance is added only after that envelope and is not consumed by smoothing.

The backend is authoritative for smoothed geometry. Tool and bin editors request zero-clearance contours from `POST /api/tools/preview-outline` and paint the returned outer/interior rings with the SVG `evenodd` fill rule. SVG downloads and STL generation use the same `PolygonScaler.smooth` implementation; there is no second frontend smoothing algorithm. While a request is pending or fails, the editor explicitly labels its traced-outline fallback and never presents stale geometry as the current smooth preview. Any physical pipeline change invalidates cached geometry: bump `STL_GEOMETRY_VERSION` in `stl_generator_manifold.py`.

## EXIF orientation

cv2 ignores EXIF orientation, browsers apply it. `ingest_image` bakes orientation into the pixels at upload -- without it, corner coordinates from the UI land in a different frame than the backend warps. All image ingest (upload, corrected downscale, mask upload) must go through it.

## Three.js memory leaks

Every `BufferGeometry` and `EdgesGeometry` must be `.dispose()`d on React unmount. STL regeneration creates new geometries each time -- if the old ones aren't disposed, the browser will OOM. Same applies to `Image` objects created in useEffect (use a `cancelled` flag in cleanup).

## Docker

Single container runs both frontend and backend via supervisor. Key details:

- CORS origins in `backend/.env` override the Python defaults -- if you change the frontend port, update `.env` too
- `NEXT_TELEMETRY_DISABLED=1` is set in the Dockerfile build stage
- `.dockerignore` excludes `docs/`, `node_modules/`, `venv/`, `storage/`, `.claude/`
- Container runs as non-root user `tracefinity` (UID 1000) by default. Supports `--user "$(id -u):$(id -g)"` for arbitrary UIDs. Runtime-writable dirs (`/app/storage`, `/app/.u2net`, `/app/.next`, `/tmp/nginx`, `/tmp/supervisor`, `/var/lib/nginx`) are world-writable. `U2NET_HOME` and `HOME` are set to `/app` paths so model downloads and nginx/supervisor state work without root.

## Manifold3d boolean performance

The generator batches polygon cutters before subtracting them from the bin. Keep
that batching: performing a separate mesh boolean for every cutout is much
slower. Manifold3d replaced the original build123d/OCCT generator because its
mesh booleans were measured at 10-100x faster for this workload. See
[stl-generation.md](stl-generation.md) for the current pipeline.

## Frontend patterns

- Shared constants (`DISPLAY_SCALE`, `SNAP_GRID`, `GRID_UNIT`, etc.) live in `lib/constants.ts`
- `DISPLAY_SCALE = 8` converts mm to SVG units in the bin editor
- Config is spread into the API request body: `{ ...config, polygons }` in `generateStl`
- Text labels live on BinConfig (not Polygon) since they're free-placed
- PolygonEditor uses refs (`polygonsRef`, `onPolygonsChangeRef`) to avoid stale closures during drag -- do not add `polygons` or `onPolygonsChange` to the `handleMouseMove` dependency array
- Auto-save uses the `useDebouncedSave` hook (debounce + `beforeunload` flush). Pass `skipInitial: true` to avoid saving on first load.
- Undo/redo uses the `useHistory` hook (deep-clone, Cmd+Z handling). The `set()` method pushes to history; `undo()`/`redo()` call the `onChange` callback.
- ToolEditor and BinEditor are split into orchestrator + toolbar + canvas sub-components. `CutoutOverlay` renders finger holes in both.

## Bin placements and auto-arrange

- `PlacedTool.points` are rigid copies of the library outline: rotated by `PlacedTool.rotation` (absolute, relative to the library outline) about the outline centroid, then translated. `sync_placed_tools` rebuilds them on every read, so anything that moves a tool must update `rotation` and the points together.
- Auto-layout placements report `x`/`y` as the **minimum corner** of the placed outline; the bin editor rotates the tool and shifts its min corner to that position. Reporting the translation offset instead shifts every tool by its own rotated bounds and the packed layout falls apart.
- Packing runs inside the request handler: keep CPU-bound endpoints off the event loop (declare `def` so FastAPI uses its threadpool, or wrap in `asyncio.to_thread`). A blocked loop does not fail cleanly — the dev proxy dies with `socket hang up`/ECONNRESET and the feature looks broken rather than slow.
- Threadpool execution keeps the event loop responsive but does not prevent proxy timeouts. Auto-layout must discard candidates whose best possible score cannot beat an existing placement **before** translating or clipping polygons. Seed refinement with the screened contact placement; keep outside-area scoring for overflow layouts when no inside placement exists.

## AVX / ONNX requirement

U2-Net paper detection and all local tracers (`isnet`, `birefnet-lite`, `inspyrenet`) require ONNX Runtime, which needs AVX CPU instructions. On non-AVX CPUs (some older VMs, Atoms), ONNX is disabled at startup and paper detection falls back to OpenCV-only brightness thresholding -- less accurate, may need manual corner adjustment. Local tracers won't load; use a remote tracer (`gemini`, `replicate`, `fal`).

Detection is two-tier: CPU flag check (`/proc/cpuinfo` on Linux, `sysctl` on macOS), then a subprocess probe that catches SIGILL without killing the main process. Result is cached for the process lifetime.

## Paper corner detection

Uses a two-stage approach: U2-Net Portable generates a rough tool mask (~0.17s), tool pixels are blacked out, then OpenCV brightness thresholding finds the paper rectangle in the cleaned image. This prevents tools (especially dark ones on white paper) from fragmenting the paper region during detection.

The brightness detection first excludes saturated pixels (HSV saturation >45), then opens the remaining grayscale image with a kernel 3% of the short image dimension. This keeps bright wood out and disconnects thin silver tools crossing a sheet edge before gap-closing can incorporate them into the paper rectangle. It tries multiple brightness thresholds (200, 190, 180), picks the largest valid candidate, and validates against aspect ratio (0.55-0.85, covering A-series, Letter, and Tabloid) and fill ratio (>35% of the bounding rectangle is bright). A convex hull merge step handles cases where the paper is split into fragments. If no candidate survives, the existing edge-based strategies still run on the original image.

Difficult cases: hands in the frame, sticks/rods crossing the paper, very heavy tool overflow with minimal visible paper. These may need manual corner adjustment.

On a bright sheet against a dark background U2-Net returns the sheet, not the tool. A mask over `TOOL_MASK_MAX_FRACTION` of the frame is ignored, and a masked miss retries unmasked; before that the upload came back with no corners at all (#213).

## Saliency crop

Local and remote saliency tracers run on the paper rect from `_detect_paper_rect`, not the full corrected image, because on the full image the bright sheet is the salient object. Two traps follow. A tool crossing the sheet splits the bright region, so fragments that line up with the sheet across a tool-sized gap are merged before cropping. A tool overhanging the sheet is outside the crop, so the crop grows on any side the mask touches and runs again; without that the mask is cut flat at the paper edge (#212). Gemini does not crop.

## Gemini mask quirks

- Masks come back at different dimensions AND aspect ratio than requested. `_trace_mask()` resizes with `INTER_NEAREST`, then `_align_mask()` uses template matching to correct the positional offset.
- `_align_mask()` extracts the tool region from the resized mask, searches for it in the inverted corrected image via `cv2.matchTemplate(TM_CCOEFF_NORMED)`, and applies a translation. Runs at 0.25x resolution (~20ms). Skipped if score < 0.15 or shift > 10% of image dimension.
- `_trace_mask()` handles both alpha-channel PNGs (tool=opaque, bg=transparent) and RGB PNGs (tool=black, bg=white).
- The prompt asks for a "stencil" -- flat black shapes on flat white. This works better than asking for a "mask" with `gemini-2.5-flash-image`.

## Toolbox vertical datums

Physical planning uses `bin_vertical_geometry` and `assess_printed_bin` beside the manifold generator.
Never derive fit by summing nominal height units or STL bounding-box heights.
Standalone exterior height includes the lip and enabled raised rim; assembled
stack increments account for mating overlap. An intact floor stops the upper base
at the floor datum; broad pockets can let it descend to the pocket edge or mating
collar instead. Every raised collar, half-grid base and rotated interface is resolved
against the actual generated solids, including embossed labels, in memory without
exporting files. A nominal taper offset is not the sampled geometry's contact datum.
Generated-surface tests independently check contact and pocket/insert resting
surfaces, rather than copying preview arithmetic.
Cutters must leave the protected mating lip/collar intact. Tool outlines must fit
the clipped printed pocket and clear the solid at its floor; otherwise seating,
resting elevation and tool-to-ceiling clearance are not claimed.

Per-cutout depth overrides precede the global depth; insert allowance is added
before physical clamping. The tool rests on the resulting floor **plus the
printed insert thickness**, including shallow bins whose insert allowance was
clamped. Scanned outline envelopes are conservative, not tool reconstruction.

Support references are placement IDs local to one drawer plan. Root transforms
carry the stack; missing supports and cycles must fail before replacing saved
work. Floor occupancy is the root-footprint union, never summed stacked members.
Fit assessments and preview revision keys are derived, never durable caches.
Refresh current shared tool/bin data before assessing or generating; pending or
failed STL loading must remain explicitly distinct from verified geometry.

## Automatic cutout depths

`BinConfig.cutout_depth_mode` is `"automatic"`, `"uniform"`, or `null`, and the
three are not interchangeable. `null` is a record written before the field
existed: it must keep honouring a stored `PlacedTool.depth_override`, so an
absent mode must never be normalised to `"uniform"` on load — uniform
deliberately ignores custom depths (they are kept, not lost). `pocket_depths.py`
resolves each placement's depth for both export and planning; do not recompute
it separately, and never persist a derived depth into `PlacedTool.depth_override`
or a later mode switch turns it into a manual override.

Automatic depths use the mating increment from `assess_printed_bin`, not
`wall_top + rim * 7`. A raised rim changes the increment by less than a full
unit (the upper base settles on the collar), so nominal arithmetic over-cuts by
millimetres. `cutout_depth` remains the fallback for a tool with no
`Tool.thickness_mm`; that fallback is unverified, so the assessment stays
`uncertain` and no stacking clearance is claimed for it.
