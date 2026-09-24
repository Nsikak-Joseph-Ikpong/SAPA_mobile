"""Command line: load spreadsheets, ask for production order IDs, report flags."""

from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime

from .analysis import analyse, all_order_ids
from .config import load_settings
from .loader import assign_order, load_files
from .report import print_report, write_excel


def parse_ids(text: str) -> list[str]:
    return [t for t in re.split(r"[\s,;]+", text.strip()) if t]


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="sap_variance",
        description="Flag cheese input/output variances per production order across one or more "
                    "SAP ByDesign spreadsheet exports (order list, confirmation journal, product master).",
    )
    p.add_argument("files", nargs="*", help="Excel/CSV files or folders. All are read together and cross-referenced.")
    p.add_argument("-o", "--orders", help="Production order IDs, e.g. '589,746 783'. Omit to be asked.")
    p.add_argument("-a", "--all", action="store_true", help="Check every order found in the files.")
    p.add_argument("-x", "--excel", help="Write the report to this Excel file (default: variance_report_<time>.xlsx).")
    p.add_argument("--no-excel", action="store_true", help="Do not write an Excel report.")
    p.add_argument("-j", "--journal-order", action="append", default=[], metavar="FILE=ORDER",
                   help="Production order a confirmation journal belongs to, e.g. conf_jtest.xlsx=589. "
                        "Needed for journals without an order column (repeat for several files).")
    p.add_argument("-c", "--config", help="JSON file overriding column names, keywords or tolerances.")
    p.add_argument("--hide-info", action="store_true", help="Hide INFO-level notes in the console.")
    return p


def run_once(dataset, settings, ids, args) -> None:
    analysis = analyse(dataset, settings, ids)
    print_report(analysis, show_info=not args.hide_info)
    if not args.no_excel and analysis.requested:
        out = args.excel or f"variance_report_{datetime.now():%Y%m%d_%H%M%S}.xlsx"
        print(f"\nExcel report: {write_excel(analysis, out)}")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    interactive = sys.stdin.isatty()

    files = list(args.files)
    if not files:
        if not interactive:
            print("No files given.", file=sys.stderr)
            return 2
        entered = input("Spreadsheet files or folder (separate with ';'): ")
        files = [f.strip().strip('"').strip("'") for f in entered.split(";") if f.strip()]

    settings = load_settings(args.config)
    journal_orders = {}
    for item in args.journal_order:
        name, _, order = item.rpartition("=")
        if not name or not order:
            print(f"--journal-order expects FILE=ORDER, got '{item}'", file=sys.stderr)
            return 2
        journal_orders[name.split("/")[-1].split("\\")[-1]] = order
    try:
        dataset = load_files(files, settings, journal_orders)
    except (FileNotFoundError, ValueError) as exc:
        print(exc, file=sys.stderr)
        return 2

    for table in dataset.unassigned_journals:
        if not interactive:
            print(f"{table.label} is a confirmation journal with no production order column. "
                  f"Say which order it is for with --journal-order \"{table.source}=ORDER\".", file=sys.stderr)
            return 2
        while True:
            order = input(f"Which production order is the journal {table.label} for? ").strip()
            if order:
                assign_order(table, order)
                break
    known = all_order_ids(dataset)
    if not known:
        print("No production orders found in the files. Check the 'Files read' list for "
              "which columns were recognised, or add aliases with --config.", file=sys.stderr)
        print_report(analyse(dataset, settings))
        return 1
    print(f"Loaded {len(files)} path(s); {len(known)} production order(s) found.")

    if args.all:
        run_once(dataset, settings, None, args)
        return 0
    if args.orders:
        run_once(dataset, settings, parse_ids(args.orders), args)
        return 0
    if not interactive:
        run_once(dataset, settings, None, args)
        return 0

    while True:
        text = input("\nProduction order ID(s) to check (comma/space separated, 'all', or Enter to quit): ")
        if not text.strip():
            return 0
        ids = None if text.strip().lower() == "all" else parse_ids(text)
        run_once(dataset, settings, ids, args)


if __name__ == "__main__":
    sys.exit(main())
