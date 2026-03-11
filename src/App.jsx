import { useState, useCallback, useRef } from "react";
import * as XLSX from "https://cdn.sheetjs.com/xlsx-0.20.1/package/xlsx.mjs";

// ─── Palette & Design System ─────────────────────────────────────────────────
const T = {
  navy:   "#0B1F3A",
  blue:   "#1A4A8A",
  sky:    "#2176FF",
  teal:   "#00C2CB",
  white:  "#F5F7FA",
  card:   "#111E33",
  border: "#1E3356",
  muted:  "#6B88B0",
  red:    "#FF4757",
  orange: "#FF8C42",
  yellow: "#FFD166",
  green:  "#06D6A0",
  grey:   "#8899AA",
};

const STATUS_CONFIG = {
  "🔴 CRITICAL": { color: T.red,    bg: "#2a0a0a", label: "CRITICAL" },
  "🟠 URGENT":   { color: T.orange, bg: "#2a1400", label: "URGENT"   },
  "🟡 REORDER":  { color: T.yellow, bg: "#2a2000", label: "REORDER"  },
  "🟢 HEALTHY":  { color: T.green,  bg: "#002a1a", label: "HEALTHY"  },
  "⚫ EXCESS":   { color: T.grey,   bg: "#1a1a1a", label: "EXCESS"   },
};

// ─── Calculation Engine ───────────────────────────────────────────────────────
function calcMonthlyDemand(salesHistory, sku) {
  const rows = salesHistory.filter(r => String(r.SKU || r["SKU Code"] || "").trim() === sku);
  if (!rows.length) return 0;
  const vals = rows.map(r => parseFloat(r["Units Sold"] || r.UnitsSold || 0)).filter(v => !isNaN(v));
  if (!vals.length) return 0;
  // Weighted moving average: most recent gets highest weight
  const n = vals.length;
  let weightedSum = 0, weightSum = 0;
  vals.forEach((v, i) => { const w = i + 1; weightedSum += v * w; weightSum += w; });
  return weightSum ? weightedSum / weightSum : 0;
}

function calcLeadTime(poHistory, sku) {
  const rows = poHistory.filter(r => String(r.SKU || r["SKU Code"] || "").trim() === sku);
  const lts = rows.map(r => {
    const created  = r["PO Created Date"]   || r.POCreatedDate;
    const received = r["PO Received Date"]  || r.POReceivedDate;
    if (!created || !received) return null;
    const d1 = new Date(created), d2 = new Date(received);
    const diff = (d2 - d1) / (1000 * 60 * 60 * 24);
    return isNaN(diff) || diff <= 0 ? null : diff;
  }).filter(v => v !== null);
  if (!lts.length) return 45; // default 45 days
  return lts.reduce((a, b) => a + b, 0) / lts.length;
}

function calcStatus(monthsOfStock) {
  if (monthsOfStock < 1)   return "🔴 CRITICAL";
  if (monthsOfStock < 1.5) return "🟠 URGENT";
  if (monthsOfStock < 2)   return "🟡 REORDER";
  if (monthsOfStock <= 4)  return "🟢 HEALTHY";
  return "⚫ EXCESS";
}

function runCalculations(skuMaster, inventory, salesHistory, poHistory) {
  return skuMaster.map(sku => {
    const skuCode    = String(sku["SKU Code"] || sku.SKU || "").trim();
    const inv        = inventory.find(i => String(i["SKU Code"] || i.SKU || "").trim() === skuCode);
    const currentStock   = parseFloat(inv?.["Current Stock"] || inv?.CurrentStock || 0);
    const unitCost       = parseFloat(sku["Unit Cost ($)"] || sku["Unit Cost"] || sku.UnitCost || 0);
    const tariffPct      = parseFloat(String(sku["Current Tariff %"] || sku.TariffPct || "0").replace("%","")) / 100;
    const forecastDemand = calcMonthlyDemand(salesHistory, skuCode);
    const leadTimeDays   = calcLeadTime(poHistory, skuCode);
    const leadTimeMonths = leadTimeDays / 30;
    const safetyStock    = leadTimeMonths > 1 ? 1.0 : 0.5;
    const reorderPoint   = Math.round(forecastDemand * (leadTimeMonths + safetyStock));
    const monthsOfStock  = forecastDemand > 0 ? currentStock / forecastDemand : 0;
    const tariffCost     = forecastDemand * unitCost * tariffPct;
    const status         = calcStatus(monthsOfStock);
    return {
      sku: skuCode,
      description:    sku.Description || "",
      supplier:       sku["Supplier Name"] || sku.Supplier || "",
      country:        sku["Supplier Country"] || sku.Country || "",
      currentStock,
      unitCost,
      tariffPct,
      forecastDemand: Math.round(forecastDemand * 10) / 10,
      leadTimeMonths: Math.round(leadTimeMonths * 10) / 10,
      safetyStock,
      reorderPoint,
      monthsOfStock:  Math.round(monthsOfStock * 10) / 10,
      tariffCost:     Math.round(tariffCost),
      status,
    };
  });
}

