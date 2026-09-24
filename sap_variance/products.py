"""Product facts: pack weight, starch percentage, blend ratio and component type.

The product master file wins. Where it has no entry, facts are read from the
material description (e.g. "12x1kg", "70/30") or the material ID
(e.g. MCGR155EF7030 -> 70/30 blend, GR -> grated).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

import pandas as pd

from .config import Settings
from .loader import is_blank


@dataclass
class ProductInfo:
    material_id: str
    description: str | None
    pack_kg: float | None
    pack_source: str
    starch_pct: float
    starch_source: str
    blend: tuple[float, ...] | None     # e.g. (0.7, 0.3)
    component_type: str | None          # override from product master
    master_pack_kg: float | None = None
    parsed_pack_kg: float | None = None


def parse_pack_kg(description: str | None) -> float | None:
    """'12x1kg' -> 12, '10x1kg' -> 10, '5x1' -> 5, '12 x 500g' -> 6, '2kg' -> 2."""
    if not description:
        return None
    text = description.lower()
    m = re.search(r"(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|g)?\b", text)
    if m:
        count = int(m.group(1))
        size = float(m.group(2).replace(",", "."))
        unit = m.group(3) or "kg"
        return count * (size / 1000 if unit == "g" else size)
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*kg\b", text)
    if m:
        return float(m.group(1).replace(",", "."))
    return None


def parse_blend(*texts: str | None) -> tuple[float, ...] | None:
    """'70/30' in a description, or a trailing '7030' on a material ID."""
    for text in texts:
        if not text:
            continue
        m = re.search(r"\b(\d{1,2})\s*/\s*(\d{1,2})(?:\s*/\s*(\d{1,2}))?\b", text)
        if m:
            parts = [int(p) for p in m.groups() if p]
            if sum(parts) == 100:
                return tuple(sorted((p / 100 for p in parts), reverse=True))
    for text in texts:
        if not text:
            continue
        m = re.search(r"(\d{2})(\d{2})$", text.strip())
        if m and int(m.group(1)) + int(m.group(2)) == 100 and int(m.group(2)) > 0:
            return tuple(sorted((int(m.group(1)) / 100, int(m.group(2)) / 100), reverse=True))
    return None


def _is_grated(material_id: str, description: str | None, settings: Settings) -> bool:
    if description and "grated" in description.lower():
        return True
    if description and "sliced" in description.lower():
        return False
    # Material IDs like MAGR155BA / WHGR155EF carry "GR" after a 2-letter prefix
    return any(len(material_id) > 3 and material_id[2:4] == marker.upper()
               for marker in settings.grated_markers if len(marker) == 2)


class ProductCatalog:
    def __init__(self, products: pd.DataFrame, descriptions: dict[str, str], settings: Settings):
        self.settings = settings
        self.descriptions = descriptions
        self.master: dict[str, dict] = {}
        if not products.empty:
            for row in products.to_dict("records"):
                mid = row.get("material_id")
                if mid:
                    entry = self.master.setdefault(mid, {})
                    for key, value in row.items():
                        if not is_blank(value) and key not in entry:
                            entry[key] = value
        self._cache: dict[str, ProductInfo] = {}

    def description(self, material_id: str | None) -> str | None:
        if not material_id:
            return None
        master_desc = self.master.get(material_id, {}).get("material_desc")
        return master_desc or self.descriptions.get(material_id)

    def component_type(self, material_id: str | None) -> str | None:
        if not material_id:
            return None
        value = self.master.get(material_id, {}).get("component_type")
        return str(value).strip().lower() if value else None

    def get(self, material_id: str) -> ProductInfo:
        if material_id in self._cache:
            return self._cache[material_id]
        entry = self.master.get(material_id, {})
        desc = self.description(material_id)

        master_pack = self.settings.pack_overrides.get(material_id, entry.get("pack_kg"))
        master_pack = None if master_pack is None or math.isnan(float(master_pack)) else float(master_pack)
        parsed_pack = parse_pack_kg(desc)
        if master_pack:
            pack, pack_source = master_pack, "product master"
        elif parsed_pack:
            pack, pack_source = parsed_pack, "description"
        else:
            pack, pack_source = None, "unknown"

        starch = entry.get("starch_pct")
        if starch is not None and not math.isnan(starch):
            starch = float(starch)
            if starch > 1:  # written as 1.5 meaning 1.5%
                starch /= 100
            starch_source = "product master"
        elif _is_grated(material_id, desc, self.settings):
            starch, starch_source = self.settings.grated_starch_pct, "default for grated"
        else:
            starch, starch_source = 0.0, "default (not grated)"

        blend = parse_blend(entry.get("blend_ratio"), desc, material_id)

        info = ProductInfo(
            material_id=material_id, description=desc, pack_kg=pack, pack_source=pack_source,
            starch_pct=starch, starch_source=starch_source, blend=blend,
            component_type=self.component_type(material_id),
            master_pack_kg=master_pack, parsed_pack_kg=parsed_pack,
        )
        self._cache[material_id] = info
        return info
