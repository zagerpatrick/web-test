# Cell Mesh Timeseries Viewer

A Three.js web application for viewing timeseries of 3D meshes and volumetric images. Features scissor-based multi-view rendering, volume ray marching, and interactive playback controls.

## Project Structure

```
├── src/                    # Source code
│   ├── index.html          # Home page (hero mesh viewer + links to the viewer pages)
│   ├── membrane-dynamics.html  # Neutrophil membrane dynamics viewer page
│   ├── main.js             # Application orchestration
│   ├── js/                 # JavaScript modules
│   │   ├── SharedRenderer.js
│   │   ├── MeshTimeseriesView.js
│   │   ├── VolumeTimeseriesView.js
│   │   ├── theme.js        # Light / dark theme toggle
│   │   └── ...
│   ├── icons/              # Camera-preset SVG icons, inlined into the buttons at build time
│   └── styles/
│       ├── viewer.css      # Viewer components (canvas, views, controls) shared by every page
│       ├── style.css       # Viewer page layout and typography
│       └── home.css        # Home page layout and typography
├── public/                 # Static assets (served at root)
│   ├── data/
│   │   ├── meshes/         # GLB mesh files
│   │   └── volumes/        # Binary volume data
│   ├── brotli_wasm.js      # WASM decompression module
│   └── brotli_wasm_bg.wasm
├── raw-data/               # Source data (not deployed)
│   ├── plys/               # Original PLY mesh files
│   └── images/             # Original Zarr volume files
├── scripts/                # Data conversion scripts
├── .github/workflows/      # GitHub Actions for deployment
├── vite.config.js
└── package.json
```

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## Deployment to GitHub Pages

This project is configured for automatic deployment via GitHub Actions.

1. Push your code to the `main` branch
2. Go to your repository Settings > Pages
3. Under "Build and deployment", select "GitHub Actions"
4. The site will deploy automatically on each push to `main`

### Manual Deployment

If you prefer manual deployment:

```bash
npm run build
# Deploy the contents of ./dist to your hosting provider
```

## Data Processing

The `scripts/` directory contains utilities for converting raw data:

- `ply_to_glb.py` - Converts PLY meshes to optimized GLB format and bakes per-vertex
  ambient occlusion into the vertex-colour alpha channel (needs `pip install embreex scipy`
  in the conversion environment; without embree the bake falls back to a ~100x slower
  pure-Python ray caster). Every frame is translated by the same offset, the centre of the
  whole sequence's bounding box (or `--center Z Y X`), so registered meshes keep their
  frame-to-frame positions; the offset and bounds are written to `metadata.json` next to
  the GLBs.
- `convert-zarr-to-bin.py` - Converts Zarr volumes to Brotli-compressed binary

### Data layout

- **Dataset folders** are named `<kind>_<cell>_<YYYYMMDD>`, e.g. `meshes_21_20260731`
  and `volumes_21_20260731`. The label shown above a viewer is derived from that name
  ("20260731 Cell 21") unless a dataset entry in `data-datasets` sets `label` explicitly.
- **Meshes** (`public/data/meshes_<cell>_<date>/`): one GLB per frame named `<prefix><NNNN>.glb`,
  zero-padded to 4 digits and numbered contiguously (no gaps). Both 0-based
  (`mesh0000.glb`) and 1-based (`mesh0001.glb`) sequences work. Each `.mesh-view`
  in `src/membrane-dynamics.html` names the prefix with `data-basepath` (e.g. `data/meshes/mesh`).
  The number of frames is discovered automatically from the server, so swapping in a
  new sequence needs no HTML edits. `data-meshcount` and `data-startindex` are optional
  overrides for the discovered values. Vertex colours follow the Paul Tol palette of the
  MeshVis notebooks (grey `#BBBBBB`, blue `#0077BB`, red `#CC3311`) and their alpha
  channel stores baked ambient occlusion as visibility (`alpha = 1 - ao`). GLBs converted
  before AO baking existed have alpha 1 and simply render without AO darkening until they
  are re-exported (`--no-ao` reproduces that; `--ao-rays` and `--ao-seed` tune the bake).
  `--labels` takes a numpy object array with one entry per frame, either per-vertex
  (`561_labv_corr_list_1.npy`, zero-padded rows; each face takes the majority label of its
  three corners) or per-face (`561_labf_list_1.npy`); `--label-type` forces one reading.
  Frames share one translation (see `metadata.json` in the folder), so the viewer shows
  the registered motion of the cell. The viewer then shifts the whole sequence by one
  more fixed XY offset so the first frame's bounding-box centre sits on the centre of
  the coverslip, and seats the coverslip on that frame's lowest point; later frames
  move relative to it.
- **Autoplay**: `data-autoplay="true"` on a `.mesh-view` or `.volume-view` starts
  playback as soon as every file has loaded (the home page viewer does this at 6 frames
  per second, the starting value of its FPS box).
- **Elapsed time**: `data-frame-interval="6"` (seconds per frame) on a `.mesh-view`
  or `.volume-view` makes the counter beside the timeline show elapsed time as
  `MMm SSs` from 0 at the first frame instead of the frame index.
- **Controls hint**: a `.view-hint` element placed inside a `.mesh-view` or
  `.volume-view` is faded in the first time the pointer enters the view and out again
  8 seconds later (later hovers show nothing); the home page uses it to list the mouse
  and keyboard controls. Views without the element show nothing.
