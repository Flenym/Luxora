#!/usr/bin/env python3
"""Create deterministic visual evidence for one iPhone reference comparison.

The tool deliberately refuses to resize either input. A pixel comparison is
meaningful only when the reference and Simulator capture use the same viewport,
scale and orientation. A white optional mask excludes dynamic identity, user
content and brand-only regions from the edge score.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
from pathlib import Path
from typing import Final

import PIL
from PIL import Image, ImageChops, ImageFilter, ImageOps, ImageStat


DEFAULT_EDGE_THRESHOLD: Final[int] = 28
DEFAULT_TOLERANCE_PX: Final[int] = 3


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare one same-size iPhone reference and Simulator PNG."
    )
    parser.add_argument("--reference", required=True, type=Path)
    parser.add_argument("--candidate", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument(
        "--mask",
        type=Path,
        help="Optional same-size image; white pixels are excluded from scoring.",
    )
    parser.add_argument(
        "--edge-threshold",
        type=int,
        default=DEFAULT_EDGE_THRESHOLD,
        help=f"0..255 grayscale edge threshold (default: {DEFAULT_EDGE_THRESHOLD}).",
    )
    parser.add_argument(
        "--tolerance-px",
        type=int,
        default=DEFAULT_TOLERANCE_PX,
        help=f"Edge matching radius in physical pixels (default: {DEFAULT_TOLERANCE_PX}).",
    )
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def open_rgb(path: Path) -> Image.Image:
    with Image.open(path) as source:
        return source.convert("RGB")


def binary_edges(image: Image.Image, threshold: int) -> Image.Image:
    gray = image.convert("L")
    edges = gray.filter(ImageFilter.FIND_EDGES)
    binary = edges.point(lambda value: 255 if value >= threshold else 0)
    # FIND_EDGES treats the outermost pixels as an artificial boundary.
    if binary.width > 4 and binary.height > 4:
        binary.paste(0, (0, 0, binary.width, 2))
        binary.paste(0, (0, binary.height - 2, binary.width, binary.height))
        binary.paste(0, (0, 0, 2, binary.height))
        binary.paste(0, (binary.width - 2, 0, binary.width, binary.height))
    return binary


def white_pixel_count(image: Image.Image) -> int:
    return image.histogram()[255]


def edge_metrics(
    reference_edges: Image.Image,
    candidate_edges: Image.Image,
    tolerance_px: int,
) -> dict[str, float | int | None]:
    kernel_size = tolerance_px * 2 + 1
    reference_near = reference_edges.filter(ImageFilter.MaxFilter(kernel_size))
    candidate_near = candidate_edges.filter(ImageFilter.MaxFilter(kernel_size))

    reference_count = white_pixel_count(reference_edges)
    candidate_count = white_pixel_count(candidate_edges)
    matched_reference = white_pixel_count(
        ImageChops.multiply(reference_edges, candidate_near)
    )
    matched_candidate = white_pixel_count(
        ImageChops.multiply(candidate_edges, reference_near)
    )

    recall = matched_reference / reference_count if reference_count else None
    precision = matched_candidate / candidate_count if candidate_count else None
    f1 = (
        2 * precision * recall / (precision + recall)
        if precision is not None
        and recall is not None
        and precision + recall > 0
        else None
    )
    return {
        "referenceEdgePixels": reference_count,
        "candidateEdgePixels": candidate_count,
        "matchedReferenceEdgePixels": matched_reference,
        "matchedCandidateEdgePixels": matched_candidate,
        "precision": precision,
        "recall": recall,
        "f1": f1,
    }


def apply_optional_mask(
    reference_edges: Image.Image,
    candidate_edges: Image.Image,
    mask_path: Path | None,
    expected_size: tuple[int, int],
) -> tuple[Image.Image, Image.Image]:
    if mask_path is None:
        return reference_edges, candidate_edges
    with Image.open(mask_path) as source:
        mask = source.convert("L")
    if mask.size != expected_size:
        raise ValueError(
            f"mask is {mask.size[0]}x{mask.size[1]}, expected "
            f"{expected_size[0]}x{expected_size[1]}"
        )
    keep = ImageOps.invert(mask)
    return (
        ImageChops.multiply(reference_edges, keep),
        ImageChops.multiply(candidate_edges, keep),
    )


def main() -> int:
    args = parse_args()
    if not 0 <= args.edge_threshold <= 255:
        raise ValueError("--edge-threshold must be between 0 and 255")
    if not 0 <= args.tolerance_px <= 15:
        raise ValueError("--tolerance-px must be between 0 and 15")

    reference = open_rgb(args.reference)
    candidate = open_rgb(args.candidate)
    if reference.size != candidate.size:
        raise ValueError(
            f"viewport mismatch: reference is {reference.width}x{reference.height}, "
            f"candidate is {candidate.width}x{candidate.height}; no resize was performed"
        )

    args.output_dir.mkdir(parents=True, exist_ok=True)
    overlay = Image.blend(reference, candidate, 0.5)
    raw_difference = ImageChops.difference(reference, candidate)
    difference_gray = ImageOps.autocontrast(raw_difference.convert("L"))
    difference_heatmap = ImageOps.colorize(
        difference_gray,
        black=(0, 0, 0),
        mid=(63, 104, 255),
        white=(255, 45, 143),
    )

    reference_edges = binary_edges(reference, args.edge_threshold)
    candidate_edges = binary_edges(candidate, args.edge_threshold)
    reference_edges, candidate_edges = apply_optional_mask(
        reference_edges,
        candidate_edges,
        args.mask,
        reference.size,
    )

    overlay_path = args.output_dir / "overlay-50.png"
    difference_path = args.output_dir / "difference-heatmap.png"
    reference_edges_path = args.output_dir / "reference-edges.png"
    candidate_edges_path = args.output_dir / "candidate-edges.png"
    report_path = args.output_dir / "report.json"
    overlay.save(overlay_path, optimize=True)
    difference_heatmap.save(difference_path, optimize=True)
    reference_edges.save(reference_edges_path, optimize=True)
    candidate_edges.save(candidate_edges_path, optimize=True)

    channel_means = ImageStat.Stat(raw_difference).mean
    report = {
        "schemaVersion": 1,
        "toolchain": {
            "python": platform.python_version(),
            "pillow": PIL.__version__,
        },
        "reference": {
            "path": str(args.reference),
            "sha256": sha256(args.reference),
        },
        "candidate": {
            "path": str(args.candidate),
            "sha256": sha256(args.candidate),
        },
        "mask": None
        if args.mask is None
        else {"path": str(args.mask), "sha256": sha256(args.mask)},
        "viewport": {
            "widthPx": reference.width,
            "heightPx": reference.height,
            "scale": 3 if reference.size == (1179, 2556) else None,
            "widthPt": 393 if reference.size == (1179, 2556) else None,
            "heightPt": 852 if reference.size == (1179, 2556) else None,
        },
        "parameters": {
            "edgeThreshold": args.edge_threshold,
            "tolerancePx": args.tolerance_px,
        },
        "rawPixelDifference": {
            "meanAbsoluteChannelValues": channel_means,
            "normalizedMeanAbsoluteError": sum(channel_means) / (3 * 255),
            "note": "Brand and dynamic copy differences make this diagnostic, not an acceptance score.",
        },
        "geometryEdges": edge_metrics(
            reference_edges,
            candidate_edges,
            args.tolerance_px,
        ),
        "artifacts": {
            "overlay50": overlay_path.name,
            "differenceHeatmap": difference_path.name,
            "referenceEdges": reference_edges_path.name,
            "candidateEdges": candidate_edges_path.name,
        },
    }
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(report_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
