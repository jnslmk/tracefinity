# API Endpoints

## Authentication

Identity depends on `AUTH_MODE` (see [auth.md](auth.md)). In `native` mode
(default), the `tracefinity_auth` cookie authenticates API and `/storage`
requests; unauthenticated requests receive `401`. In `proxy` mode a trusted
reverse proxy sets `X-User-Id` with the matching `X-Proxy-Secret`; requests
without the header receive `401`. In `open` mode requests fall back to the
`default` namespace. Requests carrying `X-User-Id` when it is not trusted
receive `403 Forbidden`.

### Auth endpoints (native mode)

- `GET /api/auth/status` - `{mode, setup_required, authenticated}`; available in every mode
- `POST /api/auth/setup` - create the first administrator; `409` once setup is done
- `POST /api/auth/login` - password login; 2FA accounts get `{pending: true, pending_token}` instead of a cookie
- `POST /api/auth/login/2fa` - redeem a pending token with a TOTP or backup code
- `POST /api/auth/logout` - revoke the auth token and clear the cookie
- `GET /api/auth/me` - the authenticated account
- `POST /api/auth/password` - self-service password change (requires the current password)
- `POST /api/auth/2fa/enroll` - start TOTP enrolment; returns the secret and otpauth URI
- `POST /api/auth/2fa/confirm` - confirm with a first valid code; enables 2FA and returns backup codes
- `POST /api/auth/2fa/backup-codes` - regenerate backup codes (password + current code)
- `POST /api/auth/2fa/disable` - disable 2FA (password + current code)

Two-step login errors carry a machine-readable code so a client can tell them
apart without matching on wording: `detail` is
`{"code": ..., "message": ...}` instead of a plain string.
`pending_login_invalid` means the pending token is spent and the login must
restart; `two_factor_code_invalid` means only the code was wrong and the
pending token is still good.

### Admin endpoints (native mode)

- `GET /api/admin/users` - list accounts
- `POST /api/admin/users` - create an account; supports credential import (see [auth.md](auth.md))
- `POST /api/admin/users/{id}/disable` - disable and revoke the account's tokens immediately
- `POST /api/admin/users/{id}/enable` - re-enable
- `POST /api/admin/users/{id}/reset-password` - set a new password, revoking tokens
- `POST /api/admin/users/{id}/clear-2fa` - recovery for a lost authenticator; administrator session only
- `GET /api/admin/tokens` - list administrator API tokens; administrator session only
- `POST /api/admin/tokens` - issue one, returning the raw value once; administrator session only
- `DELETE /api/admin/tokens/{id}` - revoke one; administrator session only

Administrator API tokens authenticate the user-management endpoints above with
`Authorization: Bearer <token>`, without a password or second factor. They do
not reach `clear-2fa`, the token endpoints themselves, `storage-stats`, or
anything outside `/api/admin/users`.

Within those endpoints a token cannot create an administrator (`is_admin: true`
is `403`) or write to an account that is one, so create, disable, enable and
reset-password apply to ordinary accounts only. Listing is unrestricted. An
administrator session keeps all of it. See [auth.md](auth.md).

## Sessions (trace workflow)
- `POST /api/upload` - upload image, auto-detect corners
- `POST /api/sessions/{id}/corners` - set corners, apply perspective correction; returns `CornersResponse` with scale, capture-frame metadata and advisory photo warnings (camera too close, paper cut off, extreme perspective)
- `POST /api/sessions/{id}/trace` - AI trace tool outlines
- `POST /api/sessions/{id}/trace-mask` - trace from uploaded mask
- `PUT /api/sessions/{id}/polygons` - save polygon edits
- `POST /api/sessions/{id}/generate` - generate STL/3MF from traced polygons
- `POST /api/sessions/{id}/save-tools` - convert traced polygons to library tools
- `GET /api/sessions` - list sessions
- `GET /api/sessions/{id}` - get session state
- `PATCH /api/sessions/{id}` - update session metadata
- `DELETE /api/sessions/{id}` - delete session

