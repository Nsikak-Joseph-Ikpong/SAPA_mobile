"""Settings: column-name aliases, material classification rules and tolerances.

Everything here can be overridden with a JSON file passed via ``--config``.
Keys in that file replace the defaults below; for ``column_aliases`` the
listed aliases are *added* to the built-in ones for that field.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

# Field name -> header texts that mean that field. Matching ignores case,
# spaces and punctuation, so "Required On (Date)" matches "required on date".
DEFAULT_COLUMN_ALIASES: dict[str, list[str]] = {
    "order_id": [
        "production order id", "production order", "prod order id", "prod order",
        "order id", "order", "job number", "job no", "job",
    ],
    "date": [
        "required on (date)", "required on", "posting date", "confirmation date",
        "confirmed on", "date", "created on", "finished on", "completed on",
    ],
    "material_id": ["material id", "material", "product id", "product", "material number", "item id"],
    "material_desc": [
        "material description", "material text", "description", "product description",
        "material name", "item description",
    ],
    "status": ["production order status", "order status", "status"],
    "planned_qty": ["planned quantity", "planned qty", "planned output"],
    "fulfilled_qty": ["fulfilled quantity", "fulfilled qty", "fulfilled", "actual output"],
    "open_qty": ["open quantity", "open qty", "remaining quantity"],
    # Order-level summary columns (e.g. the existing variance spreadsheet)
    "output_kg": ["nominal weight of output", "nominal output kg", "output kg"],
    "issued_kg": ["actual cheese issued", "cheese issued", "issued kg", "actual issued"],
    # Confirmation journal columns
    "quantity": ["confirmed quantity", "effective qty", "effective quantity", "quantity", "qty",
                 "actual quantity", "confirmed qty"],
    "uom": ["unit of measure", "uom", "unit", "quantity unit"],
    "batch": [
        "identified stock (identified stock id)", "identified stock", "identified stock id", "batch", "batch id", "batch number",
        "batch no", "lot", "lot number",
    ],
    "direction": [
        "input/output", "input output", "direction", "material role", "confirmation type",
        "movement type", "type",
    ],
    "reversal": ["reversed", "reversal", "cancelled", "canceled", "cancellation", "is reversal"],
    "line": ["resource", "resource id", "production line", "line", "work centre", "work center"],
    "user": ["created by", "confirmed by", "posted by", "user", "operator"],
    "confirmation_id": ["conf.id", "conf id", "confirmation id", "confirmation", "confirmation number"],
    # Confirmation journal as exported from ByDesign: signed quantities per logistics area
    "doc_type": ["conf.document type", "conf document type", "confirmation document type", "document type"],
    "location": ["logistics area (logistics area id)", "logistics area", "logistics area id",
                 "storage location", "location", "bin"],
    "site": ["site", "site id"],
    # Product master columns
    "pack_kg": ["pack kg", "kg per case", "case weight kg", "case kg", "nominal pack weight", "pack weight"],
    "starch_pct": ["starch pct", "starch %", "starch percent", "anti caking pct"],
    "blend_ratio": ["blend ratio", "blend", "blend composition"],
    "component_type": ["component type", "material type", "category"],
}


@dataclass
class Settings:
    column_aliases: dict[str, list[str]] = field(
        default_factory=lambda: {k: list(v) for k, v in DEFAULT_COLUMN_ALIASES.items()}
    )
    header_scan_rows: int = 30

    # --- material classification (checked in this order) ---
    offcut_keywords: list[str] = field(default_factory=lambda: ["offcut", "off-cut", "off cut", "trim", "rework", "end piece"])
    starch_keywords: list[str] = field(default_factory=lambda: ["starch", "anti-caking", "anticaking", "anti caking"])
    packaging_keywords: list[str] = field(default_factory=lambda: [
        "box", "carton", "case", "label", "film", "basefilm", "topfilm", "pillow", "bag",
        "tray", "lid", "sleeve", "pallet", "wrap", "tape", "packaging",
    ])
    packaging_id_prefixes: list[str] = field(default_factory=lambda: ["BO", "LA", "BASEFILM", "TOPFILM", "PILLOW"])
    cheese_id_prefixes: list[str] = field(default_factory=lambda: ["RM"])
    cheese_keywords: list[str] = field(default_factory=lambda: [
        "cheese", "cheddar", "mozzarella", "mozz", "leicester", "gouda", "edam", "emmental",
    ])

    # --- expected yield ---
    grated_starch_pct: float = 0.015  # 36.75kg starch on 2,450kg output
    grated_markers: list[str] = field(default_factory=lambda: ["grated", "GR"])

    # --- tolerances ---
    tolerance_pct: float = 0.05
    tolerance_kg: float = 50.0
    high_severity_multiple: float = 3.0   # |variance| > 3x tolerance -> HIGH
    high_severity_kg: float = 500.0       # ... or > 500kg -> HIGH
    no_issue_ratio: float = 0.10          # issued <= 10% of expected -> "nothing issued"
    closed_short_ratio: float = 0.90      # fulfilled < 90% of planned with open = 0
    over_produced_ratio: float = 1.10
    blend_share_tolerance: float = 0.08   # 70/30 accepted between 62/38 and 78/22
    offcut_max_ratio: float = 0.15        # offcuts > 15% of cheese issued
    closed_statuses: list[str] = field(default_factory=lambda: ["closed", "completed", "finished", "technically completed"])

    # --- confirmation journal with signed quantities ---
    production_doc_keywords: list[str] = field(default_factory=lambda: ["production"])
    unmatched_window_minutes: int = 60   # no-output confirmations this close to the job on the same line belong to it

    # --- cross-order swap matching ---
    swap_window_days: int = 7
    swap_max_residual: float = 0.35  # |a + b| / max(|a|, |b|) must be below this


def alias_key(text) -> str:
    """Normalise a header so 'Required On (Date)' == 'required on date'."""
    return re.sub(r"[^a-z0-9%]", "", str(text).lower())


def load_settings(path: str | Path | None) -> Settings:
    settings = Settings()
    if not path:
        return settings
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    for key, value in data.items():
        if key == "column_aliases":
            for fld, aliases in value.items():
                existing = settings.column_aliases.setdefault(fld, [])
                # User aliases take priority over built-in ones
                settings.column_aliases[fld] = list(aliases) + [a for a in existing if a not in aliases]
        elif hasattr(settings, key):
            setattr(settings, key, value)
        else:
            raise ValueError(f"Unknown setting in {path}: {key}")
    return settings