- **Several sequences in one view**: a `.mesh-view` can carry `data-sequences`, a JSON
  array of `{ "basePath", "meshCount"?, "startIndex"? }` objects, instead of a single
  `data-basepath`. The sequences are loaded and played together, aligned at frame 0
  (frame *i* shows file *i* of each sequence); the timeline spans the longest one and a
  shorter sequence disappears once it runs out of frames. A `data-datasets` entry may
  likewise list `sequences` in place of `basePath`. The home page (`src/index.html`)
  shows `meshes_prim_3` and `meshes_prim_21` this way.
- **Absolute positions**: `data-center="false"` (the `centerFrames` option) switches
  off the first-frame centring described above, so meshes exported with
  `--center 0 0 0` keep their positions in the imaging volume and sequences of
  different cells stay in register with each other. The coverslip is then sized to
  1.25 x the scene footprint and seated at its lowest point, and the camera is aimed at
  the scene centre from far enough to fit it. The scene bounds come from the `bounds`
  entry of each sequence's `metadata.json` (written by `ply_to_glb.py`); a sequence
  without that file contributes its first frame's bounding box instead.
  `data-rotation` (the `sceneRotation` option, degrees counterclockwise seen from
  above) turns the meshes and coverslip about the vertical axis, e.g. `90` to lay a
  tall field of view across a wide viewer; the camera presets are unaffected.
  `data-coverslip-scale` sets the slab footprint relative to the scene footprint
  (default 1.25) in absolute mode. The camera distance is divided by the
  `--viewer-zoom` CSS custom property of the view element (default 1; 1.25 brings
  the camera 25% closer), so a stylesheet can set it per viewer and per media query,
  as `home.css` does for phones. `data-axes-size` sets the orientation marker's size
  in pixels (default 120) on any mesh view.
- **Volumes** (`public/data/volumes_<cell>_<date>/`): `metadata.json` plus one `NNNN.bin.br` per
  frame (0-based), both written by `convert-zarr-to-bin.py`. The metadata must be
  valid JSON (watch for trailing commas when editing it by hand); its `files` array is
  the source of truth for the frame count. At runtime every frame's compressed bytes are
  fetched up front, frames are decoded (Brotli + 4-bit unpack) in a pool of Web Workers,
  and each view keeps a single 8-bit `R8` 3D texture that is updated in place. The
  decoded-frame cache size (`maxDecodedFrames`, ~10 MB per frame) and decode-ahead
  window (`prefetchRadius`) are `VolumeTimeseriesView` options.

### Rendering style

The viewers reproduce the napari / MeshVis reference renders; every constant lives in
`src/js/RenderStyle.js`.

- Surfaces use a custom shader (`src/js/MaterialFactory.js`) implementing vispy's
  Blinn-Phong model (ambient 0.75, diffuse 0.30, specular 0.20, shininess 1) lit from a
  fixed view-space direction (up-left, toward the viewer), with no tone mapping. Smooth
  normals are rebuilt at load time from the per-face GLB geometry.
- Baked ambient occlusion darkens the lit colour toward a warm tint
  (`mix(lit, (0.15, 0.13, 0.11), 0.6 * ao)`), like napari's AO overlay layer.
- The coverslip (`src/js/Coverslip.js`) is a translucent `#D3D3D3` slab with a thick
  outline, centred on the origin: a 250 x 250 x 12 pad seated on the first frame's
  lowest point in the mesh views (black outline on white), and 1.25 x the box footprint
  at the bottom face in the volume views (white outline on black). Each view applies one
  fixed XY translation to its whole timeseries so the first frame is centred on the
  slab (meshes: bounding-box centre; volumes: centre of the trimmed bounding box of
  voxels above 20% of the value range in frame 0); every other frame gets the same
  translation, so registration between frames is preserved.
  `MeshTimeseriesView` / `VolumeTimeseriesView` take
  `showCoverslip` and `coverslipOpacity` (plus `coverslipSize` / `coverslipThickness` for
  meshes) and expose `setCoverslipVisible()`; in `membrane-dynamics.html` a `.mesh-view` or
  `.volume-view` element can set `data-coverslip="false"`, `data-coverslip-opacity` and,
  for meshes, `data-coverslip-size` (mesh units).
- Viewer sizes are set by the `--viewer-width` and `--viewer-height` custom
  properties in `viewer.css` (600 x 400px by default, 300px tall on phones); a page or
  wrapper can override them, as the home page does for its 800 x 500px hero viewer.
- **Light / dark theme**: every page colour is a custom property declared in
  `viewer.css` (`--bg`, `--text`, `--panel`, `--accent`, ...). Light (white page, the
  mesh-label blue `#0077BB` as accent) is the default; the `[data-theme="dark"]` block
  swaps in the grey-and-persimmon look. The sun / moon button at the top right of each page
  (`.theme-toggle`, wired by `src/js/theme.js`) flips the attribute on `<html>` and
  remembers the choice in `localStorage`; an inline script in each page's `<head>`
  re-applies it before first paint. The camera-preset icons in `src/icons/` are
  bundled as markup and inlined into the buttons by `main.js`; their cube faces use
  the `--icon-face*` tokens (the accent plus two lighter shades), so they are blue in
  light mode and persimmon in dark. The white and black bands around the canvases are
  not themed because they match the WebGL render backgrounds.
- The volume MIP uses additive blending so it adds onto the slab instead of covering it.

## Features

- **Multi-view rendering**: Multiple independent 3D views using scissor-based rendering
- **Mesh timeseries**: Animated playback of mesh sequences
- **Reference rendering style**: napari / MeshVis look with baked per-vertex ambient
  occlusion and a coverslip slab in both mesh and volume views
- **Volume rendering**: Grayscale Maximum Intensity Projection via ray marching
- **Interactive controls**: Rotate, zoom, and change view angles
- **Display controls**: ImageJ / napari style contrast limits and gamma for volume data
