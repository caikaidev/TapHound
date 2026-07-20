# TapHound HoundMark

HoundMark is TapHound's fixed right-facing brand mark: a geometric hound profile following a tap target. The default icon uses a warm square background; transparent and monochrome marks are provided for layout integration.

## Palette

- Hound Charcoal: `#1B1D21`
- Tap Orange: `#FF5A1F`
- Trail White: `#FFF8F2`

## Geometry and spacing

- Canvas: `1024 × 1024`.
- Safe area: at least `128 px` on every side; important geometry stays within the central `768 × 768` area and its circular avatar crop.
- Minimum recommended display size: `32 px`.
- Orientation is fixed facing right. Use the same proportions in every context.

## Usage

- Use `taphound-icon.svg` on light surfaces and `taphound-icon-dark.svg` on dark surfaces.
- Use `taphound-mark.svg` when a transparent background is required.
- Use the matching dark or light monochrome mark only when color is unavailable.
- Export PNG sizes from `taphound-icon.svg` with `npm run brand:render`; do not edit PNG files individually.

Do not stretch, recolor, rotate, mirror, crop into the safe area, add shadows, add gradients, or alter the hound-to-target spacing.
