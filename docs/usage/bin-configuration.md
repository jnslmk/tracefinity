# Bin Configuration

Gridfinity is a modular storage system where bins snap into a baseplate grid. Each grid unit is 42mm x 42mm. Tracefinity generates bins that conform to the Gridfinity spec.

## Configuration options

| Setting | Range | Default | Notes |
|-|-|-|-|
| Grid width | 1-25 u | 2 | Each unit is 42mm; the grid footprint is limited to 100 cells |
| Grid depth | 1-25 u | 2 | Each unit is 42mm; the grid footprint is limited to 100 cells |
| Height | 1-20 u | 4 | Each unit is 7mm, including the 4.75mm base; lip and raised rim add height above this |
| Cutout depth | 5mm-max (0.25mm at 1u) | 20mm | Max is height × 7mm − 4.75mm base − 2mm floor |
| Clearance | 0-5mm | 1.0mm | Gap around tool outlines |
| Cutout chamfer | 0-3mm | 0mm | Bevel on top edge of pockets |
| Magnet diameter | 3-10mm | 6mm | Standard Gridfinity magnets are 6x2mm |
| Magnet depth | 1-5mm | 2.4mm | Slightly deeper than magnet for press-fit |
| Insert height | 0.5-10mm | 1.0mm | Only shown when insert is enabled |
| Insert fit | 0-1mm | 0.2mm | Clearance shaved off insert edges so it drops into the pocket |
| Bed size | 150-500mm | 256mm | For auto-splitting oversized bins |

A 2u bin allows up to 7.25mm cutout depth; a 3u bin allows up to 14.25mm,
with or without the stacking lip. A 1u bin is limited to a shallow 0.25mm
pocket to preserve the base and 2mm floor. Increase the bin height for deeper
pockets. Insert thickness is added to the requested depth, then capped at the
same physical maximum.

## Toggles

**Magnet holes** -- recesses in the bin base for magnets. On by default.

**Corners only** -- magnet holes only at the four outer corners instead of all grid positions.

**Stacking lip** -- raised rim so bins stack securely. On by default. Adds approximately 4.4mm to total height without reducing maximum cutout depth.

**Raise lip** -- extends the wall and stacking lip upward by this many units (7mm each) above the floor face, leaving the interior open. Use it for shallow bins where a tool protrudes above the floor: the raised lip lets a stacked bin clear the protruding tool. 0 = standard (lip sits at the floor face). Shown only when the stacking lip is on.

**Contrast insert** -- generates a separate STL to print in a different colour. The pocket is deepened automatically to accommodate the insert thickness.

**Partial Bins** -- disables individual grid cells, removing them from the shell.

**Connect Base** -- disabled cells keep the base plate connected instead of being fully removed.

**Retain outer wall** -- keeps the outer bin wall around the full perimeter when connect base is on.

## Grid sizing

Choose **Grid sizing** in the bin sidebar:

- **Auto width and depth** (default): both dimensions follow the placed tools; both sliders are disabled.
- **Fixed width and depth**: set both dimensions manually.
- **Fixed depth, auto width**: set **Grid Depth** (Y); **Grid Width** (X) follows the layout. Click **Auto-arrange** to pack tools within that depth and search for a smaller width. Width snaps to full units, or half units with a half-grid base.

The sizing mode lasts for the current editor session; the resulting dimensions are saved. Fixed depth never grows automatically. If tools extend outside its usable interior, preview/export pause until you rearrange them or increase depth.

Bins can be up to 25 units on either axis with a 100-cell grid footprint. Long, narrow bins are supported and are split according to the configured bed size. If an auto-sized layout exceeds either safety limit, Tracefinity keeps saving the tool placement but pauses preview and export until the tools are reduced or rearranged.

The grid sliders use a fixed 1–25u scale, so changing one dimension does not
move the other slider's thumb. Manual dimensions respect the 100-cell footprint
(`ceil(width) × ceil(depth)`). In fixed-depth mode, choosing a deeper bin can
reduce the computed width to stay within that limit.