Trace and mask-trace responses include the final visible `Polygon.label` values for the trace result. When `TOOL_LABEL_PROVIDER=ollama`, the backend attempts optional naming before persisting the session; naming failures keep the generic `tool N` labels.

### Capture-frame metadata

`CornersResponse` includes `corrected_image_url`, `scale_factor` (millimetres
per corrected-image pixel), `warnings`, optional `station`, and nullable
`capture_frame`. The same `CaptureFrame` is persisted as `Session.capture_frame`
and returned by `GET /api/sessions/{id}`. It defaults to `null` for old sessions
or captures not yet corrected; TypeScript clients allow an omitted or null field.
Use the corner response's current scale and mapping, not stale session values.

`CaptureFrame` fields:

| Field | Meaning |
|-|-|
| `source_width`, `source_height` | Integer dimensions of the ingested upright/cropped original, in source pixels |
| `corrected_to_source` | Finite 3×3 float matrix mapping final corrected-image pixels to source-frame pixels; apply to `[x, y, 1]` and divide by the resulting third coordinate |
| `optical_center` | `Point` (`{x, y}`): estimated pre-crop frame center expressed in source pixels, not calibrated lens intrinsics |
| `full_frame_width`, `full_frame_height` | Float pre-crop full-frame spans in the same source-pixel units |

For ordinary uploads, full-frame spans equal source dimensions and the estimated
center is their midpoint. For an explicit normalized `capture_crop` rectangle
`{x, y, width, height}`, the center is
`((0.5-x)/width*source_width, (0.5-y)/height*source_height)` and the full-frame
spans are `source_width/width` and `source_height/height`. Crop edges can still
clip tools. The mapping includes the actual perspective warp, full-frame offsets
and final per-axis resize; it is retained before original deletion.

The trace editor derives per-tool advice from current outlines and this metadata,
not a new endpoint or stored accuracy verdict. It flags proximity to source edges
as potential clipping and the outer 15% of either full-frame axis as a positional
heuristic for thick/raised tools. Missing metadata means advice is unavailable;
neither these flags nor their absence certify accuracy, known tool heights or fit.
See the [photo guide](usage/uploading-photos.md) for capture recommendations and
the separate EXIF distance check's limitations.

## Tools (library)
- `GET /api/tools` - list tools
- `GET /api/tools/{id}` - get tool
- `PUT /api/tools/{id}` - update tool (name, points, finger_holes, nullable `thickness_mm`)
- `POST /api/tools/{id}/auto-rotate` - compute optimal rotation angle (degrees) to minimise bounding box
- `DELETE /api/tools/{id}` - delete tool

`POST /api/tools/preview-outline` accepts an array of outline objects:
`{id, label, points, interior_rings?, smoothed?, smooth_level?}`. Coordinates are
millimetres. It returns the corresponding polygon objects with the actual
zero-clearance smoothed/simplified points and interior rings, without changing
stored tools. Defaults are `smoothed: true` and `smooth_level: 0.5`; levels must
be finite and between 0 and 1. The batch is limited to 100 outlines and 100,000
total vertices, and each ring requires at least three finite points. It uses
the normal authentication rules and shares the SVG/STL preparation pipeline.

## Bins
- `GET /api/bins` - list bins
- `GET /api/bins/{id}` - get bin (syncs placed tools with library versions)
- `POST /api/bins` - create bin (optionally with tool_ids for auto-sizing and bin_config defaults)
- `POST /api/bins/import` - upload an existing STL bin as a read-only planning bin (multipart `file`, optional `name`, `project_id`)
- `POST /api/bins/auto-layout` - arrange requested tools without creating a bin
- `PUT /api/bins/{id}` - update bin
- `DELETE /api/bins/{id}` - delete bin + output files
- `POST /api/bins/{id}/generate` - generate STL/3MF from bin

- `GET /api/bins/{id}/height-planning?safety_clearance_mm=0` - current loaded-bin assessment and inspectable deeper-pocket / raised-rim alternatives
- `POST /api/bins/{id}/height-planning?safety_clearance_mm=0` - assess an unsaved `BinUpdateRequest` draft without persisting it

