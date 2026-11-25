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
│   │   ├── MeshLoadPool.js # Loads mesh frames in Web Workers (meshLoadWorker.js)
│   │   ├── deviceProfile.js # Memory plan: full on desktops, low-memory on phones and tablets
│   │   ├── ViewCamera.js   # Orthographic camera, fit-to-coverslip zoom and pan speed shared by both views
│   │   ├── dataSource.js   # Maps `data/...` paths to where the datasets are hosted
│   │   ├── theme.js        # Light / dark theme toggle
│   │   └── ...
│   ├── icons/              # Camera-preset and reset SVG icons, inlined into the buttons at build time
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

- Use `--prune` after re-exporting a mesh sequence with fewer frames, to delete the old
  export's leftover frames from the bucket. The viewer plays the files listed in the
  folder's `metadata.json`, so the leftovers no longer show, but a mesh folder without
  a `metadata.json` has its frames counted on the server and would still play them.
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

What that means for a visitor, and what the viewers add to it:

- **Downloads** are cached by the browser's HTTP cache only; the site keeps nothing
  on disk itself. Within the 4 hours a page refresh, or a switch back to a dataset
  shown earlier, reads every mesh, volume frame and `metadata.json` from that cache
  without a request. After 4 hours the browser asks whether each file has changed
  and downloads only the ones that have.
