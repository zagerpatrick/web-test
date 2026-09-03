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

## Features

- **Multi-view rendering**: Multiple independent 3D views using scissor-based rendering
- **Mesh timeseries**: Animated playback of mesh sequences
- **Volume rendering**: Ray marching with MIP and opacity modes
- **Interactive controls**: Rotate, zoom, and change view angles
- **Colormaps**: Multiple visualization colormaps for volume data
