import React, { useState, useRef } from "react";

// ————————————————————————————————————————————————————————————
// CSV parser (RFC 4180-ish): commas, quotes, CRLF, escaped quotes "".
// ————————————————————————————————————————————————————————————
function parseCSV(text, delimiter = ",") {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++; // skip the escaped quote
      } else if (char === '"') {
        inQuotes = false; // closing quote
      } else {
        field += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true; // opening quote
      } else if (char === delimiter) {
        row.push(field);
        field = "";
      } else if (char === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (char === "\r") {
        // ignore CR (\r) — handle CRLF
        continue;
      } else {
        field += char;
      }
    }
  }
  // push last field / row if any
  if (field !== "" || inQuotes || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ————————————————————————————————————————————————————————————
// Robust delimiter detection
// ————————————————————————————————————————————————————————————
const CANDIDATES = [",", "\t", ";", "|", ":"]; // common delimiters
function detectDelimiterByStructure(sample) {
  const text = sample.split(/\r?\n/).slice(0, 20).join("\n");
  let best = ",";
  let bestScore = -Infinity;

  for (const d of CANDIDATES) {
    const rows = parseCSV(text, d);
    if (rows.length < 2) continue; // need header+1
    const lens = rows.map(r => r.length);
    const headerCols = lens[0];
    const nonEmpty = rows.slice(1).filter(r => r.some(c => (c ?? "").trim() !== ""));
    const matching = nonEmpty.filter(r => r.length === headerCols).length;
    const uniqueLens = new Set(lens).size;
    // score: prefer >1 columns, many rows matching header length, lower variance
    if (headerCols > 1) {
      const mean = lens.reduce((a, c) => a + c, 0) / lens.length;
      const variance = lens.reduce((a, c) => a + (c - mean) ** 2, 0) / lens.length;
      const score = matching * 100 - variance * 10 - (uniqueLens - 1) * 5;
      if (score > bestScore) { bestScore = score; best = d; }
    }
  }
  return best;
}

// ————————————————————————————————————————————————————————————
// Helpers for nested JSON detection + parsing
// ————————————————————————————————————————————————————————————
function looksLikeJSON(value) {
  if (typeof value !== "string") return false;
  const t = value.trim();
  if (!t) return false;
  return t.startsWith("{") || t.startsWith("[") || (t.startsWith('"') && (t[1] === '{' || t[1] === '['));
}

// ————————————————————————————————————————————————————————————
// DynamoDB AttributeValue (AV) unmarshalling
// ————————————————————————————————————————————————————————————
const AV_KEYS = new Set(["S","N","BOOL","NULL","M","L","SS","NS","BS","B"]);

function isAttributeValue(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj);
  if (keys.length !== 1) return false;
  return AV_KEYS.has(keys[0]);
}

function unmarshallAV(av) {
  const [t] = Object.keys(av);
  const v = av[t];
  switch (t) {
    case 'S': return String(v);
    case 'N': return Number(v);
    case 'BOOL': return Boolean(v);
    case 'NULL': return null;
    case 'SS': return Array.isArray(v) ? v.map(String) : [];
    case 'NS': return Array.isArray(v) ? v.map(Number) : [];
    case 'L': return Array.isArray(v) ? v.map(unmarshallDeep) : [];
    case 'M': return unmarshallMap(v);
    case 'B': return v; // leave as-is
    case 'BS': return v; // leave as-is
    default: return v;
  }
}

function unmarshallMap(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    out[k] = unmarshallDeep(v);
  }
  return out;
}

function maybeMapOfAVs(obj) {
  const entries = Object.values(obj || {});
  if (entries.length === 0) return false;
  return entries.every(x => isAttributeValue(x));
}

