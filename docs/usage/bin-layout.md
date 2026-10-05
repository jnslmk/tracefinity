# Bin Layout Editor

The bin layout editor is where you arrange tools inside a gridfinity bin and configure it for printing.

## Layout

The editor has three areas: a configuration sidebar on the left, a 2D canvas in the centre, and a 3D preview on the right. A horizontal tool library strip sits above the canvas and preview.

The 2D canvas shows the 42mm Gridfinity grid over both the bin floor and tool
outlines. Grid lines stay visible when zoomed out and do not block tool selection
or dragging. Half-grid bases also show lighter, dashed 21mm subdivisions.

### Dimensions and drawer fit

**Dimensions & fit** combines the bin's width, depth and exterior height with
each linked drawer's width, depth and usable height. Physical millimetre limits
take precedence over target grid dimensions. Click a drawer name to open its plan.

Bin dimension values are green when they fit, red when they exceed a drawer
limit, and amber when fit is unknown. Width and depth account for a 90° rotation;
height includes the loaded bin and safety gap. Hover a value for the fit status.
With multiple drawer plans, each dimension shows the worst result across them:
an exceeded limit takes precedence over an unknown check. Without a drawer plan,
the values stay neutral.

This panel only warns about the bin itself: a footprint that cannot fit in
either orientation, or a standalone loaded height (including inserts, tools and
the drawer's safety gap) that exceeds the usable height. A bin that fits after
rotation is not a size failure. Unknown measurements stay explicitly unknown;
pending edits and failed assessments never show stale height-fit results.

Saved positions, overlaps, other bins and support-stack elevations are placement
problems, not bin-size problems. Inspect those in the drawer plan, which retains
the full fit assessment, occupancy and placement details.

## Adding tools

The tool library strip shows all available tools (filtered to the current project if you arrived from one). Click a tool to add it to the bin. It is automatically centred, and the grid expands if needed.

## Undo and action history

Use **Undo** and **Redo** in the sidebar, or **Ctrl/Cmd+Z** and
**Ctrl/Cmd+Shift+Z** outside text fields. Expand **Action history** to see the
recorded actions, the current state, and any undone actions.

History includes adding and removing tools, moving and rotating placements,
pinning, cutout-depth changes, text labels, access-pocket placement, dragging,
resizing, rotating, duplicating and deleting, bin configuration, grid-sizing
mode, height plans and renaming. A drag is one action. Auto-arrange and its
automatic grid changes are one action too: undo restores the previous
dimensions, partial cell mask, tool outlines, rotations, finger holes and labels
together.

Restored changes are automatically saved and refresh the preview. A new edit
after undo discards the redo branch. Undo also discards an in-flight auto-arrange,
so its late result cannot overwrite the restored layout.

History is limited to the latest 50 states in the current editor session; opening
another bin or reloading clears it. Shared library smoothing settings and saved
global defaults are not reverted. While typing, keyboard undo stays native to
the field.

## Selecting and moving tools

Click a placed tool to select it. Drag to reposition. The toolbar updates to show options for the selected tool.

Snap is off by default (5mm grid when enabled). Toggle it with the **Snap** button in the floating toolbar.

## Rotating tools

When a tool is selected, a rotation handle appears. Drag it to rotate freely.

## Pinning placements

Position and rotate a tool, then select **Pin** in its toolbar. A **Pinned**
badge marks the anchor on the canvas; **Unpin** releases it. Pins are saved with
the bin and survive reloads. Pinning constrains automation only: you can still
drag and rotate a pinned tool to adjust its anchor.

Pins belong to individual placements, not library tools. If you add several
copies of the same tool, pin or unpin each copy independently; auto-arrange
moves only the unpinned copies and preserves every pinned copy's exact pose.

**Auto-arrange** keeps every pinned outline, rotation, finger hole and interior
ring in place and packs the remaining tools around those anchors. Tool padding
applies to anchors too. Pins outside the usable interior or too close to another
pin produce an actionable error without replacing the layout; move them, adjust
the grid or padding, or unpin them before retrying.

While any tool is pinned, **Recenter** is disabled and automatic grid sizing
measures from the bin origin to the tools' far edges rather than translating the
group. Tools near the right or bottom edges can therefore require a larger bin
than their combined outline size suggests. **Fixed depth, auto width** still
accepts the server's computed width without moving anchors or changing depth.
Move tools inside the top and left usable edges if they cross those edges;
automatic sizing cannot fix this by moving a pinned layout.

Pinning, unpinning, dragging or rotating during an auto-arrange discards the
pending result, so a late response cannot replace the updated placement.


## Per-tool cutout depth

Select a tool to see a **Depth** field in the toolbar. Leave it blank to use the bin's default cutout depth. Enter a value to override it for that tool only. Click the reset button to clear the override.

## Access pockets

Access pockets are finger recesses cut into the bin itself, so a tool can be
lifted out of a tight cavity. Unlike finger holes they are not part of a tool:
they belong to the bin, are stored in its `bin_config`, and never move when
tools are auto-arranged, recentred or re-synced from the library.

1. Click the **Pocket** tool in the floating toolbar.
2. Click inside the bin to place a pocket. It is selected, and the **Access
   pocket** panel opens.

The panel edits the selected pocket:

- **Rectangle / Rounded scoop** shape toggle. A rounded scoop is a genuine
  curved-bottom trough with rounded ends; its width and depth are independent,
  so it can be shallower than a half-sausage. A rectangle keeps the corner and
  bottom radii below; a scoop has intrinsic curvature and hides them.
- **Length (mm)**, **Width (mm)**, **Depth (mm)**, **Angle (°)** exact values.
  Length and width are the nominal opening *before* the opening-edge finish.
- **Opening edge**: **Inherit bin chamfer** (follows **Cutout Chamfer**),
  **Sharp** (an explicit override that ignores later bin-default changes),
  **45° chamfer**, or **Round (fillet)**. Chamfer and fillet are mutually
  exclusive; the extra field sets the chamfer's leg length or the fillet's
  radius.
- **Geometry** (rectangles only): **Corner radius** (plan-view) and **Bottom
  radius** (the curved floor-to-wall and floor-to-end transition).
- **Duplicate** and **Delete**.

Finishing widens the opening outward, so it never shrinks the usable space. The
canvas draws the nominal opening as a solid outline and the finishing envelope
as a dashed outline. **Depth** cannot exceed the same protected floor as tool
cutouts. Typing a value outside a field's allowed range adjusts it to the limit
and shows a short explanation under the field naming the requested and effective
values (and the protected-floor maximum for depth); the panel also always shows
the effective depth and effective opening edge, so nothing is changed silently.

On the canvas, drag a pocket to move it, drag a corner handle to resize it from
the opposite corner, and drag the round handle to rotate it. A resize cannot
collapse a pocket below 1mm; impossible radii are clamped to the opening.

A bin may contain only access pockets: preview and export still work.

## Text labels

1. Click the **Text** tool in the floating toolbar.
2. Click anywhere on the canvas to place a label. A text input appears.
3. Type the label text and press Enter to confirm (Escape to cancel).
4. Double-click an existing label to edit its text.

When a label is selected, the toolbar shows:

- **Text** field to edit the content.
- **Size** to set the font size in mm.
- **Depth** to set how deep the text is cut or raised, in mm.
- **Emboss / Recess** toggle. Emboss raises the text above the surface; recess cuts it in.

Labels can be dragged to reposition and have a rotation handle.

## Grid sizing

Use **Grid sizing** in the sidebar. **Auto width and depth** (default) fits both dimensions to the placed tools and recentres them when there are no pins; pinned layouts keep their origin-relative positions. **Fixed width and depth** lets you set both dimensions manually.

To choose only Y, select **Fixed depth, auto width**, set **Grid Depth**, then click **Auto-arrange**. The arranger keeps that depth and searches for a compact width; the width control displays the computed X. Manual tool edits also resize X without changing Y. A tool that exceeds the fixed depth is flagged rather than silently increasing it.

## Recentre

Click **Recenter** in the toolbar to move all placed tools to the centre of the bin. Unpin tools first; recentering is disabled while any anchor is pinned.

## Auto-arrange

Click **Auto-arrange** in the toolbar to pack the placed tools into an efficient layout. The canvas status shows a loading bar and estimated seconds remaining based on the compute budget submitted for that run. The bar measures estimated elapsed budget, not actual optimizer progress, packing steps, or solution quality; the server does not report a completion percentage. If the budget elapses before the response arrives, the spinner stays active and the status reads **Waiting for result…**; budget expiry does not declare the request finished.

The default **Automatic** algorithm runs Raster and PackingSolver simultaneously
in independent processes, retaining the best result validated against the
original tool outlines: fitting more tools takes priority, then a more compact
layout. The best valid result is retained when the compute budget expires. When
every tool fits a fixed bin and there are no pins, the arranger centers the packed
group within its usable interior; it leaves pinned, overflow and auto-sized layouts unchanged.

In **Fixed depth, auto width**, fitting more tools still takes priority, then
smaller occupied width rather than bounding-box area. The chosen width respects
the 25u/100-cell limits, wall/stacking-lip inset and cutout fit clearance; fitted
tools are centred in the resulting bin only when there are no pins. This is a bounded heuristic search, not
proof of the smallest possible width.

Open **Advanced** beside Auto-arrange to select **Automatic**, **Raster**, or
**PackingSolver**, and set **Compute time (seconds)** from **0.5 to 60** (default
**5**). This is one total budget covering worker startup, preparation, and search,
not a separate allowance for each engine. More time can help the search find a
better arrangement, but does not guarantee improvement or prove an optimum.
The estimated countdown keeps that run's submitted budget even if you edit the setting while
it runs. These choices last only for the current editor session. **Tool padding (mm)** remains outside
Advanced and sets the minimum gap between outlines, separate from cutout fit
clearance.

If no fitting layout is found, the editor still applies the returned arrangement and shows a warning naming the affected tools, their count, and the grid dimensions requested for that run. Increase the grid size or remove tools, then try again. This is a packing result, not proof that no possible arrangement could fit.

The warning describes the **last run**, not the current grid: auto-size may expand the grid immediately after the arrangement is applied. It remains until dismissed or another auto-arrange starts; a fitting rerun leaves no warning.

A failed request keeps the existing tool layout and allows another attempt. Editing tools, bin settings, tool padding, algorithm, or compute time while packing is running invalidates the pending result, so a late response cannot overwrite those changes. An empty, non-finite, or out-of-range compute-time draft disables Auto-arrange until corrected, without changing the existing layout.

## 3D preview

The right panel shows a live 3D preview that regenerates whenever the layout or configuration changes. Controls:

- **Drag** to orbit, **scroll** to zoom, **right-drag** to pan.
- Camera preset buttons: Home, Top, Front, Right, Fit.
- Render mode toggle: solid or edges (wireframe).

## Split visualisation

When the bin exceeds the configured bed size, the STL is automatically split. The sidebar shows a "Split into N pieces" banner. The 3D preview shows each piece in a different colour, spaced apart.

## Insert display

When **Contrast Insert** is enabled in the sidebar, the insert appears in the 3D preview as an orange piece alongside the main bin.

## Bin configuration

The sidebar controls all bin parameters:

| Setting | Description |
|-|-|
| Grid Width / Depth | Bin size in gridfinity units (42mm each). 1-25 per axis, up to a 100-cell footprint. |
| Height | Bin height in units (7mm each, including the base; lip and raised rim add height). |
| Cutout Depth | How deep tool pockets are cut. |
| Clearance | Extra space around tool outlines. |
| Cutout Chamfer | Bevel on the top edge of each pocket. 0 = sharp. |
| Magnet holes | Holes in the base for magnets. Configurable diameter and depth. |
| Corners only | Place magnet holes at the four outer corners only. |
| Stacking lip | Raised rim for stacking bins. |
| Contrast Insert | Generates a separate insert STL for two-colour printing. |
| Insert Height | Thickness of the insert piece. |
| Bed Size | Print bed dimension. Bins exceeding this are split automatically. |
| Partial Bins | Disable individual grid cells in the bin. |

**Save as default** stores the current settings for all new bins. **Reset** restores factory defaults.

## Keyboard shortcuts

| Key | Action |
|-|-|
| Escape | Deselect / cancel text input |
| Enter | Confirm text input |
| Ctrl/Cmd+Z | Undo the last bin action (outside editable fields) |
| Ctrl/Cmd+Shift+Z | Redo an undone bin action (outside editable fields) |
