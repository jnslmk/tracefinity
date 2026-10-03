"""Conservative 1mm concave occupancy proposals, checked against originals."""
from __future__ import annotations

import math
import random
import sys
import time

import cv2
import numpy as np
from shapely import intersects_xy
from shapely.affinity import translate

from app.services.auto_layout_geometry import ANGLES, TOLERANCE, LayoutGeometry, layout_bounds

# ponytail: request-local masks and a bounded board; tile only if measured bin
# sizes need more than this memory ceiling. Exact shelf incumbents still survive.
MAX_BOARD_CELLS = 16_000_000
MAX_RASTER_AXIS = 8192
MAX_MASK_BYTES = 64_000_000


def _mask(rotated, angle, clearance, halo, deadline):
    left, top, right, bottom = rotated.bounds
    width, height = right - left, bottom - top
    nx, ny = math.ceil(width) + 2 * halo, math.ceil(height) + 2 * halo
    if nx > MAX_RASTER_AXIS or ny > MAX_RASTER_AXIS or nx * ny > MAX_BOARD_CELLS:
        return None
    normalized = translate(rotated, -left, -top)
    # Pixel squares touching the c/2 envelope are conservatively occupied. The
    # buffer's polygonal arcs are circumscribed, not used as clearance tolerance.
    radius = (clearance / 2 + 1 / math.sqrt(2)) / math.cos(math.pi / 32)
    envelope = normalized.buffer(radius, quad_segs=8)
    x = np.arange(nx, dtype=np.float64) - halo + 0.5
    mask = np.empty((ny, nx), dtype=np.uint8)
    for start in range(0, ny, 32):
        if time.monotonic() >= deadline:
            return None
        end = min(start + 32, ny)
        y = np.arange(start, end, dtype=np.float64) - halo + 0.5
        mask[start:end] = intersects_xy(envelope, x[None, :], y[:, None])
    packed = np.packbits(mask, axis=1, bitorder="little")
    rows = [(i, int.from_bytes(row.tobytes(), "little")) for i, row in enumerate(packed)]
    rows = [(i, bits) for i, bits in rows if bits]
    retained_bytes = mask.nbytes + sys.getsizeof(rows) + sum(
        sys.getsizeof(pair) + sys.getsizeof(pair[0]) + sys.getsizeof(pair[1]) for pair in rows)
    return {"angle": angle, "width": width, "height": height, "mask": mask,
            "rows": rows, "bytes": retained_bytes}


def _positions(counts, entry, right, bottom, deadline, auto_width=False):
    """Three proposals per orientation, with bounded transient coordinate arrays."""
    best = []
    for top in range(0, counts.shape[0], 32):
        for left in range(0, counts.shape[1], 4096):
            if time.monotonic() >= deadline:
                return best
            ys, xs = np.nonzero(counts[top:top + 32, left:left + 4096] <= 0.5)
            if not xs.size:
                continue
            xs += left
            ys += top
            extents = np.maximum(right, xs + entry["width"])
            if not auto_width:
                extents *= np.maximum(bottom, ys + entry["height"])
            count = min(3, xs.size)
            choices = np.argpartition(extents, count - 1)[:count]
            best.extend((float(extents[choice]), int(ys[choice]), int(xs[choice])) for choice in choices)
            best = sorted(best)[:3]
    return best


