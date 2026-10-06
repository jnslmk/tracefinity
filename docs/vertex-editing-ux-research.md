# Simpler vertex insertion for photo outlines

Research date: 2026-10-06. Scope: inserting vertices into an **existing** drawer boundary or obstruction, not drawing new shapes, adding Bézier handles, or mesh extrusion. Official documentation and upstream event handlers were inspected. These applications were not installed or exercised; usability recommendations below are design inferences, not measured usability results. No Tracefinity interaction code was changed for this research.

## Recommendation

**Add Alt/Option-click on an edge as a shortcut in ordinary vertex-editing mode, while retaining the visible Add vertex (+) mode.** Labelme, an image-polygon annotation program, documents exactly this gesture. It removes the toolbar-mode round trip without changing ordinary click selection or vertex dragging. It is a reasonable application-specific shortcut, **not an industry-wide standard**. [1]

Suggested interaction contract (design inference):

- Hover an edge while holding Alt/Option: show a small insertion preview at the projected cursor position and an add-point cursor/hint.
- Alt/Option-click that edge: insert one vertex, activate its ring, and remain in ordinary editing mode. Clicking an existing vertex should not insert a duplicate or delete it.
- Project the preview/insertion onto the straight segment, so inserting alone preserves the outline. Drag the new vertex to change the shape deliberately.
- Preserve ordinary ring selection, existing vertex dragging, Space/middle-button panning, undo/redo, and **Del = remove selected obstruction**. Do not overload Del to remove a point without an explicit point-selection model.
- Preserve Add vertex (+) → edge click as the discoverable, modifier-free route, especially for touch and desktop setups that reserve Alt-click. Do not add shortcut configuration or additional gestures just to accommodate every precedent.

**If the goal is to remove insertion modes altogether**, the strongest alternative is Label Studio's selected-polygon, hover-preview, single-click insertion. Its preview follows the pointer along the edge, rather than forcing a midpoint. [2] This is more discoverable and keyboardless, but changes what an ordinary selected-edge click means and requires careful handling of ring selection, overlapping edges, and dense vertex hit targets. For a larger refinement, a visibly distinct hover “+” that can be clicked or dragged would combine that feedback with Mapbox/JOSM's add-and-position gesture. That combined design is a proposal, not a claim that those applications implement identical behavior. [2, 8, 9]

## How other programs do it

| Program | Required context | Add a vertex to an existing edge | Relevant distinction |
| --- | --- | --- | --- |
| **Labelme** | Edit Shapes; select polygon and hover its edge | **Alt-click**; **Option-click** on macOS | Direct match for the proposed shortcut; insertion can continue into dragging the new vertex. Alt+Shift-click a vertex removes that point. [1] |
| **Label Studio, classic Polygon** | Selected, completed, editable polygon; whole-shape Move transformer inactive | **Single-click edge**, with a hover circle at the projected position | No insertion modifier or separate insert mode. Default circular vertex handles use Alt-click/double-click for point removal, not insertion. [2] |
| **VIA 2.0.12** | Selected polygon; hover edge | **Ctrl/Command-click edge** | Same modifier on a vertex deletes it; in-canvas hover help explains the distinction. This evidence is for VIA 2.x, not an asserted VIA 3.x convention. [3] |
| **CVAT** | Editable polygon with vertex handles | **Shift-click an existing vertex**, draw replacement points, finish on another vertex | A boundary-section retracing/cropping workflow, **not** simple Shift-click edge insertion. Alt-click an existing vertex removes it. [4] |
| **Inkscape 1.4.x** | Node tool editing a path | **Double-click edge**, or **Ctrl+Alt-click edge** | Alt alone selects underneath; Ctrl+Alt-click on a node deletes it. Double-click in the Selector instead enters Node tool. [5] |
| **Adobe Illustrator** | Add Anchor Point tool, or Pen over a selected path with auto-add/delete enabled | **Single-click edge**; **+** selects Add Anchor Point | Auto-switching is tool-scoped, not ordinary Selection behavior. Alt/Option converts anchors with Pen or toggles Add/Delete tools. [6] |
| **Figma** | Vector selected; Enter vector edit; Pen tool (P) | **Single-click existing path** | Move (V) remains for dragging points. Alt-only insertion was not verified. [7] |
| **QGIS 3.44** | Editable layer; Vertex tool | **Shift-double-click segment**, or hover its virtual midpoint, click, move, click | Combines a shortcut with a visible virtual-node route. Alt-click starts polygonal vertex selection, not edge splitting. [8] |
| **JOSM** | Select mode | **Drag the yellow midpoint cross** | Creates and positions a node in one gesture without switching to Draw mode. [9] |
| **Mapbox GL Draw 1.5.0** | Direct-select mode on a line/polygon | **Press/drag a midpoint handle**; source also routes touch-start to it | Inserts the coordinate immediately and selects it for dragging. Fixed midpoints, not arbitrary edge-click placement. [10] |