### Cutout depth modes

`BinConfig.cutout_depth_mode` selects how each placed tool's pocket depth is
resolved. It is `"automatic"`, `"uniform"`, or `null` for a record written
before the field existed.

- `"automatic"` (default for new bins): each placement derives the shallowest
  supported pocket depth that leaves `stacking_clearance_mm` between the tool's
  top and the underside of the bin stacked above it. The depth follows the
  measured `Tool.thickness_mm` and the authoritative generated mating increment
  — not nominal lip arithmetic — so rim height, half-grid bases, insert
  allowance and real mating drop are all accounted for. Derived depths are
  recomputed on every assessment and generation; they are never written back as
  manual overrides. A tool with no `thickness_mm` falls back to the configured
  `cutout_depth` and stays explicitly unverified (assessment `uncertain`).
- `"uniform"`: `cutout_depth` is applied to every tool. Stored per-placement
  `depth_override` values are kept but ignored while the mode is uniform.
- `null` (pre-feature records): a stored `depth_override` is honoured, otherwise
  `cutout_depth` applies — exactly the behaviour before this field existed. The
  editor shows this as the "Existing per-tool depths" option only while the bin
  still stores no mode. It is a compatibility state, not a third mode: choosing
  Automatic or Uniform applies immediately and Undo (editor history, which
  snapshots the bin config) restores the previous choice.

`PlacedTool.depth_mode` is `"custom"`, `"automatic"`, or `null`. A `"custom"`
placement keeps its `depth_override`; `"automatic"` derives the depth. `null`
keeps a stored override and otherwise follows the bin's automatic depth.
`stacking_clearance_mm` accepts 0-10mm (finite); `cutout_depth_mode` and
`depth_mode` reject unknown values (422).

The height-planning assessment reports each envelope's calculated
`effective_depth_mm` and remaining `clearance_mm`, plus violations
`automatic_depth_unsupported` (the protected floor cannot seat the tool with the
configured clearance) and `custom_depth_too_shallow` (a custom override is
shallower than the derived requirement).

Auto-layout accepts `{tool_ids, placement_ids?, clearance, bin_config?, auto_width?, fixed_placements?, algorithm?, time_budget_seconds?}` and returns
`{placements, bounds, efficiency, unfitted_tool_ids, unfitted_placement_ids, grid_x}`.
`tool_ids` defaults to `[]`; `placement_ids` and `bin_config` default to `null`.
Placement `x`/`y` is the minimum corner of the final rotated original outline in
**bin coordinates**, in millimetres. With `bin_config`,
`unfitted_tool_ids` contains requested library tool IDs not placed or whose final
outlines extend beyond the usable interior (wall/stacking-lip inset), with a
1e-6 mm containment tolerance. Degenerate outlines are also reported. Without a
target configuration, only unplaced or degenerate tools are reported.
Overflow placements are still returned: this warning means the arranger did not
find a fitting layout, not that fitting is mathematically impossible. Increase
the grid size or remove tools and try again. Missing tools still return 404;
empty requests and requests containing only degenerate outlines return 400.

For repeated copies of a library tool, send `placement_ids` parallel to `tool_ids`.
It must contain exactly one unique, nonempty string instance ID per requested
tool (invalid identities return `400`; non-string IDs return `422`). Each returned
placement then includes that `placement_id` alongside its library `tool_id`.
Fit is tracked independently per instance: `unfitted_tool_ids` still contains
library IDs, once per unfitted requested copy, even when another copy fits.
`unfitted_placement_ids` identifies those exact instances, including overflow
diagnostic rows still returned in `placements`; placement presence does not mean
the instance fits. This field is `[]` for legacy requests without `placement_ids`.
Omitting `placement_ids` preserves the legacy unique-library-tool behavior.

