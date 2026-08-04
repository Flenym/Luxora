# Luxora brand assets

**Release:** Beta-0.1  
**Owner and developer:** Flenym

- `../../logo.png` is the canonical supplied raster logo and must not be
  replaced, recoloured, stretched, or reinterpreted.
- `luxora-logo-transparent-final.png` is the background-extracted RGBA master
  for future compositing. It is 1254 × 1254 and preserves the original square
  canvas and mark placement.
- `luxora-loader-route.svg` contains the reviewed closed motion route derived
  from the outer and internal ribbon edges. It is geometry only: the loader
  must not render the full path or use it as a visible replacement logo.

The transparent master was produced non-destructively from the supplied logo.
The original remains the source of truth. Client build pipelines should derive
platform sizes from the master without committing another manually edited logo.
Loader implementations show only two moving points and their short trails; the
logo image, full silhouette and idle route remain invisible.

The loader motion contract is
[`docs/specs/BRAND_LOADING_MOTION.md`](../../docs/specs/BRAND_LOADING_MOTION.md).
The standalone, non-product preview is
[`design-previews/brand-loader/index.html`](../../design-previews/brand-loader/index.html).
