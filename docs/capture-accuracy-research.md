# Tool-photo capture accuracy: parallax, centering, distance and focal length

Research date: 2026-10-06. This is an optical assessment and capture guide, not an empirical accuracy benchmark of a particular photograph, phone or tracing model. No new photograph, measured tool dimensions or camera calibration were supplied. Numerical results below are **derived ideal-pinhole estimates**; actual errors also depend on contour heights, occlusion, lens correction, paper calibration and segmentation.

## Conclusion

Corner tools can have millimetres to centimetres of height-dependent displacement, even when the corrected paper is perfectly rectangular. For a camera 600 mm above the paper and a feature 200 mm sideways from directly beneath the lens, the displacement relative to that feature's vertical footprint is about **5.1 mm at 15 mm height**, **10.5 mm at 30 mm**, and **18.2 mm at 50 mm**. This is not automatically the dimensional error of the saved tool: some displacement is removable translation; a contour at uniform height remains a uniformly enlarged shape. A tool with different contour heights or visible sidewalls is more vulnerable to genuine shape distortion.

For practical capture, use a batch photograph for thin, flat tools, but retake bulky corner tools individually with the **actual lens physically above the tool**, from farther away and with enough image detail. Centering reduces the additional off-axis deformation; increasing distance also reduces the scale error that remains in centered photographs. Neither cropping nor a stronger tracing model reconstructs an unknown 3D footprint reliably from one silhouette. These are geometric implications of the pinhole and planar-homography models, not measured model-performance claims. [1–3]

## What Tracefinity currently corrects

- [`ImageProcessor.apply_perspective_correction`](../backend/app/services/image_processor.py) estimates one homography from the paper's four corners and warps the full visible image. Its metric reference is the **paper plane**, not the elevated tool surface.
- [`photo_checks.py`](../backend/app/services/photo_checks.py) estimates camera height from paper geometry and 35 mm-equivalent EXIF focal length when available. It warns below 450 mm, using a 15 mm reference tool, and recommends 600 mm or higher. The paper-edge and keystone warnings do not estimate each tool's height-dependent corner error. An unwarned image is not certified accurate.
- [`routes.py`](../backend/app/api/routes.py) caps uploaded and corrected images at 2048 pixels on the longest side. The warp's nominal 10 pixels/mm in `image_processor.py` does not create new captured detail.
- The inspected upload/rectification path does not apply a calibrated lens-distortion map. A phone may have corrected its image already, but residual distortion is unknown without measurements.
- [`docs/usage/uploading-photos.md`](usage/uploading-photos.md) already explains elevated-object scale error and recommends 50–60 cm or more. That is a useful starting point, **not a universal accuracy guarantee** for thick tools or tight fits.

OpenCV's homography derivation explicitly assumes the object-coordinate plane `Z=0`. It cannot remove the extra height contribution of arbitrary raised features; lens undistortion is also a separate operation. [1, 2, 4]

## Quantifying the error

### 1. Elevated-point displacement

Let:

- `H` be the perpendicular height of the camera's projection center above the paper;
- `z` be a contour feature's height above the paper, with `0 ≤ z < H`;
- `C` be the camera's perpendicular projection onto the paper;
- `P` be the feature's true vertical footprint on the paper;
- `r = |P − C|` be its horizontal distance from directly beneath the camera.

After an ideal paper-plane correction, the feature is mapped to the camera ray's intersection with the paper:

```text
P_corrected = C + H/(H − z) · (P − C)
point displacement d = r · z/(H − z)
```

This follows by intersecting the camera-to-feature line with `z=0`. It remains true for a tilted camera after exact paper correction, provided all relevant points are visible and lens distortion is absent/corrected. In the perpendicular setup, the feature's viewing angle satisfies `tan(theta) = r/(H − z)`, so `d = z tan(theta)`. [Derived from 1, 2]

**Camera height 600 mm:**

| Feature height above paper | At r = 100 mm | At r = 200 mm | At r = 300 mm |
|---|---:|---:|---:|
| 5 mm | 0.84 mm | 1.68 mm | 2.52 mm |
| 15 mm | 2.56 mm | 5.13 mm | 7.69 mm |
| 30 mm | 5.26 mm | 10.53 mm | 15.79 mm |
| 50 mm | 9.09 mm | 18.18 mm | 27.27 mm |

Here `r` is a real distance on the table, not a percentage of the image or the corrected crop. For an A4 sheet centered beneath the lens, the paper corners are approximately 182 mm from that point. At 600 mm camera height, a feature above that radius is displaced approximately 4.7 mm at 15 mm elevation or 9.6 mm at 30 mm. Image corners can be farther away when the sheet occupies only part of the frame.

