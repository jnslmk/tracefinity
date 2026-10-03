# Bin Layout Editor

The bin layout editor is where you arrange tools inside a gridfinity bin and configure it for printing.

## Layout

The editor has three areas: a configuration sidebar on the left, a 2D canvas in the centre, and a 3D preview on the right. A horizontal tool library strip sits above the canvas and preview.

The 2D canvas shows the 42mm Gridfinity grid over both the bin floor and tool
outlines. Grid lines stay visible when zoomed out and do not block tool selection
or dragging. Half-grid bases also show lighter, dashed 21mm subdivisions.

## Adding tools

The tool library strip shows all available tools (filtered to the current project if you arrived from one). Click a tool to add it to the bin. It is automatically centred, and the grid expands if needed.

## Selecting and moving tools

Click a placed tool to select it. Drag to reposition. The toolbar updates to show options for the selected tool.

Snap is off by default (5mm grid when enabled). Toggle it with the **Snap** button in the floating toolbar.

## Rotating tools

When a tool is selected, a rotation handle appears. Drag it to rotate freely.

## Per-tool cutout depth

Select a tool to see a **Depth** field in the toolbar. Leave it blank to use the bin's default cutout depth. Enter a value to override it for that tool only. Click the reset button to clear the override.

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

## Auto-size grid

Enabled by default. The grid automatically expands or contracts to fit all placed tools with clearance. Tools are recentred when the grid changes. Turn it off in the sidebar to set grid dimensions manually.

## Recentre

Click **Recentre** in the toolbar to move all placed tools to the centre of the bin.

## Auto-arrange

Click **Auto-arrange** in the toolbar to pack the placed tools into an efficient layout. A spinner and a visible canvas status remain while the request is running. Progress is indeterminate: the server does not report individual packing steps or a completion percentage.

If no fitting layout is found, the editor still applies the returned arrangement and shows a warning naming the affected tools, their count, and the grid dimensions requested for that run. Increase the grid size or remove tools, then try again. This is a packing result, not proof that no possible arrangement could fit.

The warning describes the **last run**, not the current grid: auto-size may expand the grid immediately after the arrangement is applied. It remains until dismissed or another auto-arrange starts; a fitting rerun leaves no warning.

A failed request keeps the existing tool layout and allows another attempt. Editing tools or bin settings while packing is running invalidates the pending result, so a late response cannot overwrite those changes.

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