- **In memory** a viewer holds the dataset it is showing: every mesh frame of a mesh
  viewer; for a volume viewer the compressed bytes of every frame plus up to 16 decoded
  ones. Switching dataset releases all of it. Keeping earlier datasets around would
  make switching back instant but costs about 430 MB per mesh dataset and about
  200 MB per volume dataset, on a page that already holds more than 1 GB. (That is
  the plan for desktops; phones and tablets hold far less, see
  [Memory on phones and tablets](#memory-on-phones-and-tablets).)
- **Preparing a mesh frame** (glTF parsing, meshopt decoding, smooth normals) is not
  something a cache keeps, so it is redone on every load. It runs in Web Workers
  (`src/js/MeshLoadPool.js`), which is why a cached mesh dataset reappears in a
  fraction of a second. Volume frames are likewise decoded in workers, on demand.
- **The list of mesh frames** comes from the folder's `metadata.json`, which is cached
  like any other file. Only a mesh folder without one is counted with `HEAD` requests,
  which no cache keeps (see [Data layout](#data-layout)).

To see a replaced file straight away while checking an upload, purge Cloudflare's
cache as above, then load the page with the browser's own cache switched off
(DevTools > Network > "Disable cache"). A hard reload (Shift + Reload) is not enough:
in Chrome it re-fetches the `metadata.json` files but still takes the frames from
the cache.

### Memory on phones and tablets

A desktop browser lets a page take several GB. A phone does not: iOS ends a tab's
process once it holds around 1.5 GB (less on phones with less RAM, and sooner when
the device as a whole is short of memory) and Safari reloads the page, which fills
up and is ended again, so the page seems to load for a few seconds and then refresh,
over and over. The project page, with every frame of two mesh viewers decoded (about
430 MB each, and as much again on the GPU once drawn) and a volume viewer, is at
that line.

`src/js/deviceProfile.js` therefore picks a memory plan when a page loads. Desktops
get the full plan described above. Phones and tablets (iPhone, iPad, Android), and
any device that reports 4 GB of RAM or less, get the low-memory plan:

- A **mesh viewer** keeps the downloaded file of every frame (about 1 MB each) but
  only a window of decoded frames around the one on show, 64 MB worth (the
  `residentBytes` option of `MeshTimeseriesView`; about 9 frames of the project page's
  meshes). Frames that leave the window are released, on the GPU too, and decoded
  again by the workers when playback or the timeline comes back to them. If decoding
  falls behind, the last frame stays up until the next is ready. A viewer that is
  playing more than a screen away from the visible part of the page keeps its place
  on the timeline but decodes nothing until it comes back.
- A **volume viewer** keeps 5 decoded frames instead of 16 and decodes 2 ahead and
  behind instead of 6. It still holds the compressed bytes of every frame (160 to
  225 MB per dataset), which is now the largest thing in memory.
- Both **worker pools** have 2 workers instead of 3.
- A viewer **starts loading when it comes within one screen height** of the visible
  part of the page, instead of at page load, so a phone downloads and holds only the
  viewers its reader gets to.

With that the project page takes roughly 0.2 GB with its first viewer loaded and
0.5 to 0.65 GB with all three loaded and playing (WebKit, measured on a Mac), against
more than 1 GB for the full plan, and GPU memory stays near 0.1 GB instead of growing
to about 0.85 GB.

On the full plan the viewers load in page order instead: the one at the top of the
page loads alone, with all the bandwidth and every mesh worker, and the others start
when it has finished (`startViews` in `src/main.js`). A waiting viewer that scrolls
onto the screen starts at once.

Append `?memory=low` to a page's address to try the low-memory plan on a desktop,
or `?memory=full` to force the full plan on a device that would get the other.

Both plans give back the memory of a frame the moment it is dropped
(`src/js/releaseBuffers.js`) instead of leaving it to the garbage collector. Safari's
collector does not count arrays that arrive from a worker, as every decoded frame
does, so without this the dropped frames pile up: playing a volume used to grow the
page by about 80 MB a second until a collection happened to run.

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
  cache. The `HEAD` requests with which the mesh viewer counts the frames of a folder
  that has no `metadata.json` are never cached, so those always reach R2.

## Data Processing

The `scripts/` directory contains utilities for converting raw data:

- `ply_to_glb.py` - Converts PLY meshes to optimized GLB format and bakes per-vertex
  ambient occlusion into the vertex-colour alpha channel (needs `pip install embreex scipy`
  in the conversion environment; without embree the bake falls back to a ~100x slower
  pure-Python ray caster). Every frame is translated by the same offset, the centre of the
  whole sequence's bounding box (or `--center Z Y X`), so registered meshes keep their
  frame-to-frame positions; the offset and bounds are written to `metadata.json` next to
  the GLBs. `--num-meshes N` (`-n N`) converts only the first N meshes, in which case the
  offset and bounds cover just those frames; pass `--center` to pin the offset instead.
- `convert-zarr-to-bin.py` - Converts Zarr volumes to Brotli-compressed binary

### Data layout

- **Dataset folders** are named `<kind>_<cell>_<YYYYMMDD>`, e.g. `meshes_21_20260731`
  and `volumes_21_20260731`. A viewer with several datasets shows "Dataset i of n" above
  it, followed by the dataset's name, which is derived from that folder name as cell then
  month/day/year ("Cell 21 07/31/2026") unless a dataset entry in `data-datasets` sets
  `label` explicitly.
- **Meshes** (`public/data/meshes_<cell>_<date>/`): one GLB per frame named `<prefix><NNNN>.glb`,
  zero-padded to 4 digits and numbered contiguously (no gaps). Both 0-based
  (`mesh0000.glb`) and 1-based (`mesh0001.glb`) sequences work. Each `.mesh-view`
  in `src/membrane-dynamics.html` names the prefix with `data-basepath` (e.g. `data/meshes/mesh`).
  The frames are the files named `<prefix><NNNN>.glb` in the `files` list of the folder's
  `metadata.json` (written by `ply_to_glb.py`), played in the order listed, so swapping
  in a new sequence needs no HTML edits. A listed file that is missing from the end of
  the sequence shortens it, with a warning in the console; one missing in the middle
  leaves an empty frame. A folder without a `metadata.json` has its frames counted on
  the server instead, which takes a couple of dozen uncached `HEAD` requests before the
  first mesh can load, and needs the contiguous numbering. `data-meshcount` and
  `data-startindex` are optional overrides. Vertex colours follow the Paul Tol palette of the
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
  A fractional interval (`data-frame-interval="1.1"`) reads `SS.Ss` instead.
  `data-frame-gaps="8:1.9"` lists steps that differ from the interval as
  comma-separated `frame:seconds` pairs (frames counted from 0): here the step from
  frame 8 to frame 9 takes 1.9 s, and every later time shifts with it.
- **Reset view**: the circular-arrow button at the right end of the `.view-buttons`
  bar (added by `main.js` next to the camera presets) animates the camera back to the
  view it starts in: top orientation (or the preset named by `data-initial-view` on a
  `.mesh-view`, e.g. `data-initial-view="front"` on the first membrane-dynamics viewer),
  default zoom, panning undone. On a volume viewer
  it also returns contrast and gamma to their base values (the sliders' `value`
  attributes in the HTML, then the dataset's own presets). The frame being shown and
  playback are not touched.
- **Controls hint**: a `.view-hint` element placed inside a `.mesh-view` or
  `.volume-view` is faded in the first time the pointer enters the view and out again
  8 seconds later (later hovers show nothing); the home page uses it to list the mouse
  and keyboard controls. Views without the element show nothing.
- **Figure captions**: a `.view-caption` element placed last in a viewer wrapper (after
  `.view-progress`) is shown under the viewer, eLife style: a `.caption-label`
  ("Figure 1.") and `.caption-title` in bold, then the description as plain text.
  The numbers are written in the markup, so renumber them when adding a viewer.
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
  the scene centre and zoomed to fit it. The scene bounds come from the `bounds`
  entry of each sequence's `metadata.json` (written by `ply_to_glb.py`); a sequence
  without that file contributes its first frame's bounding box instead.
  `data-rotation` (the `sceneRotation` option, degrees counterclockwise seen from
  above) turns the meshes and coverslip about the vertical axis, e.g. `90` to lay a
  tall field of view across a wide viewer; the camera presets are unaffected.
  `data-coverslip-scale` sets the slab footprint relative to the scene footprint
  (default 1.25) in absolute mode. The default zoom is multiplied by the
  `--viewer-zoom` CSS custom property of the view element (default 1; 1.25 magnifies
  the view by 25%), so a stylesheet can set it per viewer and per media query
  (no page sets it at present). `data-axes-size` sets the orientation marker's size
  in pixels (default 120) on any mesh or volume view, up to 38% of the view's smaller
  side. The marker's axis labels carry a contrasting outline (white around the dark
  labels of the mesh views, black around the light ones of the volume views) so they
  stay readable over the coverslip edges.
- **Volumes** (`public/data/volumes_<cell>_<date>/`): `metadata.json` plus one `NNNN.bin.br` per
  frame (0-based), both written by `convert-zarr-to-bin.py`. The metadata must be
  valid JSON (watch for trailing commas when editing it by hand); its `files` array is
  the source of truth for the frame count. At runtime every frame's compressed bytes are
  fetched up front, frames are decoded (Brotli + 4-bit unpack) in a pool of Web Workers,
  and each view keeps a single 8-bit `R8` 3D texture that is updated in place. The
  decoded-frame cache size (`maxDecodedFrames`, ~10 MB per frame) and decode-ahead
  window (`prefetchRadius`) are `VolumeTimeseriesView` options, which `main.js` sets
  from the memory plan (see [Memory on phones and tablets](#memory-on-phones-and-tablets)).

### Rendering style

The viewers reproduce the napari / MeshVis reference renders; every constant lives in
`src/js/RenderStyle.js`.

- Surfaces use a custom shader (`src/js/MaterialFactory.js`) implementing vispy's
  Blinn-Phong model (ambient 0.75, diffuse 0.30, specular 0.20, shininess 1) lit from a
  fixed view-space direction (up-left, toward the viewer), with no tone mapping. Smooth
  normals are rebuilt at load time from the per-face GLB geometry
  (`src/js/SmoothNormals.js`, run by the mesh load workers).
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
  `showCoverslip`, `coverslipSize` and `coverslipOpacity` (plus `coverslipThickness` for
  meshes) and expose `setCoverslipVisible()`; a `.mesh-view` or `.volume-view` element can
  set `data-coverslip="false"`, `data-coverslip-opacity` and `data-coverslip-size` (a
  square footprint in mesh units, i.e. voxels; the viewers in `membrane-dynamics.html`
  use 200).
- Both views use an orthographic camera (`src/js/ViewCamera.js`), so parallel edges stay
  parallel on screen and line up with the orientation marker. The default zoom fits the
  coverslip seen from above with an 8% margin (`FIT_PADDING`); in absolute mode the mesh
  view fits the scene and its slab from the initial view instead. The fit is redone when
  the viewer is resized, until the user rotates, zooms or pans.
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
