"""Original geometry and real-process deadline/resource regressions."""
import math
import subprocess
import sys
import threading
import time
from textwrap import indent

import pytest
from shapely.affinity import rotate, translate
from shapely.geometry import Polygon, box

import app.services.auto_layout as service
from app.services.auto_layout_geometry import LayoutGeometry, LayoutGeometryError, layout_bounds


def _tools(*polygons):
    return [{"id": str(index), "name": f"tool {index}", "polygon": polygon}
            for index, polygon in enumerate(polygons)]


def test_proposals_cannot_hide_original_tips_overlap_or_insufficient_clearance():
    tip = Polygon([(0, 0), (10, 0), (10, 4), (10.02, 4), (10.02, 6), (10, 6), (10, 10), (0, 10)])
    tools = _tools(tip, box(0, 0, 2, 2))
    bounded = LayoutGeometry(tools, 0, 10, 10)
    assert bounded.validate([[0, 0, 0, 0]]) is None
    unbounded = LayoutGeometry(tools, 0, None, None)
    assert unbounded.validate([[0, 0, 0, 0], [1, 10.01, 4, 0]]) is None
    separated = LayoutGeometry(tools, 1, None, None)
    assert separated.validate([[0, 0, 0, 0], [1, 10.5, 4, 0]]) is None
    assert separated.validate([[0, 0, 0, 0], [1, 11.02, 4, 0]]) is not None


def test_feasible_wall_roundoff_does_not_defeat_actual_compactness():
    geometry = LayoutGeometry(_tools(box(0, 0, 20, 10)), 0, 50, 50)
    compact = geometry.validate([[0, -0.5e-6, 0, 0]])
    loose = geometry.validate([[0, 0, 0, 45]])
    assert compact is not None and loose is not None
    assert geometry.score(compact)[0] == geometry.score(loose)[0] == -1
    assert geometry.score(compact) < geometry.score(loose)
    assert geometry.validate([[0, -2e-6, 0, 0]]) is None


def test_fit_count_precedes_bbox_and_overflow_preserves_all_originals():
    originals = [box(-10, -10, 10, 10), box(0, 0, 10, 10), box(0, 0, 80, 80)]
    geometry = LayoutGeometry(_tools(*originals), 2, 40, 40)
    partial = geometry.complete(geometry.validate([[0, 0, 0, 0]]))
    more_fitted = geometry.complete(geometry.validate([[0, 0, 0, 0], [1, 22, 0, 90]]))
    assert geometry.score(more_fitted) < geometry.score(partial)
    assert {item.tool_id for item in more_fitted} == {"0", "1", "2"}
    for index, item in enumerate(more_fitted):
        original = rotate(originals[index], item.rotation, origin=(0, 0))
        left, top, _, _ = original.bounds
        expected = translate(original, item.x - left, item.y - top)
        assert item.polygon.symmetric_difference(expected).area < 1e-8
        for other in more_fitted[index + 1:]:
            assert item.polygon.intersection(other.polygon).area == 0
            assert item.polygon.distance(other.polygon) >= 2 - 1e-6


@pytest.mark.parametrize(
    ("outline", "clearance", "width", "depth"),
    [(box(0, 0, 10, 10), 1e100, 100, 100), (box(0, 0, 100_000, 10), 0, 200_000, 100)],
)
def test_raster_resource_bounds_preserve_safe_originals_without_padding_limits(outline, clearance, width, depth):
    placed = service.auto_layout(_tools(outline), clearance=clearance, bin_width=width, bin_depth=depth,
                                 algorithm="raster", time_budget_seconds=2)
    item, = placed
    assert item.polygon.is_valid and item.polygon.area == pytest.approx(outline.area)
    left, top, right, bottom = item.polygon.bounds
    assert left >= -1e-6 and top >= -1e-6 and right <= width + 1e-6 and bottom <= depth + 1e-6


def test_unrepresentable_finite_spacing_fails_instead_of_returning_collapsed_shapes():
    with pytest.raises(LayoutGeometryError):
        service.auto_layout(_tools(box(0, 0, 10, 10), box(0, 0, 10, 10)),
                            clearance=1e100, algorithm="raster", time_budget_seconds=2)


def _controlled_workers(monkeypatch, script):
    """Fault-inject actual child programs at the process seam, never fake Popen."""
    children = []
    started = threading.Event()
    original_popen = subprocess.Popen

    def record(*args, **kwargs):
        child = original_popen(*args, **kwargs)
        children.append(child)
        started.set()
        return child

    monkeypatch.setattr(service, "_worker_command", lambda algorithm: [sys.executable, "-c", script, algorithm])
    monkeypatch.setattr(service.subprocess, "Popen", record)
    return children, started


