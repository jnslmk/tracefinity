"""Access pockets in derived planning: geometry inclusion and cache isolation.

Pockets live in the bin config, so height/seating planning must assess the
same pocketed solid that is exported and must not reuse a cached assessment
from before the pocket was added or removed.
"""

from app.models.schemas import AccessPocket, BinConfig, BinModel, PlacedTool, Tool
from app.services import toolbox_planning as planning

_POINTS = [
    {"x": 11, "y": 11}, {"x": 31, "y": 11}, {"x": 31, "y": 31}, {"x": 11, "y": 31},
]


def _bin(pocket: AccessPocket | None = None) -> tuple[BinModel, dict]:
    config = BinConfig(grid_x=2, grid_y=2, height_units=4, magnets=False)
    if pocket is not None:
        config.access_pockets = [pocket]
    data = BinModel(
        id="bin",
        bin_config=config,
        placed_tools=[PlacedTool(id="placement", tool_id="tool", name="Square", points=_POINTS, depth_override=8)],
    )
    tools = {"tool": Tool(id="tool", name="Square", points=_POINTS, thickness_mm=12)}
    return data, tools


def test_planning_key_changes_when_a_pocket_is_added():
    plain, _ = _bin()
    pocketed, _ = _bin(AccessPocket(id="p", x=42, y=70, length=30, width=20, depth=8))
    assert planning._planning_key(plain, {}) != planning._planning_key(pocketed, {})


def test_assessment_uses_the_pocketed_solid():
    clean, tools = _bin()
    assert planning.assess_bin(clean, tools)["seating_errors"] == {}

    # a pocket deeper than the tool cavity removes the tool's resting floor
    dirty, _ = _bin(AccessPocket(id="p", x=21, y=21, length=30, width=20, depth=12))
    errors = planning.assess_bin(dirty, tools)["seating_errors"]
    assert errors, "planning must assess the pocketed geometry, not the pocket-free bin"


def test_cached_assessment_is_invalidated_by_pocket_edits():
    plain, tools = _bin()
    first = planning.assess_bin(plain, tools)
    assert planning.assess_bin(plain, tools) == first

    with_pocket, _ = _bin(AccessPocket(id="p", x=21, y=21, length=30, width=20, depth=12))
    changed = planning.assess_bin(with_pocket, tools)
    assert changed != first