**Do not read this table as “the pocket is this many millimetres too large.”** A uniformly elevated contour scales by the same factor everywhere; its extra off-axis displacement includes a translation that disappears when placing the saved tool. What damages shape is different elevations contributing different shifts, and the silhouette switching between top edges, sidewalls and lower edges.

For two vertically aligned features at heights `z1` and `z2`, their relative paper-referenced displacement is:

```text
q = r · H · |z2 − z1| / ((H − z1)(H − z2))
```

With `z1=0` and `z2=t`, this reduces to `q=r t/(H−t)`, the values in the table. With a uniform-height contour there is no such differential-height term. Neither a single thickness nor one radius predicts the exact silhouette error of an irregular tool.

### 2. Centered scale error remains

For a contour lying at constant height `t`, its linear size is exaggerated by:

```text
scale = H/(H − t)
relative size error = t/(H − t)
```

| Camera height | 15 mm-high contour | 30 mm-high contour | 50 mm-high contour |
|---|---:|---:|---:|
| 300 mm | +5.26% | +11.11% | +20.00% |
| 600 mm | +2.56% | +5.26% | +9.09% |
| 1000 mm | +1.52% | +3.09% | +5.26% |

A centered 200 mm-long outline at 15 mm elevation therefore measures approximately 205.1 mm from 600 mm away: about 2.6 mm extra at each end after centering. A real tool's contour does not necessarily lie at its maximum thickness; these are examples, not a claim about every 15 mm-thick tool.

To keep this constant-height size bias below a fraction `p`, require `H ≥ t(1 + 1/p)`. A 15 mm contour needs approximately **765 mm for 2%**, or **1515 mm for 1%**. A 30 mm contour needs 1530 mm for 2%. Choosing a distant lens position cannot be separated from maintaining adequate image sampling.

### 3. A concrete silhouette example

For an ideal opaque rectangular solid **100 mm long in the radial direction, 40 mm wide and 30 mm high**, viewed from 600 mm above the paper:

- centered beneath the camera: projected silhouette length **105.26 mm**;
- center shifted 200 mm sideways: projected silhouette length **113.16 mm**.

The off-center silhouette includes the near lower edge and far upper edge. The extra length falls from 13.16 mm to 5.26 mm on centering, but does not disappear. If only the uniformly elevated top-face contour were traced, its length would instead be 105.26 mm in both positions, after translation. This illustrates why a point-displacement number and a final cutout-size error must not be conflated. Rounded handles, tapered sections and openings need their own geometry; the example is not an empirical error bound for them.

### 4. Lens distortion and tracing errors are separate

Radial distortion changes scale nonlinearly across the field even for flat objects. It is not the same as depth-dependent perspective/parallax, and a four-corner projective warp cannot generally remove it. Manufacturers document greater distortion risk for wide angular fields, but there is **no justified generic phone distortion percentage** here. Calibration must match the actual camera/lens, capture mode and processing. [3, 4, 6]

Blur, shadows, highlights, paper-corner mistakes and AI mask displacement add further errors. No measured values for those terms are available in this assessment. Better segmentation can improve mask extraction without eliminating the camera geometry.

## When to take a centered retake

The following thresholds are **practical derived screening guidance, not validated acceptance limits**:

1. **Retake thick or mixed-height corner tools for a fitted pocket.** If important low and high contour features could differ by more than your allowed contour error—often about 1 mm for a snug outline—centering is worthwhile. At 600 mm height and 200 mm offset, a 15 mm elevation difference already gives a 5.1 mm displacement signal. It is sufficiently large to justify a retake unless a several-millimetre loose cavity is acceptable.
2. **Treat conspicuous sidewalls, asymmetric handle contours, hidden jaws/openings, or edge cropping as retake signals.** A trace cannot reliably restore unseen geometry. Long tools can remain oblique at their ends even when their midpoint is centered.
3. **Keep batch shots for genuinely flat/thin tools when the required tolerance permits.** Being near a corner does not by itself distort a planar object in the ideal corrected model. Still inspect focus and residual lens distortion there.
4. **Do not rely on clearance to fix shape.** A uniform outward buffer cannot correct an enlarged length, a displaced raised handle, or an incorrectly positioned opening. A generous pocket may work, but that is a different accuracy target.
5. **Reposition physically, not digitally.** Move the tool under the lens or move the camera directly above it while keeping the camera parallel to the paper. Cropping a corner tool to the image center leaves the original rays unchanged. Tilting the phone to put it in the center also leaves the camera's perpendicular foot elsewhere.

