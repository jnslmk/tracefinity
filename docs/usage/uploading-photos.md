# Uploading Photos

## Paper as a size reference

Tracefinity uses one known-size sheet of paper to scale outlines to real-world dimensions. Where practical, place all wanted tools on the same A4, Letter, A3, or Tabloid sheet, rather than beside it. Keep unrelated neighboring tools out of the frame, and do not stack or tile sheets as a substitute for one known rectangle.

The paper is for scale only. Tools can overflow the paper edges; the full visible area beyond the paper is included in the corrected image. Oversized or bulky overhanging tools are better photographed alone or on a supported larger sheet, with all four paper corners and the complete tool visible.

## Tips for good results

- **Contrasting background** -- use a dark surface under white paper (or vice versa). The AI needs to distinguish paper edges from the background.
- **Even lighting and focus** -- use diffuse light without harsh shadows or glare. Focus on the tools and use a stable overhead stand or tripod to avoid blur.
- **Flat batches, bulky tools separately** -- batch thin, flat tools without overlap, leaving gaps between them. Photograph thick tools or raised handles separately, centered under the actual camera lens.
- **Shoot from above** -- keep the camera parallel to the paper and all four corners visible. Perspective correction handles some angle, but cannot remove the effects of a tool raised above the paper.
- **Move farther away** -- 80-100 cm from the paper is a practical starting point, not an accuracy guarantee. Keep enough real image detail to see tool edges. Use the main camera or a genuine optical telephoto lens that still gives useful detail, rather than an ultrawide camera close up. Digital zoom or cropping alone does not change capture distance or recenter a tool under the lens.

## Photo warnings

After you confirm the paper corners, Tracefinity shows advisory photo-wide checks:

- **Camera too close** -- a rough camera-to-paper distance estimate uses EXIF 35 mm-equivalent focal length and the paper's apparent size. Missing EXIF (common in edited images and screenshots) skips this check; it does not mean the distance is acceptable.
- **Paper cut off** -- a paper corner sits at or beyond the photo edge.
- **Extreme perspective** -- a strong camera angle degrades edge accuracy even after correction.

Warnings are advisory: you can dismiss them and continue. They do not measure tool height or certify outline accuracy or physical cutout fit.

### Per-tool rephotography advice

After automatic or manual-mask tracing, the edit step lists advice by tool name; hover or focus a tool's advice to identify its outline. Advice follows outline edits, renames, additions and deletions, and is available when reopening sessions with capture-frame metadata.

- **Near the source photo edge** -- an outline within 2 source pixels of an ingested photo edge is potentially clipped. Check completeness and rephotograph if parts are missing; edge contact alone does not prove clipping, and thick tools may also need a centered shot.
- **Outer-frame position** -- any outline point in the outer 15% along either original frame axis triggers a conservative position heuristic, not a measured error. Rephotograph centered if the tool is thick or raised; thin, flat tools may be acceptable but are not verified accurate.
- **No position flags** -- only these position checks passed. Tool heights, blur, segmentation quality and lens distortion remain unassessed; camera distance has only the separate EXIF advisory where available.

Older sessions without capture-frame metadata show position advice as unavailable, rather than guessing from the corrected image's center. Advice never blocks saving, changes outlines or deselects tools, and these checks make no provider calls.

To rephotograph, return to the home upload, put the raised tool under the actual lens, keep the camera parallel to the paper, move farther away while retaining useful detail, and include all four corners and the complete tool. Cropping an existing corner tool is not a new centered capture.

## Supported formats

JPG, PNG, WebP, and HEIC. Uploads are limited to 20 MB and 64 megapixels by
default. Self-hosted instances can tune these limits with `MAX_UPLOAD_MB` and
`MAX_IMAGE_PIXELS`.

Images are automatically downscaled to a maximum of 2048px on the longest edge. Original uploads are deleted after perspective correction; only the corrected image is retained.

## Paper size

After uploading, select A4, Letter, A3, or Tabloid. Pick whichever you actually used. This determines the scale of everything downstream: tool outlines, bin dimensions, and exported STL geometry.

## Troubleshooting

- **Cutout comes out a few percent larger than the tool** -- a close capture can contribute: the paper is on the table, but a raised tool outline is nearer the camera and projects oversized. Rephotograph the tool centered from farther away (80-100 cm is a practical start), then inspect the trace and check real dimensions; distance alone does not guarantee fit.