// ─── Excel Export ─────────────────────────────────────────────────────────────
function exportToExcel(skuMaster, inventory, salesHistory, poHistory, results) {
  const wb = XLSX.utils.book_new();

  const addSheet = (name, data) => {
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, name);
  };

  addSheet("1-SKU Master",       skuMaster);
  addSheet("2-Current Inventory", inventory);
  addSheet("3-Sales History",    salesHistory);
  addSheet("4-PO History",       poHistory);

  const calcData = results.map(r => ({
    "SKU":                    r.sku,
    "Description":            r.description,
    "Supplier":               r.supplier,
    "Country":                r.country,
    "Current Stock":          r.currentStock,
    "Unit Cost ($)":          r.unitCost,
    "Tariff %":               (r.tariffPct * 100).toFixed(1) + "%",
    "Forecast Next Month":    r.forecastDemand,
    "Lead Time (months)":     r.leadTimeMonths,
    "Safety Stock (months)":  r.safetyStock,
    "Reorder Point (units)":  r.reorderPoint,
    "Months of Stock":        r.monthsOfStock,
    "Tariff Cost/Month ($)":  r.tariffCost,
    "STATUS":                 r.status,
    "Action Required":        r.status === "🔴 CRITICAL" ? "ORDER IMMEDIATELY — STOCKOUT IMMINENT"
                            : r.status === "🟠 URGENT"   ? "Place order within this week"
                            : r.status === "🟡 REORDER"  ? "Schedule reorder this month"
                            : r.status === "🟢 HEALTHY"  ? "Monitor — no action needed"
                            : "Review purchasing — excess cash tied up",
  }));
  addSheet("5-Calculations", calcData);

  const criticalCount = results.filter(r => r.status === "🔴 CRITICAL").length;
  const urgentCount   = results.filter(r => r.status === "🟠 URGENT").length;
  const healthyCount  = results.filter(r => r.status === "🟢 HEALTHY").length;
  const excessCount   = results.filter(r => r.status === "⚫ EXCESS").length;
  const totalTariff   = results.reduce((s, r) => s + r.tariffCost, 0);
  const excessCash    = results.filter(r => r.status === "⚫ EXCESS")
                               .reduce((s, r) => s + r.currentStock * r.unitCost, 0);

  const dashData = [
    { "METRIC": "CRITICAL SKUs (< 1 month)",        "VALUE": criticalCount,                  "NOTE": "Order immediately" },
    { "METRIC": "URGENT SKUs (1–1.5 months)",        "VALUE": urgentCount,                    "NOTE": "Order this week" },
    { "METRIC": "HEALTHY SKUs (2–4 months)",         "VALUE": healthyCount,                   "NOTE": "Monitor" },
    { "METRIC": "EXCESS SKUs (> 4 months)",          "VALUE": excessCount,                    "NOTE": "Review purchasing" },
    { "METRIC": "Total Tariff Cost This Month ($)",  "VALUE": "$" + totalTariff.toLocaleString(), "NOTE": "" },
    { "METRIC": "Cash in Excess Stock ($)",          "VALUE": "$" + Math.round(excessCash).toLocaleString(), "NOTE": "Free this up" },
    { "METRIC": "Tariff Cost if Rates Double ($)",   "VALUE": "$" + (totalTariff * 2).toLocaleString(), "NOTE": "Scenario" },
    {},
    ...calcData,
  ];
  addSheet("6-Dashboard", dashData);

  XLSX.writeFile(wb, "TariffSafe_Report.xlsx");
}

// ─── CSV/Excel Parser ─────────────────────────────────────────────────────────
async function parseFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb   = XLSX.read(data, { type: "array" });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        resolve(XLSX.utils.sheet_to_json(ws, { defval: "" }));
      } catch { reject(new Error("Could not parse file")); }
    };
    reader.onerror = () => reject(new Error("File read error"));
    reader.readAsArrayBuffer(file);
  });
}

