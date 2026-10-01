# Projects

Projects are named containers that group tools and bins for planning a drawer or workspace layout. They help you organise which tools go together and track progress from tracing through to printing.

## Creating a project

From the dashboard, click **New project**. Give it a name and optional description.

## Project status

Each project has a status that tracks its lifecycle:

| Status | Meaning |
|-|-|
| Active | Work in progress. Tools being traced and bins being designed. |
| Ready to print | All tools are placed in bins. Ready for export. |
| Printed | Bins have been printed. |
| Archived | Project is complete or shelved. |

Change the status from the dropdown in the project header.

## Adding tools

The **Add tools** section shows all tools not yet assigned to the project. Select tools using checkboxes and click **Add**. Use the search field to filter by name. Select all / select none buttons are available.

Tools can belong to multiple projects.

## Removing tools

Click the delete icon next to a tool in the **Project tools** section to remove it from the project. This does not delete the tool itself.

## Filtering project tools

The project tools list has filter buttons:

- **All** shows every tool in the project.
- **Unplaced** shows tools not yet placed in any bin.
- **Placed** shows tools already assigned to a bin.

A search field filters by name within the current filter.

## Creating a bin from a project

1. In the **Project tools** section, tick the tools you want in the new bin.
2. Click **Create bin** in the project header.

The bin is created with the project's default configuration (if set) and opens in the bin editor. The bin is automatically linked to the project.

## Default bin settings

Expand the **Bin defaults** section to configure default settings for all new bins created from this project. This uses the same controls as the bin configurator (grid size, height, magnets, stacking lip, etc.).

Click **Save defaults** to store. Click **Clear** to revert to global defaults.

## Linking existing bins

Click **Add existing bin** in the **Linked bins** section header. This shows unassigned bins that can be linked to the project.

Options when importing:

- **Import bin tools** also adds the bin's tools to the project.
- **Show assigned bins** includes bins already linked to other projects.

## Detaching bins

Click the unlink icon next to a bin in the **Linked bins** section. This removes the association but does not delete the bin.

## Deleting bins

Click the delete icon next to a bin to permanently delete it and all associated files.

## Project health check

If there are inconsistencies (orphaned tools, mismatched bin assignments), a health banner appears showing the issues. Common issues:

- A tool referenced by the project no longer exists.
- A bin's project ID does not match.
- A tool in a linked bin is not part of the project.

## Project repair

When health issues are detected and some are repairable, a **Repair links** button appears. Clicking it auto-fixes what it can (re-linking orphaned items, correcting mismatched IDs) and re-runs the health check.

## Bin contents

Expand a linked bin to see which tools are placed in it. Tools from outside the project are flagged with a warning.

## Drawer plans

The **Drawer plans** section at the bottom of the project page lists every plan for this project. Click **New plan** to add one -- a project can hold as many as you like, for example one per drawer or a few variants of the same drawer you want to compare. Click a plan to open it, rename it by clicking its name in the breadcrumb, and delete it with the trash icon. Deleting a plan only removes the arrangement; the bins stay in the project.

### Setting the drawer size

The drawer size is optional. **Set drawer size** enters width and depth in Gridfinity units (1 to 40, in 0.5 steps). You can instead enter usable width/depth in millimetres under **Usable container measurements** (up to the existing 1680 mm planner limit). Millimetres take precedence over grid controls on each axis. **Clear physical limits** restores the saved grid-only constraints; clearing dimensions does not delete placements.

Bins snap to whole gridfinity units. A bin configured with a **half-grid base** snaps to half units instead, matching the 21mm cells it actually sits on -- there is nothing to switch on in the planner.

### Placing bins

- Drag a bin from the **Project bins** list onto the grid.
- Or click the **+** icon to drop it into the first free spot.
- Drag a placed bin to move it.
- **R** or the rotate icon turns a bin by 90 degrees, cycling through 0, 90, 180 and 270.
- **D** or the copy icon duplicates the selected bin.
- **Delete** or the trash icon takes it back out of the drawer.

A bin can be placed as often as you like -- the list shows how many copies of it are in the drawer, and the **x** icon next to a bin removes all of them at once.

### Highlight colours

The palette icon next to a bin sets a highlight colour for every copy of that bin; the swatches in the bar below the canvas recolour just the selected one. The palette follows the Chart.js default colours, with the Tracefinity blue as the default swatch. Colours show up in both views, which helps when you want to mark, say, everything that still needs printing. Bins that overlap or hang out of the drawer are drawn red and amber with a dashed outline, regardless of their colour.

Each placed bin shows the outlines of the tools it contains and a small stack of bars in the corner marking its height in gridfinity units, so you can see at a glance whether a rearrangement is worth reprinting.

### Auto arrange