## Auto-arrange tool padding

Use **Tool padding (mm)** beside **Auto-arrange** to choose the minimum
edge-to-edge distance between raw tool outlines. The default is **1 mm**;
**0 mm** allows outlines to touch without overlapping. Enter a finite,
non-negative number; blank or invalid input shows an error and disables
Auto-arrange rather than using another spacing.

This is separate from **Clearance** in the bin configuration, which expands
each pocket around its tool for fit. Tool padding does not guarantee a wall
between the expanded cutouts: allow for both tools' fit clearance and the
desired wall thickness when choosing padding. It does not add a bin-wall
margin. Auto-arrange still packs inside the usable wall/stacking-lip interior
and warns if it cannot find a fitting layout.

Padding applies to the next Auto-arrange run, not manual moves or existing
placements. It stays in the current editor session and is not saved in bin
defaults. Changing padding while a run is pending discards that run's result;
run Auto-arrange again to use the new value.

## Default bin settings

Defaults can be saved at two levels:

- **Global** -- stored in browser localStorage. Apply to all new bins. Set from the bin editor or settings page.
- **Per-project** -- stored on the project via the API. Override global defaults for bins created within that project.

Use "Save as defaults" to capture the current bin config. Use "Reset defaults" to restore factory settings (2x2 grid, 4u height, magnets on, stacking lip on).

## Partial Bins

The partial bins option allows you to disable individual parts of the Gridfinity box to save filament. By using a matrix that matches the grid width * grid depth, specific parts of the box can be enabled or disabled.

## Bed splitting

If the bin dimensions exceed your configured bed size or the bin model is separated by the partial bins configuration, Tracefinity automatically splits it into printable pieces. You get:

- Individual STLs for each piece (also available as a ZIP).
- The full merged STL for large-format printers.
- A split preview in the 3D viewer.

## Loaded-bin height planning

Record each library tool's maximum **resting thickness in the scanned
orientation** in its tool editor. The bin's **Fit height to tools** panel lists
each contained tool's height in millimetres and Gridfinity height units (7 mm
per unit). Green/check means it fits, red/cross means it does not, and
amber/question mark means fit is unknown. Missing measurements stay unknown.
Use the **×** beside a tool to remove that placement from the bin without
deleting the library tool.

Previously computed measurements stay visible when you reopen the same draft or
return to the window. The panel refreshes shared tool measurements in the
background; auto-setting height stays unavailable until that refresh completes.
Changing the bin configuration or placements requires a new fit assessment.

Depth assessment uses the same generator rules: per-tool override before global
cutout depth, insert allowance, the physical base/floor clamp and the normal 5 mm
minimum when the physical limit permits it. A contrast insert raises the resting
surface by its printed thickness after pocket clamping.
Both global depths and explicit overrides receive the insert allowance exactly once
inside the generator, before clamping. Proposals honor this rule and never ignore
a shallow override or double-add its insert allowance.
Known insert interference is reported even while tool thickness is unknown.
If the scanned outline cannot seat in the printed, clipped pocket, fix its position
or bin footprint first; the planner does not propose a false floor-level fit.

**Auto-set bin height** chooses the smallest supported body height and adjusts
pocket depths, including explicit per-tool overrides, to fit all contained
tools. It enables the stacking lip and resets the raised rim to zero.
The button is unavailable while checking fit, when measurements or pocket
seating are unresolved, or when no supported height fits; its description
explains why. There are no separate strategy or safety-clearance controls in
this panel.

Applying follows normal auto-save and STL generation and updates the shared bin
in every linked plan. Inspect save or generation errors before leaving.
Opening the panel does not apply a height change. A taller bin can still
interfere with the container lid, so reassess linked drawer plans after changing
it. Automatic fitting uses zero additional vertical safety clearance, not a
manufacturing tolerance; check measured thicknesses and test printed parts
physically. Drawer plans retain their own safety-clearance setting.
