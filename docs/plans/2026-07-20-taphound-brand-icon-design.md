# TapHound Brand Icon Design

**Date:** 2026-07-20
**Status:** Approved
**Visual direction:** HoundMark
**Delivery scope:** Core release suite

## 1. Goal

Establish a cross-platform, developer-friendly brand Icon for TapHound that remains clearly recognizable at small sizes. It primarily serves GitHub repository, README, and npm-release brand display, but it must not be tied to Android because TapHound may eventually support iOS, Web, or other clients.

The Icon needs to express two meanings simultaneously:

- `Hound`: persistent tracking, reliably finding the target.
- `Tap`: user interaction, path recording, and deterministic verification.

This phase only designs the standalone brand mark; it does not extend to a wordmark, README banner, social share image, or a complete visual design system.

## 2. Direction Selection

Three directions were evaluated:

1. **HoundMark (adopted)**: an abstract hound side profile with its nose tip aimed at a tap target. The brand name and product behavior can both hold in a single compact graphic.
2. **TrackHound**: a hound outline formed from path lines; the narrative is complete, but there is too much detail at 16–32 px.
3. **TargetEar**: a hound front face combined with a tap ripple; it reads more like a mascot and is more easily mistaken for a pet product.

HoundMark is the most balanced across legibility, professionalism, small-size performance, and future cross-platform applicability.

## 3. Core Form

The main graphic is an abstract rightward-tracking hound side profile:

- Ear, forehead, and muzzle are formed from a few bold geometric planes creating a continuous forward momentum.
- The nose tip points at an independent tap target, forming the moment of "target found."
- The target is composed of a solid dot and one broken ripple, expressing Tap, recording, and verification complete.
- Clear negative space is retained between the hound and the target, to avoid merging into a generic arrow at small sizes.
- The form uses filled geometric planes and does not rely on thin strokes, fonts, or filters.

No realistic fur, paw prints, Android robots, device frames, code brackets, or `TH` letter initials are used. The Icon must stand as an independent silhouette, not rely on text explanation.

## 4. Composition and Proportion

- Base canvas: `1024 × 1024`, square.
- Safe area: at least `128 px` on all sides; all key outlines must fall within the central `768 × 768` region.
- Circular-crop safe area: the main graphic must fall entirely within a circle centered on the canvas center with a diameter of `768 px`, to fit GitHub avatar cropping.
- Visual center of gravity: the hound occupies about 68% of the graphic width, the tap target about 18%, and the negative space between them about 6–8%.
- Orientation: fixed rightward, representing forward progress along a Journey; no arbitrary mirrored versions.
- Corner radius: the outer outline uses a limited corner radius, avoiding aggressive sharpness while keeping a tool feel rather than a cartoon feel.

At `16 px`, the ripple may be simplified, but the hound's orientation, muzzle, and the target dot must remain recognizable.

## 5. Color System

Primary colors:

- Hound Charcoal: `#1B1D21`
- Tap Orange: `#FF5A1F`
- Trail White: `#FFF8F2`

The standard light Icon uses a warm-white background, a deep-charcoal hound, and an orange target. The dark version uses a deep-charcoal background, a warm-white hound, and an orange target.

Pure-black and pure-white monochrome versions are also provided. A monochrome version cannot distinguish the hound and target by color alone; it must preserve structure through negative space. Gradients, shadows, glows, semi-transparent overlays, and Android-green platform hints are prohibited.

## 6. Deliverable Files

Source files and release assets are stored uniformly under `assets/brand/`:

```text
assets/brand/
├── README.md
├── taphound-icon.svg
├── taphound-icon-dark.svg
├── taphound-mark.svg
├── taphound-mark-mono-dark.svg
├── taphound-mark-mono-light.svg
└── png/
    ├── taphound-icon-1024.png
    ├── taphound-icon-512.png
    ├── taphound-icon-256.png
    ├── taphound-icon-128.png
    ├── taphound-icon-64.png
    └── taphound-icon-32.png
```

File responsibilities:

- `taphound-icon.svg`: the default release Icon on a warm-white square background, serving as the single master version.
- `taphound-icon-dark.svg`: the dark-background version.
- `taphound-mark.svg`: a two-color mark on a transparent background, for README or future layout compositions.
- `taphound-mark-mono-*`: pure-black/pure-white transparent-background marks.
- PNG: exported from the default release Icon using a square canvas; no secondary sharpening that produces white edges.
- `assets/brand/README.md`: records color values, whitespace, minimum size, permitted uses, and prohibited deformations.

The SVG must have an explicit `viewBox="0 0 1024 1024"` and must not contain fonts, external links, scripts, embedded bitmaps, editor-private metadata, or meaningless decimal precision.

## 7. Product Integration

- The README top uses `taphound-mark.svg` with the text title `TapHound` kept alongside, to avoid baking the brand name into the image.
- The GitHub repository avatar uses `taphound-icon-512.png`.
- `taphound-icon-512.png` may serve as an npm organization or account display asset; the npm package itself does not add a non-standard `icon` field.
- The npm tarball includes only `assets/brand/taphound-mark.svg`, ensuring the packaged README still has a usable brand image; other source variants and PNGs do not enter the package body.
- The first-version Android Demo does not replace its app icon with the TapHound brand Icon, to avoid mixing the test fixture with the tool brand.

## 8. Acceptance and Review

The design review uses four view groups:

1. `1024 px`: check geometric relationships, negative space, and visual center of gravity.
2. `128 px`: check the common repository avatar size.
3. `32 px`: check toolbar and small-avatar legibility.
4. Circular crop and light/dark backgrounds: check avatar-platform adaptation.

Automated checks:

- All SVGs are parseable, and canvas and viewBox are consistent.
- SVGs contain no fonts, scripts, external resources, filters, or bitmaps.
- PNG file dimensions, color mode, and transparency conform to the file contract.
- README-referenced asset paths exist.
- The master version uses only the three approved color values.

Manual checks:

- At 16–32 px, "rightward hound + tap target" is still distinguishable.
- Circular cropping does not cut off the ear, muzzle, or tap ripple.
- Structure still holds under grayscale and monochrome conditions.
- It does not resemble a pet store, browser, Android-only tool, or generic play button.
- It is consistent with the brand semantics of `Follow every tap. Catch every regression.`

## 9. Failure Handling

- If the hound and target merge at 32 px, prioritize enlarging the negative space and the target dot; do not add outline detail.
- If the graphic is mistaken for a fox, wolf, or generic arrow, adjust the ear angle, the forehead-to-muzzle ratio, and the nose-tip pause; do not add eyes or realistic features.
- If circular cropping loses key structure, shrink the overall graphic and re-center; do not maintain multiple inconsistent master forms for different platforms.
- If auto-exported PNGs appear blurry or have white edges, re-export from the master SVG; do not hand-edit individual sizes, which causes version drift.

## 10. Completion Criteria

- The HoundMark master form and the orange-black palette form the single approved direction.
- The core SVG, dark version, monochrome versions, and 32–1024 px PNGs are all delivered.
- GitHub circular crop, README, and small-size views pass manual review.
- Assets pass automated checks for structure, dimensions, color values, and referenced paths.
- The README uses the brand mark, but product code, Journey/Report schema, and Android fixture behavior are unaffected.
- Design assets are included in the TapHound local migration audit and completed before the GitHub first-push and npm publish gates.
