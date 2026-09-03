#!/usr/bin/env python3
"""
Convert Zarr file to 8-bit Brotli-compressed binary format for web volume rendering.

Clips intensity values to [min, max] and maps to full 8-bit range [0, 255].

Usage:
    python convert-zarr-to-bin.py -i images/561_registered.zarr -o public/volumes/ --min 200 --max 4000

    # Only convert the first 65 timepoints:
    python convert-zarr-to-bin.py -i images/561_registered.zarr -o public/volumes/ --min 200 --max 4000 --num-volumes 65

Requirements:
    pip install zarr numpy brotli
"""

import argparse
import json
import sys
from pathlib import Path

try:
    import numpy as np
    import zarr
    import brotli
except ImportError as e:
    print(f"Error: Required package not found: {e}")
    print("Please install with: pip install zarr numpy brotli")
    sys.exit(1)


def convert_zarr_to_bin(zarr_path, output_dir, intensity_min, intensity_max, num_volumes=None):
    """
    Convert a Zarr file to 8-bit Brotli-compressed binary format.

    Args:
        zarr_path: Path to input Zarr file
        output_dir: Path for output directory
        intensity_min: Minimum intensity value
        intensity_max: Maximum intensity value
        num_volumes: Number of timepoints to convert (from the start). None = all.

    Returns:
        dict with volume metadata
    """
    print(f"Opening Zarr file: {zarr_path}")

    # Open zarr array
    z = zarr.open(str(zarr_path), mode='r')

    print(f"  Shape: {z.shape}")
    print(f"  Dtype: {z.dtype}")
    print(f"  Chunks: {z.chunks}")

    # Determine dimensions based on zarr metadata
    if hasattr(z, 'attrs') and 'dimension_names' in z.attrs:
        dim_names = z.attrs['dimension_names']
        print(f"  Dimension names: {dim_names}")

    # Shape is (t, z, y, x)
    total_timepoints = z.shape[0]
    depth = z.shape[1]
    height = z.shape[2]
    width = z.shape[3]

    if num_volumes is None or num_volumes >= total_timepoints:
        n_timepoints = total_timepoints
    else:
        n_timepoints = num_volumes

    print(f"  Timepoints: {n_timepoints} of {total_timepoints}")
    print(f"  Volume dimensions: {width} x {height} x {depth}")
    print(f"  Intensity range: [{intensity_min}, {intensity_max}]")

    # Create output directory
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    all_metadata = []

    for t in range(n_timepoints):
        print(f"\nProcessing timepoint {t + 1}/{n_timepoints}...")

        # Read volume data for this timepoint
        volume = z[t, :, :, :]  # Shape: (z, y, x)

        # Get original stats
        orig_min = int(volume.min())
        orig_max = int(volume.max())
        print(f"  Original range: {orig_min} to {orig_max}")

        # Clip to [min, max] and map to 8-bit range [0, 255]
        volume = volume.astype(np.float32)
        clipped = np.clip(volume, intensity_min, intensity_max)
        normalized = (clipped - intensity_min) / (intensity_max - intensity_min)
        output = np.round(normalized * 255).astype(np.uint8)
        volume = output

        # Get final stats
        final_min = int(volume.min())
        final_max = int(volume.max())
        print(f"  Final range: {final_min} to {final_max}")

        # One voxel per byte (no packing needed for 8-bit)
        volume = volume.flatten()

        # Ensure C-contiguous array
        volume = np.ascontiguousarray(volume)

        # Write Brotli-compressed binary
        output_path = output_dir / f"{t:04d}.bin.br"
        print(f"  Writing {output_path.name} (Brotli)...")

        raw_bytes = volume.tobytes()
        compressed = brotli.compress(raw_bytes, quality=11)
        with open(str(output_path), 'wb') as f:
            f.write(compressed)

        compressed_size = output_path.stat().st_size
        raw_size = volume.nbytes
        ratio = compressed_size / raw_size * 100

        print(f"  Size: {raw_size / 1024 / 1024:.2f}MB raw -> {compressed_size / 1024 / 1024:.2f}MB ({ratio:.1f}%)")

        all_metadata.append({
            'file': f"{t:04d}.bin.br",
            'compressedSize': compressed_size,
            'rawSize': raw_size
        })

    # Generate metadata.json
    metadata = {
        'frameCount': n_timepoints,
        'dimensions': [width, height, depth],  # WebGL order
        'dataType': 'uint8',
        'bitDepth': 8,
        'spacing': [1.0, 1.0, 1.0],
        'valueRange': [final_min, final_max],
        'files': [m['file'] for m in all_metadata],
        'compression': 'brotli',
        'processing': {
            'intensityMin': intensity_min,
            'intensityMax': intensity_max,
            'originalDtype': str(z.dtype),
            'converted': '8-bit',
            'totalTimepointsInSource': total_timepoints
        }
    }

    metadata_path = output_dir / 'metadata.json'
    with open(metadata_path, 'w') as f:
        json.dump(metadata, f, indent=2)

    # Summary
    total_raw = sum(m['rawSize'] for m in all_metadata)
    total_compressed = sum(m['compressedSize'] for m in all_metadata)

    print(f"\n{'=' * 50}")
    print(f"Conversion complete!")
    print(f"  Frames: {n_timepoints} of {total_timepoints}")
    print(f"  Dimensions: {width} x {height} x {depth}")
    print(f"  Data type: uint8 (8-bit, 256 levels)")
    print(f"  Compression: Brotli (quality=11)")
    print(f"  Value range: {intensity_min} - {intensity_max}")
    print(f"  Intensity mapping: [{intensity_min}, {intensity_max}]")
    print(f"\nTotal size: {total_raw / 1024 / 1024:.2f}MB raw -> {total_compressed / 1024 / 1024:.2f}MB compressed")
    print(f"Compression ratio: {total_compressed / total_raw * 100:.1f}%")
    print(f"\nOutput: {output_dir}")
    print(f"Metadata: {metadata_path}")

    return metadata


def main():
    parser = argparse.ArgumentParser(
        description='Convert Zarr to 8-bit Brotli-compressed binary for web volume rendering'
    )
    parser.add_argument(
        '--input', '-i',
        required=True,
        help='Input Zarr file path'
    )
    parser.add_argument(
        '--output', '-o',
        default='public/volumes',
        help='Output directory for binary files (default: public/volumes)'
    )
    parser.add_argument(
        '--min',
        type=int,
        required=True,
        help='Minimum intensity value (clipping bound, maps to 0)'
    )
    parser.add_argument(
        '--max',
        type=int,
        required=True,
        help='Maximum intensity value (clipping bound, maps to 255)'
    )
    parser.add_argument(
        '--num-volumes', '-n',
        type=int,
        default=None,
        help='Number of timepoints to convert, starting from the first (default: all)'
    )

    args = parser.parse_args()

    # Resolve paths
    zarr_path = Path(args.input)
    output_dir = Path(args.output)

    if not zarr_path.exists():
        print(f"Error: Zarr file not found: {zarr_path}")
        sys.exit(1)

    if args.min >= args.max:
        print(f"Error: --min ({args.min}) must be less than --max ({args.max})")
        sys.exit(1)

    if args.num_volumes is not None and args.num_volumes < 1:
        print(f"Error: --num-volumes ({args.num_volumes}) must be at least 1")
        sys.exit(1)

    convert_zarr_to_bin(zarr_path, output_dir, args.min, args.max, args.num_volumes)


if __name__ == '__main__':
    main()
