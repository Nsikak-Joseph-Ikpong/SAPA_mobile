"""Read any number of Excel/CSV files and sort their tables into three kinds.

* ``orders``   - one row per production order (planned / fulfilled / open qty)
* ``journal``  - confirmation journal lines (material, batch, quantity per order)
* ``products`` - product master (pack kg, starch %, blend ratio per material)

Each sheet is scanned for the row that looks most like a header, so title rows
above the table (common in SAP ByDesign exports) are skipped automatically.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path

import pandas as pd

from .config import Settings, alias_key

SUPPORTED_SUFFIXES = {".xlsx", ".xlsm", ".xls", ".csv", ".txt"}
NUMERIC_FIELDS = {
    "planned_qty", "fulfilled_qty", "open_qty", "output_kg", "issued_kg",
    "quantity", "pack_kg", "starch_pct",
}


@dataclass
class Table:
    source: str
    sheet: str
    kind: str                 # orders | journal | products | unknown
    header_row: int           # 1-based row number in the sheet
    mapping: dict[str, str]   # field -> original header text
    df: pd.DataFrame
    # Journals exported per order carry no order column; the order ID is supplied
    order_source: str = ""    # "column" | "given" | "file name" | "" (still needed)

    @property
    def needs_order(self) -> bool:
        return self.kind == "journal" and not self.order_source

    @property
    def label(self) -> str:
        return f"{self.source} [{self.sheet}]" if self.sheet else self.source


@dataclass
class Dataset:
    tables: list[Table] = field(default_factory=list)

    def _concat(self, kind: str) -> pd.DataFrame:
        frames = [t.df for t in self.tables if t.kind == kind and not t.df.empty]
        return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()

    @property
    def orders(self) -> pd.DataFrame:
        return self._concat("orders")

    @property
    def journal(self) -> pd.DataFrame:
        j = self._concat("journal")
        return j[j["order_id"].notna()].reset_index(drop=True) if not j.empty else j

    @property
    def unassigned_journals(self) -> list[Table]:
        return [t for t in self.tables if t.needs_order]

    @property
    def products(self) -> pd.DataFrame:
        return self._concat("products")


# ---------------------------------------------------------------- value parsing

def is_blank(value) -> bool:
    if value is None:
        return True
    if isinstance(value, float) and math.isnan(value):
        return True
    try:
        if pd.isna(value):
            return True
    except (TypeError, ValueError):
        pass
    return isinstance(value, str) and value.strip() == ""


def to_number(value) -> float:
    """Parse '2,254.00', '1.234,5', '(12.5)', '12.5-' and plain numbers."""
    if is_blank(value):
        return math.nan
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip().replace(" ", "").replace(" ", "")
    negative = False
    if s.startswith("(") and s.endswith(")"):
        negative, s = True, s[1:-1]
    if s.endswith("-"):  # SAP style trailing minus
        negative, s = True, s[:-1]
    s = re.sub(r"[^0-9,.\-]", "", s)
    if s.startswith("-"):
        negative, s = not negative, s[1:]
    if not s:
        return math.nan
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        s = s.replace(",", "") if re.fullmatch(r"\d{1,3}(,\d{3})+", s) else s.replace(",", ".")
    try:
        number = float(s)
    except ValueError:
        return math.nan
    return -number if negative else number


_DMY = re.compile(r"^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?")


def to_date(value):
    """Dates like '19.08.2026' or '24.09.2026 03:44:29 GMTUK' (day first)."""
    if is_blank(value):
        return pd.NaT
    if isinstance(value, (datetime, date, pd.Timestamp)):
        return pd.Timestamp(value)
    text = str(value).strip()
    m = _DMY.match(text)
    if m:
        d, mo, y, hh, mm, ss = m.groups()
        y = int(y) + 2000 if len(y) == 2 else int(y)
        try:
            return pd.Timestamp(y, int(mo), int(d), int(hh or 0), int(mm or 0), int(ss or 0))
        except ValueError:
            return pd.NaT
    try:
        return pd.to_datetime(text, dayfirst=True)
    except (ValueError, TypeError):
        return pd.NaT


def to_id(value) -> str | None:
    if is_blank(value):
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    s = re.sub(r"\.0$", "", str(value).strip())
    return s.upper() or None


def to_flag(value) -> bool:
    if is_blank(value):
        return False
    if isinstance(value, (bool, int, float)):
        return bool(value)
    return str(value).strip().lower() in {"x", "yes", "y", "true", "1", "reversed", "cancelled", "canceled", "reversal"}


# ---------------------------------------------------------------- table detection

def _alias_lookup(settings: Settings) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for fld, aliases in settings.column_aliases.items():
        for alias in aliases:
            lookup.setdefault(alias_key(alias), fld)
    return lookup


def _find_header_row(raw: pd.DataFrame, lookup: dict[str, str], scan_rows: int) -> tuple[int, int]:
    best_row, best_hits = -1, 0
    for i in range(min(len(raw), scan_rows)):
        fields = {lookup.get(alias_key(v)) for v in raw.iloc[i] if not is_blank(v)}
        fields.discard(None)
        if len(fields) > best_hits:
            best_row, best_hits = i, len(fields)
    return best_row, best_hits


def _classify(fields: set[str]) -> str:
    if "order_id" in fields and "material_id" in fields and "quantity" in fields:
        return "journal"
    if "order_id" in fields and fields & {"planned_qty", "fulfilled_qty", "output_kg", "issued_kg"}:
        return "orders"
    # Journal pulled from one production order: no order column of its own
    if "material_id" in fields and "quantity" in fields and fields & {"doc_type", "batch", "confirmation_id"}:
        return "journal"
    if "material_id" in fields and "order_id" not in fields and fields & {"pack_kg", "starch_pct", "blend_ratio", "component_type"}:
        return "products"
    return "unknown"


def parse_sheet(raw: pd.DataFrame, source: str, sheet: str, settings: Settings) -> Table:
    lookup = _alias_lookup(settings)
    raw = raw.replace("", None).dropna(how="all").dropna(axis=1, how="all")
    sheet_rows = list(raw.index)  # original row positions, for reporting
    raw = raw.reset_index(drop=True)
    header_idx, hits = _find_header_row(raw, lookup, settings.header_scan_rows)
    if header_idx < 0 or hits < 2:
        return Table(source, sheet, "unknown", 0, {}, pd.DataFrame())

    headers = list(raw.iloc[header_idx])
    columns: dict[str, int] = {}
    mapping: dict[str, str] = {}
    for pos, header in enumerate(headers):
        if is_blank(header):
            continue
        fld = lookup.get(alias_key(header))
        if fld and fld not in columns:
            columns[fld] = pos
            mapping[fld] = str(header).strip()

    # SAP exports often put the material description in an untitled column
    # immediately to the right of "Material ID".
    if "material_desc" not in columns and "material_id" in columns:
        nxt = columns["material_id"] + 1
        if nxt < len(headers) and is_blank(headers[nxt]):
            columns["material_desc"] = nxt
            mapping["material_desc"] = "(untitled column after material ID)"

    kind = _classify(set(columns))
    body = raw.iloc[header_idx + 1:]
    out = pd.DataFrame({fld: body.iloc[:, pos].tolist() for fld, pos in columns.items()})

    # ByDesign writes the unit into the quantity cell: "-1,002.11 kg", "98.00 case"
    if "quantity" in out.columns and "uom" not in out.columns:
        units = [re.search(r"([A-Za-z]+)\s*$", v).group(1).lower()
                 if isinstance(v, str) and re.search(r"[A-Za-z]+\s*$", v) else None for v in out["quantity"]]
        if any(units):
            out["uom"] = units
            mapping["uom"] = f"(unit written after {mapping['quantity']})"

    for fld in out.columns:
        if fld in NUMERIC_FIELDS:
            out[fld] = [to_number(v) for v in out[fld]]
        elif fld == "date":
            out[fld] = [to_date(v) for v in out[fld]]
        elif fld in {"order_id", "material_id", "batch", "confirmation_id"}:
            out[fld] = [to_id(v) for v in out[fld]]
        elif fld == "reversal":
            out[fld] = [to_flag(v) for v in out[fld]]
        else:
            out[fld] = [None if is_blank(v) else str(v).strip() for v in out[fld]]

    # Grouped journal exports show the order ID only on the first line of a group
    if kind == "journal" and "order_id" in out.columns:
        out["order_id"] = out["order_id"].ffill()

    # Drop repeated header rows, subtotal rows and blank rows
    key_field = "order_id" if "order_id" in out.columns else "material_id"
    if key_field in out.columns:
        keys = out[key_field]
        header_key = alias_key(mapping[key_field])
        bad = keys.isna() | keys.map(lambda k: k is not None and (
            alias_key(k) == header_key or alias_key(k) in {"total", "result", "overallresult", "sum"}))
        out = out[~bad]
    if kind == "journal":
        out = out[out["material_id"].notna()]
    out = out.reset_index(drop=True)
    out["_source"] = f"{source} [{sheet}]" if sheet else source
    if kind == "journal" and "order_id" not in out.columns:
        out["order_id"] = None
    order_source = "column" if kind == "journal" and "order_id" in columns else ""
    return Table(source, sheet, kind, sheet_rows[header_idx] + 1, mapping, out, order_source)


def order_from_filename(name: str) -> str | None:
    """'journal_589.xlsx' or 'PO 1439 confirmations.csv' -> the order number, if exactly one."""
    # Only stand-alone numbers: ByDesign's own names ("...CFJU01_Q0001_23") must not count
    numbers = re.findall(r"(?<![A-Za-z\d])(\d{3,7})(?![A-Za-z\d])", Path(name).stem)
    return numbers[0] if len(numbers) == 1 else None


def assign_order(table: Table, order_id: str, how: str = "given") -> None:
    table.df["order_id"] = to_id(order_id)
    table.order_source = how


def _read_csv(path: Path) -> pd.DataFrame:
    for encoding in ("utf-8-sig", "latin-1"):
        try:
            return pd.read_csv(path, header=None, dtype=str, sep=None, engine="python",
                               encoding=encoding, keep_default_na=False)
        except UnicodeDecodeError:
            continue
    raise ValueError(f"Could not decode {path}")


def expand_paths(paths: list[str]) -> list[Path]:
    files: list[Path] = []
    for p in paths:
        path = Path(p).expanduser()
        if path.is_dir():
            files.extend(sorted(f for f in path.iterdir()
                                if f.suffix.lower() in SUPPORTED_SUFFIXES and not f.name.startswith("~$")))
        elif path.exists():
            files.append(path)
        else:
            raise FileNotFoundError(f"File not found: {p}")
    return files


def load_files(paths: list[str], settings: Settings,
               journal_orders: dict[str, str] | None = None) -> Dataset:
    """Read every file. ``journal_orders`` maps a journal's file name to its production order,
    for journals that have no order column; otherwise a number in the file name is used."""
    journal_orders = {k.lower(): v for k, v in (journal_orders or {}).items()}
    dataset = Dataset()
    for path in expand_paths(paths):
        if path.suffix.lower() in {".csv", ".txt"}:
            sheets = {"": _read_csv(path)}
        else:
            sheets = pd.read_excel(path, sheet_name=None, header=None, dtype=object)
        for sheet_name, raw in sheets.items():
            table = parse_sheet(raw, path.name, str(sheet_name), settings)
            if table.needs_order:
                given = journal_orders.get(path.name.lower()) or journal_orders.get(path.stem.lower())
                if given:
                    assign_order(table, given, "given")
                elif order_from_filename(path.name):
                    assign_order(table, order_from_filename(path.name), "file name")
            dataset.tables.append(table)
    return dataset
