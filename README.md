# Cell Mesh Timeseries Viewer

A Three.js web application for viewing timeseries of 3D meshes and volumetric images. Features scissor-based multi-view rendering, volume ray marching, and interactive playback controls.

## Project Structure

```
├── src/                    # Source code
│   ├── index.html          # Main HTML entry point
│   ├── main.js             # Application orchestration
│   ├── js/                 # JavaScript modules
│   │   ├── SharedRenderer.js
│   │   ├── MeshTimeseriesView.js
│   │   ├── VolumeTimeseriesView.js
│   │   └── ...
│   └── styles/
│       └── style.css
├── public/                 # Static assets (served at root)
│   ├── data/
│   │   ├── meshes/         # GLB mesh files
│   │   └── volumes/        # Binary volume data
│   ├── icons/              # View orientation SVG icons
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

- `ply_to_glb.py` - Converts PLY meshes to optimized GLB format
- `convert-zarr-to-bin.py` - Converts Zarr volumes to Brotli-compressed binary

### Data layout

- **Meshes** (`public/data/meshes/`): one GLB per frame named `<prefix><NNNN>.glb`,
  zero-padded to 4 digits and numbered contiguously (no gaps). Both 0-based
  (`mesh0000.glb`) and 1-based (`mesh0001.glb`) sequences work. Each `.mesh-view`
  in `src/index.html` names the prefix with `data-basepath` (e.g. `data/meshes/mesh`).
  The number of frames is discovered automatically from the server, so swapping in a
  new sequence needs no HTML edits. `data-meshcount` and `data-startindex` are optional
  overrides for the discovered values.
- **Volumes** (`public/data/volumes/`): `metadata.json` plus one `NNNN.bin.br` per
  frame (0-based), both written by `convert-zarr-to-bin.py`. The metadata must be
  valid JSON (watch for trailing commas when editing it by hand); its `files` array is
  the source of truth for the frame count. At runtime every frame's compressed bytes are
  fetched up front, frames are decoded (Brotli + 4-bit unpack) in a pool of Web Workers,
  and each view keeps a single 8-bit `R8` 3D texture that is updated in place. The
  decoded-frame cache size (`maxDecodedFrames`, ~10 MB per frame) and decode-ahead
  window (`prefetchRadius`) are `VolumeTimeseriesView` options.

## Features

- **Multi-view rendering**: Multiple independent 3D views using scissor-based rendering
- **Mesh timeseries**: Animated playback of mesh sequences
- **Volume rendering**: Ray marching with MIP and opacity modes
- **Interactive controls**: Rotate, zoom, and change view angles
- **Colormaps**: Multiple visualization colormaps for volume data