**Auto arrange** packs independent floor-level placements, largest first, rotating them when that helps. Established stacks stay intact and fixed; they reserve only their floor-root footprint. Existing placements that do not fit retain their position with a warning.

### Space usage

The sidebar tracks floor-root footprint **union**, free half-grid cells and connected available regions. Stacked members do not double-count floor space. Residual edge strips in a non-grid-aligned container are shown separately, never rounded upward. Independent roots that overlap still collide; aligned supported members in the same stack are assessed by their support relationship. Free area is a planning indicator, not a promise that another tool or bin can fit.

### 2D and 3D

Switch between the top-down sketch and a 3D view with the buttons above the canvas. The 3D view renders the actual bin models, the same geometry you would print, so you can check tool pockets, heights and reach. It uses the same controls as the bin preview: camera presets (home, top, front, right, fit) and a toggle that switches from solid models to contour lines only. Models are generated on demand the first time you open the 3D view; until a model is ready, the bin shows as a translucent block.

The plan saves automatically and is stored with the project.

### Closed-lid height and safety clearance

Name a plan for the toolbox or layout variant. Enter usable floor-to-closed-lid
height in millimetres or in height units: **10u converts to 70 mm**. Height is saved
in millimetres; nominal unit sums do not prove that a loaded stack fits.
The floor datum is the supporting surface beneath the lowest bin bases.
Subtract the elevation of an installed baseplate or liner from the measured
internal height; Tracefinity does not model the baseplate.

Set a non-negative **Safety clearance** for measurement uncertainty and practical
clearance. Zero preserves old-plan behaviour but is not a manufacturing tolerance.
The gap applies between a tool envelope and an upper bin, and between contents
and the ceiling.

### Manual stacks and accessible actions

Select a placed floor bin and choose **Stack on** another placement. Only aligned,
matching rectangular footprints after rotation with verified mating bases and an
intact lower stacking lip are supported. Full- and half-grid bases cannot be mixed.
Partial-bin interfaces whose support cannot be established are not verified.
The dropdown checks support on the server; rejected operations leave the saved
arrangement intact. Upper bins are positioned from the generated mating geometry,
not from editable Z coordinates or sums of exterior mesh heights.

Dragging, rotating or changing **Stack X/Y** moves the complete rooted stack.
Duplicating one selected bin creates an independent floor placement, not a copy
of the entire stack. **Move up/down in stack** explicitly reorders neighbors and
rechecks interfaces. Removing a member with bins above it offers **Remove upper
sub-stack** or **Remove and reconnect**; reconnect checks the remaining interface.
Removing all copies of a bin offers the same choice when upper members are affected.
Detaching/deleting a library bin deterministically removes its placed copies and
their upper sub-stacks, but does not delete the upper library bins.

The **Select every stack member** list reaches lower bins hidden from above.
It works with keyboard focus and Enter; all stack actions also have textual
controls, and Stack X/Y provides movement without dragging. Selection diagnostics
show elevation, limiting tools, current clearance and support compatibility.

### Fit diagnostics and previews

The backend derives fit from current library thickness, pocket overrides,
depth clamps, contrast inserts, raised rims and generated base/lip datums:

- **Verified**: relevant limits and measurements are known, every project tool is
  housed in a bin actually placed in this plan, and all checks pass.
- **Uncertain**: measurements, limits or housing remain unresolved.
- **Invalid**: a known boundary, overlap, support, tool or lid violation exists.
  Missing measurements are listed separately and never hide a known failure.

The plan reports each stack's remaining headroom and project tools **not housed
in this plan**. Linking a bin elsewhere does not complete this toolbox.
Changes to shared tools and bins are re-evaluated when returning to the planner;
**Reassess shared tools and bins** refreshes an already-open plan explicitly.
Only measurements, limits and placement relationships persist, not cached fit
results. Old tools remain unmeasured and old floor-only plans still load.

**Side clearance** shows elevations, labelled conservative tool envelopes and the
closed-lid ceiling. **3D** shows actual generated bin meshes at assembled mating
positions, extruded scanned outlines at their resting elevations and the ceiling.
Gold tool envelopes are approximations of maximum thickness, not reconstructed
3D tools. A placeholder block is explicitly labelled pending/unavailable geometry,
not a verified physical preview. Physically check measurements and printed mating
parts before printing the complete set.

Blue insert envelopes use the known insert thickness and floor position, including
when the tool itself is still unmeasured. They are conservative contours, not claims
that the separately printed insert STL has been loaded.

If a scanned outline crosses the bin wall, its cutout is clipped away, or printed
material prevents it reaching the pocket floor, the plan reports a known seating
violation. Its resting elevation is left unresolved and no floor-level tool or
insert envelope is drawn. Correct the tool placement or bin footprint before
requesting a height proposal; increasing body height alone cannot fix that fit.