`auto_width` defaults to `false`. When `true`, `bin_config` is required (400 if
missing): `grid_y` is fixed and the supplied `grid_x` is replaced by the computed
width. The search prioritises fitted tool count, then occupied width. Returned
`grid_x` snaps to full grid units, or half units with `half_grid_base`, within
the 25u/100-cell footprint limits. Its usable interior includes the actual
wall/stacking-lip inset plus `cutout_clearance`. Without pins, fitted tools are
centred in the resulting bin. With pins, the anchored rightmost fitted extent
plus margins determines width; unused space left of an anchor is not removed,
and neither X nor Y is recentered. Overflow tools remain explicit diagnostics.
`grid_x` is `null` when `auto_width` is false.

`clearance` is finite, non-negative tool padding in millimetres (default `1.0`):
the minimum edge-to-edge gap between the raw tool outlines, not a per-tool
offset or the bin's `cutout_clearance` fit allowance. Zero allows touching
outlines without overlap. Negative or non-finite spacing returns 400.

`algorithm` selects `"auto"` (default), `"raster"`, or `"packingsolver"`.
`time_budget_seconds` is a finite number from `0.5` to `60`, inclusive (default
`5.0`). Invalid algorithm or budget values return 422.

`"auto"` (Automatic) concurrently runs the real Raster and native PackingSolver
optimizers in isolated, owned worker processes. A single absolute deadline is
established at handler entry; its shared budget covers worker startup and
imports, canonical tool/bin preparation, search, and original-geometry
validation inside those workers. It compares validated incumbents, prioritising
fitted tool count, then smaller layout bounding-box area for ordinary layouts
(occupied width for `auto_width`). On timeout it keeps the best validated
incumbent found so far; it does not prove optimality. Explicit `"raster"` or
`"packingsolver"` runs only the selected optimizer under the same deadline.

The bundled Next.js rewrite proxy allows 65 seconds so a 60-second budget can
return after worker cleanup. Other reverse proxies need a compatible response
timeout.

Each backend process admits one active layout request and at most two optimizer
children; busy requests are rejected rather than queued. Busy requests, an
unavailable or failed selected explicit engine, failure or unavailability of
both Automatic engines, or expiration before any safe incumbent return 503.
One healthy Automatic engine can still return its valid result when the other fails.
Deadline termination after a safe incumbent is not an engine failure.
Unrecoverable geometry arithmetic returns 400 rather than altered or collapsed
outlines.

`fixed_placements` defaults to `[]`. Each entry is
`{tool_id, placement_id?, x, y, rotation}` with finite numeric coordinates and angle (degrees).
When `placement_ids` is supplied, every pin must supply a matching `placement_id`
and its corresponding library `tool_id`; unknown, mismatched, or missing pin
identities return `400`. Without `placement_ids`, pins use `tool_id` and must not
supply `placement_id`. It anchors that requested instance at its final rotated-outline minimum
corner, in the same bin coordinates returned by the endpoint. Angles, including
non-cardinal angles and whole turns, and fractional corners are preserved.
Pins require `bin_config`; their original outlines must fit the usable interior
and meet the same edge-to-edge `clearance` as other tools. Each instance can be
pinned once and must be requested. Duplicate, unrequested, degenerate,
outside, overlapping, or too-close pins return an actionable `400`; missing
library tools return `404`, and non-finite pin coordinates/angles return `422`.
Invalid pins are never relocated. All-pinned requests still validate and return
the supplied poses unchanged. Both optimizers pack movable tools around fixed
outlines, including usable holes; overflow IDs retain their normal meaning.
No layout with pins is group-centered.

Saved bin `placed_tools` add `pinned: boolean` (default `false` for old data).
`PUT /api/bins/{id}` persists it and bin reads/library synchronization preserve
it. This is an automatic-placement constraint, not a manual-edit lock: clients
may still drag or rotate pinned tools and submit their new pose on the next
auto-layout request.

`thickness_mm` is the maximum measured resting thickness in the scanned orientation.
It is finite and strictly positive, or `null` for unknown. A tool update that omits
the field preserves it; explicit `null` clears it. Tool detail and summary responses
include it. Old tools and newly saved traces default to unknown, never zero.