def _concave_tools():
    outline = Polygon([(0, 0), (10, 0), (10, 2), (2, 2), (2, 10), (0, 10)])
    return _tools(outline, outline)


def _assert_reaped(children):
    assert all(child.poll() is not None and child.stdout.closed for child in children)
    child_names = {f"tracefinity-layout-{child.pid}" for child in children}
    assert not any(thread.name in child_names for thread in threading.enumerate())


def _proposal_script(body, setup=""):
    """Inject solver proposals while retaining production preparation and validation."""
    return (
        "import sys, time\n"
        "from app.services import auto_layout_worker as worker\n"
        "from app.services import auto_layout_raster as raster\n"
        f"{setup}\n"
        "def injected(geometry, width, depth, deadline, emit, *_):\n"
        f"{indent(body, '    ')}\n"
        "worker.solve_native = injected\n"
        "raster.solve = injected\n"
        "sys.exit(worker.entrypoint())\n"
    )


def test_one_shared_hard_budget_retains_improvement_and_reaps_both_cpu_workers(monkeypatch):
    script = _proposal_script(
        "time.sleep(0.04)\n"
        "emit([[0, 0, 0, 0], [1, 4, 2, 180]])\n"
        "time.sleep(0.04)\n"
        "emit([[0, 0, 0, 0], [1, 2, 2, 180]])\n"
        "while True:\n"
        "    pass"
    )
    children, _ = _controlled_workers(monkeypatch, script)
    started = time.monotonic()
    placed = service.auto_layout(_concave_tools(), clearance=0, bin_width=30, bin_depth=30,
                                 time_budget_seconds=2)
    elapsed = time.monotonic() - started
    left, top, right, bottom = layout_bounds(placed)
    assert (right - left) * (bottom - top) == pytest.approx(144)
    assert (left, top, right, bottom) == pytest.approx((9, 9, 21, 21))
    assert placed[0].polygon.intersection(placed[1].polygon).area == 0
    assert elapsed < 2.45  # not independent 2-second budgets for each engine
    assert len(children) == 2 and children[0].pid != children[1].pid
    _assert_reaped(children)


def test_later_invalid_packet_does_not_replace_valid_incumbent(monkeypatch):
    script = _proposal_script(
        "emit([[0, 0, 0, 0], [1, 2, 2, 180]])\n"
        "emit([[0, 0, 0, 0], [1, 0, 0, 0]])\n"
        'print("not-json", flush=True)'
    )
    children, _ = _controlled_workers(monkeypatch, script)
    placed = service.auto_layout(_concave_tools(), clearance=0, bin_width=30, bin_depth=30,
                                 algorithm="raster", time_budget_seconds=2)
    left, top, right, bottom = layout_bounds(placed)
    assert (right - left) * (bottom - top) == pytest.approx(144)
    assert placed[0].polygon.intersection(placed[1].polygon).area == 0
    _assert_reaped(children)


def test_failure_reaps_worker_and_releases_request_gate(monkeypatch):
    script = _proposal_script('raise RuntimeError("injected native failure")')
    children, _ = _controlled_workers(monkeypatch, script)
    for _ in range(2):
        with pytest.raises(service.LayoutEngineError):
            service.auto_layout(_concave_tools(), algorithm="packingsolver", time_budget_seconds=2)
    assert len(children) == 2
    _assert_reaped(children)

@pytest.mark.parametrize("failure", ["reported", "nonzero"])
def test_automatic_total_engine_failure_is_visible_and_reaps_both_workers(monkeypatch, failure):
    body = 'raise RuntimeError("injected portfolio failure")' if failure == "reported" else "sys.exit(7)"
    script = _proposal_script(body)
    children, _ = _controlled_workers(monkeypatch, script)
    with pytest.raises(service.LayoutEngineError):
        service.auto_layout(_concave_tools(), time_budget_seconds=2)
    assert len(children) == 2
    _assert_reaped(children)


def test_automatic_total_startup_failure_is_visible_and_releases_gate(monkeypatch, tmp_path):
    missing_executable = str(tmp_path / "missing-layout-executable")
    monkeypatch.setattr(service, "_worker_command", lambda algorithm: [missing_executable])
    for _ in range(2):
        with pytest.raises(service.LayoutEngineError):
            service.auto_layout(_concave_tools(), time_budget_seconds=0.5)


