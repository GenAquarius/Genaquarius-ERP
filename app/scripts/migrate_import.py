"""
Migration importer (both fiscal years).

Parses the current and prior-year workbooks (cached values) into a normalised
seed the Node app imports into MySQL. Cost/invoice come straight from Excel
cached cells => zero deviation by construction.

Output: app/data/seed.json
  { geographies, clients, employees, ctcRecords, fxRates,
    years: { "FY26-27": {monthlySheets, actualCost}, "FY25-26": {monthlySheets, actualCost} } }
"""
import json
import os
import datetime
import re
import openpyxl
from openpyxl.utils import column_index_from_string as col_idx, get_column_letter

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "app", "data", "seed.json")
MONTHS = ["Apr", "May", "June", "July", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"]

# Per-workbook config for the Actual Cost grid + monthly tabs.
WORKBOOKS = {
    "FY26-27": {
        "path": os.path.join(ROOT, "Costing_FY26-27New.xlsm"),
        "ac_header_row": 13, "ac_first": 14, "ac_last": 132,
        "ac_cost_col": {"Apr":"F","May":"L","June":"R","July":"X","Aug":"AB","Sep":"AF","Oct":"AJ","Nov":"AN","Dec":"AR","Jan":"AV","Feb":"AZ","Mar":"BD"},
        "monthly_tabs": ["Apr", "May", "June"], "is_master": True,
    },
    "FY25-26": {
        "path": os.path.join(ROOT, "Costing_Updated till Mar26.xlsm"),
        # updated workbook: (US) team groups added; real data now ends at r124 (r125+ are rollups/params)
        "ac_header_row": 11, "ac_first": 12, "ac_last": 124,
        "ac_cost_col": {"Apr":"F","May":"J","June":"N","July":"R","Aug":"V","Sep":"Z","Oct":"AD","Nov":"AH","Dec":"AL","Jan":"AP","Feb":"AT","Mar":"AX"},
        "monthly_tabs": [], "is_master": False,
    },
}

GEO = {
    "Providence":"US","Kira":"US","NP":"US","LM":"US",
    "Station Casino - India Team":"US","Station Casino - US Team":"US",
    "Clarien":"CARIBBEAN","Voices":"US","Vancity":"CANADA","Bastian":"US",
    "Cozzini Bros.":"US","Cyncly":"US","Stratoscope":"US","MC Energy":"US","Symsoft (Caltrans)":"US",
}
NON_CUSTOMER = {"Internal \nHR/IT","Internal HR/IT","Expenses India","Expenses India - Resourcing","Expenses US/Canada","Expenses"}
ROLLUP_PREFIX = ("Total","Revenue Run","Profit","Cash Flow","India Team","US/Canada","Monthly Profit","Average")


def num(v):
    return float(v) if isinstance(v, (int, float)) else 0.0
def clean(s):
    return None if s is None else re.sub(r"\s+", " ", str(s)).strip()
def iso(v):
    return v.isoformat() if isinstance(v, (datetime.datetime, datetime.date)) else None
def project_code(name):
    base = re.sub(r"[^A-Za-z0-9]", "", name.split("(")[0].split("-")[0])
    return base.upper()[:8] or "PROJ"
def is_rollup(b):
    return any(b.startswith(p) for p in ROLLUP_PREFIX)


def parse_actual_cost(wb, cfg):
    ac = wb["Actual Cost"]
    rows = []
    cur = None
    for r in range(cfg["ac_first"], cfg["ac_last"] + 1):
        a = clean(ac.cell(r, 1).value)
        b = clean(ac.cell(r, 2).value)
        if a:
            cur = a
        if not b or is_rollup(b):
            continue
        monthly = {}
        any_val = False
        for m, cc in cfg["ac_cost_col"].items():
            ci = col_idx(cc)
            cost = num(ac.cell(r, ci).value)
            inv = num(ac.cell(r, ci + 1).value)
            monthly[m] = {"cost": cost, "invoice": inv}
            if cost or inv:
                any_val = True
        if not any_val:
            continue
        is_cust = cur not in NON_CUSTOMER
        rows.append({"project": cur, "resourceName": b,
                     "geo": GEO.get(cur, "US" if is_cust else "INTERNAL"),
                     "isCustomer": is_cust, "monthly": monthly})
    return rows


def cellnum(ac, r, c):
    v = ac.cell(r, c).value
    return float(v) if isinstance(v, (int, float)) else None


def parse_summary(wb, cfg):
    """Headline metrics from Actual Cost rows 1-7 (Salary Expense, Total Cost,
    Monthly Profit, Net Profit %, Head Count / TB / Off B / On B) per month."""
    ac = wb["Actual Cost"]
    out = []
    for m, cc in cfg["ac_cost_col"].items():
        c = col_idx(cc)
        hc = cellnum(ac, 7, c)
        if hc is not None and hc > 1000:  # bogus cell (e.g. June 16739)
            hc = None
        out.append({
            "month": m, "monthIndex": MONTHS.index(m) + 1,
            "salaryExpense": cellnum(ac, 1, c),
            "totalCost": cellnum(ac, 2, c),
            "revenue": cellnum(ac, 2, c + 1),
            "monthlyProfit": cellnum(ac, 4, c + 1),
            "netProfitPct": cellnum(ac, 5, c + 1),
            "headCount": int(hc) if hc is not None else None,
            "billableHeadCount": int(cellnum(ac, 7, c + 1)) if cellnum(ac, 7, c + 1) is not None else None,
            "offshoreBillable": int(cellnum(ac, 7, c + 2)) if cellnum(ac, 7, c + 2) is not None else None,
            "onsiteBillable": int(cellnum(ac, 7, c + 3)) if cellnum(ac, 7, c + 3) is not None else None,
        })
    return out


def parse_monthly_tabs(wb, cfg):
    sheets = []
    for mi, mname in enumerate(cfg["monthly_tabs"], start=1):
        if mname not in wb.sheetnames:
            continue
        ws = wb[mname]
        lines = []
        cur = None
        for r in range(2, ws.max_row + 1):
            name = clean(ws.cell(r, 2).value)
            if not name or name in ("Total",):
                continue
            if name in ("India Health Insurance", "Vendor Name", "commison for billable"):
                break
            proj = clean(ws.cell(r, 3).value)
            if proj:
                cur = proj
            lines.append({"resourceName": name, "projectName": cur,
                          "rateUsd": num(ws.cell(r, 5).value), "estimateHours": num(ws.cell(r, 6).value),
                          "billingAmount": num(ws.cell(r, 7).value), "actualHours": num(ws.cell(r, 8).value),
                          "invoiceAmount": num(ws.cell(r, 9).value), "costUsd": num(ws.cell(r, 4).value)})
        sheets.append({"month": mname, "monthIndex": MONTHS.index(mname) + 1, "lines": lines})
    return sheets


def parse_master(wb):
    """employees, ctc, fx from the current-year (master) workbook."""
    ctc = wb["CTC"]
    employees, ctc_records = {}, []
    for r in range(3, 81):
        name = clean(ctc.cell(r, 2).value)
        if not name or name in ("Total", "Vendor Name", "Employees"):
            continue
        proj = clean(ctc.cell(r, 3).value)
        jd = iso(ctc.cell(r, 4).value)
        employees.setdefault(name, {"name": name, "joiningDate": jd, "project": proj})
        ctc_records.append({"name": name, "effectiveFrom": jd or "2025-04-01",
            "basic": num(ctc.cell(r,5).value), "hra": num(ctc.cell(r,6).value),
            "otherAllowance": num(ctc.cell(r,7).value), "specialAllowance": num(ctc.cell(r,8).value),
            "conveyance": num(ctc.cell(r,10).value), "communication": num(ctc.cell(r,11).value),
            "meals": num(ctc.cell(r,12).value), "books": num(ctc.cell(r,13).value),
            "driver": num(ctc.cell(r,14).value), "uniform": num(ctc.cell(r,15).value),
            "usd": num(ctc.cell(r,18).value)})
    settings = wb["Settings"]
    fx = [
        {"context":"USD_INR","baseCcy":"USD","quoteCcy":"INR","rate":93,"note":"Company USD-INR rate (used everywhere)"},
        {"context":"CANADA_FACTOR","baseCcy":"CAD","quoteCcy":"USD","rate":num(settings["E7"].value) or 0.71,"note":"Canada factor"},
    ]
    return employees, ctc_records, fx


def main():
    years = {}
    employees, ctc_records, fx = {}, [], []
    customer_projects = {}

    for fy, cfg in WORKBOOKS.items():
        if not os.path.exists(cfg["path"]):
            print(f"!! missing {cfg['path']}"); continue
        wb = openpyxl.load_workbook(cfg["path"], data_only=True, read_only=False)
        ac_rows = parse_actual_cost(wb, cfg)
        sheets = parse_monthly_tabs(wb, cfg)
        summary = parse_summary(wb, cfg)
        years[fy] = {"monthlySheets": sheets, "actualCost": ac_rows, "summary": summary}
        if cfg["is_master"]:
            employees, ctc_records, fx = parse_master(wb)
        for row in ac_rows:
            p = row["project"]
            if row["isCustomer"] and p not in customer_projects:
                customer_projects[p] = {"name": p, "code": project_code(p), "geo": row["geo"]}
        print(f"[{fy}] actualCostRows={len(ac_rows)} monthlyTabs={len(sheets)}")

    geographies = sorted({v["geo"] for v in customer_projects.values()} | {"US","CANADA","CARIBBEAN","INDIA"})
    seed = {
        "geographies": geographies,
        "clients": list(customer_projects.values()),
        "employees": list(employees.values()),
        "ctcRecords": ctc_records,
        "fxRates": fx,
        "years": years,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(seed, f, ensure_ascii=False, indent=1)
    print(f"employees={len(employees)} ctc={len(ctc_records)} clients={len(customer_projects)} years={list(years)}")
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
