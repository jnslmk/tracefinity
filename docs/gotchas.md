# Gotchas

Hard-won lessons. Read before making changes to coordinate mapping, 3D preview, or Docker.

## Y-axis inversion

SVG/layout/bin-space is Y-down (0 = top edge). Manifold3d is Y-up. Always negate Y when mapping: `-(y + offset_y)`.

- Flipping Y reverses polygon winding -- remove any `reversed()` calls if adding a Y-flip
- Text labels use a flipped Plane (z_dir down) so they negate Y separately
- BinPreview3D.tsx: rotation `[-PI/2, 0, 0]` converts Z-up to Y-up. Do NOT add `scale [1, -1, 1]` -- that was a compensating hack for un-flipped Y
- All three must match: layout editor, 3D preview, downloaded STL in slicer

## Cutout pipeline order

Smoothing/simplification runs BEFORE clearance (`prepare_for_generation`), never after -- vertex reduction erodes the outline by up to its tolerance and must not eat the clearance. The printed pocket is the previewed shape grown by exactly the clearance. The smoothing epsilon is absolute mm (`smooth_epsilon`), duplicated in `lib/svg.ts smoothEpsilon`. After simplification, both pipelines add support points 2mm from each corner before Chaikin subdivision so corner influence cannot bow long edges. Keep the epsilon and Chaikin corner span in lockstep between backend and frontend or preview and print diverge.

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

## AVX / ONNX requirement

U2-Net paper detection and all local tracers (`isnet`, `birefnet-lite`, `inspyrenet`) require ONNX Runtime, which needs AVX CPU instructions. On non-AVX CPUs (some older VMs, Atoms), ONNX is disabled at startup and paper detection falls back to OpenCV-only brightness thresholding -- less accurate, may need manual corner adjustment. Local tracers won't load; use a remote tracer (`gemini`, `replicate`, `fal`).

Detection is two-tier: CPU flag check (`/proc/cpuinfo` on Linux, `sysctl` on macOS), then a subprocess probe that catches SIGILL without killing the main process. Result is cached for the process lifetime.

## Paper corner detection

Uses a two-stage approach: U2-Net Portable generates a rough tool mask (~0.17s), tool pixels are blacked out, then OpenCV brightness thresholding finds the paper rectangle in the cleaned image. This prevents tools (especially dark ones on white paper) from fragmenting the paper region during detection.

The brightness detection tries multiple thresholds (200, 190, 180), picks the largest valid candidate, and validates against aspect ratio (0.55-0.85, covering A-series, Letter, and Tabloid) and fill ratio (>35% of the bounding rectangle is bright). A convex hull merge step handles cases where the paper is split into fragments.

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