def test_automatic_keeps_valid_result_when_one_engine_fails(monkeypatch):
    script = _proposal_script(
        'if sys.argv[1] == "packingsolver":\n'
        "    sys.exit(7)\n"
        "emit([[0, 0, 0, 0], [1, 2, 2, 180]])"
    )
    children, _ = _controlled_workers(monkeypatch, script)
    placed = service.auto_layout(_concave_tools(), clearance=0, bin_width=30, bin_depth=30,
                                 time_budget_seconds=2)
    left, top, right, bottom = layout_bounds(placed)
    assert (right - left) * (bottom - top) == pytest.approx(144)
    assert {item.tool_id for item in placed} == {"0", "1"}
    assert placed[0].polygon.intersection(placed[1].polygon).area == 0
    _assert_reaped(children)



def test_busy_request_is_visible_without_waiting_or_spawning_more_workers(monkeypatch):
    script = _proposal_script("while True:\n    pass")
    children, started = _controlled_workers(monkeypatch, script)
    errors = []

    def run():
        try:
            service.auto_layout(_concave_tools(), time_budget_seconds=2)
        except Exception as exc:
            errors.append(exc)

    request = threading.Thread(target=run)
    request.start()
    try:
        assert started.wait(timeout=1)
        second_started = time.monotonic()
        with pytest.raises(service.LayoutBusyError):
            service.auto_layout(_concave_tools(), time_budget_seconds=0.5)
        assert time.monotonic() - second_started < 0.1
    finally:
        request.join(timeout=3)
    assert not request.is_alive() and not errors
    assert len(children) == 2
    _assert_reaped(children)


def test_slow_original_geometry_validation_stays_inside_killable_workers(monkeypatch):
    script = _proposal_script(
        "emit([[0, 0, 0, 0], [1, 2, 2, 180]])",
        setup=(
            "from app.services.auto_layout_geometry import LayoutGeometry\n"
            "original_validate = LayoutGeometry.validate\n"
            "def slow_validate(self, proposals, deadline=float('inf')):\n"
            "    time.sleep(10)\n"
            "    return original_validate(self, proposals, deadline)\n"
            "LayoutGeometry.validate = slow_validate"
        ),
    )
    children, _ = _controlled_workers(monkeypatch, script)
    started = time.monotonic()
    placed = service.auto_layout(_concave_tools(), clearance=0, bin_width=30, bin_depth=30,
                                 time_budget_seconds=2)
    assert time.monotonic() - started < 2.45
    assert {item.tool_id for item in placed} == {"0", "1"}
    assert placed[0].polygon.intersection(placed[1].polygon).area == 0
    assert len(children) == 2
    _assert_reaped(children)


