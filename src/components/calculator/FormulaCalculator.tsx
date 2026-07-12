"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Calculator, ChevronDown, ChevronUp, Plus, Pin, Edit3, X, FunctionSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useEditorStore } from "@/store/editor-store";
import type { FormulaStore, FormulaEntry } from "@/lib/editor/types";
import { setDefaultDisplaySettings } from "@/lib/editor/doc-formula-scanner";
import { getMath, loadMath } from "@/lib/editor/math-loader";
import { publicAssetUrl } from "@/lib/public-path";

const GREEK_SYMBOLS = [
  { value: "custom", label: "Свой" },
  { value: "alpha", label: "α" },
  { value: "beta", label: "β" },
  { value: "gamma", label: "γ" },
  { value: "delta", label: "δ" },
  { value: "theta", label: "θ" },
  { value: "lambda", label: "λ" },
  { value: "mu", label: "μ" },
  { value: "sigma", label: "σ" },
  { value: "omega", label: "ω" },
];

function useKatex() {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    // If KaTeX is already loaded, no need to set state — the synchronous
    // check below handles it.
    if ((window as unknown as { katex?: unknown }).katex) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = publicAssetUrl("libs/katex/css/katex.min.css");
    document.head.appendChild(link);
    const script = document.createElement("script");
    script.src = publicAssetUrl("libs/katex/katex.min.js");
    script.onload = () => setLoaded(true);
    script.onerror = () => setLoaded(false);
    document.head.appendChild(script);
  }, []);
  // Synchronous check — KaTeX may have been loaded by another component.
  if (typeof window !== "undefined" && (window as unknown as { katex?: unknown }).katex) {
    return true;
  }
  return loaded;
}

function renderLatex(formula: string, element: HTMLElement | null) {
  if (!element) return;
  try {
    const math = getMath();
    if (!math) { element.textContent = formula; loadMath().catch(() => {}); return; }
    const node = math.parse(formula);
    const latex = node.toTex({ parenthesis: "auto" });
    const katex = (window as unknown as { katex?: { render: (tex: string, el: HTMLElement, opts?: Record<string, unknown>) => void } }).katex;
    if (katex) katex.render(latex, element, { throwOnError: false, displayMode: true });
    else element.textContent = latex;
  } catch {
    if (element) element.textContent = formula;
  }
}

