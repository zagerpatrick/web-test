"""
Convert PLY meshes to GLB format with face colors based on labels.

Face labels are mapped to colors for visualization in Three.js.
Uses flat shading (per-face normals and colors) by duplicating vertices.
Optionally compresses output using meshoptimizer (gltfpack).
"""

import numpy as np
import trimesh
from pathlib import Path
import struct
import subprocess
import tempfile
import shutil
from gltflib import (
    GLTF, GLTFModel, Asset, Scene, Node, Mesh, Primitive,
    Attributes, Accessor, BufferView, Buffer, AccessorType,
    BufferTarget, ComponentType, Material, PBRMetallicRoughness,
    GLBResource
)


# Color mapping for face labels (RGBA, values 0-1)
LABEL_COLORS = {
    0: [0.5, 0.5, 0.5, 1.0],  # Gray (unlabeled/background)
    1: [0.2, 0.6, 1.0, 1.0],  # Blue
    2: [1.0, 0.4, 0.2, 1.0],  # Orange/Red
}


def load_ply_mesh(ply_path: Path) -> trimesh.Trimesh:
    """Load a PLY mesh file."""
    mesh = trimesh.load(ply_path, process=False)
    return mesh


def center_vertices(vertices: np.ndarray) -> np.ndarray:
    """Center vertices at the origin using bounding box center."""
    bbox_min = vertices.min(axis=0)
    bbox_max = vertices.max(axis=0)
    center = (bbox_min + bbox_max) / 2
    return vertices - center


def rotate_vertices_x90(vertices: np.ndarray) -> np.ndarray:
    """
    Rotate vertices 90 degrees around the X-axis.

    Transforms from Z-up coordinate system to Y-up (Three.js convention).
    (x, y, z) -> (x, -z, y)
    """
    rotation_matrix = np.array([
        [1,  0,  0],
        [0,  0, -1],
        [0,  1,  0]
    ], dtype=np.float32)
    return vertices @ rotation_matrix.T