// ─── Sample Data ──────────────────────────────────────────────────────────────
const SAMPLE = {
  skuMaster: [
    { "SKU Code":"SKU001","Description":"Industrial Valve A","Supplier Name":"Supplier Alpha","Supplier Country":"China",  "HTS Code":"8481.80","Current Tariff %":"25%","Unit Cost ($)":45,  "Unit of Measure":"PCS","Min Order Qty":50  },
    { "SKU Code":"SKU002","Description":"Bearing Kit B",     "Supplier Name":"Supplier Beta", "Supplier Country":"Mexico", "HTS Code":"8482.10","Current Tariff %":"0%", "Unit Cost ($)":12.5,"Unit of Measure":"PCS","Min Order Qty":100 },
    { "SKU Code":"SKU003","Description":"Steel Plate C",     "Supplier Name":"Supplier Gamma","Supplier Country":"USA",    "HTS Code":"7208.51","Current Tariff %":"0%", "Unit Cost ($)":88,  "Unit of Measure":"KG", "Min Order Qty":500 },
    { "SKU Code":"SKU004","Description":"Pump Assembly D",   "Supplier Name":"Supplier Delta","Supplier Country":"Vietnam","HTS Code":"8413.81","Current Tariff %":"10%","Unit Cost ($)":210, "Unit of Measure":"PCS","Min Order Qty":20  },
    { "SKU Code":"SKU005","Description":"Gasket Set E",      "Supplier Name":"Supplier Alpha","Supplier Country":"China",  "HTS Code":"8484.10","Current Tariff %":"25%","Unit Cost ($)":8.75,"Unit of Measure":"SET","Min Order Qty":200 },
  ],
  inventory: [
    { "SKU Code":"SKU001","Current Stock":1200,"Last Count Date":"Jan-2025","Warehouse":"Warehouse A" },
    { "SKU Code":"SKU002","Current Stock":340, "Last Count Date":"Jan-2025","Warehouse":"Warehouse A" },
    { "SKU Code":"SKU003","Current Stock":5500,"Last Count Date":"Jan-2025","Warehouse":"Warehouse B" },
    { "SKU Code":"SKU004","Current Stock":28,  "Last Count Date":"Jan-2025","Warehouse":"Warehouse A" },
    { "SKU Code":"SKU005","Current Stock":890, "Last Count Date":"Jan-2025","Warehouse":"Warehouse B" },
  ],
  salesHistory: [
    ...["SKU001","SKU002","SKU003","SKU004","SKU005"].flatMap((sku, si) =>
      ["Aug-2024","Sep-2024","Oct-2024","Nov-2024","Dec-2024","Jan-2025"].map((month, mi) => ({
        "Month": month, "SKU Code": sku,
        "Units Sold": [320,340,360,410,490,420][mi] * [1,0.85,13,0.07,2.1][si] | 0,
      }))
    ),
  ],
  poHistory: [
    { "PO Number":"PO-1001","Supplier Name":"Supplier Alpha","SKU Code":"SKU001","PO Created Date":"2024-08-03","PO Received Date":"2024-09-01","Units Ordered":500 },
    { "PO Number":"PO-1002","Supplier Name":"Supplier Alpha","SKU Code":"SKU001","PO Created Date":"2024-10-01","PO Received Date":"2024-11-05","Units Ordered":500 },
    { "PO Number":"PO-1003","Supplier Name":"Supplier Beta", "SKU Code":"SKU002","PO Created Date":"2024-09-15","PO Received Date":"2024-10-06","Units Ordered":200 },
    { "PO Number":"PO-1004","Supplier Name":"Supplier Gamma","SKU Code":"SKU003","PO Created Date":"2024-10-01","PO Received Date":"2024-10-10","Units Ordered":2000},
    { "PO Number":"PO-1005","Supplier Name":"Supplier Delta","SKU Code":"SKU004","PO Created Date":"2024-08-05","PO Received Date":"2024-09-20","Units Ordered":50  },
    { "PO Number":"PO-1006","Supplier Name":"Supplier Alpha","SKU Code":"SKU005","PO Created Date":"2024-09-10","PO Received Date":"2024-10-12","Units Ordered":300 },
  ],
};

