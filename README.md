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
│   │   ├── dataSource.js   # Maps `data/...` paths to where the datasets are hosted
│   │   ├── theme.js        # Light / dark theme toggle
│   │   └── ...
│   ├── icons/              # Camera-preset SVG icons, inlined into the buttons at build time
│   └── styles/
│       ├── viewer.css      # Viewer components (canvas, views, controls) shared by every page
│       ├── style.css       # Viewer page layout and typography
│       └── home.css        # Home page layout and typography
├── public/                 # Static assets (served at root)
│   ├── data/               # Local copy of the datasets (not in git, hosted on R2)
│   │   ├── meshes_<cell>_<date>/   # GLB mesh files
│   │   └── volumes_<cell>_<date>/  # Binary volume data
│   ├── brotli_wasm.js      # WASM decompression module
│   └── brotli_wasm_bg.wasm
├── raw-data/               # Source data (not deployed)
│   ├── plys/               # Original PLY mesh files
│   └── images/             # Original Zarr volume files
├── scripts/                # Data conversion scripts
│   ├── sync-data.mjs       # Uploads public/data/ to the R2 bucket (npm run data:push)
│   └── r2-cors.json        # CORS policy of the R2 bucket
├── .github/workflows/      # GitHub Actions for deployment
├── .env.production         # URL of the data host used by production builds
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

Only the site itself (a few MB) is deployed this way. The datasets are served from
Cloudflare R2 and are uploaded separately, see [Data hosting](#data-hosting-cloudflare-r2).

### Manual Deployment

If you prefer manual deployment:

```bash
npm run build
# Deploy the contents of ./dist to your hosting provider, leaving out ./dist/data
# (a local build copies public/data/ there, but the built site does not read it)
```

## Data hosting (Cloudflare R2)

The datasets are too large for GitHub Pages (1 GB site limit, 10 minute deploy limit),
so they are neither in git nor in the site build. They live in a Cloudflare R2 bucket,
`patrickzager-data`, which is served at `https://data.patrickzager.com/`.

- **Paths**: pages keep naming datasets by a path under `data/`
  (`data/meshes_21_20260731/mesh`). `src/js/dataSource.js` swaps that prefix for the
  data host. Production builds take the host from `VITE_DATA_BASE_URL` in
  `.env.production`; `npm run dev` does not read that file, so the same paths load from
  the local `public/data/` folder.
- **Bucket layout**: the bucket mirrors `public/data/`. The file
  `public/data/<folder>/<file>` is the object `<folder>/<file>`, served at
  `https://data.patrickzager.com/<folder>/<file>`.

### Adding or changing a dataset

1. Convert it into `public/data/<folder>/` (see [Data Processing](#data-processing))
   and check it with `npm run dev`.
2. Upload it with `npm run data:push`. Only new and changed files are sent.
3. Commit and push the page changes that use it. Do this after the upload, so the
   deployed page never points at files that are not there yet.

Options go after a `--`:

```bash
npm run data:push -- --dry-run              # show what would be uploaded, change nothing
npm run data:push -- meshes_21_20260731     # only this dataset folder
npm run data:push -- --prune                # also delete bucket files whose local file is gone
npm run data:push -- --all                  # upload everything again
```

- Use `--prune` after re-exporting a mesh sequence with fewer frames. The viewer counts
  frames by probing the server, so leftover frames from the old export would still play.
- The script uploads through [Wrangler](https://developers.cloudflare.com/workers/wrangler/),
  Cloudflare's CLI, which `npx` downloads on first use. Log in once with
  `npx wrangler login`.
- Wrangler cannot list a bucket, so the script records what it has uploaded in
  `.r2-sync-state.json` (not in git). Without that file, for example in a fresh clone,
  the next push uploads everything again. Files changed in the bucket by other means
  are not noticed; `--all` puts the bucket back in step with the local folder.

### Caching

Files are uploaded with `Cache-Control: public, max-age=14400` (the `CACHE_CONTROL`
constant in `scripts/sync-data.mjs`), so browsers and Cloudflare's cache reuse them
for up to 4 hours. New files are live straight away. A file replaced under the same
name can be served stale for that long; to refresh it sooner, purge the cache in the
Cloudflare dashboard: the `patrickzager.com` zone > Caching > Configuration > Purge
Cache > Custom Purge > Hostname > `data.patrickzager.com`.

### Working without the local data

A clone has no `public/data/`. To run the dev server against the hosted data, create
`.env.local` (not in git) containing:

```
VITE_DATA_BASE_URL=https://data.patrickzager.com/
```

Production builds are unaffected, because `.env.production` takes priority over
`.env.local`. To make a production build read the local folder instead, run
`VITE_DATA_BASE_URL=data/ npm run build`.

### Bucket setup (one-time, kept for reference)

```bash
npx wrangler login
npx wrangler r2 bucket create patrickzager-data
npx wrangler r2 bucket cors set patrickzager-data --file scripts/r2-cors.json
npx wrangler r2 bucket domain add patrickzager-data --domain data.patrickzager.com --zone-id <zone ID of patrickzager.com>
```

- The CORS policy lets any website read the files with `GET` and `HEAD`. They are
  public anyway, and this keeps the dev server working on any port. To limit it to
  the site, replace `"*"` in `scripts/r2-cors.json` with `"https://patrickzager.com"`
  (plus any dev origins such as `"http://localhost:5173"`) and run the `cors set`
  command again.
- Cloudflare only caches some file types by default, and `.glb`, `.br` and `.json` are
  not among them. A cache rule in the `patrickzager.com` zone (Caching > Cache Rules,
  "Cache the R2 data bucket") makes it cache the data: when the hostname equals
  `data.patrickzager.com`, cache eligibility is "Eligible for cache". How long a file
  stays cached follows its `Cache-Control` header (see [Caching](#caching)). Without
  the rule everything still works, but every download is read from R2 instead of the
  cache. The `HEAD` requests the mesh viewer uses to count frames are never cached,
  so those always reach R2.

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
