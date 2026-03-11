import { useState, useRef } from "react";
import * as XLSX from "xlsx";

// ─── Palette ──────────────────────────────────────────────────────────────────
const T = {
  navy:"#0B1F3A", blue:"#1A4A8A", sky:"#2176FF", teal:"#00C2CB",
  white:"#F5F7FA", card:"#111E33", border:"#1E3356", muted:"#6B88B0",
  red:"#FF4757", orange:"#FF8C42", yellow:"#FFD166", green:"#06D6A0",
  grey:"#8899AA", purple:"#9B59B6",
};

const STATUS_CONFIG = {
  "🔴 CRITICAL":{ color:T.red,    bg:"#2a0a0a" },
  "🟠 URGENT":  { color:T.orange, bg:"#2a1400" },
  "🟡 REORDER": { color:T.yellow, bg:"#2a2000" },
  "🟢 HEALTHY": { color:T.green,  bg:"#002a1a" },
  "⚫ EXCESS":  { color:T.grey,   bg:"#1a1a1a" },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ██████████████  TARIFF ENGINE  ██████████████████████████████████████████████
// ═══════════════════════════════════════════════════════════════════════════════
//
// Layer 1 — MFN General Duty        : base rate from HTS schedule
// Layer 2 — Section 301 (China only): +7.5% to +100% on Chinese imports
// Layer 3 — Section 232             : +25% steel / +10% aluminum globally
//                                     (exempt: USMCA Canada & Mexico, Australia)
// Layer 4 — Section 201             : safeguard tariffs (solar, washers, etc.)
// Layer 5 — Section 122             : *** NEW *** flat 15% surcharge, ALL countries
//                                     Active: Feb 24, 2026 – Jul 24, 2026
//                                     HTS 9903.03.01
//                                     Exempt: USMCA goods, Sec232-covered goods,
//                                     Annex I/II products (steel/alum/aircraft/
//                                     semiconductors/copper/wood/energy/pharma)
// FTA      — deducts MFN if 0% FTA rate applies
//
// TOTAL = MFN + S301 + S232 + S201 + S122
//
// DATA SOURCES (free, no cost):
//   1. ustariffrates.com API — 100 calls/month free, no credit card
//      Returns: MFN + S301 + S232 + FTA in one call
//   2. USTR Section 301 tool — ustr.gov/issue-areas/enforcement/section-301-investigations/search
//   3. Built-in offline HTS database — 60+ manufacturing codes, instant fallback
// ═══════════════════════════════════════════════════════════════════════════════

// Runtime API key (set by user in UI)
let _apiKey = "";
// Cache: avoid re-calling API for same HTS+country pair
const _cache = {};

// ── Section 122 constants (as of March 11, 2026) ─────────────────────────────
const S122_RATE       = 15;    // % — raised to 15% by Trump Truth Social post Feb 22 2026
const S122_ACTIVE     = true;  // Set false after Jul 24, 2026
const S122_EXPIRES    = "July 24, 2026";
const S122_HTS        = "9903.03.01";
// Exempt countries (USMCA preferential)
const S122_USMCA_EXEMPT = ["Canada","Mexico"];
// Exempt HTS chapters (Annex I/II: energy, pharma, aircraft, semiconductors, copper, wood, steel/alum)
const S122_EXEMPT_CHAPTERS = [
  25,26,27,       // minerals, energy, fuels
  28,29,30,       // chemicals, pharma
  47,44,          // wood, pulp
  72,73,76,       // steel, steel articles, aluminium ← these are Sec232 so also exempt via that route
  85,             // electronics/semiconductors (partial)
  88,             // aircraft & parts
];
// Sec232 stacking: if Sec232 applies, Sec122 does NOT stack (mutually exclusive per proclamation)
// USMCA = exempt from Sec122

function calcSec122(htsCode, country, sec232Rate) {
  if (!S122_ACTIVE) return 0;
  if (S122_USMCA_EXEMPT.includes(country)) return 0;           // USMCA exempt
  if (sec232Rate > 0) return 0;                                 // Sec232 goods exempt
  const ch = parseInt(String(htsCode).replace(/\D/g,"").substring(0,2), 10);
  if (S122_EXEMPT_CHAPTERS.includes(ch)) return 0;             // Annex I/II exempt
  return S122_RATE;
}

// ── FTA map ───────────────────────────────────────────────────────────────────
const FTA_MAP = {
  "Canada":"USMCA","Mexico":"USMCA",
  "Australia":"AUSFTA","Chile":"US-Chile FTA",
  "Colombia":"US-Colombia TPA","Israel":"US-Israel FTA",
  "Jordan":"US-Jordan FTA","South Korea":"KORUS",
  "Singapore":"US-Singapore FTA","Peru":"US-Peru TPA",
  "Panama":"US-Panama TPA","Bahrain":"US-Bahrain FTA",
  "Morocco":"US-Morocco FTA","Oman":"US-Oman FTA",
  "Japan":"US-Japan Agreement",
  "Costa Rica":"CAFTA-DR","El Salvador":"CAFTA-DR",
  "Guatemala":"CAFTA-DR","Honduras":"CAFTA-DR",
  "Nicaragua":"CAFTA-DR","Dominican Republic":"CAFTA-DR",
};
const CHINA_IDS = ["china","prc","china (prc)","mainland china","cn"];
function isChina(c) { return CHINA_IDS.includes(String(c||"").toLowerCase().trim()); }

// ── Offline HTS database ──────────────────────────────────────────────────────
// Key: 6-digit HTS string
// Value: { mfn, s301china, s232, s201, desc }
const HTS_DB = {
  // ── Plastics ch39
  "390110":{ mfn:6.5,  s301china:25,  s232:0,  s201:0, desc:"Polyethylene primary forms" },
  "390120":{ mfn:6.5,  s301china:25,  s232:0,  s201:0, desc:"Polyethylene primary forms" },
  "392690":{ mfn:5.3,  s301china:25,  s232:0,  s201:0, desc:"Plastic articles NES" },
  // ── Rubber ch40
  "400911":{ mfn:2.5,  s301china:25,  s232:0,  s201:0, desc:"Rubber hoses" },
  "401693":{ mfn:2.5,  s301china:7.5, s232:0,  s201:0, desc:"Rubber gaskets & seals" },
  "401699":{ mfn:2.5,  s301china:7.5, s232:0,  s201:0, desc:"Rubber articles NES" },
  // ── Wood ch44
  "440710":{ mfn:0,    s301china:25,  s232:0,  s201:0, desc:"Sawn softwood lumber" },
  "441820":{ mfn:3.2,  s301china:25,  s232:0,  s201:0, desc:"Wood doors & frames" },
  // ── Textiles ch59
  "591000":{ mfn:5.8,  s301china:25,  s232:0,  s201:0, desc:"Conveyor belting fabric" },
  // ── Stone/ceramic ch68
  "681310":{ mfn:0,    s301china:0,   s232:0,  s201:0, desc:"Brake pads (non-asbestos)" },
  // ── Steel ch72
  "720851":{ mfn:0,    s301china:0,   s232:25, s201:0, desc:"Steel flat-rolled >600mm" },
  "720852":{ mfn:0,    s301china:0,   s232:25, s201:0, desc:"Steel flat-rolled >600mm" },
  "720855":{ mfn:0,    s301china:0,   s232:25, s201:0, desc:"Steel flat-rolled coiled" },
  "720916":{ mfn:0,    s301china:0,   s232:25, s201:0, desc:"Steel coils cold-rolled" },
  "721049":{ mfn:1.5,  s301china:0,   s232:25, s201:0, desc:"Galvanized steel sheet" },
  "722830":{ mfn:0,    s301china:25,  s232:25, s201:0, desc:"Steel bars & rods NES" },
  // ── Steel articles ch73
  "730790":{ mfn:4.3,  s301china:25,  s232:0,  s201:0, desc:"Tube/pipe fittings" },
  "730799":{ mfn:4.3,  s301china:25,  s232:0,  s201:0, desc:"Steel fittings NES" },
  "732690":{ mfn:2.9,  s301china:25,  s232:0,  s201:0, desc:"Steel articles NES" },
  // ── Copper ch74
  "740311":{ mfn:1.0,  s301china:25,  s232:0,  s201:0, desc:"Refined copper cathodes" },
  "741220":{ mfn:3.0,  s301china:25,  s232:0,  s201:0, desc:"Copper pipe fittings" },
  // ── Aluminium ch76
  "760110":{ mfn:2.6,  s301china:0,   s232:10, s201:0, desc:"Unwrought aluminium" },
  "760612":{ mfn:3.0,  s301china:25,  s232:10, s201:0, desc:"Aluminium plates & sheet" },
  "761090":{ mfn:5.7,  s301china:25,  s232:10, s201:0, desc:"Aluminium structures" },
  // ── Tools ch82
  "820730":{ mfn:5.0,  s301china:25,  s232:0,  s201:0, desc:"Interchangeable tools" },
  "820760":{ mfn:4.3,  s301china:25,  s232:0,  s201:0, desc:"Borers & milling tools" },
  // ── Misc metal ch83
  "830710":{ mfn:3.8,  s301china:7.5, s232:0,  s201:0, desc:"Flexible metal tubing" },
  // ── Machinery ch84
  "840310":{ mfn:0,    s301china:25,  s232:0,  s201:0, desc:"Central heating boilers" },
  "841381":{ mfn:0,    s301china:25,  s232:0,  s201:0, desc:"Pumps NES" },
  "841391":{ mfn:0,    s301china:25,  s232:0,  s201:0, desc:"Pump parts" },
  "841950":{ mfn:0,    s301china:25,  s232:0,  s201:0, desc:"Heat exchangers" },
  "841989":{ mfn:0,    s301china:25,  s232:0,  s201:0, desc:"Industrial plant NES" },
  "842121":{ mfn:0,    s301china:25,  s232:0,  s201:0, desc:"Water filtration equip" },
  "842129":{ mfn:0,    s301china:25,  s232:0,  s201:0, desc:"Filter/purifying machines" },
  "842139":{ mfn:0,    s301china:25,  s232:0,  s201:0, desc:"Filter machines NES" },
  "847420":{ mfn:0,    s301china:25,  s232:0,  s201:0, desc:"Crushing machinery" },
  "848110":{ mfn:2.0,  s301china:25,  s232:0,  s201:0, desc:"Pressure-reducing valves" },
  "848140":{ mfn:2.0,  s301china:25,  s232:0,  s201:0, desc:"Safety/relief valves" },
  "848180":{ mfn:2.0,  s301china:25,  s232:0,  s201:0, desc:"Industrial valves NES" },
  "848190":{ mfn:2.0,  s301china:25,  s232:0,  s201:0, desc:"Valve parts" },
  "848210":{ mfn:2.8,  s301china:25,  s232:0,  s201:0, desc:"Ball bearings" },
  "848220":{ mfn:5.8,  s301china:25,  s232:0,  s201:0, desc:"Tapered roller bearings" },
  "848299":{ mfn:3.0,  s301china:25,  s232:0,  s201:0, desc:"Bearing parts" },
  "848340":{ mfn:2.5,  s301china:25,  s232:0,  s201:0, desc:"Gears & gearing" },
  "848360":{ mfn:3.5,  s301china:25,  s232:0,  s201:0, desc:"Clutches & couplings" },
  "848410":{ mfn:0,    s301china:25,  s232:0,  s201:0, desc:"Metallic gaskets" },
  // ── Electrical ch85
  "850152":{ mfn:2.8,  s301china:25,  s232:0,  s201:0, desc:"AC motors >750W" },
  "851090":{ mfn:1.5,  s301china:25,  s232:0,  s201:0, desc:"Electromechanical tools" },
  "853710":{ mfn:0,    s301china:25,  s232:0,  s201:0, desc:"Control panels <1000V" },
  "854442":{ mfn:2.6,  s301china:25,  s232:0,  s201:0, desc:"Electric conductors" },
  // ── Instruments ch90
  "902620":{ mfn:1.7,  s301china:25,  s232:0,  s201:0, desc:"Pressure gauges" },
  "902680":{ mfn:1.7,  s301china:25,  s232:0,  s201:0, desc:"Flow/pressure instruments" },
  "902750":{ mfn:0,    s301china:25,  s232:0,  s201:0, desc:"Instruments NES" },
};

// ── Parse "25%" → 25 ──────────────────────────────────────────────────────────
const pct = v => { const n = parseFloat(String(v||"").replace(/[^0-9.]/g,"")); return isNaN(n)?0:n; };

// ── Live API lookup (ustariffrates.com — 100 calls/month FREE) ─────────────────
async function fetchLiveRates(hts6, country) {
  if (!_apiKey) return null;
  const key = `${hts6}__${country}`;
  if (_cache[key]) return _cache[key];
  try {
    const r = await fetch(`https://ustariffrates.com/api/hts/${hts6}?country=${encodeURIComponent(country)}`, {
      headers: { "X-API-Key": _apiKey },
    });
    if (!r.ok) return null;
    const d = await _cache[key] = await r.json();
    return d;
  } catch { return null; }
}

// ── Master tariff lookup ──────────────────────────────────────────────────────
async function lookupTariff(rawHts, country) {
  const hts6    = String(rawHts||"").replace(/[.\s-]/g,"").substring(0,6);
  const china   = isChina(country);
  const ftaName = FTA_MAP[country] || null;

  let mfn=0, s301=0, s232=0, s201=0, desc="", src="offline";

  // ── 1. Try live API ──────────────────────────────────────────────────────
  if (_apiKey) {
    const d = await fetchLiveRates(hts6, country);
    if (d) {
      src  = "api";
      desc = d.description || "";
      mfn  = ftaName ? 0 : pct(d.mfn_rate);
      s301 = china   ? pct(d.section_301?.rate) : 0;
      s232 = pct(d.section_232?.rate);
      // FTA override
      if (ftaName && d.fta_rates) {
        const ftaKey = Object.keys(d.fta_rates).find(k => ftaName.includes(k));
        if (ftaKey && String(d.fta_rates[ftaKey]).toLowerCase().includes("free")) mfn = 0;
      }
    }
  }

  // ── 2. Offline fallback ──────────────────────────────────────────────────
  if (src === "offline") {
    const e = HTS_DB[hts6];
    if (!e) {
      // Not in database — return partial with note
      const s122unknown = calcSec122(hts6, country, 0);
      return {
        mfn:0, s301:0, s232:0, s201:0, s122:s122unknown,
        total:s122unknown, ftaName, src:"not_found", desc:"",
        note:`HTS ${hts6} not in offline DB. Enter API key for live lookup, or verify at hts.usitc.gov`,
        breakdown:[
          { label:"MFN General Duty", rate:0, note:"HTS not found — verify manually" },
          ...(s122unknown>0?[{ label:"Section 122 (Temp Surcharge)", rate:s122unknown, tag:"122" }]:[]),
        ],
      };
    }
    mfn  = ftaName ? 0 : e.mfn;
    s301 = china   ? e.s301china : 0;
    s232 = e.s232;
    s201 = e.s201;
    desc = e.desc;
  }

  // ── 3. Section 122 (always computed dynamically) ─────────────────────────
  const s122 = calcSec122(hts6, country, s232);

  // ── 4. Total ─────────────────────────────────────────────────────────────
  const total = mfn + s301 + s232 + s201 + s122;

  // ── 5. Breakdown array for tooltip ───────────────────────────────────────
  const breakdown = [];
  if (ftaName && mfn === 0) breakdown.push({ label:`${ftaName} (Free)`,          rate:0,    tag:"FTA" });
  else                      breakdown.push({ label:"MFN General Duty",            rate:mfn             });
  if (s301>0)               breakdown.push({ label:"Section 301 — China",         rate:s301, tag:"301" });
  if (s232>0)               breakdown.push({ label:"Section 232 — Steel/Alum",    rate:s232, tag:"232" });
  if (s201>0)               breakdown.push({ label:"Section 201 — Safeguard",     rate:s201, tag:"201" });
  if (s122>0)               breakdown.push({ label:"Section 122 — Temp Surcharge",rate:s122, tag:"122",
                              note:`Active ${S122_HTS} · expires ${S122_EXPIRES}` });
  else if (S122_ACTIVE)     breakdown.push({ label:"Section 122 — Exempt",        rate:0,    tag:"122",
                              note: S122_USMCA_EXEMPT.includes(country)
                                    ? "USMCA exempt (9903.03.07/08)"
                                    : s232>0
                                    ? "Sec232 goods excluded from Sec122"
                                    : "Annex I/II sector exempt" });

  return { mfn, s301, s232, s201, s122, total, ftaName, src, desc, breakdown };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CALCULATION ENGINE
// ═══════════════════════════════════════════════════════════════════════════════
function calcDemand(history, sku) {
  const vals = history
    .filter(r => String(r["SKU Code"]||r.SKU||"").trim()===sku)
    .map(r => parseFloat(r["Units Sold"]||0))
    .filter(v => !isNaN(v));
  if (!vals.length) return 0;
  let ws=0,wt=0;
  vals.forEach((v,i)=>{ const w=i+1; ws+=v*w; wt+=w; });
  return wt ? ws/wt : 0;
}

function calcLeadTime(pos, sku) {
  const lts = pos
    .filter(r=>String(r["SKU Code"]||r.SKU||"").trim()===sku)
    .map(r=>{
      const d=(new Date(r["PO Received Date"]||r.POReceivedDate))-(new Date(r["PO Created Date"]||r.POCreatedDate));
      return d>0?d/86400000:null;
    }).filter(Boolean);
  return lts.length ? lts.reduce((a,b)=>a+b,0)/lts.length : 45;
}

function calcStatus(m) {
  return m<1?"🔴 CRITICAL":m<1.5?"🟠 URGENT":m<2?"🟡 REORDER":m<=4?"🟢 HEALTHY":"⚫ EXCESS";
}

async function runCalc(skuMaster, inventory, salesHistory, poHistory) {
  const out=[];
  for (const row of skuMaster) {
    const sku       = String(row["SKU Code"]||row.SKU||"").trim();
    const hts       = String(row["HTS Code"]||"").trim();
    const country   = String(row["Supplier Country"]||row.Country||"").trim();
    const unitCost  = parseFloat(row["Unit Cost ($)"]||row["Unit Cost"]||0)||0;
    const inv       = inventory.find(i=>String(i["SKU Code"]||i.SKU||"").trim()===sku);
    const stock     = parseFloat(inv?.["Current Stock"]||0)||0;
    const forecast  = calcDemand(salesHistory, sku);
    const ltDays    = calcLeadTime(poHistory, sku);
    const ltMonths  = ltDays/30;
    const safety    = ltMonths>1?1.0:0.5;
    const months    = forecast>0?stock/forecast:0;
    const reorder   = Math.round(forecast*(ltMonths+safety));
    const tariff    = await lookupTariff(hts, country);
    const tCost     = forecast*unitCost*(tariff.total/100);
    out.push({
      sku, desc:row.Description||"", supplier:row["Supplier Name"]||"",
      country, hts, unitCost, stock, tariff,
      forecast: Math.round(forecast*10)/10,
      ltMonths: Math.round(ltMonths*10)/10,
      safety, reorder,
      months:   Math.round(months*10)/10,
      tCost:    Math.round(tCost),
      status:   calcStatus(months),
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXCEL EXPORT
// ═══════════════════════════════════════════════════════════════════════════════
function exportExcel(skuMaster, inventory, sales, pos, results) {
  const wb  = XLSX.utils.book_new();
  const add = (n,d) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(d), n);
  add("1-SKU Master", skuMaster);
  add("2-Current Inventory", inventory);
  add("3-Sales History", sales);
  add("4-PO History", pos);

  const calc = results.map(r=>({
    "SKU":                          r.sku,
    "Description":                  r.desc,
    "Supplier":                     r.supplier,
    "Supplier Country":             r.country,
    "HTS Code":                     r.hts,
    "Product Description":          r.tariff.desc,
    "MFN General Duty %":           r.tariff.mfn + "%",
    "Section 301 (China) %":        r.tariff.s301 + "%",
    "Section 232 (Steel/Alum) %":   r.tariff.s232 + "%",
    "Section 201 (Safeguard) %":    r.tariff.s201 + "%",
    "Section 122 (Temp, to Jul 24)":r.tariff.s122 + "%",
    "FTA Applied":                  r.tariff.ftaName||"None",
    "TOTAL TARIFF %":               r.tariff.total + "%",
    "Data Source":                  r.tariff.src==="api"?"Live API":"Offline DB",
    "Current Stock":                r.stock,
    "Unit Cost ($)":                r.unitCost,
    "Forecast/Month":               r.forecast,
    "Lead Time (months)":           r.ltMonths,
    "Safety Stock (months)":        r.safety,
    "Reorder Point (units)":        r.reorder,
    "Months of Stock":              r.months,
    "Tariff Cost/Month ($)":        r.tCost,
    "STATUS":                       r.status,
    "Action Required":              r.status==="🔴 CRITICAL"?"ORDER IMMEDIATELY"
                                   :r.status==="🟠 URGENT"?"Order this week"
                                   :r.status==="🟡 REORDER"?"Schedule reorder"
                                   :r.status==="🟢 HEALTHY"?"Monitor"
                                   :"Review purchasing — cash tied up",
  }));
  add("5-Calculations", calc);

  const f  = n=>"$"+Math.round(n).toLocaleString();
  const tt = results.reduce((s,r)=>s+r.tCost,0);
  const s122total = results.reduce((s,r)=>s+r.forecast*r.unitCost*(r.tariff.s122/100),0);
  const ec = results.filter(r=>r.status==="⚫ EXCESS").reduce((s,r)=>s+r.stock*r.unitCost,0);
  add("6-Dashboard",[
    {"METRIC":"Report Date",               "VALUE":new Date().toLocaleDateString()},
    {"METRIC":"Total SKUs",                "VALUE":results.length},
    {"METRIC":"Critical SKUs (<1 month)",  "VALUE":results.filter(r=>r.status==="🔴 CRITICAL").length},
    {"METRIC":"Urgent SKUs (1–1.5 months)","VALUE":results.filter(r=>r.status==="🟠 URGENT").length},
    {"METRIC":"Healthy SKUs",              "VALUE":results.filter(r=>r.status==="🟢 HEALTHY").length},
    {"METRIC":"Excess SKUs (>4 months)",   "VALUE":results.filter(r=>r.status==="⚫ EXCESS").length},
    {"METRIC":"Total Tariff Cost/Month",   "VALUE":f(tt)},
    {"METRIC":"Section 122 Cost/Month",    "VALUE":f(s122total)+" (temporary — expires "+S122_EXPIRES+")"},
    {"METRIC":"Tariff Cost if Rates Double","VALUE":f(tt*2)},
    {"METRIC":"Cash in Excess Inventory",  "VALUE":f(ec)},
    {},...calc
  ]);
  XLSX.writeFile(wb,"AJA-SCM_TariffReport.xlsx");
}

// ─── File parser ──────────────────────────────────────────────────────────────
async function parseFile(file) {
  return new Promise((res,rej)=>{
    const r=new FileReader();
    r.onload=e=>{
      try{
        const wb=XLSX.read(new Uint8Array(e.target.result),{type:"array"});
        res(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:""}));
      }catch{rej(new Error("Parse failed"));}
    };
    r.onerror=()=>rej(new Error("Read error"));
    r.readAsArrayBuffer(file);
  });
}

// ─── Sample data ──────────────────────────────────────────────────────────────
const SAMPLE_SKU = [
  {"SKU Code":"SKU001","Description":"Industrial Valve",    "Supplier Name":"Alpha Co","Supplier Country":"China",  "HTS Code":"848180","Unit Cost ($)":45,   "Unit of Measure":"PCS","Min Order Qty":50},
  {"SKU Code":"SKU002","Description":"Ball Bearing Kit",    "Supplier Name":"Beta Co", "Supplier Country":"Mexico", "HTS Code":"848210","Unit Cost ($)":12.5, "Unit of Measure":"PCS","Min Order Qty":100},
  {"SKU Code":"SKU003","Description":"Steel Flat Sheet",    "Supplier Name":"Gamma Co","Supplier Country":"USA",    "HTS Code":"720851","Unit Cost ($)":88,   "Unit of Measure":"KG", "Min Order Qty":500},
  {"SKU Code":"SKU004","Description":"Centrifugal Pump",    "Supplier Name":"Delta Co","Supplier Country":"Vietnam","HTS Code":"841381","Unit Cost ($)":210,  "Unit of Measure":"PCS","Min Order Qty":20},
  {"SKU Code":"SKU005","Description":"Metallic Gasket Set", "Supplier Name":"Alpha Co","Supplier Country":"China",  "HTS Code":"848410","Unit Cost ($)":8.75, "Unit of Measure":"SET","Min Order Qty":200},
  {"SKU Code":"SKU006","Description":"Control Panel 480V",  "Supplier Name":"Zeta Co", "Supplier Country":"China",  "HTS Code":"853710","Unit Cost ($)":320,  "Unit of Measure":"PCS","Min Order Qty":5},
  {"SKU Code":"SKU007","Description":"Flexible Metal Hose", "Supplier Name":"Beta Co", "Supplier Country":"Mexico", "HTS Code":"830710","Unit Cost ($)":18,   "Unit of Measure":"MTR","Min Order Qty":50},
  {"SKU Code":"SKU008","Description":"Filter Assembly",     "Supplier Name":"Eta Co",  "Supplier Country":"China",  "HTS Code":"842139","Unit Cost ($)":34.5, "Unit of Measure":"PCS","Min Order Qty":100},
  {"SKU Code":"SKU009","Description":"Pressure Gauge 0-200","Supplier Name":"Gamma Co","Supplier Country":"USA",    "HTS Code":"902620","Unit Cost ($)":67,   "Unit of Measure":"PCS","Min Order Qty":25},
  {"SKU Code":"SKU010","Description":"Shaft Coupling",      "Supplier Name":"Delta Co","Supplier Country":"Vietnam","HTS Code":"848360","Unit Cost ($)":22,   "Unit of Measure":"PCS","Min Order Qty":200},
];
const SAMPLE_INV = [
  {"SKU Code":"SKU001","Current Stock":1200,"Last Count Date":"Feb-2026","Warehouse":"WH-A"},
  {"SKU Code":"SKU002","Current Stock":340, "Last Count Date":"Feb-2026","Warehouse":"WH-A"},
  {"SKU Code":"SKU003","Current Stock":5500,"Last Count Date":"Feb-2026","Warehouse":"WH-B"},
  {"SKU Code":"SKU004","Current Stock":28,  "Last Count Date":"Feb-2026","Warehouse":"WH-A"},
  {"SKU Code":"SKU005","Current Stock":890, "Last Count Date":"Feb-2026","Warehouse":"WH-B"},
  {"SKU Code":"SKU006","Current Stock":12,  "Last Count Date":"Feb-2026","Warehouse":"WH-A"},
  {"SKU Code":"SKU007","Current Stock":620, "Last Count Date":"Feb-2026","Warehouse":"WH-B"},
  {"SKU Code":"SKU008","Current Stock":85,  "Last Count Date":"Feb-2026","Warehouse":"WH-A"},
  {"SKU Code":"SKU009","Current Stock":44,  "Last Count Date":"Feb-2026","Warehouse":"WH-A"},
  {"SKU Code":"SKU010","Current Stock":2800,"Last Count Date":"Feb-2026","Warehouse":"WH-B"},
];
const MO = ["Aug-2025","Sep-2025","Oct-2025","Nov-2025","Dec-2025","Jan-2026"];
const VL = [320,340,360,410,490,420];
const SC = [1,0.85,13,0.07,2.1,0.04,0.3,0.1,0.13,1.25];
const SAMPLE_SALES = SAMPLE_SKU.flatMap((s,si)=>MO.map((m,mi)=>({
  "Month":m, "SKU Code":s["SKU Code"], "Units Sold":Math.round(VL[mi]*SC[si]),
})));
const SAMPLE_PO = [
  {"PO Number":"PO-1001","Supplier Name":"Alpha Co","SKU Code":"SKU001","PO Created Date":"2025-09-01","PO Received Date":"2025-10-02","Units Ordered":500},
  {"PO Number":"PO-1002","Supplier Name":"Alpha Co","SKU Code":"SKU001","PO Created Date":"2025-11-01","PO Received Date":"2025-12-04","Units Ordered":500},
  {"PO Number":"PO-1003","Supplier Name":"Beta Co", "SKU Code":"SKU002","PO Created Date":"2025-09-15","PO Received Date":"2025-10-05","Units Ordered":200},
  {"PO Number":"PO-1004","Supplier Name":"Gamma Co","SKU Code":"SKU003","PO Created Date":"2025-10-01","PO Received Date":"2025-10-09","Units Ordered":2000},
  {"PO Number":"PO-1005","Supplier Name":"Delta Co","SKU Code":"SKU004","PO Created Date":"2025-08-01","PO Received Date":"2025-09-16","Units Ordered":50},
  {"PO Number":"PO-1006","Supplier Name":"Alpha Co","SKU Code":"SKU005","PO Created Date":"2025-09-10","PO Received Date":"2025-10-11","Units Ordered":300},
  {"PO Number":"PO-1007","Supplier Name":"Beta Co", "SKU Code":"SKU007","PO Created Date":"2025-07-10","PO Received Date":"2025-08-02","Units Ordered":200},
  {"PO Number":"PO-1008","Supplier Name":"Eta Co",  "SKU Code":"SKU008","PO Created Date":"2025-07-01","PO Received Date":"2025-08-04","Units Ordered":150},
  {"PO Number":"PO-1009","Supplier Name":"Gamma Co","SKU Code":"SKU009","PO Created Date":"2025-08-01","PO Received Date":"2025-08-08","Units Ordered":50},
  {"PO Number":"PO-1010","Supplier Name":"Delta Co","SKU Code":"SKU010","PO Created Date":"2025-06-01","PO Received Date":"2025-07-16","Units Ordered":1000},
];

// ═══════════════════════════════════════════════════════════════════════════════
// CSS
// ═══════════════════════════════════════════════════════════════════════════════
const CSS=`
  @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@700;800&family=Inter:wght@400;500&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
  body{background:#07111f;color:${T.white};font-family:'Inter',sans-serif;font-size:14px;line-height:1.5;}
  .app{max-width:1380px;margin:0 auto;padding:0 24px 80px;}

  /* Header */
  .hdr{padding:26px 0 18px;border-bottom:1px solid ${T.border};margin-bottom:20px;
    display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;}
  .logo{display:flex;align-items:center;gap:12px;}
  .logo-icon{width:44px;height:44px;background:linear-gradient(135deg,${T.sky},${T.teal});
    border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:22px;}
  .logo h1{font-family:'Syne',sans-serif;font-size:22px;font-weight:800;
    background:linear-gradient(90deg,${T.white},${T.teal});-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
  .logo p{font-size:11px;color:${T.muted};}
  .steps{display:flex;gap:4px;background:${T.card};border:1px solid ${T.border};border-radius:12px;padding:5px;}
  .sb{padding:7px 13px;border-radius:8px;border:none;background:transparent;color:${T.muted};
    font-family:'Inter',sans-serif;font-size:12px;font-weight:500;cursor:pointer;transition:all 0.2s;
    display:flex;align-items:center;gap:5px;white-space:nowrap;}
  .sb:hover{color:${T.white};background:${T.border};}
  .sb.active{background:linear-gradient(135deg,${T.sky},${T.blue});color:white;}
  .sb .n{width:18px;height:18px;border-radius:50%;background:rgba(255,255,255,0.2);
    display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;}
  .sb.done .n{background:${T.green};}

  /* Section 122 live banner */
  .s122-banner{display:flex;align-items:flex-start;gap:10px;background:#1a1200;
    border:1px solid ${T.yellow}40;border-radius:10px;padding:12px 16px;margin-bottom:16px;}
  .s122-banner .icon{font-size:20px;flex-shrink:0;margin-top:1px;}
  .s122-banner h4{font-family:'Syne',sans-serif;font-size:13px;font-weight:700;color:${T.yellow};margin-bottom:3px;}
  .s122-banner p{font-size:12px;color:#bba040;line-height:1.5;}
  .s122-banner strong{color:${T.yellow};}

  /* API panel */
  .api-panel{background:${T.card};border:1px solid ${T.border};border-radius:12px;
    padding:14px 18px;margin-bottom:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
  .api-label{font-family:'DM Mono',monospace;font-size:11px;color:${T.muted};white-space:nowrap;}
  .api-inp{background:#07111f;border:1px solid ${T.border};border-radius:8px;color:${T.white};
    font-family:'DM Mono',monospace;font-size:12px;padding:7px 11px;width:260px;
    transition:border-color 0.2s;}
  .api-inp:focus{outline:none;border-color:${T.sky};}
  .api-pill{font-family:'DM Mono',monospace;font-size:11px;padding:3px 9px;border-radius:6px;}
  .api-pill.on{background:${T.green}20;color:${T.green};}
  .api-pill.off{background:${T.border};color:${T.muted};}
  .lk{font-size:11px;color:${T.sky};text-decoration:none;}
  .lk:hover{text-decoration:underline;}
  .hint{font-size:11px;color:${T.muted};}

  /* Upload */
  .h2{font-family:'Syne',sans-serif;font-size:19px;font-weight:800;margin-bottom:5px;}
  .sub{color:${T.muted};font-size:13px;margin-bottom:20px;}
  .notice{background:${T.sky}10;border:1px solid ${T.sky}30;border-radius:10px;
    padding:10px 14px;font-size:12px;color:${T.sky};margin-bottom:18px;
    display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
  .sbtn{padding:6px 12px;border:1px solid ${T.border};border-radius:7px;
    background:transparent;color:${T.muted};font-size:12px;cursor:pointer;transition:all 0.2s;}
  .sbtn:hover{color:${T.white};border-color:${T.sky};}
  .ug{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px;margin-bottom:24px;}
  .uc{background:${T.card};border:1px dashed ${T.border};border-radius:14px;
    padding:20px;cursor:pointer;transition:all 0.2s;position:relative;}
  .uc:hover{border-color:${T.sky}60;transform:translateY(-2px);}
  .uc.ok{border-color:${T.green};border-style:solid;}
  .uc input{display:none;}
  .uc-icon{font-size:24px;margin-bottom:8px;}
  .uc h3{font-family:'Syne',sans-serif;font-size:14px;font-weight:700;margin-bottom:3px;}
  .uc p{font-size:11px;color:${T.muted};margin-bottom:9px;}
  .utag{font-family:'DM Mono',monospace;font-size:10px;padding:2px 8px;border-radius:5px;display:inline-flex;align-items:center;gap:4px;}
  .utag.empty{background:${T.border};color:${T.muted};}
  .utag.ok{background:${T.green}20;color:${T.green};}
  .rbadge{position:absolute;top:10px;right:10px;font-size:10px;padding:2px 6px;
    border-radius:4px;background:${T.sky}20;color:${T.sky};font-family:'DM Mono',monospace;font-weight:700;}

  /* Tables */
  .tw{background:${T.card};border:1px solid ${T.border};border-radius:14px;overflow:hidden;margin-bottom:18px;}
  .th{padding:12px 16px;border-bottom:1px solid ${T.border};display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;}
  .th h3{font-family:'Syne',sans-serif;font-size:14px;font-weight:700;}
  .rc{font-family:'DM Mono',monospace;font-size:10px;color:${T.muted};background:${T.border};padding:2px 8px;border-radius:5px;}
  .ts{overflow-x:auto;}
  table{width:100%;border-collapse:collapse;font-size:12px;}
  thead th{background:#0a1525;padding:8px 12px;text-align:left;font-family:'DM Mono',monospace;
    font-size:10px;font-weight:500;color:${T.muted};border-bottom:1px solid ${T.border};white-space:nowrap;}
  tbody tr{border-bottom:1px solid ${T.border}15;transition:background 0.15s;}
  tbody tr:hover{background:${T.border}25;}
  tbody td{padding:7px 12px;vertical-align:middle;white-space:nowrap;}
  td input{background:transparent;border:1px solid transparent;color:${T.white};
    font-family:'Inter',sans-serif;font-size:12px;padding:3px 5px;border-radius:5px;
    min-width:65px;width:100%;transition:border-color 0.15s;}
  td input:focus{outline:none;border-color:${T.sky};background:${T.sky}10;}
  .arb{display:flex;align-items:center;gap:6px;padding:6px 13px;background:transparent;
    border:1px dashed ${T.border};border-radius:7px;color:${T.muted};font-size:12px;
    cursor:pointer;transition:all 0.2s;margin:9px 13px;}
  .arb:hover{border-color:${T.sky};color:${T.sky};}
  .db{background:none;border:none;cursor:pointer;color:${T.muted};font-size:14px;
    padding:2px 5px;border-radius:4px;transition:all 0.15s;}
  .db:hover{color:${T.red};background:${T.red}15;}
  .tnote{font-size:10px;color:${T.muted};font-style:italic;padding:6px 14px 10px;}

  /* KPIs */
  .kg{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin-bottom:20px;}
  .kc{background:${T.card};border:1px solid ${T.border};border-radius:12px;padding:15px;position:relative;overflow:hidden;}
  .kc::after{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:12px 12px 0 0;}
  .kc.cr::after{background:${T.red};}   .kc.ur::after{background:${T.orange};}
  .kc.hl::after{background:${T.green};} .kc.ex::after{background:${T.grey};}
  .kc.tr::after{background:${T.sky};}   .kc.ca::after{background:${T.teal};}
  .kc.s1::after{background:${T.yellow};}
  .kl{font-size:10px;color:${T.muted};font-family:'DM Mono',monospace;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;}
  .kv{font-family:'Syne',sans-serif;font-weight:800;line-height:1;}
  .ks{font-size:10px;color:${T.muted};margin-top:3px;}

  /* cash cards */
  .cg{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-bottom:22px;}
  .cc{background:${T.card};border:1px solid ${T.border};border-radius:12px;
    padding:15px;display:flex;align-items:center;gap:12px;}
  .ci{font-size:24px;}
  .cl{font-size:11px;color:${T.muted};margin-bottom:3px;}
  .cv{font-family:'Syne',sans-serif;font-size:19px;font-weight:700;}

  /* Status badge */
  .badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;
    border-radius:5px;font-size:11px;font-weight:600;font-family:'DM Mono',monospace;white-space:nowrap;}

  /* Tariff tooltip cell */
  .tc{position:relative;cursor:help;display:inline-block;}
  .tcv{font-family:'DM Mono',monospace;font-weight:700;}
  .tctip{display:none;position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);
    background:#090f1c;border:1px solid ${T.border};border-radius:10px;padding:11px 14px;
    z-index:1000;min-width:240px;box-shadow:0 10px 40px rgba(0,0,0,0.7);}
  .tc:hover .tctip{display:block;}
  .tt-hd{font-size:10px;color:${T.sky};font-family:'DM Mono',monospace;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:7px;}
  .tt-row{display:flex;justify-content:space-between;align-items:center;gap:18px;
    font-family:'DM Mono',monospace;font-size:11px;padding:3px 0;border-bottom:1px solid ${T.border}20;}
  .tt-row.total{border-bottom:none;padding-top:6px;font-weight:700;}
  .tt-lbl{color:${T.muted};display:flex;align-items:center;gap:4px;}
  .tt-rate{color:${T.white};}
  .tt-row.total .tt-rate{color:${T.yellow};}
  .tt-note{font-size:9px;color:${T.muted};font-style:italic;margin-top:5px;}
  .tag{font-size:9px;font-weight:700;padding:1px 4px;border-radius:3px;}
  .t301{background:${T.red}25;color:${T.red};}
  .t232{background:${T.orange}25;color:${T.orange};}
  .t122{background:${T.yellow}25;color:${T.yellow};}
  .t201{background:${T.purple}25;color:${T.purple};}
  .tFTA{background:${T.green}25;color:${T.green};}
  .src-lbl{display:inline-flex;align-items:center;gap:3px;font-family:'DM Mono',monospace;
    font-size:9px;padding:2px 6px;border-radius:4px;margin-top:6px;}
  .src-api{background:${T.sky}20;color:${T.sky};}
  .src-off{background:${T.border};color:${T.muted};}
  .src-nf{background:${T.orange}20;color:${T.orange};}

  /* bar */
  .bar-w{display:flex;align-items:center;gap:7px;}
  .bar-t{width:55px;height:5px;background:${T.border};border-radius:3px;overflow:hidden;}
  .bar-f{height:100%;border-radius:3px;}

  /* loading */
  .loading{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px;gap:14px;}
  .spin{width:36px;height:36px;border:3px solid ${T.border};border-top-color:${T.sky};
    border-radius:50%;animation:spin 0.8s linear infinite;}
  @keyframes spin{to{transform:rotate(360deg)}}

  /* buttons */
  .btn-p{padding:11px 24px;background:linear-gradient(135deg,${T.sky},${T.blue});
    color:white;border:none;border-radius:10px;font-family:'Syne',sans-serif;font-size:13px;
    font-weight:700;cursor:pointer;transition:all 0.2s;display:inline-flex;align-items:center;
    gap:7px;box-shadow:0 4px 20px ${T.sky}30;}
  .btn-p:hover{transform:translateY(-1px);box-shadow:0 6px 26px ${T.sky}45;}
  .btn-p:disabled{opacity:0.4;cursor:not-allowed;transform:none;}
  .btn-e{padding:11px 24px;background:linear-gradient(135deg,${T.teal},${T.green});
    color:#07111f;border:none;border-radius:10px;font-family:'Syne',sans-serif;font-size:13px;
    font-weight:700;cursor:pointer;transition:all 0.2s;display:inline-flex;align-items:center;gap:7px;}
  .btn-e:hover{transform:translateY(-1px);}
  .btn-g{padding:9px 17px;background:transparent;border:1px solid ${T.border};color:${T.muted};
    border-radius:9px;font-family:'Inter',sans-serif;font-size:12px;cursor:pointer;transition:all 0.2s;
    display:inline-flex;align-items:center;gap:6px;}
  .btn-g:hover{border-color:${T.sky};color:${T.white};}
  .abar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:16px 0;border-top:1px solid ${T.border};margin-top:14px;}

  @keyframes fi{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}
  .fi{animation:fi 0.3s ease forwards;}
`;

// ─── Tariff tooltip cell ──────────────────────────────────────────────────────
function TCell({ t }) {
  if (!t) return <span style={{color:T.muted}}>—</span>;
  const nf  = t.src==="not_found";
  const col = nf?T.orange : t.total>30?T.red : t.total>10?T.yellow : t.total>0?T.green : T.muted;
  const tagC= { "301":"t301","232":"t232","122":"t122","201":"t201","FTA":"tFTA" };
  const noteRow = t.breakdown.find(b=>b.note);
  return (
    <div className="tc">
      <span className="tcv" style={{color:col}}>{nf?"?":t.total+"%"}</span>
      <div className="tctip">
        <div className="tt-hd">{t.desc||"Tariff Breakdown"}</div>
        {nf
          ? <div style={{color:T.orange,fontSize:11}}>{t.note}</div>
          : <>
              {t.breakdown.map((b,i)=>(
                <div key={i} className="tt-row">
                  <span className="tt-lbl">
                    {b.label}
                    {b.tag && <span className={`tag ${tagC[b.tag]||""}`}>{b.tag}</span>}
                  </span>
                  <span className="tt-rate">{b.rate}%</span>
                </div>
              ))}
              <div className="tt-row total">
                <span className="tt-lbl" style={{color:T.white}}>TOTAL TARIFF</span>
                <span className="tt-rate">{t.total}%</span>
              </div>
              {noteRow && <div className="tt-note">📌 {noteRow.note}</div>}
              <span className={`src-lbl ${t.src==="api"?"src-api":t.src==="not_found"?"src-nf":"src-off"}`}>
                {t.src==="api"?"⚡ Live API — ustariffrates.com":t.src==="not_found"?"⚠ HTS not found":"📦 Offline DB"}
              </span>
            </>
        }
      </div>
    </div>
  );
}

// ─── Editable Table ───────────────────────────────────────────────────────────
function ETable({ title, data, setData, cols, note }) {
  const upd = (i,k,v)=>setData(p=>p.map((r,j)=>j===i?{...r,[k]:v}:r));
  const add  = ()=>{ const e={}; cols.forEach(c=>e[c.k]=""); setData(p=>[...p,e]); };
  const del  = i=>setData(p=>p.filter((_,j)=>j!==i));
  return (
    <div className="tw fi">
      <div className="th"><h3>{title}</h3><span className="rc">{data.length} rows</span></div>
      <div className="ts">
        <table>
          <thead><tr>{cols.map(c=><th key={c.k}>{c.l}</th>)}<th style={{width:32}}></th></tr></thead>
          <tbody>
            {data.map((row,i)=>(
              <tr key={i}>
                {cols.map(c=>(
                  <td key={c.k}>
                    <input type={c.t||"text"} value={row[c.k]??""} placeholder={c.p||""}
                      onChange={e=>upd(i,c.k,e.target.value)} />
                  </td>
                ))}
                <td><button className="db" onClick={()=>del(i)}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note&&<div className="tnote">💡 {note}</div>}
      <button className="arb" onClick={add}>＋ Add row</button>
    </div>
  );
}

// ─── Upload Card ──────────────────────────────────────────────────────────────
function UCard({ icon,title,desc,loaded,count,onFile,req }) {
  const ref=useRef();
  return (
    <div className={`uc ${loaded?"ok":""}`} onClick={()=>ref.current.click()}>
      {req&&<span className="rbadge">REQUIRED</span>}
      <div className="uc-icon">{icon}</div>
      <h3>{title}</h3><p>{desc}</p>
      <span className={`utag ${loaded?"ok":"empty"}`}>
        {loaded?`✓ ${count} rows`:"Click to upload CSV/XLSX"}
      </span>
      <input ref={ref} type="file" accept=".csv,.xlsx,.xls"
        onChange={async e=>{if(e.target.files[0]){const d=await parseFile(e.target.files[0]);onFile(d);}}} />
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard({ results, onExport }) {
  const f  = n=>"$"+Math.round(n).toLocaleString();
  const cr = results.filter(r=>r.status==="🔴 CRITICAL").length;
  const ur = results.filter(r=>r.status==="🟠 URGENT").length;
  const hl = results.filter(r=>r.status==="🟢 HEALTHY").length;
  const ex = results.filter(r=>r.status==="⚫ EXCESS").length;
  const tt = results.reduce((s,r)=>s+r.tCost,0);
  const ec = results.filter(r=>r.status==="⚫ EXCESS").reduce((s,r)=>s+r.stock*r.unitCost,0);
  const s1 = results.reduce((s,r)=>s+r.forecast*r.unitCost*(r.tariff.s122/100),0);
  const bc = s=>s==="🔴 CRITICAL"?T.red:s==="🟠 URGENT"?T.orange:s==="🟡 REORDER"?T.yellow:s==="🟢 HEALTHY"?T.green:T.grey;
  const ac = s=>s==="🔴 CRITICAL"?"ORDER NOW":s==="🟠 URGENT"?"Order this week":s==="🟡 REORDER"?"Schedule reorder":s==="🟢 HEALTHY"?"Monitor":"Review stock level";

  return (
    <div className="fi">
      {/* Live S122 alert */}
      <div className="s122-banner">
        <div className="icon">⚡</div>
        <div>
          <h4>Section 122 — ACTIVE NOW (HTS 9903.03.01)</h4>
          <p>
            <strong>+15% flat surcharge</strong> on virtually all imports · Effective Feb 24 – <strong>{S122_EXPIRES}</strong> · 
            Exempt: USMCA goods (Canada/Mexico), Section 232 products (steel/alum/copper), aircraft (ch88), 
            semiconductors, energy, pharma · Section 122 cost impact this month: <strong>{f(s1)}</strong>
          </p>
        </div>
      </div>

      <div className="kg">
        {[
          {l:"Critical SKUs",   v:cr,      s:"< 1 month",       c:"cr",col:T.red,    big:true},
          {l:"Urgent SKUs",     v:ur,      s:"1–1.5 months",    c:"ur",col:T.orange, big:true},
          {l:"Healthy SKUs",    v:hl,      s:"2–4 months",      c:"hl",col:T.green,  big:true},
          {l:"Excess SKUs",     v:ex,      s:"> 4 months",      c:"ex",col:T.grey,   big:true},
          {l:"Total Tariff/Mo", v:f(tt),   s:"all layers incl S122",c:"tr",col:T.sky},
          {l:"Cash in Excess",  v:f(ec),   s:"recoverable",     c:"ca",col:T.teal},
          {l:"S122 Cost/Mo",    v:f(s1),   s:"temporary surcharge",c:"s1",col:T.yellow},
        ].map(k=>(
          <div key={k.l} className={`kc ${k.c}`}>
            <div className="kl">{k.l}</div>
            <div className="kv" style={{color:k.col,fontSize:k.big?"30px":"16px"}}>{k.v}</div>
            <div className="ks">{k.s}</div>
          </div>
        ))}
      </div>

      <div className="cg">
        <div className="cc"><div className="ci">⚠️</div><div>
          <div className="cl">If tariff rates double</div>
          <div className="cv" style={{color:T.orange}}>{f(tt*2)}/mo</div>
        </div></div>
        <div className="cc"><div className="ci">📅</div><div>
          <div className="cl">Section 122 expires (unless extended)</div>
          <div className="cv" style={{color:T.yellow,fontSize:15}}>{S122_EXPIRES}</div>
        </div></div>
        <div className="cc"><div className="ci">🚨</div><div>
          <div className="cl">SKUs needing immediate action</div>
          <div className="cv" style={{color:T.red}}>{cr+ur} SKUs</div>
        </div></div>
        <div className="cc"><div className="ci">💡</div><div>
          <div className="cl">Cash freed if excess cleared</div>
          <div className="cv" style={{color:T.teal}}>{f(ec)}</div>
        </div></div>
      </div>

      {/* Results table */}
      <div className="tw fi">
        <div className="th">
          <h3>📊 Full Inventory & Tariff Intelligence</h3>
          <span className="rc">{results.length} SKUs</span>
        </div>
        <div className="ts">
          <table>
            <thead><tr>
              {["SKU","Description","Country","HTS","Stock","Fcst/Mo","Months","Reorder",
                "Lead Time","Total Tariff %","S122","Tariff/Mo","Status","Action"]
                .map(h=><th key={h}>{h}</th>)}
            </tr></thead>
            <tbody>
              {results.map((r,i)=>{
                const sc=STATUS_CONFIG[r.status]||{};
                return (
                  <tr key={i}>
                    <td><span style={{fontFamily:"'DM Mono',monospace",color:T.teal,fontSize:11}}>{r.sku}</span></td>
                    <td style={{maxWidth:140,overflow:"hidden",textOverflow:"ellipsis"}}>{r.desc}</td>
                    <td style={{color:T.muted}}>{r.country}</td>
                    <td><span style={{fontFamily:"'DM Mono',monospace",color:T.muted,fontSize:11}}>{r.hts}</span></td>
                    <td style={{fontFamily:"'DM Mono',monospace"}}>{r.stock.toLocaleString()}</td>
                    <td style={{fontFamily:"'DM Mono',monospace"}}>{r.forecast.toLocaleString()}</td>
                    <td>
                      <div className="bar-w">
                        <span style={{fontFamily:"'DM Mono',monospace",minWidth:24,fontSize:11}}>{r.months}</span>
                        <div className="bar-t"><div className="bar-f" style={{width:Math.min(r.months/4*100,100)+"%",background:bc(r.status)}}/></div>
                      </div>
                    </td>
                    <td style={{fontFamily:"'DM Mono',monospace"}}>{r.reorder.toLocaleString()}</td>
                    <td style={{fontFamily:"'DM Mono',monospace"}}>{r.ltMonths}mo</td>
                    <td><TCell t={r.tariff}/></td>
                    <td>
                      {r.tariff.s122>0
                        ? <span style={{fontFamily:"'DM Mono',monospace",color:T.yellow,fontSize:11,fontWeight:700}}>{r.tariff.s122}%</span>
                        : <span style={{color:T.green,fontSize:11}}>Exempt</span>}
                    </td>
                    <td style={{fontFamily:"'DM Mono',monospace",color:r.tCost>0?T.yellow:T.muted}}>
                      {r.tCost>0?f(r.tCost):"—"}
                    </td>
                    <td><span className="badge" style={{color:sc.color,background:sc.bg}}>{r.status}</span></td>
                    <td style={{color:T.muted,fontSize:11}}>{ac(r.status)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="tnote">
          💡 Hover any Total Tariff % for full layer breakdown — MFN · Section 301 · Section 232 · Section 122 · FTA status.
          S122 column shows per-SKU surcharge (⚡ active 15%) or exemption reason.
          Source: ustariffrates.com API (when key provided) + built-in HTS database · Always verify with your customs broker before filing.
        </div>
      </div>

      <div className="abar">
        <button className="btn-e" onClick={onExport}>⬇ Download AJA-SCM Excel Report</button>
        <span className="hint">Includes 6 tabs with all tariff layers, Section 122 impact, and inventory analysis</span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════
const SKU_COLS=[
  {k:"SKU Code",         l:"SKU Code",          p:"SKU001"},
  {k:"Description",      l:"Description",       p:"Product name"},
  {k:"Supplier Name",    l:"Supplier",          p:"Supplier Co"},
  {k:"Supplier Country", l:"Country",           p:"China"},
  {k:"HTS Code",         l:"HTS Code (6-digit)",p:"848180"},
  {k:"Unit Cost ($)",    l:"Unit Cost ($)",     p:"45.00",t:"number"},
  {k:"Unit of Measure",  l:"UoM",               p:"PCS"},
  {k:"Min Order Qty",    l:"Min Qty",           p:"50",t:"number"},
];
const INV_COLS=[
  {k:"SKU Code",        l:"SKU Code",      p:"SKU001"},
  {k:"Current Stock",   l:"Stock",         p:"1000",t:"number"},
  {k:"Last Count Date", l:"Count Date",    p:"Feb-2026"},
  {k:"Warehouse",       l:"Warehouse",     p:"WH-A"},
];
const SAL_COLS=[
  {k:"Month",     l:"Month",      p:"Jan-2026"},
  {k:"SKU Code",  l:"SKU Code",   p:"SKU001"},
  {k:"Units Sold",l:"Units Sold", p:"400",t:"number"},
  {k:"Notes",     l:"Notes",      p:""},
];
const PO_COLS=[
  {k:"PO Number",        l:"PO #",          p:"PO-1001"},
  {k:"Supplier Name",    l:"Supplier",      p:"Alpha Co"},
  {k:"SKU Code",         l:"SKU Code",      p:"SKU001"},
  {k:"PO Created Date",  l:"Created Date",  p:"2026-01-01"},
  {k:"PO Received Date", l:"Received Date", p:"2026-02-15"},
  {k:"Units Ordered",    l:"Units",         p:"500",t:"number"},
];

export default function App() {
  const [step,    setStep]    = useState(0);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [apiKey,  setApiKey]  = useState("");
  const [skuM, setSkuM] = useState([]);
  const [inv,  setInv]  = useState([]);
  const [sal,  setSal]  = useState([]);
  const [pos,  setPos]  = useState([]);

  const loadSample = () => {
    setSkuM(SAMPLE_SKU.map(r=>({...r})));
    setInv(SAMPLE_INV.map(r=>({...r})));
    setSal(SAMPLE_SALES.map(r=>({...r})));
    setPos(SAMPLE_PO.map(r=>({...r})));
  };

  const canRun = skuM.length>0 && inv.length>0 && sal.length>0;

  const run = async () => {
    _apiKey = apiKey.trim();
    setLoading(true);
    try { setResults(await runCalc(skuM,inv,sal,pos)); setStep(4); }
    finally { setLoading(false); }
  };

  const STEPS=["Upload","SKUs","Inventory","History","Results"];
  const DONE=[skuM.length>0&&inv.length>0,skuM.length>0,inv.length>0,sal.length>0,results.length>0];

  return (
    <>
      <style>{CSS}</style>
      <div className="app">

        {/* ── Header ── */}
        <div className="hdr">
          <div className="logo">
            <div className="logo-icon">🏭</div>
            <div>
              <h1>AJA-SCM</h1>
              <p>Inventory & Tariff Intelligence · MFN · S301 · S232 · S201 · S122 · FTA</p>
            </div>
          </div>
          <div className="steps">
            {STEPS.map((s,i)=>(
              <button key={i} className={`sb ${step===i?"active":""} ${DONE[i]?"done":""}`} onClick={()=>setStep(i)}>
                <span className="n">{DONE[i]?"✓":i+1}</span>{s}
              </button>
            ))}
          </div>
        </div>

        {/* ── API Key panel (always visible) ── */}
        <div className="api-panel">
          <span className="api-label">🔑 TARIFF API KEY:</span>
          <input className="api-inp" type="text" placeholder="ustariffrates.com API key (optional)..."
            value={apiKey}
            onChange={e=>{ setApiKey(e.target.value); _apiKey=e.target.value.trim(); }} />
          <span className={`api-pill ${apiKey?"on":"off"}`}>
            {apiKey?"⚡ Live API — 35,000+ HTS codes":"📦 Offline DB — 60+ codes"}
          </span>
          <a className="lk" href="https://ustariffrates.com/pricing" target="_blank" rel="noreferrer">
            Get free key (100 calls/mo, no credit card) →
          </a>
          <span className="hint">Without key: built-in database covers common manufacturing codes. With key: live lookup any HTS code.</span>
        </div>

        {/* ── Step 0: Upload ── */}
        {step===0 && (
          <div className="fi">
            <div className="h2">Upload Your Data Files</div>
            <p className="sub">Upload CSV or XLSX exports from your ERP. Enter only the 6-digit HTS code per SKU — all tariff layers (MFN, S301, S232, S122, FTA) are auto-calculated.</p>
            <div className="notice">
              💡 No files yet?
              <button className="sbtn" onClick={loadSample}>⚡ Load 10 Sample SKUs</button>
              <span style={{color:T.muted}}>— China, Vietnam, Mexico, USA across steel, pumps, valves, electronics</span>
            </div>
            <div className="ug">
              <UCard icon="📦" title="SKU Master" req desc="SKU code, supplier country, 6-digit HTS code, unit cost. No tariff % needed." loaded={skuM.length>0} count={skuM.length} onFile={setSkuM}/>
              <UCard icon="🏭" title="Current Inventory" req desc="SKU codes + current stock quantities + warehouse." loaded={inv.length>0} count={inv.length} onFile={setInv}/>
              <UCard icon="📈" title="Sales History" req desc="Month, SKU Code, Units Sold. Min 3 months, 6+ recommended." loaded={sal.length>0} count={sal.length} onFile={setSal}/>
              <UCard icon="📋" title="PO History" desc="PO Created + Received dates per SKU → auto-calculates real lead times." loaded={pos.length>0} count={pos.length} onFile={setPos}/>
            </div>
            <div className="abar">
              <button className="btn-p" disabled={!canRun} onClick={()=>setStep(1)}>Review & Edit Data →</button>
              {canRun
                ? <span style={{color:T.green,fontSize:12}}>✓ {skuM.length} SKUs ready</span>
                : <span className="hint">Upload SKU Master, Inventory & Sales to continue</span>}
            </div>
          </div>
        )}

        {/* ── Step 1: SKU Master ── */}
        {step===1 && (
          <div className="fi">
            <div className="h2">Review & Edit SKU Master</div>
            <p className="sub">Enter 6-digit HTS codes (no dots or dashes). The app looks up all tariff layers automatically.</p>
            <ETable title="📦 SKU Master" data={skuM} setData={setSkuM} cols={SKU_COLS}
              note="HTS Code: 6 digits only, e.g. 848180 — not 8481.80.00. App handles full HTS classification."/>
            <div className="abar">
              <button className="btn-g" onClick={()=>setStep(0)}>← Back</button>
              <button className="btn-p" onClick={()=>setStep(2)}>Next: Inventory →</button>
            </div>
          </div>
        )}

        {/* ── Step 2: Inventory ── */}
        {step===2 && (
          <div className="fi">
            <div className="h2">Review & Edit Current Inventory</div>
            <p className="sub">Verify current stock counts. This drives months-of-stock and reorder calculations.</p>
            <ETable title="🏭 Current Inventory" data={inv} setData={setInv} cols={INV_COLS}/>
            <div className="abar">
              <button className="btn-g" onClick={()=>setStep(1)}>← Back</button>
              <button className="btn-p" onClick={()=>setStep(3)}>Next: History →</button>
            </div>
          </div>
        )}

        {/* ── Step 3: History ── */}
        {step===3 && (
          <div className="fi">
            <div className="h2">Review Sales & PO History</div>
            <p className="sub">Sales history drives demand forecasting. PO history auto-calculates real supplier lead times.</p>
            <ETable title="📈 Monthly Sales History" data={sal} setData={setSal} cols={SAL_COLS}/>
            <ETable title="📋 PO History" data={pos} setData={setPos} cols={PO_COLS}/>
            <div className="abar">
              <button className="btn-g" onClick={()=>setStep(2)}>← Back</button>
              <button className="btn-p" disabled={!canRun||loading} onClick={run}>
                {loading?"⏳ Looking up tariffs...":"✨ Run AJA-SCM Analysis →"}
              </button>
              <span className="hint">{apiKey?"⚡ Live tariff API active":"📦 Using offline HTS database"}</span>
            </div>
          </div>
        )}

        {/* ── Loading ── */}
        {loading && (
          <div className="loading">
            <div className="spin"/>
            <div style={{fontFamily:"'DM Mono',monospace",color:T.muted,fontSize:13}}>
              {apiKey?"Fetching live tariff rates via ustariffrates.com...":"Running offline tariff calculations..."}
            </div>
            <div className="hint">Stacking MFN · Section 301 · Section 232 · Section 122 · FTA layers</div>
          </div>
        )}

        {/* ── Step 4: Results ── */}
        {step===4 && !loading && results.length>0 && (
          <div className="fi">
            <div className="h2">AJA-SCM Analysis — Tariff & Inventory Intelligence</div>
            <p className="sub">All 5 tariff layers calculated per SKU. Section 122 (15%) applied where applicable. Download Excel to share with your team.</p>
            <Dashboard results={results} onExport={()=>exportExcel(skuM,inv,sal,pos,results)}/>
          </div>
        )}

      </div>
    </>
  );
}