def expand_mesh_for_flat_shading(
    vertices: np.ndarray,
    faces: np.ndarray,
    face_labels: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Expand mesh vertices for flat shading.

    Normals are omitted - Three.js computes them at runtime with flatShading: true.

    Returns:
        expanded_vertices: (num_faces * 3, 3) vertex positions
        expanded_colors: (num_faces * 3, 4) per-vertex colors (RGBA)
        new_indices: (num_faces, 3) new face indices
    """
    num_faces = len(faces)

    # Center vertices at origin
    vertices = center_vertices(vertices)

    # Rotate to match Three.js coordinate system (Y-up)
    vertices = rotate_vertices_x90(vertices)

    # Expand vertices - each face gets its own copy of vertices
    expanded_vertices = vertices[faces.flatten()].astype(np.float32)

    # Expand colors based on face labels
    expanded_colors = np.zeros((num_faces * 3, 4), dtype=np.float32)
    for face_idx, label in enumerate(face_labels):
        color = LABEL_COLORS.get(int(label), LABEL_COLORS[0])
        expanded_colors[face_idx * 3:(face_idx + 1) * 3] = color

    # New indices - sequential
    new_indices = np.arange(num_faces * 3, dtype=np.uint32).reshape(-1, 3)

    return expanded_vertices, expanded_colors, new_indices


def create_glb(
    vertices: np.ndarray,
    colors: np.ndarray,
    indices: np.ndarray,
    output_path: Path
) -> None:
    """
    Create a GLB file from mesh data using gltflib.

    Normals are omitted - Three.js computes them at runtime with flatShading: true.

    Args:
        vertices: (N, 3) float32 vertex positions
        colors: (N, 4) float32 RGBA colors
        indices: (M, 3) uint32 face indices
    """
    # Flatten indices
    indices_flat = indices.flatten().astype(np.uint32)

    # Pack binary data (no normals)
    vertex_data = vertices.astype(np.float32).tobytes()
    color_data = colors.astype(np.float32).tobytes()
    index_data = indices_flat.tobytes()

    # Calculate buffer offsets and sizes
    vertex_offset = 0
    vertex_size = len(vertex_data)

    color_offset = vertex_size
    color_size = len(color_data)

    index_offset = color_offset + color_size
    index_size = len(index_data)

    total_size = index_offset + index_size

    # Combine all binary data
    binary_data = vertex_data + color_data + index_data

    # Calculate bounds for vertices
    v_min = vertices.min(axis=0).tolist()
    v_max = vertices.max(axis=0).tolist()

    # Create GLTF model
    model = GLTFModel(
        asset=Asset(version="2.0", generator="ply_to_glb.py"),
        scene=0,
        scenes=[Scene(nodes=[0])],
        nodes=[Node(mesh=0)],
        meshes=[
            Mesh(
                primitives=[
                    Primitive(
                        attributes=Attributes(
                            POSITION=0,
                            COLOR_0=1
                        ),
                        indices=2,
                        material=0
                    )
                ]
            )
        ],
        materials=[
            Material(
                pbrMetallicRoughness=PBRMetallicRoughness(
                    baseColorFactor=[1.0, 1.0, 1.0, 1.0],
                    metallicFactor=0.0,
                    roughnessFactor=0.8
                ),
                doubleSided=True
            )
        ],
        accessors=[
            # Position accessor
            Accessor(
                bufferView=0,
                byteOffset=0,
                componentType=ComponentType.FLOAT.value,
                count=len(vertices),
                type=AccessorType.VEC3.value,
                min=v_min,
                max=v_max
            ),
            # Color accessor
            Accessor(
                bufferView=1,
                byteOffset=0,
                componentType=ComponentType.FLOAT.value,
                count=len(colors),
                type=AccessorType.VEC4.value
            ),
            # Index accessor
            Accessor(
                bufferView=2,
                byteOffset=0,
                componentType=ComponentType.UNSIGNED_INT.value,
                count=len(indices_flat),
                type=AccessorType.SCALAR.value
            )
        ],
        bufferViews=[
            # Position buffer view
            BufferView(
                buffer=0,
                byteOffset=vertex_offset,
                byteLength=vertex_size,
                target=BufferTarget.ARRAY_BUFFER.value
            ),
            # Color buffer view
            BufferView(
                buffer=0,
                byteOffset=color_offset,
                byteLength=color_size,
                target=BufferTarget.ARRAY_BUFFER.value
            ),
            # Index buffer view
            BufferView(
                buffer=0,
                byteOffset=index_offset,
                byteLength=index_size,
                target=BufferTarget.ELEMENT_ARRAY_BUFFER.value
            )
        ],
        buffers=[
            Buffer(byteLength=total_size)
        ]
    )

    # Create GLTF with embedded binary data
    resource = GLBResource(data=binary_data)
    gltf = GLTF(model=model, resources=[resource])
    gltf.export(str(output_path))


def find_gltfpack() -> str | None:
    """Find gltfpack executable path."""
    # Check common locations
    candidates = [
        Path(__file__).parent.parent / "node_modules" / ".bin" / "gltfpack",
        shutil.which("gltfpack"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return str(candidate)
    return None


def compress_glb(input_path: Path, output_path: Path, gltfpack_path: str, use_draco: bool = False) -> bool:
    """
    Compress a GLB file using gltfpack.

    Args:
        input_path: Path to uncompressed GLB
        output_path: Path to write compressed GLB
        gltfpack_path: Path to gltfpack executable
        use_draco: Use Draco compression (-c) instead of meshopt (-cc)

    Returns:
        True if compression succeeded, False otherwise
    """
    compression_flag = "-c" if use_draco else "-cc"
    try:
        result = subprocess.run(
            [gltfpack_path, "-i", str(input_path), "-o", str(output_path), compression_flag],
            capture_output=True,
            text=True,
            timeout=60
        )
        if result.returncode != 0:
            print(f"  gltfpack warning: {result.stderr}")
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        print("  gltfpack timeout")
        return False
    except Exception as e:
        print(f"  gltfpack error: {e}")
        return False


def convert_ply_to_glb(
    ply_path: Path,
    face_labels: np.ndarray,
    output_path: Path,
    gltfpack_path: str | None = None,
    use_draco: bool = False
) -> None:
    """
    Convert a single PLY file to GLB with face colors.

    Args:
        ply_path: Path to input PLY file
        face_labels: Array of face label values
        output_path: Path to output GLB file
        gltfpack_path: Optional path to gltfpack for compression
        use_draco: Use Draco compression instead of meshopt
    """
    # Load mesh
    mesh = load_ply_mesh(ply_path)
    vertices = np.array(mesh.vertices)
    faces = np.array(mesh.faces)

    # Verify face count matches labels
    if len(faces) != len(face_labels):
        raise ValueError(
            f"Face count mismatch: mesh has {len(faces)} faces, "
            f"labels has {len(face_labels)} entries"
        )

    # Expand mesh for flat shading (normals omitted - computed by Three.js)
    exp_vertices, exp_colors, new_indices = expand_mesh_for_flat_shading(
        vertices, faces, face_labels
    )

    # Create GLB file (possibly to temp location if we'll compress)
    if gltfpack_path:
        with tempfile.NamedTemporaryFile(suffix=".glb", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            create_glb(exp_vertices, exp_colors, new_indices, tmp_path)
            if not compress_glb(tmp_path, output_path, gltfpack_path, use_draco):
                # Fallback to uncompressed if compression fails
                shutil.copy(tmp_path, output_path)
        finally:
            tmp_path.unlink(missing_ok=True)
    else:
        create_glb(exp_vertices, exp_colors, new_indices, output_path)


def batch_convert(
    mesh_dir: Path,
    labels_path: Path,
    output_dir: Path,
    label_colors: dict = None,
    compress: bool = True,
    use_draco: bool = False
) -> None:
    """
    Batch convert all PLY files in a directory to GLB.

    Args:
        mesh_dir: Directory containing PLY mesh files
        labels_path: Path to numpy file with face labels array
        output_dir: Directory to save GLB files
        label_colors: Optional custom color mapping {label: [r, g, b, a]}
        compress: Whether to compress output using gltfpack
        use_draco: Use Draco compression instead of meshopt (smaller but needs decoder)
    """
    global LABEL_COLORS
    if label_colors is not None:
        LABEL_COLORS.update(label_colors)

    # Find gltfpack if compression is requested
    gltfpack_path = None
    if compress:
        gltfpack_path = find_gltfpack()
        if gltfpack_path:
            compression_type = "Draco" if use_draco else "meshopt"
            print(f"Using gltfpack for {compression_type} compression: {gltfpack_path}")
        else:
            print("Warning: gltfpack not found, output will not be compressed")
            print("  Install with: npm install gltfpack")

    # Load face labels
    all_labels = np.load(labels_path, allow_pickle=True)

    # Get sorted list of PLY files
    ply_files = sorted(mesh_dir.glob("*.ply"))

    if len(ply_files) != len(all_labels):
        raise ValueError(
            f"Mismatch: {len(ply_files)} PLY files, {len(all_labels)} label arrays"
        )

    # Create output directory
    output_dir.mkdir(parents=True, exist_ok=True)

    # Convert each mesh
    for i, (ply_path, face_labels) in enumerate(zip(ply_files, all_labels)):
        output_path = output_dir / f"{ply_path.stem}.glb"
        print(f"Converting {i+1}/{len(ply_files)}: {ply_path.name} -> {output_path.name}")

        try:
            convert_ply_to_glb(ply_path, face_labels, output_path, gltfpack_path, use_draco)
        except Exception as e:
            print(f"  Error: {e}")
            continue

    print(f"\nConversion complete. Output saved to: {output_dir}")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Convert PLY meshes to GLB with face-colored labels"
    )
    parser.add_argument(
        "--mesh-dir",
        type=Path,
        required=True,
        help="Directory containing PLY mesh files"
    )
    parser.add_argument(
        "--labels",
        type=Path,
        required=True,
        help="Path to numpy file with face labels"
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Output directory for GLB files"
    )
    parser.add_argument(
        "--no-compress",
        action="store_true",
        help="Skip gltfpack compression"
    )
    parser.add_argument(
        "--draco",
        action="store_true",
        help="Use Draco compression (smaller files, but requires decoder in viewer)"
    )

    args = parser.parse_args()

    batch_convert(
        args.mesh_dir,
        args.labels,
        args.output_dir,
        compress=not args.no_compress,
        use_draco=args.draco
    )
