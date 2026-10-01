# Tool Library

Every tool you save from a trace session goes into your library on the app home page. Tools are shown as a grid. Hover a card to see the outline preview instead of the photo.

## Actions

- **Open the editor** -- click a tool to edit its outline, add cutouts, or transform it.
- **Search** -- filter tools by name (case-insensitive).
- **Sort** -- by date created or alphabetically.
- **Rename** -- click the tool name to edit it inline.
- **Delete** -- remove the tool permanently.

## Assignment and placement

Each tool card shows which project it belongs to and whether it has been placed in a bin. Tools marked "placed" are already in a bin layout; those marked "needs bin" still need one.

Click the project indicator to go directly to that project's view.

## Reusing tools

Tools are reusable across multiple bins. Trace a tool once, then drop it into as many bin layouts as you need.

## Measured tool thickness

In the tool editor, enter **Tool thickness (mm)**: the maximum thickness while
the tool rests in the orientation captured by its scan. This is a manual physical
measurement, not the scanned outline's length/width or automatic 3D estimation.
Use a matching scan if you change resting orientation.

Measurements are finite and strictly positive. Edit a value to correct it, or
choose **Clear thickness** (or empty the field) to mark it unknown. The measurement
auto-saves on the library tool and is reused across projects and placed copies.
Watch the save indicator; a visible save error means the edit was not persisted.
Old tools and newly scanned tools begin unknown, not zero-height.

Project and bin tool lists identify unknown thickness. Drawer-plan diagnostics
link to tools needing measurement. Known measurements produce conservative,
labelled outline envelopes in height planning; these are not reconstructed 3D
models. Tool edits are read again when assessing affected bins and plans.