def _search(geometry, masks, order, width, depth, halo, deadline, emit):
    board = np.zeros((math.ceil(depth) + 2 * halo, math.ceil(width) + 2 * halo), dtype=np.uint8)
    board_rows = [0] * board.shape[0]
    placed = list(geometry.fixed.values())
    _, _, right, bottom = layout_bounds(placed)
    if placed:
        # Absolute board coordinates retain fractional corners, angles and holes.
        # Use the same conservative pixel envelope as the movable masks.
        radius = (geometry.clearance / 2 + 1 / math.sqrt(2)) / math.cos(math.pi / 32)
        for pin in placed:
            if time.monotonic() >= deadline:
                return
            envelope = pin.polygon.buffer(radius, quad_segs=8)
            x0, y0, x1, y1 = envelope.bounds
            left = max(0, math.floor(x0 + halo))
            top = max(0, math.floor(y0 + halo))
            end_x = min(board.shape[1], math.ceil(x1 + halo))
            end_y = min(board.shape[0], math.ceil(y1 + halo))
            xs = np.arange(left, end_x, dtype=np.float64) - halo + 0.5
            for start in range(top, end_y, 32):
                if time.monotonic() >= deadline:
                    return
                end = min(start + 32, end_y)
                ys = np.arange(start, end, dtype=np.float64) - halo + 0.5
                board[start:end, left:end_x] |= intersects_xy(envelope, xs[None, :], ys[:, None])
        for y, row in enumerate(board):
            if time.monotonic() >= deadline:
                return
            board_rows[y] = int.from_bytes(np.packbits(row, bitorder="little").tobytes(), "little")
    for index in order:
        if time.monotonic() >= deadline:
            break
        proposals = []
        for entry in masks[index]:
            if time.monotonic() >= deadline:
                break
            xmax = math.floor(width - entry["width"] + TOLERANCE)
            ymax = math.floor(depth - entry["height"] + TOLERANCE)
            if xmax < 0 or ymax < 0:
                continue
            # Halo exists outside the board's physical walls too: proposal
            # padding separates tools, never artificially shrinks the bin.
            counts = cv2.matchTemplate(board, entry["mask"], cv2.TM_CCORR)[:ymax + 1, :xmax + 1]
            if time.monotonic() >= deadline:
                break
            for area, y, x in _positions(counts, entry, right, bottom, deadline, geometry.auto_width):
                proposals.append((area, y, x, entry))
        proposals.sort(key=lambda proposal: (proposal[0], proposal[1], proposal[2], proposal[3]["angle"]))
        best = None
        seen_angles = set()
        for rank, (area, y, x, entry) in enumerate(proposals):
            if time.monotonic() >= deadline:
                break
            angle = entry["angle"]
            if rank >= 12 and angle in seen_angles:
                continue
            seen_angles.add(angle)
            # Exact integer bit rows catch floating-point correlation false frees.
            if any(board_rows[y + dy] & (bits << x) for dy, bits in entry["rows"]):
                continue
            item = geometry.place(index, float(x), float(y), angle)
            if not geometry.inside(item.polygon) or not geometry.collision_free(item.polygon, placed, deadline):
                continue
            if best is None or area < best[0]:
                best = (area, item, entry, x, y)
        if best is None:
            continue
        _, item, entry, x, y = best
        placed.append(item)
        mask = entry["mask"]
        board[y:y + mask.shape[0], x:x + mask.shape[1]] |= mask
        for dy, bits in entry["rows"]:
            board_rows[y + dy] |= bits << x
        _, _, right, bottom = layout_bounds(placed)
        # Stream partial improvements too: a hard kill must not erase an order's
        # valid incumbent just because the next expensive tool is unfinished.
        emit(geometry.packet(placed))


def solve(geometry: LayoutGeometry, width: float, depth: float, deadline: float, emit):
    cv2.setNumThreads(1)
    started = time.monotonic()
    radius = (geometry.clearance / 2 + 1 / math.sqrt(2)) / math.cos(math.pi / 32)
    halo = math.ceil(radius) + 1
    nx, ny = math.ceil(width) + 2 * halo, math.ceil(depth) + 2 * halo
    if nx > MAX_RASTER_AXIS or ny > MAX_RASTER_AXIS or nx * ny > MAX_BOARD_CELLS:
        return
    masks = [[] for _ in geometry.tools]
    mask_bytes = 0
    # Preprocessing shares the same deadline. Cardinals and diagonals come first;
    # preserve search time instead of exhausting the budget on all 24 masks.
    prep_deadline = started + max(0.0, deadline - started) * 0.35
    stopped = False
    for angle in ANGLES:
        for index in geometry.movable:
            if time.monotonic() >= deadline or (angle not in ANGLES[:8] and time.monotonic() >= prep_deadline):
                stopped = True
                break
            rotated = geometry.rotated(index, angle)
            x0, y0, x1, y1 = rotated.bounds
            if x1 - x0 > width + TOLERANCE or y1 - y0 > depth + TOLERANCE:
                continue
            nx, ny = math.ceil(x1 - x0) + 2 * halo, math.ceil(y1 - y0) + 2 * halo
            required = nx * ny + ((nx + 7) // 8 + 128) * ny
            if mask_bytes + required > MAX_MASK_BYTES:
                stopped = True
                break
            entry = _mask(rotated, angle, geometry.clearance, halo, deadline)
            if entry is None:
                stopped = True
                break
            masks[index].append(entry)
            mask_bytes += entry["bytes"]
        if stopped:
            break
    ids = list(geometry.movable)
    area_order = sorted(ids, key=lambda index: -geometry.tools[index]["polygon"].area)
    height_order = sorted(ids, key=lambda index: -(geometry.tools[index]["polygon"].bounds[3]
                                                 - geometry.tools[index]["polygon"].bounds[1]))
    orders = [area_order, height_order, list(reversed(area_order))]
    rng = random.Random(0)
    seen = set()
    # Reuse all masks across order trials, including additional trials when the
    # caller grants more time. No research harness, diagnostics or proxy scorer.
    attempts = 0
    while time.monotonic() < deadline and attempts < max(8, len(ids) * 8):
        if orders:
            order = orders.pop(0)
        else:
            order = ids.copy()
            rng.shuffle(order)
        attempts += 1
        key = tuple(order)
        if key in seen:
            continue
        seen.add(key)
        _search(geometry, masks, order, width, depth, halo, deadline, emit)