For a coarse top-versus-paper displacement budget `e`, `r ≤ e(H−t)/t`. For example, with `H=600 mm`, `t=15 mm`, and `e=1 mm`, this gives `r≤39 mm`. This is a conservative feature-location screen, **not a guarantee on the registered shape or pocket fit**; uniform-height translations may be harmless, while scale bias across a long tool remains.

For valuable tools or a tight fit, compare the trace's length, width and critical local features with caliper/ruler measurements. A useful empirical check is to photograph the same tool centrally and off-center at the same height/lens setting, align the resulting outlines by translation and rotation **without rescaling**, and compare their boundaries and physical dimensions. Rescaling would hide the distance/elevation bias. No such real-photo comparison was performed here.

## Capture protocol

### Positioning

- Keep the paper flat on a rigid surface, select its correct size, and leave all four corners visible. Put tools in the stable orientation they will use in the bin; prevent rocking without introducing an unmeasured raised reference plane.
- Keep the camera sensor parallel to the paper, with the actual lens above the tool or the small batch's center. On phones, the lens is usually displaced from the phone body's center.
- Put the bulkiest tools nearest the camera's perpendicular foot; keep thin flat tools farther out. Separate tools enough that neither silhouettes nor shadows merge.
- Use an overhead stand or copy setup and a timer/remote shutter. This makes height, alignment and framing repeatable and avoids hand-motion blur. Camera manufacturers document timer and alignment aids; these are not metrology guarantees. [10, 12]

These positioning recommendations combine the projection geometry with Basler's guidance on perpendicular, single-plane calibration. A centered tool is not guaranteed orthographic, especially when it is long or thick. [1–3, 8]

### Distance and focal length

- **Start around 0.8–1.0 m for ordinary hand tools if practical**, then check thickness, desired accuracy and actual pixels across the tool. This is a pragmatic starting range, not a manufacturer standard or a guarantee; even 1 m leaves about 3.1% constant-height bias at 30 mm elevation.
- Use the main rear camera rather than an ultrawide/close macro setup as the default. If a genuine telephoto camera gives a sharp, adequately exposed image, use it to preserve framing from farther away. On a separate camera, roughly **50–85 mm full-frame equivalent** is a reasonable starting range for a small overhead setup, subject to field size and available height—not a universally optimal focal length. [Derived from 3, 5, 6]
- **Distance changes perspective; focal length alone does not.** At the same projection center, changing focal length or cropping changes framing but not the depth ratios. Back away first, then choose a lens that gives useful detail. A conventional long lens is not telecentric. [1, 3, 5]
- Do not assume a phone's `2×` button selects a separate optical lens: capture modes may crop a main sensor or switch cameras. For example, Apple documents iPhone 14 Pro's 2× option as the middle 12 megapixels of its 48 MP main sensor, separately from its 3× optical telephoto camera. A native sensor crop need not interpolate, and can improve use of Tracefinity's downscale budget when applied before upload, but does not remove parallax or recover uncaptured detail. [9]
- Check for automatic macro-camera switching and actual edge sharpness. Apple documents Ultra Wide switching at macro distances on supported phones. A sharp main-camera crop can be preferable to an out-of-focus or noisy telephoto capture; inspect the actual image, not just the zoom label. [11]

For illustration, a 36 mm-wide, 3:2 full-frame sensor viewing a 400 mm-wide field requires approximately `H = f·400/36`: a 24 mm lens needs 267 mm distance, a 50 mm lens 556 mm, and a 70 mm lens 778 mm. The ideal 15 mm-height scale errors are respectively 6.0%, 2.8% and 2.0%. **The improvement comes from the greater distance at equal framing.** These are first-order entrance-pupil/projection-center calculations, not phone-specific mechanical-height predictions; different aspect ratios change the equivalent sensor dimension. [5]

### Resolution and lighting

- Keep the tool and full calibration sheet large enough in the final image. At the current 2048-pixel long-edge cap, a rectified 400 mm-long field is approximately 0.20 mm/pixel; 800 mm is 0.39 mm/pixel; 1200 mm is 0.59 mm/pixel. Warping, blur and mask generation can make effective edge accuracy worse. For submillimetre detail, smaller batches generally preserve more useful samples than an entire workbench photograph.
- Use bright, diffuse, reasonably neutral light and a contrasting, matte surrounding surface. Avoid hard cast shadows, specular clipping on metal and mixed strongly colored light. Edmund explicitly warns that shadows can produce false edges and inaccurate measurements; Basler recommends homogeneous, reflection-free calibration lighting. Ensure the tool edges, not just the sheet, are sharply focused. Use ordinary still-photo mode rather than intentional portrait/background blur. [8, 10, 13]
- Increasing distance with the same lens reduces image occupancy. Use an appropriate real lens, or a smaller central batch/crop that still includes the calibration sheet; increasing upload megapixels alone does not bypass the 2048-pixel cap.