## Comparing the candidates

These are design tradeoffs inferred from the documented behaviors, not usability measurements.

| Candidate | Advantage | Cost / risk | Fit for Tracefinity |
| --- | --- | --- | --- |
| Alt/Option-click edge | One click; no persistent mode change; exact Labelme precedent | Hidden shortcut; needs keyboard; some desktop window managers intercept Alt+mouse | Smallest shortcut improvement; retain the + fallback |
| Shift-click edge | Same one-click efficiency; avoids the documented Alt window-management conflict | Not universal: CVAT's Shift gesture is section editing, QGIS requires double-click; could compete with future multi-selection | A viable alternative if Alt conflicts on supported desktops, not a convention to claim |
| Double-click edge | No modifier; clear Inkscape precedent | Timing/steady-targeting demand; two ordinary click events precede double-click; must avoid toggling selection or inserting twice | Good desktop alternative, but not necessary alongside the proposed shortcut |
| Click a hover insertion preview | Discoverable, mode-free, keyboardless | Must distinguish insertion from ring selection; hover-only feedback is unavailable on touch | Best candidate for a broader interaction simplification |
| Drag a midpoint | Adds and positions in one gesture; visible affordance | Only starts at midpoints; all midpoints can clutter dense contours | Useful add-and-drag model, less precise for arbitrary edge splitting |

### Why Alt cannot be the only route

Inkscape explicitly warns that “On GNU/Linux, Alt+click and Alt+drag may be reserved by the window manager.” [5] Xfce documents Alt-left-click-and-move for moving windows, and JOSM documents platform-specific Alt interception. [11, 12] This establishes a real compatibility concern, **not** that the user's current desktop intercepts Alt; its actual configuration was not inspected. Xfce's guide also warns that some content needs checking against current behavior, so it should not be generalized to all desktops/releases. Modifier-only input also cannot be the sole route on keyboardless touch devices.

## Fit with the current implementation

The existing [PolygonEditor](../frontend/src/components/PolygonEditor.tsx) already has:

- Cursor-to-image coordinate mapping that accounts for zoom/pan.
- An edge insertion operation routed through undo history.
- Screen-scaled transparent edge hit targets and visible midpoint markers, currently rendered only in Add vertex mode.
- Ordinary click handlers that toggle ring selection, and Space/middle-button pan gestures.

Therefore **loosening the handler's mode guard alone is insufficient**: ordinary editing mode currently does not render the edge insertion targets. A shortcut also needs reliable edge hit-testing in that mode, without stealing ordinary selection clicks or existing vertex drags. A double-click implementation needs to account for the preceding single-click events and avoid duplicate insertion in the existing Add vertex mode. The existing [ToolEditorCanvas](../frontend/src/components/ToolEditorCanvas.tsx) is a separate rendering path; if the same gesture is later adopted for library tool editing, migrate that path too rather than creating different gestures for equivalent editing tasks.

## Evidence and sources