export function FormulaCalculator() {
  const formulaStore = useEditorStore((s) => s.formulaStore);
  const updateFormulaStore = useEditorStore((s) => s.updateFormulaStore);
  const openFormulaInsertDialog = useEditorStore((s) => s.openFormulaInsertDialog);
  const [calcOpen, setCalcOpen] = useState(false);

  if (!formulaStore) return null;

  // Count formulas that are in the document.
  const docFormulas = formulaStore.formulas.filter(f => f.inDocument);

  return (
    <Collapsible open={calcOpen} onOpenChange={setCalcOpen} className="border rounded-lg">
      <CollapsibleTrigger asChild>
        <button className="flex w-full items-center justify-between rounded-lg bg-muted/30 px-3 py-2 text-sm font-medium hover:bg-muted/50 border">
          <span className="flex items-center gap-2">
            <Calculator className="h-4 w-4" />
            Калькулятор ({docFormulas.length} в док., {formulaStore.formulas.length} всего)
          </span>
          {calcOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="p-3 space-y-4">
        <CalculatorPanel
          store={formulaStore}
          onUpdate={updateFormulaStore}
          onInsertFormula={openFormulaInsertDialog}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

function CalculatorPanel({
  store,
  onUpdate,
  onInsertFormula,
}: {
  store: FormulaStore;
  onUpdate: (patch: Partial<FormulaStore>) => void;
  onInsertFormula: (formulaId: string) => void;
}) {
  const [input, setInput] = useState("");
  const [result, setResult] = useState("0");
  const [angleUnit, setAngleUnit] = useState(store.settings.angleUnit);
  const [resultFormat, setResultFormat] = useState(store.settings.resultFormat);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newComment, setNewComment] = useState("");
  const [newSymbol, setNewSymbol] = useState("custom");
  const inputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef<HTMLInputElement>(null);
  const latexDisplayRef = useRef<HTMLDivElement>(null);
  const katexLoaded = useKatex();

  const lastFocusedField = useRef<"input" | "value">("input");
  useEffect(() => {
    const handleFocus = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      if (target === inputRef.current) lastFocusedField.current = "input";
      else if (target === valueRef.current) lastFocusedField.current = "value";
    };
    document.addEventListener("focusin", handleFocus);
    return () => document.removeEventListener("focusin", handleFocus);
  }, []);

  useEffect(() => {
    if (katexLoaded && latexDisplayRef.current && input.trim()) {
      renderLatex(input.replace(/,/g, "."), latexDisplayRef.current);
    } else if (latexDisplayRef.current) {
      latexDisplayRef.current.innerHTML = "";
    }
  }, [input, katexLoaded]);

  const formatNumber = useCallback((num: number | undefined | null): string => {
    if (num === undefined || num === null || isNaN(num)) return "?";
    if (typeof num !== "number") return String(num);
    if (resultFormat === "scientific") return num.toExponential(4);
    return num.toLocaleString("ru-RU", { maximumFractionDigits: 14 });
  }, [resultFormat]);

  const calculate = useCallback((replaceInput = false) => {
    let inputStr = input.trim();
    if (!inputStr) return;
    inputStr = inputStr.replace(/,/g, ".");
    try {
      const math = getMath();
      if (!math) { setResult("Загрузка math.js..."); loadMath().catch(() => {}); return; }
      const scope: Record<string, number> = {};
      for (const c of store.formulas) {
        if (c.value !== undefined) scope[c.name] = c.value;
      }
      // Handle degree mode for trig functions
      if (angleUnit === "deg") {
        const degScope: Record<string, unknown> = {};
        for (const fn of ["sin", "cos", "tan", "sec", "cot", "csc"]) {
          degScope[fn] = (x: number) => (math as unknown as { [key: string]: (x: number) => number })[fn]!(x * Math.PI / 180);
        }
        for (const fn of ["asin", "acos", "atan", "asec", "acot", "acsc"]) {
          degScope[fn] = (x: number) => (math as unknown as { [key: string]: (x: number) => number })[fn]!(x) * 180 / Math.PI;
        }
        Object.assign(scope, degScope);
      }
      const val = math.evaluate(inputStr, scope);
      const numVal = typeof val === "number" ? val : (typeof val?.valueOf?.() === "number" ? val.valueOf() : NaN);
      setResult(formatNumber(numVal));
      if (replaceInput) setInput(String(numVal));
      onUpdate({ history: [{ expr: inputStr, result: formatNumber(numVal), raw: numVal }, ...store.history].slice(0, 50) });
    } catch { setResult("Ошибка"); }
  }, [input, store.formulas, store.history, angleUnit, formatNumber, onUpdate]);

  const insertAtCursor = useCallback((text: string) => {
    if (lastFocusedField.current === "value" && valueRef.current) {
      const el = valueRef.current;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      setNewValue(el.value.substring(0, start) + text + el.value.substring(end));
      setTimeout(() => { el.focus(); el.selectionStart = el.selectionEnd = start + text.length; }, 0);
    } else if (inputRef.current) {
      const el = inputRef.current;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      setInput(el.value.substring(0, start) + text + el.value.substring(end));
      setTimeout(() => { el.focus(); el.selectionStart = el.selectionEnd = start + text.length; }, 0);
    } else { setInput(text); }
  }, []);

  const addOrEditFormula = () => {
    const name = newName.trim();
    const formula = newValue.trim().replace(/,/g, ".");
    if (!name || !formula) return;
    if (/[^a-zA-Z0-9_]/.test(name) || /^[0-9]/.test(name)) return;

    if (editingId) {
      const updated = store.formulas.map(f => f.id === editingId ? { ...f, name, formula, comment: newComment.trim() } : f);
      onUpdate({ formulas: updated });
      setEditingId(null);
    } else {
      if (store.formulas.some(f => f.name === name)) return;
      const newId = `F${String(store.formulas.length + 1).padStart(3, "0")}`;
      const newFormula: FormulaEntry = {
        id: newId, name, formula, comment: newComment.trim() || undefined,
        pinned: false, userCreated: true,
      };
      onUpdate({ formulas: [...store.formulas, newFormula] });
    }
    setNewName(""); setNewValue(""); setNewComment(""); setNewSymbol("custom");
  };

  const deleteFormula = (id: string) => {
    onUpdate({ formulas: store.formulas.filter(f => f.id !== id) });
    if (editingId === id) { setEditingId(null); setNewName(""); setNewValue(""); setNewComment(""); }
  };

  const editFormula = (f: FormulaEntry) => {
    setEditingId(f.id); setNewName(f.name); setNewValue(f.formula); setNewComment(f.comment || ""); setNewSymbol("custom");
  };

  const togglePin = (id: string) => {
    onUpdate({ formulas: store.formulas.map(f => f.id === id ? { ...f, pinned: !f.pinned } : f) });
  };

  const clearHistory = () => onUpdate({ history: [] });

  const handleSymbolChange = (val: string) => {
    setNewSymbol(val);
    if (val !== "custom") setNewName(val);
  };

  const pinned = store.formulas.filter(f => f.pinned);
  const unpinned = store.formulas.filter(f => !f.pinned);

  return (
    <div className="space-y-3">
      {/* LaTeX preview + display + input */}
      <div className="rounded border bg-white p-2 space-y-1">
        <div ref={latexDisplayRef} className="min-h-[32px] text-center text-sm" />
        <div className="text-lg font-mono text-right min-h-[28px] border-t pt-1">{result}</div>
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); calculate(e.shiftKey); }
            if (e.key === "Delete") { e.preventDefault(); setInput(""); setResult("0"); }
          }}
          placeholder="Введите формулу..."
          className="w-full border rounded px-2 py-1 text-sm font-mono"
        />
        <div className="flex gap-1">
          <Button size="sm" className="flex-1 h-7 text-xs border" onClick={() => calculate(false)}>=</Button>
          <Button size="sm" variant="secondary" className="h-7 text-xs border" onClick={() => calculate(true)} title="Shift+Enter">⇉</Button>
          <Button size="sm" variant="outline" className="h-7 text-xs border" onClick={() => { setInput(""); setResult("0"); }}>C</Button>
          <Button size="sm" variant="outline" className="h-7 text-xs border" onClick={() => setInput(input.slice(0, -1))}>←</Button>
          <Button size="sm" variant="outline" className="h-7 text-xs border" onClick={() => {
            if (!input.trim()) return;
            // Save the current input as a new formula, then open the insert dialog.
            const maxFNum = store.formulas.filter(f => f.id.startsWith("F") && /^F\d+$/.test(f.id)).reduce((max, f) => Math.max(max, parseInt(f.id.slice(1), 10)), 0);
            const newId = `F${String(maxFNum + 1).padStart(3, "0")}`;
            const nameMatch = input.match(/^\\?([a-zA-Z][a-zA-Z0-9_]*)\s*=/);
            const name = nameMatch ? nameMatch[1] : `f${store.formulas.length + 1}`;
            onUpdate({ formulas: [...store.formulas, { id: newId, name, formula: input, userCreated: true }] });
            setInput("");
            // Open the insert dialog for the newly created formula.
            // setTimeout ensures the store has been updated before the dialog looks up the formula.
            setTimeout(() => onInsertFormula(newId), 50);
          }} title="Вставить в документ">
            <FunctionSquare className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Keypad — 6 rows × 5 cols */}
      <div className="grid grid-cols-5 gap-1">
        {["sin(","cos(","tan(","sqrt(","abs("].map(b => <CalcKey key={b} label={b} onClick={() => insertAtCursor(b)} variant="func" />)}
        {["asin(","acos(","atan(","log(","^"].map(b => <CalcKey key={b} label={b} onClick={() => insertAtCursor(b)} variant="func" />)}
        {["7","8","9","/","("].map(b => <CalcKey key={b} label={b} onClick={() => insertAtCursor(b)} />)}
        {["4","5","6","*",")"].map(b => <CalcKey key={b} label={b} onClick={() => insertAtCursor(b)} />)}
        {["1","2","3","-","!"].map(b => <CalcKey key={b} label={b} onClick={() => insertAtCursor(b)} />)}
        {["0",".","+","π","e"].map(b => <CalcKey key={b} label={b} onClick={() => insertAtCursor(b === "π" ? "pi" : b)} />)}
      </div>

      {/* Settings */}
      <div className="flex gap-2">
        <Button size="sm" variant={resultFormat === "scientific" ? "secondary" : "outline"} className="h-6 text-[10px] flex-1 border"
          onClick={() => { const fmt = resultFormat === "normal" ? "scientific" : "normal"; setResultFormat(fmt); onUpdate({ settings: { ...store.settings, resultFormat: fmt } }); }}>
          {resultFormat === "normal" ? "Обычный" : "Научный"}
        </Button>
        <Button size="sm" variant={angleUnit === "rad" ? "secondary" : "outline"} className="h-6 text-[10px] flex-1 border"
          onClick={() => { const unit = angleUnit === "deg" ? "rad" : "deg"; setAngleUnit(unit); onUpdate({ settings: { ...store.settings, angleUnit: unit } }); }}>
          {angleUnit === "deg" ? "Градусы" : "Радианы"}
        </Button>
      </div>

      {/* Default display settings for formulas */}
      <DefaultDisplaySettings />

      {/* Formula/Constant manager — unified */}
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted-foreground">
          {editingId ? "Редактирование формулы" : "Новая формула/константа"}
        </div>
        <div className="flex gap-1">
          <Select value={newSymbol} onValueChange={handleSymbolChange}>
            <SelectTrigger className="h-7 w-20 text-xs border"><SelectValue /></SelectTrigger>
            <SelectContent>
              {GREEK_SYMBOLS.map(s => <SelectItem key={s.value} value={s.value} className="text-xs">{s.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Имя (x1)" className="h-7 text-xs flex-1 border" disabled={newSymbol !== "custom"} />
        </div>
        <input
          ref={valueRef}
          type="text"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          placeholder="Формула (b^2 - 4*a*c)"
          className="w-full border rounded h-7 px-2 text-xs font-mono"
        />
        <Input value={newComment} onChange={(e) => setNewComment(e.target.value)} placeholder="Комментарий" className="h-7 text-xs border" />
        <div className="flex gap-1">
          <Button size="sm" className="flex-1 h-7 text-xs border" onClick={addOrEditFormula}>
            {editingId ? "Сохранить" : "Добавить"}
          </Button>
          {editingId && (
            <Button size="sm" variant="outline" className="h-7 text-xs border" onClick={() => { setEditingId(null); setNewName(""); setNewValue(""); setNewComment(""); setNewSymbol("custom"); }}>
              Отмена
            </Button>
          )}
        </div>
      </div>

      {/* Formulas list — unified (constants + document formulas) */}
      <div className="max-h-48 overflow-y-auto space-y-1">
        <div className="text-xs font-medium text-muted-foreground">Формулы и константы:</div>
        {[...pinned, ...unpinned].map(f => (
          <div key={f.id} className={`rounded border p-1.5 text-xs ${f.pinned ? "border-l-4 border-l-primary bg-muted/30" : "bg-muted/20"} ${f.inDocument ? "ring-1 ring-blue-300" : ""}`}>
            <div className="flex items-center justify-between gap-1">
              <button className="font-bold hover:underline cursor-pointer border rounded px-1" onClick={() => insertAtCursor(f.name)}>{f.name}</button>
              <button className="hover:underline cursor-pointer border rounded px-1" onClick={() => insertAtCursor(String(f.value ?? 0))}>= {formatNumber(f.value)}</button>
              <div className="flex gap-0.5">
                {f.inDocument && <Badge variant="outline" className="text-[8px] px-1">док</Badge>}
                <button onClick={() => togglePin(f.id)} className="border rounded p-0.5 hover:bg-muted" title="Закрепить"><Pin className="h-3 w-3" /></button>
                <button onClick={() => editFormula(f)} className="border rounded p-0.5 hover:bg-muted" title="Редактировать"><Edit3 className="h-3 w-3" /></button>
                <button onClick={() => onInsertFormula(f.id)} className="border rounded p-0.5 hover:bg-muted" title="Вставить в документ"><Plus className="h-3 w-3" /></button>
                <button onClick={() => deleteFormula(f.id)} className="border rounded p-0.5 hover:bg-muted text-destructive" title="Удалить"><X className="h-3 w-3" /></button>
              </div>
            </div>
            <button className="font-mono text-[10px] text-muted-foreground hover:underline cursor-pointer border rounded px-1 w-full text-left" onClick={() => insertAtCursor(f.formula)}>
              {f.formula}
            </button>
            {f.comment && <div className="text-[10px] text-muted-foreground italic mt-0.5">{f.comment}</div>}
          </div>
        ))}
      </div>

      {/* History */}
      {store.history.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">История</span>
            <Button size="sm" variant="outline" className="h-5 text-[10px] border" onClick={clearHistory}>Очистить</Button>
          </div>
          <div className="max-h-32 overflow-y-auto space-y-1">
            {store.history.map((h, i) => (
              <div key={i} className="rounded border bg-muted/20 p-1.5 text-xs">
                <button className="font-mono text-muted-foreground hover:underline cursor-pointer border rounded px-1 w-full text-left" onClick={() => insertAtCursor(h.expr)}>
                  {h.expr} =
                </button>
                <div className="flex items-center justify-between mt-1">
                  <button className="font-bold text-green-600 hover:underline cursor-pointer border rounded px-1" onClick={() => insertAtCursor(String(h.raw))}>
                    {h.result}
                  </button>
                  <div className="flex gap-0.5">
                    <button className="border rounded px-1 text-[9px] hover:bg-muted" title="Значение в формулу" onClick={() => { setNewValue(String(h.raw)); valueRef.current?.focus(); }}>V</button>
                    <button className="border rounded px-1 text-[9px] hover:bg-muted" title="Выражение в формулу" onClick={() => { setNewValue(h.expr); valueRef.current?.focus(); }}>F</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CalcKey({ label, onClick, variant }: { label: string; onClick: () => void; variant?: "func" | "op" }) {
  return (
    <button
      onClick={onClick}
      className={`h-7 rounded text-xs font-medium border transition-colors ${
        variant === "func" ? "bg-green-50 hover:bg-green-100 text-green-800 border-green-200" :
        variant === "op" ? "bg-amber-50 hover:bg-amber-100 text-amber-800 border-amber-200" :
        "bg-muted hover:bg-muted/70 border-border"
      }`}
    >
      {label}
    </button>
  );
}

/** Default display settings for newly scanned/inserted formulas. */
function DefaultDisplaySettings() {
  const [showDesignation, setShowDesignation] = useState(true);
  const [showFormula, setShowFormula] = useState(true);
  const [showValue, setShowValue] = useState(true);
  const [showNumber, setShowNumber] = useState(true);
  const [showDescription, setShowDescription] = useState(false);

  // Update the scanner's default settings
  useEffect(() => {
    setDefaultDisplaySettings({ showDesignation, showFormula, showValue, showNumber, showDescription });
  }, [showDesignation, showFormula, showValue, showNumber, showDescription]);

  return (
    <div className="space-y-1.5 border rounded p-2 bg-muted/20">
      <div className="text-[10px] font-medium text-muted-foreground">Настройки формул по умолчанию:</div>
      <div className="flex gap-1">
        <button
          className={`flex-1 h-6 text-[9px] rounded border-2 font-medium transition-all ${
            showDesignation
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-background text-muted-foreground border-input"
          }`}
          onClick={() => setShowDesignation(!showDesignation)}
        >Обозн.</button>
        <button
          className={`flex-1 h-6 text-[9px] rounded border-2 font-medium transition-all ${
            showFormula
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-background text-muted-foreground border-input"
          }`}
          onClick={() => setShowFormula(!showFormula)}
        >Формула</button>
        <button
          className={`flex-1 h-6 text-[9px] rounded border-2 font-medium transition-all ${
            showValue
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-background text-muted-foreground border-input"
          }`}
          onClick={() => setShowValue(!showValue)}
        >Значение</button>
      </div>
      <div className="flex items-center gap-2">
        <label className="text-[9px] flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={showNumber} onChange={(e) => setShowNumber(e.target.checked)} className="h-3 w-3" />
          Номер
        </label>
        <label className="text-[9px] flex items-center gap-1 cursor-pointer">
          <input type="checkbox" checked={showDescription} onChange={(e) => setShowDescription(e.target.checked)} className="h-3 w-3" />
          Описание
        </label>
      </div>
    </div>
  );
}