function unmarshallDeep(value) {
  if (isAttributeValue(value)) return unmarshallAV(value);
  if (Array.isArray(value)) return value.map(unmarshallDeep);
  if (value && typeof value === 'object') {
    if (value.M && isAttributeValue({ M: value.M })) return unmarshallAV({ M: value.M });
    if (maybeMapOfAVs(value)) return unmarshallMap(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = unmarshallDeep(v);
    return out;
  }
  return value;
}

// ————————————————————————————————————————————————————————————
// Type inference (outside DynamoDB AV)
// ————————————————————————————————————————————————————————————
function inferScalar(str) {
  if (typeof str !== 'string') return str;
  const t = str.trim();
  if (t === '') return str; // keep empty strings as-is
  const lower = t.toLowerCase();
  if (lower === 'null') return null;
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  return str;
}

function coerceDeep(value) {
  if (Array.isArray(value)) return value.map(coerceDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = coerceDeep(v);
    return out;
  }
  return inferScalar(value);
}

function convertRowsToObjects(rows, { parseNestedJSON, doUnmarshall, doInferTypes }) {
  if (!rows.length) return [];
  const headers = rows[0].map(h => h?.trim?.() ?? "");
  const dataRows = rows.slice(1);
  return dataRows
    .filter(r => r.some(cell => (cell ?? "").trim() !== ""))
    .map(r => {
      const obj = {};
      headers.forEach((h, idx) => {
        let v = r[idx] ?? "";
        if (parseNestedJSON && looksLikeJSON(v)) {
          try { v = JSON.parse(v); } catch {}
        }
        if (doUnmarshall && v && typeof v === 'object') {
          v = unmarshallDeep(v);
        }
        if (doInferTypes) {
          v = coerceDeep(v);
        }
        obj[h || `col_${idx + 1}`] = v;
      });
      return obj;
    });
}

// ————————————————————————————————————————————————————————————
// Simple deep equality for test assertions
// ————————————————————————————————————————————————————————————
function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a); const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