`bin_config.access_pockets` is a list of bin-local finger-access pockets, each
`{id, shape, x, y, length, width, depth, rotation, edge, edge_size,
corner_radius, bottom_radius}`. `shape` is `"rectangle"` or `"scoop"`;
`length`/`width` are the nominal opening in millimetres *before* the opening-edge
finish and `x`/`y`/`rotation` place the pocket in bin space (origin top-left,
clockwise angles, Y-down). `edge` is `"inherit"` (follow the bin cutout
chamfer), `"sharp"` (explicit override), `"chamfer"` (45°, equal vertical and
horizontal distances) or `"fillet"` (round); `edge_size` is the chamfer leg or
fillet radius. A `"scoop"` is a genuine curved-bottom trough with intrinsic
curvature, so `corner_radius` and `bottom_radius` must be `0` (`422` otherwise);
a `"rectangle"` may use both radii. Non-finite or non-positive sizes, a corner
radius above half the smaller opening, a bottom radius above the depth or half
the smaller opening, and an explicit edge size at or above the depth are `422`.
Pockets persist with the rest of `bin_config` through `PUT /api/bins/{id}` and
are returned by bin reads; records written before pockets existed load with an
empty list. Where the pocket depth exceeds the protected-floor maximum the
generator clamps it (as it does for tool cutouts); clients should surface the
effective depth. `POST /api/bins/{id}/generate` accepts a bin with no placed
tools when it has at least one access pocket (`400` otherwise).

`bin_config.stacking_lip_empty_cells` (default `false`) raises a standard 1x1
stacking lip on every **full** grid cell whose top surface is cutout-free, so
smaller bins can stack inside a larger traced bin without its outer rim. It is
dormant unless `stacking_lip` is on; the outer lip and `rim_units` collar are
unchanged. An upper bin seats in a cell lip with the same base profile as the
bin's own rim, and adjacent cells (42 mm pitch, 0.5 mm gap) accept several 1x1
bins or one multi-base-cell upper bin.

Eligibility is computed from the actual cutter solids when the bin is generated:
prepared cutout clearance and smoothing, finger holes, `cutout_chamfer`
widening, access-pocket opening finishes, and engraved or embossed labels all
disqualify every cell they overlap, and a fractional trailing cell never gets a
lip. `half_grid_base` only changes the bottom base cells and does not affect
which cells are eligible. The field persists with the rest of `bin_config`
through `PUT /api/bins/{id}` and is returned by bin reads; records written before
it existed load with `false`, and their generated geometry is unchanged.

Bin detail includes a derived `height_assessment`. Height planning returns
`{assessment, alternatives}`. Each alternative identifies its strategy, whether
measurements are complete, proposed `bin_config` and `placed_tools`, any explicit
cutout override changes, external height and clearance, or an explanation when no
supported configuration fits. These endpoints never change saved geometry.
Apply a chosen alternative with the existing `PUT /api/bins/{id}` and then
`POST /api/bins/{id}/generate`. Body and rim limits remain 20 units each.

Assessments and height proposals use bounded, in-memory caches keyed by their
physical inputs and referenced tools. Identical planning requests reuse the
computed result; changes to measurements, smoothing, placements, labels, or
configuration trigger reassessment. Cache entries are never persisted.

`POST /api/bins/import` is multipart (`file`, optional `name`, optional
`project_id`) and is the way to create a planning-only bin. `file` is an STL no
larger than 25 MiB, assumed to be in millimetres with Z up, centred in X/Y with
its Z-minimum dropped to zero and stored as a binary STL in the user's
`imports/` directory. Width and depth are matched to full (42 mm) or half
(21 mm) grid cells within 0.75 mm; height is matched to 7 mm body units with or
without the 4.4 mm stacking lip within 0.75 mm. A non-standard axis is accepted
with a warning and rounded up to a conservative nominal footprint. The response
is the created `BinModel`: `imported_model` carries the measured `width_mm`,
`depth_mm` and `height_mm` bounding box plus `warnings`, and `bin_config` carries
the detected nominal grid, height and half-grid flag used for planning.