def test_slow_canonical_store_preparation_cannot_overrun_parent_deadline(monkeypatch, tmp_path):
    from app.models.schemas import Tool
    from app.services.tool_store import ToolStore

    store = ToolStore(tmp_path)
    store.set("0", Tool(id="0", name="rectangle", points=[
        {"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 10}, {"x": 0, "y": 10},
    ]))
    script = _proposal_script(
        "pass",
        setup=(
            "from app.services.tool_store import ToolStore\n"
            "original_load = ToolStore._load\n"
            "def slow_load(self):\n"
            "    time.sleep(10)\n"
            "    return original_load(self)\n"
            "ToolStore._load = slow_load"
        ),
    )
    children, _ = _controlled_workers(monkeypatch, script)
    started = time.monotonic()
    with pytest.raises(service.LayoutEngineError):
        service.auto_layout([], time_budget_seconds=2, _stored_request={
            "storage_path": str(tmp_path),
            "request": {"tool_ids": ["0"], "bin_config": None},
        })
    assert time.monotonic() - started < 2.45
    assert len(children) == 2
    _assert_reaped(children)


@pytest.mark.parametrize("algorithm", ["auto", "raster", "packingsolver"])
def test_pins_preserve_fractional_pose_while_other_tools_pack_around_them(algorithm):
    tools = _tools(box(-5, -5, 5, 5), box(0, 0, 10, 10), box(0, 0, 10, 10))
    pin = {"tool_id": "1", "x": 20.25, "y": 15.5, "rotation": 387}
    placed = service.auto_layout(tools, clearance=2, bin_width=60, bin_depth=50,
                                 algorithm=algorithm, time_budget_seconds=2, fixed_placements=[pin])
    by_id = {item.tool_id: item for item in placed}
    anchor = by_id["1"]
    assert (anchor.x, anchor.y, anchor.rotation) == (20.25, 15.5, 387)
    for index, item in enumerate(placed):
        assert item.polygon.bounds[0] >= -1e-6 and item.polygon.bounds[1] >= -1e-6
        assert item.polygon.bounds[2] <= 60 + 1e-6 and item.polygon.bounds[3] <= 50 + 1e-6
        for other in placed[index + 1:]:
            assert item.polygon.distance(other.polygon) >= 2 - 1e-6


@pytest.mark.parametrize("algorithm", ["raster", "packingsolver"])
def test_optimizers_place_tools_inside_fixed_outline_holes(algorithm):
    from app.services.auto_layout_raster import solve
    from app.services.auto_layout_worker import solve_native

    ring = Polygon(box(0, 0, 40, 40).exterior.coords, [box(8, 8, 32, 32).exterior.coords])
    geometry = LayoutGeometry(_tools(ring, box(0, 0, 10, 10)), 3, 40.5, 40.5,
                              fixed_placements=[{"tool_id": "0", "x": 0.25, "y": 0.25, "rotation": 0}])
    best = geometry.complete(list(geometry.fixed.values()))

    def emit(packet):
        nonlocal best
        checked = geometry.validate(packet)
        if checked is not None:
            candidate = geometry.complete(checked)
            if geometry.score(candidate) < geometry.score(best):
                best = candidate
        return checked

    # Native import/preparation is allowed a functional search budget. The
    # separate process regressions prove shared deadline termination.
    deadline = time.monotonic() + 5
    if algorithm == "raster":
        solve(geometry, 40.5, 40.5, deadline, emit)
    else:
        solve_native(geometry, 40.5, 40.5, deadline, emit, lambda: best)
    fitted = [item for item in best if geometry.inside(item.polygon)]
    assert len(fitted) == 2
    assert fitted[0].polygon.distance(fitted[1].polygon) >= 3 - 1e-6
    assert box(8.25, 8.25, 32.25, 32.25).covers(fitted[1].polygon)


def test_optimizer_packets_cannot_move_or_overlap_a_pin():
    geometry = LayoutGeometry(_tools(box(0, 0, 10, 10), box(0, 0, 10, 10)), 2, 50, 50,
                              fixed_placements=[{"tool_id": "0", "x": 10.25, "y": 10.5, "rotation": 13}])
    assert geometry.validate([[0, 0, 0, 13]]) is None
    assert geometry.validate([[1, 10.25, 10.5, 0]]) is None
    preserved = geometry.validate([[1, 35, 35, 0]])
    assert preserved[0] is geometry.fixed[0]


@pytest.mark.parametrize("pinned", [False, True])
def test_native_auto_width_refines_partial_fit_after_initial_search_returns_no_improvement(monkeypatch, pinned):
    from types import SimpleNamespace

    import packingsolver.irregular as ps

    from app.services.auto_layout_worker import solve_native

    geometry = LayoutGeometry(
        _tools(box(0, 0, 20, 20), box(0, 0, 20, 20), box(0, 0, 40, 40)),
        0, 200, 30, auto_width=True,
        fixed_placements=[{"tool_id": "0", "x": 0, "y": 0, "rotation": 0}] if pinned else [],
    )
    best = geometry.complete(geometry.validate([[0, 0, 0, 0], [1, 80, 0, 0]]))
    initial_score = geometry.score(best)
    optimize = ps.optimize
    initial = True

    def initial_search_without_improvement(instance, parameters):
        nonlocal initial
        if initial:
            initial = False
            # Exercise the legal early-return path: no proposal beats the seed
            # in the fit-count pass. Subsequent width searches use the real engine.
            return SimpleNamespace(solution=SimpleNamespace(number_of_different_bins=lambda: 0))
        return optimize(instance, parameters)

    monkeypatch.setattr(ps, "optimize", initial_search_without_improvement)

    def emit(packet):
        nonlocal best
        checked = geometry.validate(packet)
        if checked is None:
            return None
        candidate = geometry.complete(checked)
        if geometry.score(candidate) < geometry.score(best):
            best = candidate
        return checked

    solve_native(geometry, 200, 30, time.monotonic() + 1.0, emit, lambda: best)
    score = geometry.score(best)
    assert score[0] == initial_score[0] == -2
    assert score[1] < initial_score[1]
    fitted = [item for item in best if geometry.inside(item.polygon)]
    assert {item.tool_id for item in fitted} == {"0", "1"}
    for item in fitted:
        assert item.polygon.bounds[1] >= -1e-6
        assert item.polygon.bounds[3] <= 30 + 1e-6
    assert fitted[0].polygon.intersection(fitted[1].polygon).area < 1e-6
    if pinned:
        pin = next(item for item in best if item.tool_id == "0")
        assert (pin.x, pin.y, pin.rotation) == (0, 0, 0)


def test_valid_pin_pair_expiring_during_clearance_validation_is_not_misclassified(monkeypatch):
    from types import SimpleNamespace

    import app.services.auto_layout_geometry as geometry_module

    tools = _tools(box(0, 0, 10, 10), box(0, 0, 10, 10))
    pins = [
        {"tool_id": "0", "x": 0, "y": 0, "rotation": 0},
        {"tool_id": "1", "x": 20, "y": 0, "rotation": 0},
    ]
    valid = LayoutGeometry(tools, 2, 50, 50, fixed_placements=pins)
    assert {item.tool_id for item in valid.fixed.values()} == {"0", "1"}
    assert valid.fixed[0].polygon.distance(valid.fixed[1].polygon) == 10

    # Entry checks pass for both valid pins; the pair check then expires.
    # Exercise the constructor seam directly: subprocess imports are independent.
    ticks = iter((0.0, 0.0))
    monkeypatch.setattr(geometry_module, "time", SimpleNamespace(
        monotonic=lambda: next(ticks, math.inf),
    ))
    with pytest.raises(TimeoutError):
        LayoutGeometry(tools, 2, 50, 50, fixed_placements=pins, deadline=0.5)


@pytest.mark.parametrize("boundary", ["capacity", "deadline"])
def test_scalar_model_transport_stops_before_spawning_on_resource_boundary(monkeypatch, tmp_path, boundary):
    from types import SimpleNamespace

    from app.api.routes import AutoLayoutRequest

    children, _ = _controlled_workers(monkeypatch, _proposal_script("pass"))
    request = AutoLayoutRequest(tool_ids=["雪" * 1024 if boundary == "capacity" else "0"])
    if boundary == "capacity":
        monkeypatch.setattr(service, "_MAX_FRAME_BYTES", 1024)
    else:
        ticks = iter((0.0, 0.0, 0.0))
        monkeypatch.setattr(service, "time", SimpleNamespace(monotonic=lambda: next(ticks, math.inf)))
    with pytest.raises(service.LayoutEngineError):
        service.auto_layout([], time_budget_seconds=2, _stored_request={
            "storage_path": str(tmp_path), "request": request,
        })
    assert not children


def test_original_source_ceiling_is_shared_across_both_engines_and_visible(monkeypatch):
    # Each individual frame fits; only the combined retained originals exceed
    # this ceiling. Even an already prepared healthy result must not hide it.
    monkeypatch.setattr(service, "_MAX_SOURCE_BYTES", 3072)
    children, _ = _controlled_workers(monkeypatch, _proposal_script("pass"))
    with pytest.raises(service.LayoutEngineError):
        service.auto_layout(_concave_tools(), time_budget_seconds=2)
    assert len(children) == 2
    _assert_reaped(children)


def test_optional_centering_preserves_each_original_when_large_translation_loses_precision():
    clearance = 2**60 - 512
    geometry = LayoutGeometry(_tools(box(0, 0, 256, 256), box(0, 0, 256, 256)),
                              clearance, 2**80, 1024)
    placed = geometry.validate([[0, 0, 0, 0], [1, 2**60 - 256, 0, 0]])
    assert placed is not None
    # Isolate optional presentation after actual original-geometry validation;
    # worker startup/kill deadlines have their own real-process regressions.
    for item in placed:
        item.context = {"width": geometry.width, "depth": geometry.depth,
                        "auto_width": geometry.auto_width, "has_fixed": bool(geometry.fixed)}
        item.fitted = geometry.inside(item.polygon)
    assert all(item.fitted and not item.context["auto_width"] and not item.context["has_fixed"]
               and item.context["width"] == 2**80 and item.context["depth"] == 1024 for item in placed)
    left, _, right, _ = layout_bounds(placed)
    dx = (geometry.width - right - left) / 2
    # Aggregate width survives while either individual original collapses:
    # this is the numerical boundary the per-outline guard must distinguish.
    assert (right + dx) - (left + dx) == right - left
    assert placed[0].bounds[0] + dx == placed[0].bounds[2] + dx
    assert math.ulp(placed[0].bounds[0] + dx) > 256
    before = [(item.x, item.y, item.rotation) for item in placed]
    placed = service._center(placed)
    assert [(item.x, item.y, item.rotation) for item in placed] == before
    assert {item.tool_id for item in placed} == {"0", "1"}
    for item in placed:
        left, top, right, bottom = item.polygon.bounds
        assert item.polygon.is_valid and item.polygon.area == 256 * 256
        assert right - left == bottom - top == 256
        assert 0 <= left < right <= 2**80 and 0 <= top < bottom <= 1024
    assert placed[0].polygon.intersection(placed[1].polygon).area == 0
    assert placed[0].polygon.distance(placed[1].polygon) >= clearance