The sampling values are arithmetic from the inspected code, not a measured edge-error estimate. Edmund notes that pixels across an object alone do not establish resolved detail: contrast, lighting and optics also matter. Lighting/focus guidance addresses reliable silhouette extraction, not correction of 3D parallax. [13, 14]

## Higher-accuracy limits

Putting a known reference at the same height as a **uniformly elevated planar contour**, then calibrating that reference plane, can remove its particular plane-height bias. It does not solve a tool whose defining contour spans multiple heights, and it should not be mixed with paper-plane scaling without accounting for the plane change. A 3D model/multiple calibrated views or object-space telecentric imaging can address different aspects of that problem. Telecentric systems suppress depth-dependent magnification but require appropriate field coverage, alignment, focus and calibration; large-field optics are not a casual phone upgrade. [1–3, 7]

## Verification and evidence limits

- Evaluated the numerical tables directly and checked the point-displacement formula against **18 independent ray/plane-intersection cases**.
- Exercised actual OpenCV `getPerspectiveTransform` and `perspectiveTransform` on synthetic A4 paper corners and raised points with **four combinations of camera tilt (0°/20°) and focal length in pixels (700/1400)**. The maximum difference from the derived ray/plane formula was **0.000039 mm**. This verifies ideal homography geometry, not physical camera or AI accuracy.
- Projected the eight vertices of the synthetic solid-prism example and checked the stated silhouette extents and uniform-height contrast.
- No CAD generation, live provider calls, physical measurements, real-photo accuracy benchmark or application regression suites were needed or performed for this research-only document. No runtime behavior was changed.

## Primary sources

1. OpenCV, [Camera Calibration and 3D Reconstruction](https://docs.opencv.org/4.13.0/d9/d0c/group__calib3d.html): pinhole model, projection-center geometry, intrinsics and distortion.
2. OpenCV, [Basic concepts of the homography explained with code](https://docs.opencv.org/4.13.0/d9/dab/tutorial_homography.html): planar assumption, `Z=0` derivation and perspective correction.
3. Edmund Optics, [The Advantages of Telecentricity](https://www.edmundoptics.com/knowledge-center/application-notes/imaging/advantages-of-telecentricity/): conventional depth-dependent magnification/parallax and telecentric imaging.
4. OpenCV, [Camera Calibration](https://docs.opencv.org/4.13.0/dc/dbb/tutorial_py_calibration.html): radial/tangential distortion and lens calibration.
5. Edmund Optics, [Understanding Focal Length and Field of View](https://www.edmundoptics.com/knowledge-center/application-notes/imaging/understanding-focal-length-and-field-of-view/): focal length, field size, working distance and first-order calculation limitations.
6. Edmund Optics, [Distortion](https://www.edmundoptics.com/knowledge-center/application-notes/imaging/distortion/): lens distortion versus parallax, nonlinear field dependence and measurement relevance.
7. Opto Engineering, [Telecentric lenses tutorial](https://www.opto-e.com/en/resources/tutorials/telecentric-lenses-tutorial): object-space telecentric geometry, finite telecentricity and large-field practical limitations.
8. Basler, [Calibration vTool](https://docs.baslerweb.com/calibration-vtool): perpendicular setup, measurement-plane height, systematic errors and calibration illumination.
9. Apple, [Apple debuts iPhone 14 Pro and iPhone 14 Pro Max](https://www.apple.com/newsroom/2022/09/apple-debuts-iphone-14-pro-and-iphone-14-pro-max/): native-sensor 2× crop versus separate 3× optical telephoto.
10. Apple, [Use iPhone camera tools to set up your shot](https://support.apple.com/guide/iphone/use-camera-tools-iph3dc593597/ios): focus/exposure controls, grid/level and timer.
11. Apple, [Take macro photos and videos with your iPhone camera](https://support.apple.com/guide/iphone/take-macro-photos-and-videos-iphfaacf2eb0/ios): automatic Ultra Wide switching and close-focus limitations.
12. Nikon, [D3500 self-timer mode](https://onlinemanual.nikonimglib.com/d3500/en/09_more_on_photography_04.html): tripod/stable-surface setup.
13. Edmund Optics, [Common Illumination Types](https://www.edmundoptics.com/knowledge-center/application-notes/illumination/choose-the-correct-illumination/): shadows causing false edges, glare and diffuse lighting.
14. Edmund Optics, [Resolution](https://www.edmundoptics.com/knowledge-center/application-notes/imaging/resolution/): object-space sampling versus actual resolved detail.