An imported bin is read-only. `PUT /api/bins/{id}` accepts only `name` and
`project_id`; sending `bin_config`, `placed_tools` or `text_labels` returns `400`.
`POST /api/bins/{id}/generate` returns a URL for the stored upload instead of
regenerating geometry, and `GET /api/bins/{id}/height-planning` reports an
`uncertain` assessment with no alternatives. The stored mesh lives outside the
export retention sweep, so it survives until the bin is deleted. Records written
before imports existed load with `imported_model: null`.

Both generation endpoints may return `503 Service Unavailable` with
`Retry-After: 5` when `STL_GENERATION_CONCURRENCY` is configured and every
generation slot remains occupied for 5 seconds. Cached generation responses
bypass this queue.

## Bin projects
- `GET /api/bin-projects` - list project summaries with tool/bin/placement counts
- `POST /api/bin-projects` - create a project, optionally seeded with tool ids
- `GET /api/bin-projects/{id}` - get project detail with derived placed/unplaced tool ids
- `PATCH /api/bin-projects/{id}` - update project metadata and status
- `DELETE /api/bin-projects/{id}` - delete project metadata; tools and bins are retained
- `POST /api/bin-projects/{id}/tools` - add tools to a project
- `DELETE /api/bin-projects/{id}/tools/{tool_id}` - remove a tool from a project
- `POST /api/bin-projects/{id}/bins` - link existing bins to a project
- `DELETE /api/bin-projects/{id}/bins/{bin_id}` - detach a bin from a project
- `POST /api/bin-projects/{id}/create-bin` - create a new bin from selected project tools, using project or request bin defaults
- `GET /api/bin-projects/{id}/health` - report project/tool/bin link mismatches
- `POST /api/bin-projects/{id}/repair` - repair safe project/tool/bin link mismatches
- `POST /api/bin-projects/{id}/sketches` - add a drawer plan (optional `name`, `target_grid_x`, `target_grid_y`, `outline`, `grid_alignment`, `fit_clearance_mm`, and `source_session_id`/`source_seed` to start from a calibrated photo)
- `PATCH /api/bin-projects/{id}/sketches/{sketch_id}` - update a plan's name, drawer grid, `bin_layout`, `outline`, `grid_alignment`, `fit_clearance_mm`, `source_session_id`/`source_seed`
- `POST /api/bin-projects/{id}/sketches/outline/candidate` - propose the interior floor around a selected point (`{session_id, seed, provider?, api_key?, tracer?}`) through the configured Gemini/OpenRouter provider; returns the boundary in millimetres and persists nothing. The proposal is a starting point, not a verdict: it may follow the case walls, rim or exterior, so review and edit it, or trace the boundary locally instead
- `DELETE /api/bin-projects/{id}/sketches/{sketch_id}` - delete a plan; bins and tools are untouched
- `POST /api/bin-projects/{id}/sketches/{sketch_id}/assessment` - derived physical fit and capacity; optionally assess a `ProjectSketchUpdateRequest` draft without saving
- `POST /api/bin-projects/{id}/sketches/{sketch_id}/placements/{placement_id}/stack-action` - explicitly stack, reorder or remove members

Drawer-plan create/update/detail contracts extend the existing grid with nullable
`container_width_mm`, `container_depth_mm`, `container_height_mm` and finite
non-negative `safety_clearance_mm` (default zero). Dimensions are finite and positive;
width and depth retain the planner's 40-unit / 1680 mm maximum. Height is canonical
millimetres: 10 height units entered in the UI means 70 mm. Its datum is the
supporting surface beneath the lowest bin bases; subtract installed baseplate or
liner elevation from measured floor-to-closed-lid height. Millimetre dimensions
override grid controls per axis. Clearing them preserves placements and restores
the saved grid-only limits. Residual edge strips are not rounded up into grid cells.

