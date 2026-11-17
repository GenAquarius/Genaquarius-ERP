"""
Golden-master extractor.

Reads BOTH costing workbooks and exports the *cached computed value* of every
non-empty cell of every sheet. This dataset is the immutable "truth" the
application must reproduce with ZERO deviation (see IMPLEMENTATION_PLAN.md
section 9.1).

Output: app/data/golden_master.json
  {
    "<workbook-key>": {
       "<SheetName>": { "A1": <value>, "B2": <value>, ... },
       ...
    },
    ...
  }

Values are the Excel-cached results (data_only=True), so formula cells export
their evaluated number/text exactly as Excel last saved them.
"""
import json
import os
import datetime
import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# ROOT = ...\costing
WORKBOOKS = {
    "FY26-27": os.path.join(ROOT, "Costing_FY26-27New.xlsm"),
    "FY25-26": os.path.join(ROOT, "Costing_Updated till Mar26.xlsm"),
}
OUT = os.path.join(ROOT, "app", "data", "golden_master.json")


def cell_value(v):
    """Normalise a cell value to a JSON-serialisable, comparison-stable form."""
    if v is None:
        return None
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.isoformat()
    if isinstance(v, float):
        # Keep full precision; round only obvious float noise at 10 dp.
        r = round(v, 10)
        return int(r) if r.is_integer() else r
    return v


def extract_workbook(path):
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    out = {}
    for name in wb.sheetnames:
        ws = wb[name]
        sheet = {}
        for row in ws.iter_rows():
            for c in row:
                val = cell_value(c.value)
                if val is not None and val != "":
                    sheet[c.coordinate] = val
        out[name] = sheet
    wb.close()
    return out


def main():
    result = {}
    summary = []
    for key, path in WORKBOOKS.items():
        if not os.path.exists(path):
            print(f"!! MISSING: {path}")
            continue
        wb_data = extract_workbook(path)
        result[key] = wb_data
        cells = sum(len(s) for s in wb_data.values())
        summary.append((key, len(wb_data), cells))
        print(f"[{key}] sheets={len(wb_data)} cells={cells}")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=0)
    total = sum(s[2] for s in summary)
    print(f"\nWrote {OUT}")
    print(f"TOTAL workbooks={len(summary)} cells={total}")


if __name__ == "__main__":
    main()
