"""Hard-deadline supervision of independent original-geometry layout workers."""
from __future__ import annotations

import json
import logging
import math
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from pydantic import BaseModel

from app.services.auto_layout_geometry import LayoutGeometryError, PlacedItem, layout_bounds, layout_efficiency

__all__ = ["PlacedItem", "auto_layout", "layout_bounds", "layout_efficiency"]
logger = logging.getLogger(__name__)
_LAYOUT_GATE = threading.BoundedSemaphore(1)
# Bounded protocol frames, not a physical-size or padding restriction.
_MAX_FRAME_BYTES = 16 * 1024 * 1024
_MAX_SOURCE_BYTES = 16 * 1024 * 1024


class LayoutBusyError(RuntimeError):
    pass


class LayoutEngineError(RuntimeError):
    pass


class LayoutInputError(LayoutGeometryError):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code


def _encode_request(value, deadline):
    """Bound allocation and check the shared deadline while traversing scalars."""
    payload = bytearray()

    def append(fragment):
        if time.monotonic() >= deadline:
            raise LayoutEngineError("compute time elapsed while preparing the request")
        if len(payload) + len(fragment) > _MAX_FRAME_BYTES:
            raise LayoutEngineError("original request exceeds bounded layout transport capacity")
        payload.extend(fragment)

    def encode(node):
        if isinstance(node, str):
            append(b'"')
            for offset in range(0, len(node), 4096):
                append(json.dumps(node[offset:offset + 4096], ensure_ascii=True)[1:-1].encode("ascii"))
            append(b'"')
        elif isinstance(node, (list, tuple)):
            append(b"[")
            for index, child in enumerate(node):
                if index:
                    append(b",")
                encode(child)
            append(b"]")
        elif isinstance(node, (dict, BaseModel)):
            fields = (node.items() if isinstance(node, dict)
                      else ((name, getattr(node, name)) for name in type(node).model_fields))
            append(b"{")
            for index, (key, child) in enumerate(fields):
                if not isinstance(key, str):
                    raise TypeError("layout transport keys must be strings")
                if index:
                    append(b",")
                encode(key)
                append(b":")
                encode(child)
            append(b"}")
        elif node is None or isinstance(node, (bool, int, float)):
            append(json.dumps(node, allow_nan=False).encode("ascii"))
        else:
            raise TypeError(f"unsupported layout transport value: {type(node).__name__}")

    encode(value)
    return payload


def _worker_command(algorithm: str) -> list[str]:
    return [sys.executable, "-m", "app.services.auto_layout_worker", algorithm]