A plan may also carry an optional photo-derived boundary: `outline`
(`{points, interior_rings}`, millimetres in drawer space with x right and y down),
`source` (the calibration: historical `session_id`, plan-owned `original_image_url`
and `corrected_image_url`, corrected image size, `paper_size`, `scale_factor`
millimetres per pixel, original-frame paper `corners` and selected `seed`),
`grid_alignment` (`origin_x_mm`, `origin_y_mm`, `rotation_deg`,
all default zero) and a finite non-negative `fit_clearance_mm` (default zero),
which is separate from the vertical `safety_clearance_mm`. Every field is optional
with defaults, so records written before the feature load unchanged. The source is
derived server-side from a session the caller owns — never sent by the client — and
`source_session_id` (with an optional `source_seed`) adopts a pending source on
create/update. Omit it when accepting edits to an unchanged owned source: the
historical session can already be deleted. Recalibration reopens the saved
uncorrected original with its paper corners/size via upload and corner editing.
Both recalibration and a replacement photo are traced in their pending session's
metric frame, then adopted only on explicit Accept. Validated images are staged at
new owned addresses before committing matching metadata; failure removes them and
leaves the old source/outline/calibration usable. A committed replacement returns
the new source; disposal of the obsolete copies runs after that commit, so a
filesystem error while removing them is logged and leaves an unreferenced leftover
rather than failing the committed request or touching the new images. Deleting a
plan/project removes only its owned photos. Session candidates belong to the
session; saved-source candidates belong to the plan and are removed with that owner.
Reviewing a candidate never creates a plan.

`grid_alignment` is the grid's own frame: an anchor plus a turn. The turn aligns the
grid to a straight drawer edge that is not parallel to the reference paper, and the
boundary and source photo stay in drawer millimetres, so the two are independent.
A placement footprint is therefore a rectangle in that turned frame; its four
corners and all intervening edges are tested for coverage, and half/full-unit snaps
and cardinal rotations are unchanged inside the frame. Scan/render bounds are
derived from the actual floor in that current frame, not the legacy rectangle.
Placement coordinates are finite signed half-unit offsets, so an offset/turned
grid can use negative cells and bins larger than the old display rectangle.

The boundary is authoritative for containment: the whole nominal footprint must be
covered by the outline minus its exclusions, and its minimum **Euclidean** distance
to every outer/exclusion edge must be at least `fit_clearance_mm`. It is not a
per-axis rectangle expansion. Corners inside are not sufficient — a concave notch
or exclusion can cross the footprint. Harmless corner/shared-edge contact is valid
at zero clearance, but a footprint coinciding with an exclusion is not floor. The
bounding box only supplies scan/render bounds, never containment. An invalid
outline (fewer than three points, zero area, self-crossing, exclusions outside,
crossing, overlapping or nested) is rejected atomically with 400.

`outline/candidate` returns a provider proposal in millimetres. The provider sees
the full corrected scene, not a seed-centred crop. A small red cross marks the
selected floor point on the provider-input copy, with matching prepared pixel
coordinates in the prompt; neither saved source image is annotated. The cross is
only a selection cue, never a boundary or an obstruction. The prompt asks for white
usable floor (including under paper), black walls/rim/case/lid/latches/obstructions.
Before contouring, the mask is inverted and mapped back to the full corrected frame.
Seed containment rejects disconnected candidates or a seed inside an exclusion;
it cannot distinguish an enclosing case exterior from real floor. The user must
review the native proposal and outline before Accept; a photo cannot verify
physical fit. With no configured provider, trace locally over the corrected photo.

Placements add nullable `support_id`, referencing another placement in the **same
plan**, not a bin ID. Copies retain independent identity. A placement supports at
most one direct child; missing references and cycles are rejected before persistence.
Root-only move/rotation updates carry unchanged descendants coherently.
`stack-action` accepts `{action, support_id?, bin_layout?, remove_bin_copies?}`.
Actions are `stack_on`, `move_up`, `move_down`, `remove_substack` and
`remove_reconnect`; reconnect/reorder/attach recheck affected mating interfaces.
An optional layout supplies the current draft. `remove_bin_copies` applies removal
to all copies of the selected bin, atomically. Detaching/deleting a bin removes
its referenced placements and upper sub-stacks; library bins above it are retained.

