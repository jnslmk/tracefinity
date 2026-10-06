# Feature Inventory

Reference for AI agents. Check here before suggesting new features or claiming something is missing.

## Tracing and Image Processing

- Image upload (drag-drop or file picker, JPG/PNG/WebP/HEIC)
- Paper corner detection with draggable handles
- Paper size presets (A4, Letter, A3, Tabloid)
- Photo quality warnings before tracing (camera too close via EXIF focal length, paper cut off at the frame edge, extreme perspective)
- Named per-tool rephotography advice after automatic or manual-mask tracing: source-edge proximity means potential clipping (check completeness, not proof); outer 15% along either original frame axis is a position heuristic recommending a centered recapture if thick/raised, not a measured error
- Advice highlights outlines on hover/keyboard focus, follows outline edits and naming changes, and survives session reload via capture-frame metadata; older captures without it report advice unavailable. "No position flags" does not certify accuracy or fit, infer tool heights, or assess blur/lens distortion; distance checks require usable EXIF. Advice never blocks saving or changes tool selection
- [Capture guidance](usage/uploading-photos.md): wanted tools on one known-size sheet where practical, overhang supported, thin tools batched and bulky tools centered separately; actual distance/lens choice, stable focus and diffuse light rather than crop/zoom alone
- AI tracing (multiple tracer backends: IS-Net, BiRefNet, InSPyReNet)
- Remote tracing via Replicate (`REPLICATE_API_TOKEN`, model `men1scus/birefnet` by default; `REPLICATE_RESOLUTION` optional)
- Remote tracing via fal.ai (`FAL_KEY`, model `fal-ai/birefnet/v2` by default; `FAL_OPERATING_RESOLUTION` default `1024x1024`). Uses `sync_mode` so results are not stored in fal request history; Replicate predictions auto-purge after ~1h.
- Manual mask upload
- Corrected image download
- Prompt copy to clipboard
- Mask preview
- Session persistence (save in-progress tracing)
- Step navigation (corners/trace/edit)
- Tool selection with include/exclude checkboxes
- Session renaming

## Polygon Editing

- Vertex add/remove/drag
- Grid snap (5mm increments, toggle on/off)
- Smoothing toggle (accurate vs smooth) with smoothness slider
- 90-degree rotation (clockwise/counter-clockwise)
- Flip/mirror (horizontal and vertical)
- Auto-rotate (minimise bounding box)
- Interior rings / fill-in mode for donut shapes
- Undo/redo (Ctrl+Z / Ctrl+Shift+Z)
- Source image overlay with opacity control
- Zoom/pan (spacebar to pan)
- SVG export of tool outline

## Cutouts (Finger Holes and Pockets)

- Finger hole tool (15mm default)
- Circle mode (spherical pocket, 10mm default)
- Cylinder mode (flat-bottomed circular, 10mm default)
- Square mode (20mm default)
- Rectangle mode (30x20mm default)
- Drag to move, corner handles to resize
- Rotation handle on rectangular cutouts
- Per-hole depth override
- Delete individual holes

## Bin Configuration

- Grid sizing (width/depth in gridfinity units, 1-25 per axis and 100 cells total, with 0.5-unit increments for 21mm half-grid)
- Bin height in units (7mm each, including the base; lip and raised rim add height)
- Cutout depth (5mm to the height-dependent maximum; 0.25mm at 1u)
- Cutout depth mode: Automatic per tool (default for new bins) derives each measured tool's shallowest stacking-safe depth; Uniform applies one configured depth to every tool; a bin saved before modes exist shows "Existing per-tool depths" as a compatibility choice until you pick a mode (Undo restores it)
- Stacking clearance (0-10mm, default 1mm) kept between a measured tool's top and the underside of the bin stacked on top; automatic depths grow and shrink with it
- Clearance (0-5mm extra space around tools)
- Cutout chamfer toggle
- Magnet holes (enable/disable, diameter and depth)
- Magnets at corners only option
- Stacking lip toggle
- Raise lip (extend wall/lip above the floor face in 7mm units so a stacked bin clears a protruding tool)
- Stacking lips on empty cells (built-in 1×1 lips on cutout-free full cells so smaller bins can stack inside a larger bin, away from its edges)
- Half-grid base (21mm cells for finer baseplate positioning)
- Insert mode (contrast insert with configurable height)
- Bed size for auto-splitting large bins
- Partial bins (disable individual grid cells to reduce print volume)
- Auto-size grid to fit placed tools
- Save/reset default bin configuration (global and per-project)

## Bin Layout and Placement

- Drag-and-drop tools from library into bin
- Click to select placed tools
- Drag to reposition (with/without snap)
- Text labels with emboss/recess options
- Label editing (text, font size, emboss depth)
- Per-tool cutout depth override
- Per-tool Automatic / Custom depth in automatic bins (Custom pins a depth; Automatic goes back to the derived one)
- Auto-centre tools in expanded grids
- Centre view (fit all to viewport)

## Access pockets (bin-local)

- Finger-access recesses cut into the bin itself, independent of the tool library
- Rectangle: rounded-rectangle recess with an optional plan-view corner radius and an optional curved bottom radius (floor-to-wall fillet)
- Rounded scoop: a genuine curved-bottom trough with rounded ends (a half-sausage), with independent width and depth so it can be shallow
- Opening-edge finish: inherit the bin cutout chamfer, sharp, 45° chamfer, or round (fillet); chamfer and fillet are mutually exclusive
- Length/width are the nominal opening before finishing; finishing widens the rim outward rather than shrinking usable space, and both the nominal outline and the finishing envelope are shown in 2D
- Place with the Pocket tool, then select, drag, resize from a corner, rotate, duplicate and delete; exact length/width/depth/angle fields
- Depth is clamped to the same protected floor as tool cutouts and the editor shows the effective depth and effective opening edge
- Bin-local positioning: pockets never move during auto-arrange, recentring, height planning or library sync
- A bin containing only access pockets can still preview and export