// ─── UI Components ────────────────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@600;700;800&family=Inter:wght@300;400;500&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: #07111f;
    color: ${T.white};
    font-family: 'Inter', sans-serif;
    font-size: 14px;
    line-height: 1.5;
    min-height: 100vh;
  }

  .app {
    max-width: 1280px;
    margin: 0 auto;
    padding: 0 24px 80px;
  }

  /* Header */
  .header {
    padding: 32px 0 24px;
    border-bottom: 1px solid ${T.border};
    margin-bottom: 32px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .logo {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .logo-icon {
    width: 42px; height: 42px;
    background: linear-gradient(135deg, ${T.sky}, ${T.teal});
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 20px;
  }
  .logo-text h1 {
    font-family: 'Syne', sans-serif;
    font-size: 22px; font-weight: 800;
    background: linear-gradient(90deg, ${T.white}, ${T.teal});
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    letter-spacing: -0.5px;
  }
  .logo-text p { font-size: 12px; color: ${T.muted}; margin-top: 1px; }

  /* Steps nav */
  .steps-nav {
    display: flex;
    gap: 4px;
    background: ${T.card};
    border: 1px solid ${T.border};
    border-radius: 12px;
    padding: 6px;
  }
  .step-btn {
    padding: 8px 16px;
    border-radius: 8px;
    border: none;
    background: transparent;
    color: ${T.muted};
    font-family: 'Inter', sans-serif;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
    display: flex; align-items: center; gap: 6px;
  }
  .step-btn:hover { color: ${T.white}; background: ${T.border}; }
  .step-btn.active {
    background: linear-gradient(135deg, ${T.sky}, ${T.blue});
    color: white;
  }
  .step-btn .step-num {
    width: 20px; height: 20px;
    border-radius: 50%;
    background: rgba(255,255,255,0.2);
    display: flex; align-items: center; justify-content: center;
    font-size: 11px; font-weight: 700;
  }
  .step-btn.done .step-num { background: ${T.green}; }

  /* Section */
  .section-title {
    font-family: 'Syne', sans-serif;
    font-size: 20px; font-weight: 700;
    margin-bottom: 6px;
    color: ${T.white};
  }
  .section-sub { color: ${T.muted}; font-size: 13px; margin-bottom: 24px; }

  /* Upload Card */
  .upload-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 16px;
    margin-bottom: 32px;
  }
  .upload-card {
    background: ${T.card};
    border: 1px dashed ${T.border};
    border-radius: 16px;
    padding: 24px;
    cursor: pointer;
    transition: all 0.25s;
    position: relative;
    overflow: hidden;
  }
  .upload-card::before {
    content: '';
    position: absolute; inset: 0;
    background: linear-gradient(135deg, ${T.sky}10, transparent);
    opacity: 0;
    transition: opacity 0.25s;
  }
  .upload-card:hover { border-color: ${T.sky}80; transform: translateY(-2px); }
  .upload-card:hover::before { opacity: 1; }
  .upload-card.loaded { border-color: ${T.green}; border-style: solid; }
  .upload-card.loaded::before { background: linear-gradient(135deg, ${T.green}10, transparent); opacity: 1; }
  .upload-card input { display: none; }
  .upload-icon {
    font-size: 28px; margin-bottom: 12px;
    display: flex; align-items: center; gap: 8px;
  }
  .upload-card h3 {
    font-family: 'Syne', sans-serif;
    font-size: 15px; font-weight: 700; margin-bottom: 4px;
  }
  .upload-card p { font-size: 12px; color: ${T.muted}; margin-bottom: 12px; }
  .upload-status {
    font-family: 'DM Mono', monospace;
    font-size: 11px; padding: 4px 10px;
    border-radius: 6px;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .upload-status.empty { background: ${T.border}; color: ${T.muted}; }
  .upload-status.loaded { background: ${T.green}20; color: ${T.green}; }
  .required-badge {
    position: absolute; top: 12px; right: 12px;
    font-size: 10px; padding: 2px 8px;
    border-radius: 4px; font-weight: 600;
    background: ${T.sky}20; color: ${T.sky};
    font-family: 'DM Mono', monospace;
  }

  /* Sample data btn */
  .sample-btn {
    padding: 10px 20px;
    border: 1px solid ${T.border};
    border-radius: 8px;
    background: transparent;
    color: ${T.muted};
    font-family: 'Inter', sans-serif;
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s;
    display: inline-flex; align-items: center; gap: 8px;
  }
  .sample-btn:hover { color: ${T.white}; border-color: ${T.sky}; }

  /* Table */
  .table-wrap {
    background: ${T.card};
    border: 1px solid ${T.border};
    border-radius: 16px;
    overflow: hidden;
    margin-bottom: 24px;
  }
  .table-header {
    padding: 16px 20px;
    border-bottom: 1px solid ${T.border};
    display: flex; align-items: center; justify-content: space-between;
    flex-wrap: wrap; gap: 8px;
  }
  .table-header h3 {
    font-family: 'Syne', sans-serif;
    font-size: 15px; font-weight: 700;
  }
  .row-count {
    font-family: 'DM Mono', monospace;
    font-size: 11px; color: ${T.muted};
    background: ${T.border}; padding: 3px 10px; border-radius: 6px;
  }
  .table-scroll { overflow-x: auto; }
  table {
    width: 100%; border-collapse: collapse;
    font-size: 13px;
  }
  thead th {
    background: #0d1929;
    padding: 10px 14px;
    text-align: left;
    font-family: 'DM Mono', monospace;
    font-size: 11px; font-weight: 500;
    color: ${T.muted};
    border-bottom: 1px solid ${T.border};
    white-space: nowrap;
  }
  tbody tr { border-bottom: 1px solid ${T.border}20; transition: background 0.15s; }
  tbody tr:hover { background: ${T.border}30; }
  tbody td {
    padding: 9px 14px;
    vertical-align: middle;
    white-space: nowrap;
  }
  td input, td select {
    background: transparent;
    border: 1px solid transparent;
    color: ${T.white};
    font-family: 'Inter', sans-serif;
    font-size: 13px;
    padding: 4px 6px;
    border-radius: 6px;
    width: 100%;
    min-width: 80px;
    transition: border-color 0.15s;
  }
  td input:focus, td select:focus {
    outline: none;
    border-color: ${T.sky};
    background: ${T.sky}10;
  }
  td select option { background: ${T.card}; }

  /* Add row btn */
  .add-row-btn {
    display: flex; align-items: center; gap: 6px;
    padding: 8px 16px;
    background: transparent;
    border: 1px dashed ${T.border};
    border-radius: 8px;
    color: ${T.muted};
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s;
    margin: 12px 16px;
  }
  .add-row-btn:hover { border-color: ${T.sky}; color: ${T.sky}; }

  /* Delete row btn */
  .del-btn {
    background: none; border: none; cursor: pointer;
    color: ${T.muted}; font-size: 16px; padding: 2px 6px;
    border-radius: 4px; transition: all 0.15s;
  }
  .del-btn:hover { color: ${T.red}; background: ${T.red}20; }

  /* Dashboard KPIs */
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px;
    margin-bottom: 28px;
  }
  .kpi-card {
    background: ${T.card};
    border: 1px solid ${T.border};
    border-radius: 14px;
    padding: 18px;
    position: relative;
    overflow: hidden;
  }
  .kpi-card::after {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 3px;
    border-radius: 14px 14px 0 0;
  }
  .kpi-card.critical::after { background: ${T.red}; }
  .kpi-card.urgent::after   { background: ${T.orange}; }
  .kpi-card.healthy::after  { background: ${T.green}; }
  .kpi-card.excess::after   { background: ${T.grey}; }
  .kpi-card.tariff::after   { background: ${T.sky}; }
  .kpi-card.cash::after     { background: ${T.teal}; }
  .kpi-label {
    font-size: 11px; color: ${T.muted};
    font-family: 'DM Mono', monospace;
    text-transform: uppercase; letter-spacing: 0.5px;
    margin-bottom: 8px;
  }
  .kpi-value {
    font-family: 'Syne', sans-serif;
    font-size: 32px; font-weight: 800;
    line-height: 1;
  }
  .kpi-sub { font-size: 11px; color: ${T.muted}; margin-top: 4px; }

  /* Status badge */
  .status-badge {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 3px 10px; border-radius: 6px;
    font-size: 12px; font-weight: 600;
    font-family: 'DM Mono', monospace;
    white-space: nowrap;
  }

  /* Cash summary */
  .cash-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 12px;
    margin-bottom: 28px;
  }
  .cash-card {
    background: ${T.card};
    border: 1px solid ${T.border};
    border-radius: 14px;
    padding: 20px;
    display: flex; align-items: center; gap: 14px;
  }
  .cash-icon { font-size: 28px; }
  .cash-label { font-size: 12px; color: ${T.muted}; margin-bottom: 4px; }
  .cash-value {
    font-family: 'Syne', sans-serif;
    font-size: 22px; font-weight: 700;
  }

  /* Buttons */
  .btn-primary {
    padding: 12px 28px;
    background: linear-gradient(135deg, ${T.sky}, ${T.blue});
    color: white; border: none; border-radius: 10px;
    font-family: 'Syne', sans-serif;
    font-size: 14px; font-weight: 700;
    cursor: pointer; transition: all 0.2s;
    display: inline-flex; align-items: center; gap: 8px;
    box-shadow: 0 4px 20px ${T.sky}30;
  }
  .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 6px 28px ${T.sky}50; }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }

  .btn-export {
    padding: 12px 28px;
    background: linear-gradient(135deg, ${T.teal}, ${T.green});
    color: #07111f; border: none; border-radius: 10px;
    font-family: 'Syne', sans-serif;
    font-size: 14px; font-weight: 700;
    cursor: pointer; transition: all 0.2s;
    display: inline-flex; align-items: center; gap: 8px;
    box-shadow: 0 4px 20px ${T.teal}30;
  }
  .btn-export:hover { transform: translateY(-1px); box-shadow: 0 6px 28px ${T.teal}50; }

  .btn-ghost {
    padding: 10px 20px;
    background: transparent;
    border: 1px solid ${T.border};
    color: ${T.muted}; border-radius: 10px;
    font-family: 'Inter', sans-serif;
    font-size: 13px; font-weight: 500;
    cursor: pointer; transition: all 0.2s;
    display: inline-flex; align-items: center; gap: 8px;
  }
  .btn-ghost:hover { border-color: ${T.sky}; color: ${T.white}; }

  .action-bar {
    display: flex; align-items: center; gap: 12px;
    flex-wrap: wrap;
    padding: 20px 0;
    border-top: 1px solid ${T.border};
    margin-top: 20px;
  }

  .notice {
    background: ${T.sky}10;
    border: 1px solid ${T.sky}30;
    border-radius: 10px;
    padding: 12px 16px;
    font-size: 13px; color: ${T.sky};
    margin-bottom: 20px;
    display: flex; align-items: center; gap: 8px;
  }

  .months-bar {
    display: flex; align-items: center; gap: 8px;
  }
  .months-bar-track {
    width: 80px; height: 6px;
    background: ${T.border};
    border-radius: 3px; overflow: hidden;
  }
  .months-bar-fill {
    height: 100%; border-radius: 3px;
    transition: width 0.3s;
  }

  @keyframes fadeIn { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
  .fade-in { animation: fadeIn 0.3s ease forwards; }
`;

// ─── Editable Table ───────────────────────────────────────────────────────────
function EditableTable({ title, data, setData, columns }) {
  const updateCell = (rowIdx, key, val) => {
    setData(prev => prev.map((r, i) => i === rowIdx ? { ...r, [key]: val } : r));
  };
  const addRow = () => {
    const empty = {};
    columns.forEach(c => empty[c.key] = "");
    setData(prev => [...prev, empty]);
  };
  const delRow = idx => setData(prev => prev.filter((_, i) => i !== idx));

  return (
    <div className="table-wrap fade-in">
      <div className="table-header">
        <h3>{title}</h3>
        <span className="row-count">{data.length} rows</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {columns.map(c => <th key={c.key}>{c.label}</th>)}
              <th style={{width:40}}></th>
            </tr>
          </thead>
          <tbody>
            {data.map((row, ri) => (
              <tr key={ri}>
                {columns.map(c => (
                  <td key={c.key}>
                    {c.type === "select" ? (
                      <select value={row[c.key] || ""} onChange={e => updateCell(ri, c.key, e.target.value)}>
                        {c.options.map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input
                        type={c.type || "text"}
                        value={row[c.key] !== undefined ? row[c.key] : ""}
                        onChange={e => updateCell(ri, c.key, e.target.value)}
                        placeholder={c.placeholder || ""}
                      />
                    )}
                  </td>
                ))}
                <td><button className="del-btn" onClick={() => delRow(ri)}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="add-row-btn" onClick={addRow}>＋ Add row</button>
    </div>
  );
}

// ─── Upload Card ──────────────────────────────────────────────────────────────
function UploadCard({ icon, title, desc, loaded, rowCount, onFile, required }) {
  const ref = useRef();
  return (
    <div className={`upload-card ${loaded ? "loaded" : ""}`} onClick={() => ref.current.click()}>
      {required && <span className="required-badge">REQUIRED</span>}
      <div className="upload-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{desc}</p>
      <span className={`upload-status ${loaded ? "loaded" : "empty"}`}>
        {loaded ? `✓ ${rowCount} rows loaded` : "Click to upload CSV / XLSX"}
      </span>
      <input ref={ref} type="file" accept=".csv,.xlsx,.xls"
        onChange={async e => { if (e.target.files[0]) { const d = await parseFile(e.target.files[0]); onFile(d); }}} />
    </div>
  );
}

// ─── Dashboard View ───────────────────────────────────────────────────────────
function Dashboard({ results, onExport }) {
  const critical = results.filter(r => r.status === "🔴 CRITICAL").length;
  const urgent   = results.filter(r => r.status === "🟠 URGENT").length;
  const healthy  = results.filter(r => r.status === "🟢 HEALTHY").length;
  const excess   = results.filter(r => r.status === "⚫ EXCESS").length;
  const totalTariff = results.reduce((s, r) => s + r.tariffCost, 0);
  const excessCash  = results.filter(r => r.status === "⚫ EXCESS")
                             .reduce((s, r) => s + r.currentStock * r.unitCost, 0);
  const fmt = n => "$" + Math.round(n).toLocaleString();

  const getBarColor = st => {
    if (st === "🔴 CRITICAL") return T.red;
    if (st === "🟠 URGENT")   return T.orange;
    if (st === "🟡 REORDER")  return T.yellow;
    if (st === "🟢 HEALTHY")  return T.green;
    return T.grey;
  };

  const getAction = st => {
    if (st === "🔴 CRITICAL") return "ORDER IMMEDIATELY";
    if (st === "🟠 URGENT")   return "Order this week";
    if (st === "🟡 REORDER")  return "Schedule reorder";
    if (st === "🟢 HEALTHY")  return "Monitor";
    return "Review purchasing";
  };

  return (
    <div className="fade-in">
      <div className="kpi-grid">
        {[
          { label: "Critical SKUs", value: critical, sub: "< 1 month stock", cls: "critical", color: T.red },
          { label: "Urgent SKUs",   value: urgent,   sub: "1–1.5 months",    cls: "urgent",   color: T.orange },
          { label: "Healthy SKUs",  value: healthy,  sub: "2–4 months",      cls: "healthy",  color: T.green },
          { label: "Excess SKUs",   value: excess,   sub: "> 4 months",      cls: "excess",   color: T.grey },
          { label: "Tariff Cost/Mo",value: fmt(totalTariff), sub: "at current rates", cls: "tariff", color: T.sky },
          { label: "Cash in Excess",value: fmt(excessCash),  sub: "free this up",     cls: "cash",   color: T.teal },
        ].map(k => (
          <div key={k.label} className={`kpi-card ${k.cls}`}>
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value" style={{ color: k.color }}>{k.value}</div>
            <div className="kpi-sub">{k.sub}</div>
          </div>
        ))}
      </div>

      <div className="cash-grid">
        <div className="cash-card">
          <div className="cash-icon">⚠️</div>
          <div>
            <div className="cash-label">If tariff rates double</div>
            <div className="cash-value" style={{ color: T.orange }}>{fmt(totalTariff * 2)}/mo</div>
          </div>
        </div>
        <div className="cash-card">
          <div className="cash-icon">💡</div>
          <div>
            <div className="cash-label">Cash freed by fixing excess stock</div>
            <div className="cash-value" style={{ color: T.teal }}>{fmt(excessCash)}</div>
          </div>
        </div>
        <div className="cash-card">
          <div className="cash-icon">🚨</div>
          <div>
            <div className="cash-label">SKUs needing immediate action</div>
            <div className="cash-value" style={{ color: T.red }}>{critical + urgent} SKUs</div>
          </div>
        </div>
      </div>

      <div className="table-wrap fade-in">
        <div className="table-header">
          <h3>📊 Full Inventory Intelligence</h3>
          <span className="row-count">{results.length} SKUs</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {["SKU","Description","Supplier","Country","Stock","Forecast/Mo","Months Stock","Reorder Pt","Lead Time","Tariff/Mo","Status","Action"].map(h =>
                  <th key={h}>{h}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => {
                const sc = STATUS_CONFIG[r.status] || {};
                const barPct = Math.min(r.monthsOfStock / 4 * 100, 100);
                return (
                  <tr key={i}>
                    <td><span style={{ fontFamily:"'DM Mono',monospace", color: T.teal }}>{r.sku}</span></td>
                    <td>{r.description}</td>
                    <td style={{ color: T.muted }}>{r.supplier}</td>
                    <td style={{ color: T.muted }}>{r.country}</td>
                    <td style={{ fontFamily:"'DM Mono',monospace" }}>{r.currentStock.toLocaleString()}</td>
                    <td style={{ fontFamily:"'DM Mono',monospace" }}>{r.forecastDemand.toLocaleString()}</td>
                    <td>
                      <div className="months-bar">
                        <span style={{ fontFamily:"'DM Mono',monospace", minWidth:28 }}>{r.monthsOfStock}</span>
                        <div className="months-bar-track">
                          <div className="months-bar-fill" style={{ width: barPct+"%", background: getBarColor(r.status) }} />
                        </div>
                      </div>
                    </td>
                    <td style={{ fontFamily:"'DM Mono',monospace" }}>{r.reorderPoint.toLocaleString()}</td>
                    <td style={{ fontFamily:"'DM Mono',monospace" }}>{r.leadTimeMonths} mo</td>
                    <td style={{ fontFamily:"'DM Mono',monospace", color: r.tariffCost > 0 ? T.yellow : T.muted }}>
                      {r.tariffCost > 0 ? "$" + r.tariffCost.toLocaleString() : "—"}
                    </td>
                    <td>
                      <span className="status-badge" style={{ color: sc.color, background: sc.bg }}>
                        {r.status}
                      </span>
                    </td>
                    <td style={{ color: T.muted, fontSize: 12 }}>{getAction(r.status)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="action-bar">
        <button className="btn-export" onClick={onExport}>
          ⬇ Download TariffSafe Excel Report
        </button>
        <span style={{ color: T.muted, fontSize: 12 }}>
          Exports all 6 tabs: SKU Master, Inventory, Sales, POs, Calculations & Dashboard
        </span>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [step, setStep]   = useState(0);
  const [results, setResults] = useState([]);

  const [skuMaster,    setSkuMaster]    = useState([]);
  const [inventory,    setInventory]    = useState([]);
  const [salesHistory, setSalesHistory] = useState([]);
  const [poHistory,    setPoHistory]    = useState([]);

  const loadSample = () => {
    setSkuMaster(SAMPLE.skuMaster.map(r => ({...r})));
    setInventory(SAMPLE.inventory.map(r => ({...r})));
    setSalesHistory(SAMPLE.salesHistory.map(r => ({...r})));
    setPoHistory(SAMPLE.poHistory.map(r => ({...r})));
  };

  const canCalculate = skuMaster.length > 0 && inventory.length > 0 && salesHistory.length > 0;

  const calculate = () => {
    const r = runCalculations(skuMaster, inventory, salesHistory, poHistory);
    setResults(r);
    setStep(4);
  };

  const doExport = () => exportToExcel(skuMaster, inventory, salesHistory, poHistory, results);

  const SKU_COLS = [
    { key:"SKU Code",          label:"SKU Code",        placeholder:"SKU001" },
    { key:"Description",       label:"Description",     placeholder:"Product name" },
    { key:"Supplier Name",     label:"Supplier",        placeholder:"Supplier name" },
    { key:"Supplier Country",  label:"Country",         placeholder:"China" },
    { key:"HTS Code",          label:"HTS Code",        placeholder:"8481.80" },
    { key:"Current Tariff %",  label:"Tariff %",        placeholder:"25%" },
    { key:"Unit Cost ($)",     label:"Unit Cost ($)",   placeholder:"45.00", type:"number" },
    { key:"Unit of Measure",   label:"UoM",             placeholder:"PCS" },
    { key:"Min Order Qty",     label:"Min Order Qty",   placeholder:"50", type:"number" },
  ];
  const INV_COLS = [
    { key:"SKU Code",         label:"SKU Code",        placeholder:"SKU001" },
    { key:"Current Stock",    label:"Current Stock",   placeholder:"1000", type:"number" },
    { key:"Last Count Date",  label:"Count Date",      placeholder:"Jan-2025" },
    { key:"Warehouse",        label:"Warehouse",       placeholder:"Warehouse A" },
  ];
  const SALES_COLS = [
    { key:"Month",       label:"Month",       placeholder:"Jan-2025" },
    { key:"SKU Code",    label:"SKU Code",    placeholder:"SKU001" },
    { key:"Units Sold",  label:"Units Sold",  placeholder:"400", type:"number" },
    { key:"Notes",       label:"Notes",       placeholder:"" },
  ];
  const PO_COLS = [
    { key:"PO Number",          label:"PO #",            placeholder:"PO-1001" },
    { key:"Supplier Name",      label:"Supplier",        placeholder:"Supplier Alpha" },
    { key:"SKU Code",           label:"SKU Code",        placeholder:"SKU001" },
    { key:"PO Created Date",    label:"Created Date",    placeholder:"2025-01-01" },
    { key:"PO Received Date",   label:"Received Date",   placeholder:"2025-02-15" },
    { key:"Units Ordered",      label:"Units",           placeholder:"500", type:"number" },
  ];

  const steps = [
    { label:"Upload",   icon:"⬆" },
    { label:"SKUs",     icon:"📦" },
    { label:"Inventory",icon:"🏭" },
    { label:"History",  icon:"📈" },
    { label:"Results",  icon:"✨" },
  ];

  const doneSets = [
    skuMaster.length > 0 && inventory.length > 0,
    skuMaster.length > 0,
    inventory.length > 0,
    salesHistory.length > 0,
    results.length > 0,
  ];

  return (
    <>
      <style>{css}</style>
      <div className="app">

        {/* Header */}
        <div className="header">
          <div className="logo">
            <div className="logo-icon">🏭</div>
            <div className="logo-text">
              <h1>TariffSafe</h1>
              <p>Inventory & Tariff Intelligence for Mid-Market Manufacturers</p>
            </div>
          </div>
          <div className="steps-nav">
            {steps.map((s, i) => (
              <button key={i} className={`step-btn ${step===i?"active":""} ${doneSets[i]?"done":""}`}
                onClick={() => setStep(i)}>
                <span className="step-num">{doneSets[i] ? "✓" : i+1}</span>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Step 0 — Upload */}
        {step === 0 && (
          <div className="fade-in">
            <div className="section-title">Upload Your Data Files</div>
            <p className="section-sub">Upload CSV or Excel exports from your ERP. Or load sample data to explore the tool.</p>

            <div className="notice">
              💡 Don't have files ready? <button className="sample-btn" style={{marginLeft:8}} onClick={loadSample}>⚡ Load Sample Data</button>
              <span style={{marginLeft:8, color: T.muted}}>— instantly populate all 4 tabs with demo data</span>
            </div>

            <div className="upload-grid">
              <UploadCard icon="📦" title="SKU Master" required
                desc="Your product list: SKU codes, suppliers, countries, HTS codes, tariff %, unit costs."
                loaded={skuMaster.length>0} rowCount={skuMaster.length}
                onFile={setSkuMaster} />
              <UploadCard icon="🏭" title="Current Inventory" required
                desc="Latest stock count: SKU codes, current stock quantities, warehouse locations."
                loaded={inventory.length>0} rowCount={inventory.length}
                onFile={setInventory} />
              <UploadCard icon="📈" title="Sales History" required
                desc="Monthly sales: Month, SKU Code, Units Sold. Minimum 6 months for accurate forecasting."
                loaded={salesHistory.length>0} rowCount={salesHistory.length}
                onFile={setSalesHistory} />
              <UploadCard icon="📋" title="PO History" 
                desc="Purchase orders: PO dates, received dates, supplier, SKU. Used to auto-calculate lead times."
                loaded={poHistory.length>0} rowCount={poHistory.length}
                onFile={setPoHistory} />
            </div>

            <div className="action-bar">
              <button className="btn-primary" disabled={!canCalculate} onClick={() => setStep(1)}>
                Review & Edit Data →
              </button>
              {!canCalculate && <span style={{color:T.muted, fontSize:12}}>Upload SKU Master, Inventory & Sales History to continue</span>}
              {canCalculate && <span style={{color:T.green, fontSize:12}}>✓ Ready to proceed</span>}
            </div>
          </div>
        )}

        {/* Step 1 — SKUs */}
        {step === 1 && (
          <div className="fade-in">
            <div className="section-title">Review & Edit SKU Master</div>
            <p className="section-sub">Check your product data. Edit any cell directly. Add or remove rows as needed.</p>
            <EditableTable title="📦 SKU Master" data={skuMaster} setData={setSkuMaster} columns={SKU_COLS} />
            <div className="action-bar">
              <button className="btn-ghost" onClick={() => setStep(0)}>← Back</button>
              <button className="btn-primary" onClick={() => setStep(2)}>Next: Inventory →</button>
            </div>
          </div>
        )}

        {/* Step 2 — Inventory */}
        {step === 2 && (
          <div className="fade-in">
            <div className="section-title">Review & Edit Current Inventory</div>
            <p className="section-sub">Verify your current stock counts. These numbers drive the months-of-stock calculation.</p>
            <EditableTable title="🏭 Current Inventory" data={inventory} setData={setInventory} columns={INV_COLS} />
            <div className="action-bar">
              <button className="btn-ghost" onClick={() => setStep(1)}>← Back</button>
              <button className="btn-primary" onClick={() => setStep(3)}>Next: History →</button>
            </div>
          </div>
        )}

        {/* Step 3 — History */}
        {step === 3 && (
          <div className="fade-in">
            <div className="section-title">Review Sales & PO History</div>
            <p className="section-sub">Sales history drives demand forecasting. PO history auto-calculates your actual supplier lead times.</p>
            <EditableTable title="📈 Monthly Sales History" data={salesHistory} setData={setSalesHistory} columns={SALES_COLS} />
            <EditableTable title="📋 PO History (Lead Times)" data={poHistory} setData={setPoHistory} columns={PO_COLS} />
            <div className="action-bar">
              <button className="btn-ghost" onClick={() => setStep(2)}>← Back</button>
              <button className="btn-primary" disabled={!canCalculate} onClick={calculate}>
                ✨ Run TariffSafe Analysis →
              </button>
            </div>
          </div>
        )}

        {/* Step 4 — Results */}
        {step === 4 && results.length > 0 && (
          <div className="fade-in">
            <div className="section-title">TariffSafe Analysis Results</div>
            <p className="section-sub">Your complete inventory intelligence report. Download the Excel file to share with your team.</p>
            <Dashboard results={results} onExport={doExport} />
          </div>
        )}

      </div>
    </>
  );
}
