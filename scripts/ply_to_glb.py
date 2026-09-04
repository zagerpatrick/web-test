"""
Convert PLY meshes to GLB format with face colors based on labels.

Labels come from a numpy object array with one entry per frame, either
per-vertex (e.g. ``561_labv_corr_list_1.npy``, rows zero-padded to the largest
vertex count) or per-face (``561_labf_list_1.npy``). Vertex labels are turned
into face labels by majority vote over each face's three vertices, and each
face label is mapped to a colour for visualization in Three.js.
Vertices are duplicated per face so every face keeps a crisp label colour;
normals are omitted and rebuilt (smooth) by the viewer at load time.

Every frame of a sequence is translated by the SAME offset (the centre of the
bounding box of the whole sequence, or --center), so registered meshes keep
their frame-to-frame positioning in the viewer. The offset and the sequence
bounds are written to <output-dir>/metadata.json.

Per-vertex ambient occlusion (AO) is baked with the same cosine-weighted
hemisphere ray casting as lsprocess.mesh_vis.napari_ao and stored in the
alpha channel of COLOR_0 as *visibility*: alpha = 1 - ao (1.0 = fully exposed,
0.0 = fully occluded). The viewer's surface shader reads it back; files without
baked AO have alpha 1 and render without AO darkening. Uses embree
(`pip install embreex`) when available; the pure-Python fallback is ~100x slower.

Optionally compresses output using meshoptimizer (gltfpack), which keeps the
RGBA vertex colours as 8-bit normalized VEC4.
"""

import json
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


# Color mapping for face labels (RGBA, values 0-1): the Paul Tol palette used by
# MeshVis (cm3 / cm4): grey #BBBBBB, blue #0077BB, red #CC3311
LABEL_COLORS = {
    0: [187 / 255, 187 / 255, 187 / 255, 1.0],  # #BBBBBB grey (unlabeled/background)
    1: [0 / 255, 119 / 255, 187 / 255, 1.0],    # #0077BB blue
    2: [204 / 255, 51 / 255, 17 / 255, 1.0],    # #CC3311 red
    3: [66 / 255, 66 / 255, 66 / 255, 1.0],     # #424242 dark grey (cm4 class 3)
}