## Export

- STL download (single or multi-part)
- 3MF export (for slicers supporting it)
- ZIP export (split parts as separate STLs)
- Insert STL (separate contrast insert model)
- SVG export (from tool editor)
- Split preview when bin exceeds bed size

## Projects

- Create named projects
- Project status (active, ready_to_print, printed, archived)
- Add/remove tools from projects
- Link/detach bins
- Create bin from project (with preset config)
- Project health check (validate assignments)
- Project repair (auto-fix orphaned items)
- Bulk tool import
- Bin import (with/without tool reassignment)
- Filter tool library by project membership

## Imported STL bins

- Upload an existing STL bin for read-only planning: bounding-box dimensions and a nominal grid are detected from the mesh, with warnings for non-standard geometry
- Upload from the home Bins section or a project's Linked bins section (optionally linked to that project immediately)
- Read-only geometry: no tools, cutouts or config changes; rename, link/detach, download and delete remain available
- Detected fit and stacking are always reported as uncertain, never verified

## Drawer Planning

- Several drawer plans per project, each with its own name and grid
- Optional drawer grid size per plan (width/depth in gridfinity units)
- 2D top-down drawer sketch with bin footprints, tool outlines and bin height indicators
- 3D drawer view rendering the generated bin models, with the same camera presets and edge display as the bin preview
- Drag and drop bins from the project bin list onto the grid
- Drag to move, rotate in 90 degree steps, duplicate, remove placements
- Same bin can be placed multiple times
- Snapping follows each bin's base: full units, or half units for half-grid bins
- Per-bin highlight colours
- Auto arrange (largest bins first) and space usage stats
- Overlap and out-of-drawer warnings
- Height layer slider: show every bin base elevation, or one assessed level in millimetres and units; bins spanning a level stay visible

## Drawer plans from a photo

- Create a plan from a photo of an open drawer, alongside the rectangular create; the photo is calibrated with the same upload, EXIF ingest, paper corner detection/editing, size presets and photo warnings as tool tracing
- Full-frame metric correction: the paper sets the scale, so the boundary can extend beyond the sheet
- Positively select the interior floor on the corrected photo, then either get a candidate boundary from the configured provider (Gemini through OpenRouter or the Google API) or trace it locally with no key
- The provider proposal is an editable starting point, not a verdict: it can follow the case walls, rim or exterior instead of the interior floor. Inspect it, correct the vertices and exclusions, or trace locally over the same calibrated photo
- The provider request sends the photo off-installation; the UI states the destination and that retention belongs to the provider
- Review the boundary and its obstruction exclusions over the corrected photo: add, remove and drag vertices, add exclusion rings, zoom and pan, undo and redo, with extent, area and perimeter shown. New obstructions are selected immediately. Choose **Add vertex (+)** and click an edge of the floor boundary or an obstruction to insert a point; select an obstruction and press **Del** (or click **Delete**) to remove it. The floor boundary cannot be deleted, and Del in an input does not remove an obstruction. Both vertex insertion and obstruction deletion can be undone/redone.
- Explicit acceptance before any plan is created/updated; generation, local tracing and recalibration never change the saved plan
- Persisted per plan: metric outline/exclusions, owned normalized uncorrected original and corrected photo, scale, paper corners/size and selected floor point, grid frame, and Euclidean minimum-distance container-fit clearance
- Reopen the saved original for recalibration or replace it with a new photo; trace that pending frame before Accept, without depending on the deleted historical session. Cancel/failure keeps the old source and outline usable
- Plan/project deletion removes only its owned photos and candidate masks; session-scoped masks are cleaned on session deletion, without changing ordinary Tool source retention
- Align the grid to a straight drawer edge that is not parallel to the reference paper: turn the grid and anchor it, independent of the paper's angle, and toggle the source photo underlay in the 2D view; the photo is anchored in drawer millimetres, so turning the grid never moves it
- The boundary, not a rectangle, decides: 2D/3D floor/grid, warnings, backend assessment, auto-arrange/free spots and stats cover the actual floor in the aligned frame, including negative cells; the old rectangle does not limit usable capacity
- A provider proposal containing the selected point is not guaranteed to be floor: it can include the case walls, rim or exterior. Review and correct it before Accept, or trace the boundary locally. The photo-derived physical fit remains unverified either way; concavities/exclusions are authoritative, not the bounding box
- No shaped perimeter bins, fillers, outline imports or printable floor/baseplate output in this workflow

## Tool Library

- Search by name
- Sort by date or alphabetical
- Inline rename
- Delete tools
- Thumbnails with hover preview
- Assignment indicators (which project)
- Placement status ("placed" vs "needs bin")
- Click-through to project view

## 3D Preview

- Interactive real-time 3D viewer (react-three-fiber)
- Split visualisation for multi-part bins
- Insert display when enabled
- Pan/zoom/rotate

## Settings and UI

- Dark/light mode toggle
- Guided tour / onboarding
- Section collapse (remembered state)
- Help tooltips with keyboard shortcut hints
- Default bin settings (global via localStorage, per-project via API)

## Keyboard Shortcuts

- Ctrl+Z: undo
- Ctrl+Shift+Z: redo
- Escape: close modals/dropdowns
- Enter: confirm text input
- Spacebar: pan canvas (hold)