// ————————————————————————————————————————————————————————————
// Utils: random file name + cross-browser copy
// ————————————————————————————————————————————————————————————
function randomName(len = 16) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  if (window.crypto && window.crypto.getRandomValues) {
    const arr = new Uint32Array(len);
    window.crypto.getRandomValues(arr);
    return Array.from(arr, n => alphabet[n % alphabet.length]).join('');
  }
  // Fallback
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.left = '-1000px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export default function App() {
  const [csv, setCsv] = useState("");
  const [json, setJson] = useState("[]");
  const [status, setStatus] = useState("");
  const [delimiter, setDelimiter] = useState(",");
  const [autoDelim, setAutoDelim] = useState(true);
  const [parseNestedJSON, setParseNestedJSON] = useState(true);
  const [doUnmarshall, setDoUnmarshall] = useState(true);
  const [doInferTypes, setDoInferTypes] = useState(true);
  const [testResults, setTestResults] = useState([]);
  const fileInputRef = useRef(null);

  function handleConvert() {
    try {
      setStatus("");
      const sample = csv.slice(0, 4000);
      const delim = autoDelim ? detectDelimiterByStructure(sample) : delimiter;
      setDelimiter(delim);
      const rows = parseCSV(csv, delim);
      if (!rows.length) {
        setJson("[]");
        setStatus("No rows detected. Make sure there's a header row.");
        return;
      }
      const objects = convertRowsToObjects(rows, { parseNestedJSON, doUnmarshall, doInferTypes });
      setJson(JSON.stringify(objects, null, 2));
      setStatus(`Parsed ${objects.length} row(s) with delimiter "${delim.replace("\t", "\\t")}".`);
    } catch (e) {
      console.error(e);
      setStatus("Error: " + (e?.message || String(e)));
    }
  }

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setCsv(String(ev.target?.result || ""));
    reader.readAsText(file);
  }

  function handleDrop(e) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setCsv(String(ev.target?.result || ""));
    reader.readAsText(file);
  }

  function handleDownload() {
    try {
      const name = `${randomName(16)}.json`;
      const blob = new Blob([json], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      // Safari needs the link in the DOM
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus(`Downloaded ${name}.`);
    } catch (e) {
      console.error(e);
      setStatus("Error creating download: " + (e?.message || String(e)));
    }
  }

  async function handleCopy() {
    const ok = await copyText(json);
    setStatus(ok ? "Copied JSON to clipboard." : "Copy failed. Your browser may block clipboard access.");
  }

  function runTests() {
    const cases = [];

    cases.push({
      name: "basic",
      input: `a,b\n1,2\n3,4`,
      delim: ",",
      parseNested: false,
      unmarshall: false,
      infer: true,
      expected: [ { a: 1, b: 2 }, { a: 3, b: 4 } ]
    });

    cases.push({
      name: "nested JSON object",
      input: `id,name,meta\n1,Alice,"{""role"":""admin"",""tags"": [""a"",""b""]}"`,
      delim: ",",
      parseNested: true,
      unmarshall: false,
      infer: true,
      expected: [ { id: 1, name: "Alice", meta: { role: "admin", tags: ["a", "b"] } } ]
    });

    cases.push({
      name: "nested JSON array",
      input: `id,nums\n42,"[1,2,3]"`,
      delim: ",",
      parseNested: true,
      unmarshall: false,
      infer: true,
      expected: [ { id: 42, nums: [1,2,3] } ]
    });

    cases.push({
      name: "tab autodetect",
      input: `a\tb\nX\tY`,
      delim: "\t",
      parseNested: false,
      unmarshall: false,
      infer: true,
      expected: [ { a: "X", b: "Y" } ]
    });

    cases.push({
      name: "CRLF",
      input: `a,b\r\n1,2\r\n`,
      delim: ",",
      parseNested: false,
      unmarshall: false,
      infer: true,
      expected: [ { a: 1, b: 2 } ]
    });

    cases.push({
      name: "malformed JSON tolerated",
      input: `id,bad\n1,"{notjson}"`,
      delim: ",",
      parseNested: true,
      unmarshall: false,
      infer: true,
      expected: [ { id: 1, bad: "{notjson}" } ]
    });

    cases.push({
      name: "DynamoDB inline map",
      input: `facility\n"{""zip"":{""N"":""32301""},""flag"":{""BOOL"":false},""name"":{""S"":""X""},""arr"":{""L"": [{""S"":""a""},{""N"":""2""}] } }"`,
      delim: ",",
      parseNested: true,
      unmarshall: true,
      infer: true,
      expected: [ { facility: { zip: 32301, flag: false, name: "X", arr: ["a", 2] } } ]
    });

    cases.push({
      name: "structure-based delimiter chooses comma",
      input: `"userId","facility"\n"abc","{""zip"":{""N"":""1""}}"`,
      delim: ",",
      parseNested: true,
      unmarshall: true,
      infer: true,
      expected: [ { userId: "abc", facility: { zip: 1 } } ]
    });

    cases.push({
      name: "type inference",
      input: `a,b,c,d\nnull,true,false,123.45`,
      delim: ",",
      parseNested: false,
      unmarshall: false,
      infer: true,
      expected: [ { a: null, b: true, c: false, d: 123.45 } ]
    });

    const results = [];
    for (const tc of cases) {
      try {
        const delim = detectDelimiterByStructure(tc.input);
        const rows = parseCSV(tc.input, delim);
        const out = convertRowsToObjects(rows, { parseNestedJSON: tc.parseNested, doUnmarshall: tc.unmarshall, doInferTypes: tc.infer });
        const pass = deepEqual(out, tc.expected);
        results.push({ name: tc.name + ` (d=${JSON.stringify(delim)})`, pass, out, expected: tc.expected });
      } catch (err) {
        results.push({ name: tc.name, pass: false, error: String(err) });
      }
    }
    setTestResults(results);
    setStatus(`Ran ${cases.length} test(s). ${results.filter(r => r.pass).length} passed, ${results.filter(r => !r.pass).length} failed.`);
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">CSV → JSON Converter</h1>
          <div className="text-sm text-gray-600">Runs locally in your browser. No upload.</div>
        </header>

        <section className="grid md:grid-cols-2 gap-6 items-stretch">
          {/* Input side */}
          <div className="bg-white rounded-2xl shadow p-4 flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-semibold">Paste CSV</h2>
              <div className="flex items-center gap-3 text-sm">
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="accent-blue-600"
                    checked={autoDelim}
                    onChange={e => setAutoDelim(e.target.checked)}
                  />
                  Auto-detect delimiter (structure-based)
                </label>
                {!autoDelim && (
                  <select
                    className="border rounded px-2 py-1"
                    value={delimiter}
                    onChange={e => setDelimiter(e.target.value)}
                  >
                    <option value=",">Comma (,)</option>
                    <option value="\t">Tab (\t)</option>
                    <option value=";">Semicolon (;)</option>
                    <option value="|">Pipe (|)</option>
                    <option value=":">Colon (:)</option>
                  </select>
                )}
              </div>
            </div>

            <textarea
              value={csv}
              onChange={e => setCsv(e.target.value)}
              placeholder={`header1,header2,header3\nvalue1,"{""a"":1}",value3`}
              className="flex-1 border rounded-xl p-3 font-mono text-sm min-h-[240px] resize-y"
            />

            <div
              onDrop={handleDrop}
              onDragOver={e => e.preventDefault()}
              className="mt-3 border-2 border-dashed rounded-xl p-4 text-center text-sm text-gray-600 hover:bg-gray-50"
            >
              Drag & drop a .csv file here, or
              <button
                onClick={() => fileInputRef.current?.click()}
                className="ml-1 underline text-blue-600 hover:text-blue-800"
              >browse</button>
              <input ref={fileInputRef} type="file" accept=".csv,text/csv" hidden onChange={handleFile} />
            </div>

            <div className="mt-4 flex items-center justify-between">
              <div className="flex flex-col gap-2 text-sm">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-blue-600"
                    checked={parseNestedJSON}
                    onChange={e => setParseNestedJSON(e.target.checked)}
                  />
                  Parse stringified JSON fields
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-blue-600"
                    checked={doUnmarshall}
                    onChange={e => setDoUnmarshall(e.target.checked)}
                  />
                  Unmarshall DynamoDB JSON (S/N/BOOL/L/M/…)
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-blue-600"
                    checked={doInferTypes}
                    onChange={e => setDoInferTypes(e.target.checked)}
                  />
                  Type inference (null/boolean/number)
                </label>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleConvert}
                  className="px-4 py-2 rounded-xl bg-blue-600 text-white font-medium hover:bg-blue-700"
                >
                  Convert
                </button>
                <button
                  onClick={runTests}
                  className="px-3 py-2 rounded-xl border font-medium hover:bg-gray-50"
                  title="Run built-in parser tests"
                >
                  Run Tests
                </button>
              </div>
            </div>
          </div>

          {/* Output side */}
          <div className="bg-white rounded-2xl shadow p-4 flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-semibold">Result (JSON)</h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCopy}
                  className="px-3 py-1.5 rounded-lg border text-sm hover:bg-gray-50"
                >Copy</button>
                <button
                  onClick={handleDownload}
                  className="px-3 py-1.5 rounded-lg border text-sm hover:bg-gray-50"
                >Download</button>
              </div>
            </div>

            <pre className="flex-1 border rounded-xl p-3 font-mono text-xs overflow-auto bg-gray-50 min-h-[240px]">
{json}
            </pre>

            <div className={`mt-3 text-sm ${status.startsWith("Error") ? "text-red-600" : "text-gray-600"}`}>
              {status || "Ready."}
            </div>
          </div>
        </section>

        {/* Tests output */}
        <section className="bg-white rounded-2xl shadow p-4">
          <h3 className="font-semibold mb-2">Test Results</h3>
          {testResults.length === 0 ? (
            <div className="text-sm text-gray-600">No tests run yet. Click <b>Run Tests</b> above.</div>
          ) : (
            <ul className="space-y-2 text-sm">
              {testResults.map((r, i) => (
                <li key={i} className={`p-2 rounded border ${r.pass ? 'border-green-300 bg-green-50' : 'border-red-300 bg-red-50'}`}>
                  <div className="font-medium">{r.name}: {r.pass ? 'PASS' : 'FAIL'}</div>
                  {!r.pass && (
                    <details className="mt-1">
                      <summary className="cursor-pointer">Show diff</summary>
                      <div className="mt-1 grid md:grid-cols-2 gap-2">
                        <pre className="border rounded p-2 overflow-auto"><b>Actual</b>\n{JSON.stringify(r.out, null, 2)}</pre>
                        <pre className="border rounded p-2 overflow-auto"><b>Expected</b>\n{JSON.stringify(r.expected, null, 2)}</pre>
                      </div>
                      {r.error && <div className="text-red-600 mt-1">{r.error}</div>}
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <details className="text-sm text-gray-700">
          <summary className="cursor-pointer font-medium">Tips & examples</summary>
          <div className="mt-2 space-y-2">
            <p>
              • Include a header row. Fields that <em>look</em> like JSON (start with <code>{"{"}</code> or <code>[</code>) will be parsed into native objects/arrays when enabled.
            </p>
            <p>• Toggle <b>Unmarshall DynamoDB JSON</b> to convert objects like <code>{'{"S":"str"}'}</code>, <code>{'{"N":"123"}'}</code>, <code>{'{"L":[...]}'}</code>, or maps of AVs into plain JS.</p>
            <p>• Enable <b>Type inference</b> to coerce plain strings like <code>null</code>, <code>true</code>, <code>false</code>, or <code>123.45</code> into their native types (values already parsed from JSON/AV remain correctly typed).</p>
          </div>
        </details>
      </div>
    </div>
  );
}