def vertex_to_face_labels(vertex_labels: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """
    Majority vote of each face's three vertex labels.

    A face whose vertices carry two or three copies of one label gets that label;
    a face with three different labels gets the smallest of them, so the result is
    deterministic. Boundary faces between two labelled regions therefore snap to
    whichever label two of their corners share.
    """
    corner_labels = np.sort(np.asarray(vertex_labels)[faces], axis=1)  # (F, 3)
    return np.where(corner_labels[:, 1] == corner_labels[:, 2], corner_labels[:, 1], corner_labels[:, 0])


def resolve_face_labels(labels: np.ndarray, mesh: trimesh.Trimesh, label_type: str = "auto") -> tuple[np.ndarray, str]:
    """
    Return per-face labels for ``mesh`` from either face or vertex labels.

    Args:
        labels: one frame's label array (face labels, or vertex labels possibly
            zero-padded beyond the vertex count)
        mesh: the frame's mesh
        label_type: "face", "vertex", or "auto" (face when the length equals the
            face count, otherwise vertex)

    Returns:
        (face_labels, kind) with kind in {"face", "vertex"}
    """
    labels = np.asarray(labels).astype(np.int64)
    n_faces = len(mesh.faces)
    n_verts = len(mesh.vertices)
    kind = label_type
    if kind == "auto":
        kind = "face" if len(labels) == n_faces else "vertex"
    if kind == "face":
        if len(labels) != n_faces:
            raise ValueError(f"Face count mismatch: mesh has {n_faces} faces, labels has {len(labels)} entries")
        return labels, kind
    if len(labels) < n_verts:
        raise ValueError(f"Vertex label array too short: mesh has {n_verts} vertices, labels has {len(labels)} entries")
    return vertex_to_face_labels(labels[:n_verts], mesh.faces), kind

# Ambient occlusion defaults (match lsprocess.mesh_vis.napari_ao.bake_ambient_occlusion)
AO_RAYS = 32
AO_SEED = 0

_warned_no_embree = False


def bake_ambient_occlusion(mesh: trimesh.Trimesh, n_rays: int = AO_RAYS, seed: int = AO_SEED) -> np.ndarray:
    """
    Bake per-vertex ambient occlusion via cosine-weighted hemisphere rays.

    Returns a float32 array of length len(mesh.vertices) in [0, 1], where 1 is
    fully occluded (deep cavity) and 0 is fully exposed (open hemisphere).

    At each vertex, n_rays directions are drawn from a cosine-weighted hemisphere
    around the vertex normal (Malley's method) and the fraction that hits any face
    of the mesh is the AO value. Ray origins are nudged outward by
    1e-5 * bbox_diag so vertices do not self-intersect their incident faces.
    Verbatim port of lsprocess.mesh_vis.napari_ao.bake_ambient_occlusion.
    """
    global _warned_no_embree
    rng = np.random.default_rng(seed)

    # Cosine-weighted hemisphere samples around +Z (Malley's method)
    u1 = rng.random(n_rays)
    u2 = rng.random(n_rays)
    r = np.sqrt(u1)
    theta = 2.0 * np.pi * u2
    h = np.column_stack(
        [r * np.cos(theta), r * np.sin(theta), np.sqrt(np.maximum(0.0, 1.0 - u1))]
    ).astype("float64")

    verts = np.asarray(mesh.vertices, dtype="float64")
    norms = np.asarray(mesh.vertex_normals, dtype="float64")

    # Per-vertex orthonormal frame (t, b, n)
    ref = np.tile(np.array([1.0, 0.0, 0.0]), (len(norms), 1))
    swap = np.abs(norms[:, 0]) > 0.9
    ref[swap] = np.array([0.0, 1.0, 0.0])
    t = np.cross(norms, ref)
    t /= np.linalg.norm(t, axis=1, keepdims=True) + 1e-12
    b = np.cross(norms, t)

    # Offset origins outward to avoid self-intersection at the source vertex
    bbox_diag = float(np.linalg.norm(mesh.extents))
    eps = bbox_diag * 1e-5
    origins = verts + norms * eps

    # World-space ray directions: h.x * t + h.y * b + h.z * n, broadcast over vertices
    dirs = (
        h[None, :, 0:1] * t[:, None, :]
        + h[None, :, 1:2] * b[:, None, :]
        + h[None, :, 2:3] * norms[:, None, :]
    )
    origins_flat = np.repeat(origins, n_rays, axis=0)
    dirs_flat = dirs.reshape(-1, 3)

    try:
        from trimesh.ray.ray_pyembree import RayMeshIntersector

        intersector = RayMeshIntersector(mesh)
    except Exception:
        if not _warned_no_embree:
            print("  WARNING: embree not available (pip install embreex); "
                  "falling back to the pure-Python ray caster, which is ~100x slower")
            _warned_no_embree = True
        intersector = mesh.ray

    hits = intersector.intersects_any(origins_flat, dirs_flat)
    return hits.reshape(-1, n_rays).mean(axis=1).astype("float32")


def load_ply_mesh(ply_path: Path) -> trimesh.Trimesh:
    """Load a PLY mesh file."""
    mesh = trimesh.load(ply_path, process=False)
    return mesh


def bbox_center(vertices: np.ndarray) -> np.ndarray:
    """Bounding-box centre of a vertex array, in the array's own axis order."""
    return (vertices.min(axis=0) + vertices.max(axis=0)) / 2


def sequence_bounds(ply_files: list[Path]) -> tuple[np.ndarray, np.ndarray]:
    """
    Bounding box enclosing every frame of a sequence, in (z, y, x) array order.

    Returns (min_corner, max_corner). Centring all frames on the middle of this
    box keeps registered meshes in their true relative positions.
    """
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    for ply_path in ply_files:
        bounds = load_ply_mesh(ply_path).bounds
        lo = np.minimum(lo, bounds[0])
        hi = np.maximum(hi, bounds[1])
    return lo, hi


def reorder_vertices_zyx_to_xyz(vertices: np.ndarray) -> np.ndarray:
    """
    Reorder vertex coordinates from array-index order to world order.

    Meshes extracted from the (z, y, x) volume arrays (e.g. marching cubes)
    store vertices as (z, y, x). The viewer uses the same frame as the volume
    view: world X = x, world Y = y, world Z = z (Z-up), so swap the first and
    last coordinates: (z, y, x) -> (x, y, z).

    Note: swapping two axes is a reflection, so face winding must be flipped
    alongside this to keep normals pointing outward (see
    expand_mesh_for_flat_shading).
    """
    return vertices[:, [2, 1, 0]]


def expand_mesh_for_flat_shading(
    vertices: np.ndarray,
    faces: np.ndarray,
    face_labels: np.ndarray,
    vertex_ao: np.ndarray | None = None,
    center: np.ndarray | None = None
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Expand mesh vertices so every face owns its three vertices.

    Normals are omitted - the viewer rebuilds smooth normals at load time by
    merging vertices that share a position.

    Args:
        vertices: (N, 3) vertex positions in (z, y, x) array order
        faces: (M, 3) face indices
        face_labels: (M,) integer label per face, mapped through LABEL_COLORS
        vertex_ao: optional (N,) per-vertex ambient occlusion in [0, 1]
            (1 = occluded). Stored as visibility in the colour alpha channel:
            alpha = 1 - ao. Alpha stays 1.0 when omitted.
        center: (3,) offset in (z, y, x) order subtracted from every vertex.
            Pass the same value for every frame of a sequence to preserve
            registration. Defaults to this frame's own bounding-box centre,
            which re-centres each frame independently (legacy behaviour).

    Returns:
        expanded_vertices: (num_faces * 3, 3) vertex positions
        expanded_colors: (num_faces * 3, 4) per-vertex colors (RGBA)
        new_indices: (num_faces, 3) new face indices
    """
    num_faces = len(faces)

    # Translate by the shared sequence offset (or this frame's own centre)
    if center is None:
        center = bbox_center(vertices)
    vertices = vertices - np.asarray(center, dtype=vertices.dtype)

    # Map (z, y, x) array order onto world (x, y, z) to match the volume view
    vertices = reorder_vertices_zyx_to_xyz(vertices)

    # The axis swap above is a reflection; reverse winding so normals stay outward
    faces = faces[:, [0, 2, 1]]

    # Expand vertices - each face gets its own copy of vertices
    expanded_vertices = vertices[faces.flatten()].astype(np.float32)

    # Expand colors based on face labels
    expanded_colors = np.zeros((num_faces * 3, 4), dtype=np.float32)
    for face_idx, label in enumerate(face_labels):
        color = LABEL_COLORS.get(int(label), LABEL_COLORS[0])
        expanded_colors[face_idx * 3:(face_idx + 1) * 3] = color

    # Alpha channel carries visibility (1 - AO) of each expanded vertex's source vertex
    if vertex_ao is not None:
        visibility = 1.0 - np.clip(np.asarray(vertex_ao, dtype=np.float32), 0.0, 1.0)
        expanded_colors[:, 3] = visibility[faces.flatten()]

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
    labels: np.ndarray,
    output_path: Path,
    gltfpack_path: str | None = None,
    use_draco: bool = False,
    ao_rays: int = AO_RAYS,
    ao_seed: int = AO_SEED,
    center: np.ndarray | None = None,
    label_type: str = "auto"
) -> None:
    """
    Convert a single PLY file to GLB with face colors and baked AO.

    Args:
        ply_path: Path to input PLY file
        labels: This frame's labels, per face or per vertex (see resolve_face_labels)
        output_path: Path to output GLB file
        gltfpack_path: Optional path to gltfpack for compression
        use_draco: Use Draco compression instead of meshopt
        ao_rays: Hemisphere rays per vertex for the AO bake; 0 disables AO
        ao_seed: RNG seed for the AO ray directions
        center: (3,) shared (z, y, x) offset subtracted from the vertices; None
            re-centres this frame on its own bounding box
        label_type: "auto", "vertex" or "face" (how to read ``labels``)
    """
    # Load mesh
    mesh = load_ply_mesh(ply_path)
    vertices = np.array(mesh.vertices)
    faces = np.array(mesh.faces)

    # Per-face labels (vertex labels are majority-voted per face)
    face_labels, kind = resolve_face_labels(labels, mesh, label_type)
    classes, counts = np.unique(face_labels, return_counts=True)
    print(f"  labels: {kind} -> faces " + ", ".join(f"{int(c)}: {int(n)}" for c, n in zip(classes, counts)))

    # Bake per-vertex AO on the mesh as loaded (translation and the axis swap
    # below do not change occlusion)
    vertex_ao = None
    if ao_rays > 0:
        vertex_ao = bake_ambient_occlusion(mesh, n_rays=ao_rays, seed=ao_seed)
        mean_ao = float(vertex_ao.mean())
        print(f"  AO: mean {mean_ao:.3f}, max {float(vertex_ao.max()):.3f} ({ao_rays} rays/vertex)")
        if mean_ao > 0.8:
            print("  WARNING: nearly everything is occluded; the mesh normals may point inward")

    # Expand mesh per face (normals omitted - rebuilt by the viewer)
    exp_vertices, exp_colors, new_indices = expand_mesh_for_flat_shading(
        vertices, faces, face_labels, vertex_ao, center
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
    use_draco: bool = False,
    ao_rays: int = AO_RAYS,
    ao_seed: int = AO_SEED,
    center: np.ndarray | None = None,
    label_type: str = "auto"
) -> None:
    """
    Batch convert all PLY files in a directory to GLB.

    Every frame is translated by one shared offset so registered sequences keep
    their frame-to-frame positioning: the centre of the bounding box of the
    whole sequence by default, or ``center`` when given. The offset and the
    sequence bounds are recorded in ``<output_dir>/metadata.json``.

    Args:
        mesh_dir: Directory containing PLY mesh files
        labels_path: Path to numpy file with face labels array
        output_dir: Directory to save GLB files
        label_colors: Optional custom color mapping {label: [r, g, b, a]}
        compress: Whether to compress output using gltfpack
        use_draco: Use Draco compression instead of meshopt (smaller but needs decoder)
        ao_rays: Hemisphere rays per vertex for the AO bake; 0 disables AO
        ao_seed: RNG seed for the AO ray directions
        center: Optional (3,) offset in (z, y, x) array order overriding the
            sequence bounding-box centre
        label_type: "auto", "vertex" or "face" (see resolve_face_labels)
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

    # Load labels: one entry per frame, per vertex (zero-padded) or per face
    all_labels = np.load(labels_path, allow_pickle=True)

    # Get sorted list of PLY files
    ply_files = sorted(mesh_dir.glob("*.ply"))

    if len(ply_files) != len(all_labels):
        raise ValueError(
            f"Mismatch: {len(ply_files)} PLY files, {len(all_labels)} label arrays"
        )

    # Create output directory
    output_dir.mkdir(parents=True, exist_ok=True)

    # One shared offset for the whole sequence (z, y, x), so registered frames
    # keep their relative positions instead of each being re-centred on itself
    seq_min, seq_max = sequence_bounds(ply_files)
    if center is None:
        center = (seq_min + seq_max) / 2
        centering = "sequence-bbox"
    else:
        center = np.asarray(center, dtype=float)
        centering = "explicit"
    print(f"Sequence bounds (z, y, x): {seq_min.round(2).tolist()} .. {seq_max.round(2).tolist()}")
    print(f"Shared centre (z, y, x): {center.round(3).tolist()} [{centering}]")

    # Convert each mesh
    for i, (ply_path, frame_labels) in enumerate(zip(ply_files, all_labels)):
        output_path = output_dir / f"{ply_path.stem}.glb"
        print(f"Converting {i+1}/{len(ply_files)}: {ply_path.name} -> {output_path.name}")

        try:
            convert_ply_to_glb(
                ply_path, frame_labels, output_path, gltfpack_path, use_draco,
                ao_rays=ao_rays, ao_seed=ao_seed, center=center, label_type=label_type
            )
        except Exception as e:
            print(f"  Error: {e}")
            continue

    # Record how the sequence was placed (world order x, y, z = array order reversed)
    def _xyz(v):
        return [float(v[2]), float(v[1]), float(v[0])]

    metadata = {
        "frameCount": len(ply_files),
        "centering": centering,
        "center": _xyz(center),
        "centerArrayOrder": [float(c) for c in center],
        "bounds": {"min": _xyz(seq_min - center), "max": _xyz(seq_max - center)},
        "sourceBounds": {"min": _xyz(seq_min), "max": _xyz(seq_max)},
        "axisOrder": "world x, y, z = source array x, y, z (array order was z, y, x)",
        "aoRays": int(ao_rays),
        "aoAlpha": "COLOR_0 alpha = 1 - ambient occlusion" if ao_rays > 0 else None,
        "labelColors": {str(k): v for k, v in LABEL_COLORS.items()},
        "labelSource": str(labels_path.name),
        "labelType": label_type,
        "files": [f"{p.stem}.glb" for p in ply_files],
    }
    with open(output_dir / "metadata.json", "w") as f:
        json.dump(metadata, f, indent=2)

    print(f"\nConversion complete. Output saved to: {output_dir}")
    print(f"Metadata: {output_dir / 'metadata.json'}")


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
        help="Path to numpy object array with one label array per frame: per-vertex "
             "(e.g. 561_labv_corr_list_1.npy, zero-padded) or per-face (561_labf_list_1.npy)"
    )
    parser.add_argument(
        "--label-type",
        choices=["auto", "vertex", "face"],
        default="auto",
        help="How to read --labels; auto picks face when the length matches the face count "
             "(default: auto)"
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
    parser.add_argument(
        "--ao-rays",
        type=int,
        default=AO_RAYS,
        help=f"Hemisphere rays per vertex for the ambient occlusion bake (default: {AO_RAYS})"
    )
    parser.add_argument(
        "--ao-seed",
        type=int,
        default=AO_SEED,
        help=f"Random seed for the AO ray directions (default: {AO_SEED})"
    )
    parser.add_argument(
        "--no-ao",
        action="store_true",
        help="Skip the ambient occlusion bake (vertex alpha stays 1.0)"
    )
    parser.add_argument(
        "--center",
        type=float,
        nargs=3,
        metavar=("Z", "Y", "X"),
        default=None,
        help="Shared offset subtracted from every frame, in (z, y, x) voxel order "
             "(default: centre of the whole sequence's bounding box)"
    )

    args = parser.parse_args()

    batch_convert(
        args.mesh_dir,
        args.labels,
        args.output_dir,
        compress=not args.no_compress,
        use_draco=args.draco,
        ao_rays=0 if args.no_ao else args.ao_rays,
        ao_seed=args.ao_seed,
        center=args.center,
        label_type=args.label_type
    )
