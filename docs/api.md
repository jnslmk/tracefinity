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
- `POST /api/sessions/{id}/corners` - set corners, apply perspective correction; returns advisory photo warnings (camera too close, paper cut off, extreme perspective)
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

Auto-layout accepts `{tool_ids, clearance, bin_config?}` and returns
`{placements, bounds, efficiency, unfitted_tool_ids}`. Placement `x`/`y` is the
minimum corner of the final rotated outline, in millimetres. With `bin_config`,
`unfitted_tool_ids` contains requested library tool IDs not placed or whose final
outlines extend beyond the usable interior (wall/stacking-lip inset), with a
1e-6 mm containment tolerance. Degenerate outlines are also reported. Without a
target configuration, only unplaced or degenerate tools are reported.
Overflow placements are still returned: this warning means the arranger did not
find a fitting layout, not that fitting is mathematically impossible. Increase
the grid size or remove tools and try again. Missing tools still return 404;
when no tools can be placed, the endpoint still returns 400.

`thickness_mm` is the maximum measured resting thickness in the scanned orientation.
It is finite and strictly positive, or `null` for unknown. A tool update that omits
the field preserves it; explicit `null` clears it. Tool detail and summary responses
include it. Old tools and newly saved traces default to unknown, never zero.

Bin detail includes a derived `height_assessment`. Height planning returns
`{assessment, alternatives}`. Each alternative identifies its strategy, whether
measurements are complete, proposed `bin_config` and `placed_tools`, any explicit
cutout override changes, external height and clearance, or an explanation when no
supported configuration fits. These endpoints never change saved geometry.
Apply a chosen alternative with the existing `PUT /api/bins/{id}` and then
`POST /api/bins/{id}/generate`. Body and rim limits remain 20 units each.

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
- `POST /api/bin-projects/{id}/sketches` - add a drawer plan (optional `name`, `target_grid_x`, `target_grid_y`)
- `PATCH /api/bin-projects/{id}/sketches/{sketch_id}` - update a plan's name, drawer grid or `bin_layout`
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
Tools in bins merely linked to the project do not complete this plan.
`geometry_revision` is a transient preview invalidation key, not a stored fit cache.
Only user inputs and relationships persist; assessments use current tools/bins.
Old floor-only records still load unchanged and missing physical data remains explicit.

Assessments and height proposals use bounded, in-memory caches keyed by their
physical inputs and referenced tools. Identical planning requests reuse the
computed result; changes to measurements, smoothing, placements, labels, or
configuration trigger reassessment. Cache entries are never persisted.


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