class _Worker:
    def __init__(self, algorithm, payload, environment, source_limit, source_budget):
        self.algorithm = algorithm
        self.packets = queue.Queue(maxsize=1)
        self.sources = {}
        self.source_limit = source_limit
        self.source_budget = source_budget
        self.capacity_error = False
        self.context = None
        self.error = None
        self.input_error = None
        self.timed_out = False
        self.stopped = threading.Event()
        self.finished = threading.Event()
        with tempfile.TemporaryFile() as request:
            request.write(payload)
            request.seek(0)
            self.process = subprocess.Popen(
                _worker_command(algorithm), stdin=request, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, env=environment,
                cwd=Path(__file__).resolve().parents[2], text=True,
            )
        try:
            self.reader = threading.Thread(target=self._read, name=f"tracefinity-layout-{self.process.pid}", daemon=True)
            self.reader.start()
        except BaseException:
            self.process.kill()
            self.process.wait()
            self.process.stdout.close()
            raise

    def _read(self):
        try:
            while not self.stopped.is_set():
                line = self.process.stdout.readline(_MAX_FRAME_BYTES + 1)
                if not line:
                    break
                if len(line) > _MAX_FRAME_BYTES:
                    self.error = "optimizer frame exceeds bounded transport capacity"
                    self.capacity_error = True
                    break
                try:
                    packet = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if not isinstance(packet, dict):
                    continue
                if "error" in packet:
                    if packet.get("status_code") in (400, 404):
                        self.input_error = (packet["status_code"], str(packet["error"]))
                    else:
                        self.error = str(packet["error"])
                    continue
                event = packet.get("event")
                if event == "source":
                    index, source = packet.get("index"), packet.get("source")
                    if (type(index) is int and isinstance(source, dict)
                            and all(isinstance(source.get(key), str) for key in ("id", "name", "wkb"))):
                        if not 0 <= index < self.source_limit or index in self.sources:
                            self.error = "optimizer returned an unexpected original index"
                            break
                        # The shared ceiling includes both engines and per-record
                        # Python overhead; charge before retaining another source.
                        retained = len(line) + 512
                        with self.source_budget["lock"]:
                            if self.source_budget["bytes"] + retained > _MAX_SOURCE_BYTES:
                                self.capacity_error = True
                                self.error = "original outlines exceed retained transport capacity"
                                break
                            self.source_budget["bytes"] += retained
                        self.sources[index] = source
                elif event == "prepared":
                    self.context = packet.get("context")
                elif event == "incumbent":
                    while not self.stopped.is_set():
                        try:
                            self.packets.put(packet, timeout=0.01)
                            break
                        except queue.Full:
                            continue
        except (OSError, ValueError) as exc:
            if not self.stopped.is_set():
                self.error = str(exc)
        finally:
            self.finished.set()

    def close(self, deadline):
        # EOF can precede process exit; do not race healthy shutdown with kill.
        if self.process.poll() is None and self.finished.is_set() and not self.error and not self.input_error:
            try:
                self.process.wait(timeout=max(0.0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                pass
        if self.process.poll() is None:
            self.timed_out = time.monotonic() >= deadline and not self.error and not self.input_error
            self.process.kill()
        self.process.wait()
        self.stopped.set()
        self.reader.join()
        self.process.stdout.close()


def _incumbent(worker, packet):
    """Read our worker's validated scalar result; never run GEOS in supervision."""
    context, rows = worker.context, packet.get("items")
    if not isinstance(context, dict) or not isinstance(rows, list) or len(rows) != len(worker.sources):
        return None
    if (type(context.get("auto_width")) is not bool or type(context.get("has_fixed")) is not bool
            or any(type(context.get(key)) not in (int, float) or not math.isfinite(context[key])
                   for key in ("offset_x", "offset_y"))):
        return None
    for key in ("width", "depth", "width_cap"):
        value = context.get(key)
        if value is not None and (type(value) not in (int, float) or not math.isfinite(value) or value <= 0):
            return None
    items, seen = [], set()
    for row in rows:
        if not isinstance(row, dict):
            return None
        index = row.get("index")
        if type(index) is not int or index in seen or index not in worker.sources:
            return None
        bounds = row.get("bounds")
        values = [row.get(key) for key in ("x", "y", "rotation", "area")]
        if not isinstance(bounds, list) or len(bounds) != 4:
            return None
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in values + bounds):
            return None
        if values[3] <= 0 or type(row.get("fitted")) is not bool or bounds[2] <= bounds[0] or bounds[3] <= bounds[1]:
            return None
        if abs(values[0] - bounds[0]) > 1e-6 or abs(values[1] - bounds[1]) > 1e-6:
            return None
        seen.add(index)
        items.append(PlacedItem.from_validated(row, worker.sources[index], context))
    fitted = [item for item in items if item.fitted]
    left, top, right, bottom = layout_bounds(fitted if context.get("auto_width") else items)
    extent = ((right if context.get("has_fixed") else right - left) if context.get("auto_width")
              else (right - left) * (bottom - top))
    if not math.isfinite(extent):
        return None
    return (-len(fitted), extent), items


def _center(items):
    """Common translation preserves every validated pair distance and overlap test."""
    if not items:
        return items
    context = items[0].context
    width, depth = context.get("width"), context.get("depth")
    if (context.get("auto_width") or context.get("has_fixed") or width is None or depth is None
            or not all(item.fitted for item in items)):
        return items
    left, top, right, bottom = layout_bounds(items)
    dx, dy = (width - right - left) / 2, (depth - bottom - top) / 2
    shifted = (left + dx, top + dy, right + dx, bottom + dy)
    if (not all(math.isfinite(value) for value in shifted)
            or abs((shifted[2] - shifted[0]) - (right - left)) > 1e-6
            or abs((shifted[3] - shifted[1]) - (bottom - top)) > 1e-6):
        return items  # Presentation must never destroy a validated incumbent.
    for item in items:
        x0, y0, x1, y1 = item.bounds
        translated = (x0 + dx, y0 + dy, x1 + dx, y1 + dy, item.x + dx, item.y + dy)
        if (not all(math.isfinite(value) and math.ulp(value) <= 1e-6 for value in translated)
                or abs((translated[2] - translated[0]) - (x1 - x0)) > 1e-6
                or abs((translated[3] - translated[1]) - (y1 - y0)) > 1e-6):
            return items
    for item in items:
        item.shift(dx, dy)
    return items


def _run_workers(request, deadline, algorithms):
    payload = _encode_request(request, deadline)
    stored = request.get("stored_request")
    if stored is None:
        source_limit = len(request.get("tools", []))
    else:
        model = stored["request"]
        source_limit = len(model.tool_ids if isinstance(model, BaseModel) else model["tool_ids"])
    source_budget = {"bytes": 0, "lock": threading.Lock()}
    environment = os.environ.copy()
    for key in ("OMP_NUM_THREADS", "OMP_THREAD_LIMIT", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
                "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS", "BLIS_NUM_THREADS"):
        environment[key] = "1"
    workers, failures = [], 0
    best, best_score = None, None
    try:
        for algorithm in algorithms:
            if time.monotonic() >= deadline:
                break
            try:
                workers.append(_Worker(algorithm, payload, environment, source_limit, source_budget))
            except (OSError, RuntimeError) as exc:
                failures += 1
                logger.warning("%s layout optimizer could not start: %s", algorithm, exc)
        while time.monotonic() < deadline:
            active = received = False
            for worker in workers:
                if worker.capacity_error:
                    raise LayoutEngineError("original outlines exceed retained transport capacity")
                if worker.input_error:
                    raise LayoutInputError(*worker.input_error)
                active |= not worker.finished.is_set() or not worker.packets.empty()
                try:
                    packet = worker.packets.get_nowait()
                except queue.Empty:
                    continue
                received = True
                result = _incumbent(worker, packet)
                if result is not None and time.monotonic() < deadline:
                    score, candidate = result
                    if best_score is None or score < best_score:
                        # Commit the fully validated improvement before presentation.
                        best, best_score = candidate, score
            if not active:
                break
            if not received:
                time.sleep(min(0.005, max(0.0, deadline - time.monotonic())))
    finally:
        for worker in workers:
            worker.close(deadline)
    for worker in workers:
        if worker.capacity_error:
            raise LayoutEngineError("original outlines exceed retained transport capacity")
        if worker.input_error:
            raise LayoutInputError(*worker.input_error)
        if worker.error or (worker.process.returncode != 0 and not worker.timed_out):
            failures += 1
            logger.warning("%s layout optimizer failed: %s", worker.algorithm,
                           worker.error or f"exit {worker.process.returncode}")
    if failures == len(algorithms):
        raise LayoutEngineError("all layout optimizers failed; please retry")
    if best is None:
        raise LayoutEngineError("compute time elapsed before a safe layout was ready; increase compute time")
    return _center(best)


def auto_layout(
    tools: list[dict], clearance: float = 1.0,
    bin_width: float | None = None, bin_depth: float | None = None, *,
    algorithm: str = "auto", time_budget_seconds: float = 5.0,
    auto_width: bool = False, fixed_placements: list[dict] | None = None,
    _deadline: float | None = None, _stored_request: dict | None = None,
) -> list[PlacedItem]:
    """Return original rigid placements from a bounded, killable dual-engine solve.

    Geometry is constructed/validated only in owned workers. Polygon access on a
    returned item materializes the real rigid outline lazily; bounds/efficiency
    and the API response use the exact scalar metadata from those same originals.
    """
    deadline = _deadline if _deadline is not None else time.monotonic() + time_budget_seconds
    if algorithm not in ("auto", "raster", "packingsolver"):
        raise ValueError("unknown layout algorithm")
    if not math.isfinite(time_budget_seconds) or not 0.5 <= time_budget_seconds <= 60:
        raise ValueError("time budget must be finite and between 0.5 and 60 seconds")
    if not math.isfinite(clearance) or clearance < 0:
        raise ValueError("tool padding must be finite and non-negative")
    if not _LAYOUT_GATE.acquire(blocking=False):
        raise LayoutBusyError("auto-layout is busy; try again after the current calculation")
    try:
        request = {"deadline": deadline, "clearance": clearance, "width": bin_width, "depth": bin_depth,
                   "auto_width": auto_width, "fixed_placements": fixed_placements or []}
        if _stored_request is not None:
            # The route passes canonical storage/request data, not prebuilt geometry.
            request["stored_request"] = _stored_request
        else:
            from shapely import get_num_coordinates, get_num_interior_rings

            records = []
            encoded_size = 1024
            for tool in tools:
                if time.monotonic() >= deadline:
                    raise LayoutEngineError("compute time elapsed before worker startup; increase compute time")
                polygon = tool["polygon"]
                # Bound the mandatory direct-call IPC encoder's linear work.
                # Production routes transfer IDs/storage data instead: even
                # polygon construction and record parsing are isolated there.
                encoded_size += (get_num_interior_rings(polygon) * 8 + get_num_coordinates(polygon) * 32
                                 + 1024 + 6 * (len(tool["id"]) + len(tool["name"])))
                if encoded_size > _MAX_FRAME_BYTES:
                    raise LayoutEngineError("original outline exceeds bounded layout transport capacity")
                records.append({"id": tool["id"], "name": tool["name"], "wkb": polygon.wkb_hex})
            request["tools"] = records
        algorithms = ("raster", "packingsolver") if algorithm == "auto" else (algorithm,)
        return _run_workers(request, deadline, algorithms)
    finally:
        _LAYOUT_GATE.release()
