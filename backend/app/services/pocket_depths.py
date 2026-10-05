"""Automatic per-tool pocket depths.

A placement with an automatic depth is cut just deep enough that its measured
tool rests below the bin stacked on top, leaving the configured stacking
clearance. The required depth is derived from the authoritative stack-mating
increment produced by the same solids that get exported, never from nominal lip
arithmetic, so rim height, half-grid bases and real mating drop are all
accounted for. Derived depths are recomputed from the current measurement,
placement and bin geometry on every call and are never written back as manual
overrides.
"""

from __future__ import annotations

import json

from app.models.schemas import GenerateRequest, PlacedTool
from app.services.stl_generator_manifold import (
    GF_BASE_HEIGHT,
    GF_HEIGHT_UNIT,
    assess_printed_bin,
)

# Fields that do not change the shell/lip mating surface, so they must not
# invalidate a cached mating increment.
_MATING_KEY_EXCLUDES = {
    "bed_size",
    "cutout_chamfer",
    "cutout_clearance",
    "cutout_depth",
    "cutout_depth_mode",
    "insert_clearance",
    "insert_enabled",
    "insert_height",
    "stacking_clearance_mm",
}

# ponytail: bounded FIFO keyed on the mating geometry alone; one distinct shell
# per height/rim combination is all an assessment or a proposal sweep needs.
_MATING_CACHE: dict[str, float] = {}
_MATING_CACHE_LIMIT = 32


def placement_is_custom(placed: PlacedTool) -> bool:
    """Whether a placement keeps its stored override instead of a derived depth.

    An explicit choice always wins. A pre-feature placement (no mode) keeps a
    stored override so existing bins do not silently change depth; with no
    override it follows the bin's automatic depth.
    """
    if placed.depth_mode == "custom":
        return True
    if placed.depth_mode == "automatic":
        return False
    return placed.depth_override is not None


def needs_mating_increment(config, placed_tools) -> bool:
    """True when at least one placement derives its depth from the measurement."""
    return config.cutout_depth_mode == "automatic" and any(
        not placement_is_custom(placed) for placed in placed_tools
    )


def max_supported_depth_mm(config) -> float:
    """Deepest pocket the protected floor allows, matching the cutter pipeline."""
    return config.height_units * GF_HEIGHT_UNIT - GF_BASE_HEIGHT - 2


def mating_increment_mm(
    request: GenerateRequest,
    upper_request: GenerateRequest | None = None,
    relative_rotation: int = 0,
) -> float:
    """Height a bin adds to a stack, from the generated mating assessment.

    Pocket cutouts never reach the lip or base, so the increment is computed
    from the lip/base solids alone and cached on the geometry that determines
    it. This is the same authoritative assessment planning and export use.
    """
    key = json.dumps({
        "config": request.model_dump(exclude=_MATING_KEY_EXCLUDES),
        "upper": upper_request.model_dump() if upper_request is not None else None,
        "rotation": relative_rotation,
    }, sort_keys=True, default=str)
    cached = _MATING_CACHE.get(key)
    if cached is not None:
        return cached
    increment = float(assess_printed_bin([], [], request, upper_request, relative_rotation)["stack_increment_mm"])
    # ponytail: FIFO at _MATING_CACHE_LIMIT entries; a miss just rebuilds one shell.
    if key not in _MATING_CACHE and len(_MATING_CACHE) >= _MATING_CACHE_LIMIT:
        _MATING_CACHE.pop(next(iter(_MATING_CACHE)))
    _MATING_CACHE[key] = increment
    return increment


def automatic_required_depth_mm(config, thickness_mm: float, stack_increment_mm: float) -> float:
    """Final pocket depth below the wall top that seats a measured tool with
    the configured stacking clearance to the underside above it."""
    wall_top = config.height_units * GF_HEIGHT_UNIT
    insert = config.insert_height if config.insert_enabled else 0.0
    return wall_top - stack_increment_mm + thickness_mm + insert + config.stacking_clearance_mm


def _automatic_override_mm(config, thickness_mm: float, stack_increment_mm: float) -> float:
    """Override value that makes the cutter pipeline yield the required depth.

    ``_resolve_pocket_depth`` adds the insert allowance itself, so the derived
    override subtracts it back out; the clamped result is identical.
    """
    insert = config.insert_height if config.insert_enabled else 0.0
    return automatic_required_depth_mm(config, thickness_mm, stack_increment_mm) - insert


def resolved_overrides(config, placed_tools, tools, stack_increment_mm: float | None) -> dict[str, float | None]:
    """Placement id → depth_override the cutter pipeline should use.

    ``None`` means the configured ``cutout_depth``. Storage is never modified,
    so switching modes keeps every stored override.
    """
    overrides: dict[str, float | None] = {}
    automatic_bin = config.cutout_depth_mode == "automatic"
    uniform_bin = config.cutout_depth_mode == "uniform"
    for placed in placed_tools:
        if automatic_bin and not placement_is_custom(placed):
            tool = tools.get(placed.tool_id)
            thickness = tool.thickness_mm if tool is not None else None
            if thickness is None or stack_increment_mm is None:
                # unknown measurement: unverified fallback to the global depth
                overrides[placed.id] = None
            else:
                overrides[placed.id] = _automatic_override_mm(config, thickness, stack_increment_mm)
        elif uniform_bin:
            # one configured depth for every tool; stored overrides are kept
            overrides[placed.id] = None
        else:
            overrides[placed.id] = placed.depth_override
    return overrides
