# Bin Configuration

Gridfinity is a modular storage system where bins snap into a baseplate grid. Each grid unit is 42mm x 42mm. Tracefinity generates bins that conform to the Gridfinity spec.

## Configuration options

| Setting | Range | Default | Notes |
|-|-|-|-|
| Grid width | 1-25 u | 2 | Each unit is 42mm; the grid footprint is limited to 100 cells |
| Grid depth | 1-25 u | 2 | The available maximum adjusts with the width |
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

## Auto grid sizing

On by default. When enabled, grid width and depth automatically adjust to fit all placed tools, and the grid width/depth sliders are disabled. Toggle it off to set grid size manually; the sliders become active again.

Bins can be up to 25 units on either axis with a 100-cell grid footprint. Long, narrow bins are supported and are split according to the configured bed size. If an auto-sized layout exceeds either safety limit, Tracefinity keeps saving the tool placement but pauses preview and export until the tools are reduced or rearranged.

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
orientation** in its tool editor. Unknown measurements remain unknown, including
old tools. The bin's **Fit height to tools** panel identifies the limiting tool,
effective cutout depths, current upper-bin clearance, standalone exterior height
and assembled stacking increment. These are different physical datums.

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

Inspect either alternative before applying it:

- **Deeper pockets / taller body** chooses the smallest supported body height
  that recesses measured tools enough. Any necessary increase to an explicit
  per-tool override is shown before applying.
- **Raised rim / existing pockets** retains body and pocket settings and chooses
  the smallest supported rim that clears the measured tool envelopes.

The panel shows proposed body/rim units, cutout settings, changed overrides,
resulting physical height and clearance. **Apply** changes the existing
configuration and follows normal auto-save and STL generation. Inspect save or
generation errors before leaving. It does not silently change bins merely by
opening the panel. Partial interfaces are not claimed to be stackable, and
unsupported height/depth limits return an explanation rather than a fake fit.

Missing measurements make known-tool proposals **incomplete**, not a complete
minimum-height recommendation. The plan re-evaluates current measurements and
configuration; a taller bin that becomes stackable can still interfere with the
container lid. Set a practical safety gap, and test printed parts physically.