Assessments return `status` (`verified`, `uncertain`, `invalid`), independent known
`violations` and `unresolved` inputs, missing thickness IDs, `unhoused_tool_ids`,
current bin summaries and per-placement elevations, support compatibility,
limiting tools, conservative outline envelopes, clearance and ceiling headroom.
Each envelope includes `seating_verified` and `insert_height_mm` (zero when disabled).
If an outline cannot seat in the actual clipped pocket, `effective_depth_mm`,
`resting_z_mm`, `top_mm` and `clearance_mm` are null and a known `tool_seating`
violation identifies the affected tool. No floor-level envelope is rendered.
For seated outlines the insert's top resting surface remains known even if tool
thickness is missing, so insert-to-upper-bin and insert-to-ceiling interference
stay known violations in partial plans. Generated lip/collar integrity and raised
embossed material are checked before an interface is claimed compatible.
The safety gap applies to tool-to-upper-bin and content-to-ceiling checks.
Known collisions remain invalid even when another measurement is unknown.
A verified assessment requires relevant limits, all housed project tools'
measurements and every required support check.

Capacity includes floor-root footprint union, free half-grid cells, connected free
regions, usable grid dimensions, residual edge strips and each stack's headroom.
With a boundary present, free cells and free regions are restricted to half-cells
fully covered by it, `usable_area_units` is their total, `floor_area_units` is the
continuous boundary area, and residual strips are omitted because the grid extent
is no longer the floor. All of it uses the same containment rule as the warnings,
and automatic packing never chooses a spot the boundary rejects.
Tools in bins merely linked to the project do not complete this plan.
`geometry_revision` is a transient preview invalidation key, not a stored fit cache.
Only user inputs and relationships persist; assessments use current tools/bins.
Old floor-only records still load unchanged and missing physical data remains explicit.


A project holds any number of drawer plans in `sketches`, each `{id, name, target_grid_x, target_grid_y, bin_layout, created_at, updated_at}` with its own grid of 1-40 units. Records written before multiple plans existed are migrated on load: their project-level grid and layout become a single sketch. `bin_layout` is a list of `{id, bin_id, x, y, rotation, color}` placements on the project drawer grid. `x`/`y` are gridfinity units from the top-left in 0.5 steps, `rotation` is 0, 90, 180 or 270, and `color` is an optional `#rrggbb` highlight. Every placement must reference a bin linked to the project; the same bin may be placed several times, so placement ids must be unique (the server generates one when omitted). Placements are dropped automatically when a bin is detached or deleted. `GET /api/bins` reports `grid_x`, `grid_y`, `height_units`, `half_grid_base` and `preview_tools` so a drawer plan can draw bin footprints, their contents and the snap step each bin allows.

## API Keys and tracer status
- `GET /api-keys` - returns current provider and available tracers

Response fields:
- `google` (bool): true when the server can trace without a user-supplied key (cloud env key, local, or remote).
- `provider` (string|null): one of `gemini` | `local` | `remote`.
- `provider_label` (string|null): human label for the primary tracer, e.g. `Replicate`.
- `tracers` (array): `{id, label}` entries. Remote tracers include `{"id":"replicate","label":"Replicate"}` and `{"id":"fal","label":"fal.ai"}` when the respective tokens are configured.

## Meta
- `GET /api/version` - running app version. Release images report the release tag (e.g. `0.6.0`), dev images `dev-<sha>`, local runs `dev`. Returns 404 when `SHOW_APP_VERSION=false`.

## File serving
- `GET /api/files/{session_id}/bin.stl` - session STL
- `GET /api/files/{session_id}/bin.3mf` - session 3MF
- `GET /api/files/{session_id}/bin_parts.zip` - session split parts
- `GET /api/files/bins/{bin_id}/bin.stl` - bin STL
- `GET /api/files/bins/{bin_id}/bin.3mf` - bin 3MF
- `GET /api/files/bins/{bin_id}/bin_parts.zip` - bin split parts

Exports are subject to the retention sweep (`STL_RETENTION_HOURS`, see
[stl-generation.md](stl-generation.md)); a purged file returns `404` until the
bin is regenerated.