1. **Labelme:** [official editing guide](https://labelme.io/docs/edit-annotated), [keyboard shortcuts](https://labelme.io/blog/keyboard-shortcuts), and [pinned canvas source](https://github.com/wkentaro/labelme/blob/f28ae0d2bcce471d5304fbf11b3be9de46d137ab/labelme/_widgets/_canvas.py). Guide: “To add a point, move over an edge and Alt+click it, using Option on a Mac.” `_maybe_modify_polygon_topology` distinguishes Alt edge insertion from Alt+Shift vertex deletion. [Hover hit-testing](https://github.com/wkentaro/labelme/blob/f28ae0d2bcce471d5304fbf11b3be9de46d137ab/labelme/_widgets/_canvas_interaction.py) prioritizes vertices over edges and scales tolerance with zoom.
2. **Label Studio:** [pinned PolygonRegion source](https://github.com/HumanSignal/label-studio/blob/5c6cf46f50b2530a221cc4d54b1c85e1d74325fd/web/libs/editor/src/regions/PolygonRegion.jsx), `handleLineClick`, `Edge`, `createHoverAnchor`, `Edges`, and `renderCircles`; [PolygonPoint source](https://github.com/HumanSignal/label-studio/blob/5c6cf46f50b2530a221cc4d54b1c85e1d74325fd/web/libs/editor/src/regions/PolygonPoint.jsx). `handleLineClick` requires a closed selected polygon and inserts the projected point; the edge click has no modifier gate. Point-deletion callbacks are verified in the default Circle branch, not every handle style. Whole-shape [Move tool](https://github.com/HumanSignal/label-studio/blob/5c6cf46f50b2530a221cc4d54b1c85e1d74325fd/web/libs/editor/src/tools/Selection.js) uses transformer mode and hides vertex editing. Findings concern classic Polygon, not the separate Vector/Bézier editor.
3. **VIA:** [official 2.0.12 executable demo/source](https://robots.ox.ac.uk/~vgg/software/via/via_demo.html), `_via_reg_canvas_mousedown_handler`, polygon resize branch, and hover help: “To add vertex, press [Ctrl] key and click on the edge.” Source also accepts Meta/Command and refuses deletion below three polygon vertices. [Drawing guide](https://robots.ox.ac.uk/~vgg/software/via/docs/drawing_regions.html) documents selection but does not establish these insertion gestures alone.
4. **CVAT:** [Edit polygon](https://docs.cvat.ai/docs/annotation/manual-annotation/shapes/annotation-with-polygons/edit-polygon/), [Manual drawing](https://docs.cvat.ai/docs/annotation/manual-annotation/shapes/annotation-with-polygons/manual-drawing/), [pinned canvasView source](https://github.com/cvat-ai/cvat/blob/d8193c584be9ce6cf9882dad06c0dd920cc0b9c5/cvat-canvas/src/typescript/canvasView.ts), and [editHandler source](https://github.com/cvat-ai/cvat/blob/d8193c584be9ce6cf9882dad06c0dd920cc0b9c5/cvat-canvas/src/typescript/editHandler.ts). Docs: Shift-click opens polygon editor; source identifies the clicked vertex and combines the replacement section with retained original points. A context-menu tooltip says Alt+double-click, but its active canvas handler and manual guide establish Alt+single-button-press removal; this wording discrepancy should not be copied into a gesture recommendation.
5. **Inkscape:** [keyboard/mouse reference, Node tool](https://inkscape.org/doc/keys.html#id64), [Node Tool Options](https://inkscape-manuals.readthedocs.io/en/latest/node-operations.html). “Double-clicking on the path between nodes creates a node in the click point”; Ctrl+Alt-click adds on an edge and deletes on a node. Alt's meanings and the Linux caveat are separately documented.
6. **Illustrator:** [Add or remove anchor points](https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/modify-paths/add-or-remove-anchor-points.html), [automatic add/delete](https://helpx.adobe.com/illustrator/desktop/draw-shapes-and-paths/modify-paths/turn-off-automatic-addition-or-deletion-of-anchor-points.html), [current shortcut reference](https://helpx.adobe.com/illustrator/using/default-keyboard-shortcuts.html). Current insertion and shortcut pages say + selects Add Anchor Point; an older Anchor Point article's Alt+ shortcut wording is not evidence for Alt+mouse insertion. Prior selection for the explicit Add Anchor Point tool was not established; selected-path prerequisite is explicit for Pen auto-switching.
7. **Figma:** [Edit vector layers](https://help.figma.com/hc/en-us/articles/360039957634-Edit-vector-layers). “To add additional points, select the Pen tool…or press P. Then, click along the vector network's path.” Enter vector-edit and Move/Pen distinctions are documented; no Alt-only insertion claim is made.
8. **QGIS 3.44:** [Vertex tool/basic operations](https://docs.qgis.org/3.44/en/docs/user_manual/working_with_vector/editing_geometry_attributes.html#basic-operations). “To add a vertex to a line or polygon geometry, hold Shift and double-click the place on the segment.” Virtual midpoint and Alt polygon-selection behavior are separately documented.
9. **JOSM:** [Select mode: Drag a Midpoint creates New Node](https://josm.openstreetmap.de/wiki/Help/Action/Select#DragaMidpointcreatesNewNode). “clicking and dragging a yellow cross in the middle of a segment”; inserts a new node at the cross.
10. **Mapbox GL Draw 1.5.0:** [direct_select source](https://github.com/mapbox/mapbox-gl-draw/blob/v1.5.0/src/modes/direct_select.js), `onMidpoint`, `onTouchStart = onMouseDown`, and `onDrag`. Midpoint press calls `feature.addCoordinate`, selects that coordinate, and starts dragging; touch-start shares the handler. This is source evidence, not a mobile usability trial.
11. **Xfce:** [xfwm4 Getting Started: Move windows](https://docs.xfce.org/xfce/xfwm4/getting-started#move_windows), Alt-left-click-and-move. The page includes a freshness caveat.
12. **JOSM:** [platform-specific Alt caveats](https://josm.openstreetmap.de/wiki/Shortcuts#Altkey), including desktop window-manager interception. These are configuration-dependent cautions, not a claim about the user's current setup.
