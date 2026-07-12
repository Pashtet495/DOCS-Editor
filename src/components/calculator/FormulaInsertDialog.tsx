"use client";

import { useState, useEffect, useRef } from "react";
import { FunctionSquare, Eye, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useEditorStore } from "@/store/editor-store";
import { renderFormula } from "@/lib/editor/formula-renderer";

export function FormulaInsertDialog() {
  const dialog = useEditorStore((s) => s.formulaInsertDialog);
  const closeFormulaInsertDialog = useEditorStore((s) => s.closeFormulaInsertDialog);
  const insertFormulaImage = useEditorStore((s) => s.insertFormulaImage);
  const formulaStore = useEditorStore((s) => s.formulaStore);

  const [showDesignation, setShowDesignation] = useState(true);
  const [showFormula, setShowFormula] = useState(true);
  const [showValue, setShowValue] = useState(true);
  const [showNumber, setShowNumber] = useState(true);
  const [manualNumber, setManualNumber] = useState<string>("");
  const [useManualNumber, setUseManualNumber] = useState(false);
  const [showDescription, setShowDescription] = useState(false);
  const [descriptionText, setDescriptionText] = useState("");
  const [previewDataUrl, setPreviewDataUrl] = useState<string>("");
  const [previewSize, setPreviewSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [inserting, setInserting] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);

  const formula = dialog ? formulaStore?.formulas.find((f) => f.id === dialog.formulaId) : null;

  // Compute the equation number — either manual or auto
  const autoNumber = formulaStore
    ? formulaStore.formulas.filter((f) => f.inDocument).length + 1
    : 1;
  const equationNumber = useManualNumber
    ? parseInt(manualNumber, 10) || autoNumber
    : autoNumber;

  // Check if the equation number is already used by another formula
  const numberAlreadyUsed = formulaStore
    ? formulaStore.formulas.some(
        (f) => f.inDocument && f.id !== dialog?.formulaId && f.number === equationNumber,
      )
    : false;

  // Render preview using the SAME canvas renderer as the final output.
  useEffect(() => {
    if (!dialog || !formula) return;
    let cancelled = false;
    const doRender = async () => {
      try {
        const { dataUrl, width, height } = await renderFormula({
          latex: formula.formula,
          designation: formula.name,
          value: formula.value,
          showDesignation,
          showFormula,
          showValue,
          showNumber,
          equationNumber,
          showDescription,
          descriptionText: descriptionText || undefined,
          formulaStore,
          formula,
        });
        if (!cancelled) {
          setPreviewDataUrl(dataUrl);
          setPreviewSize({ w: width, h: height });
        }
      } catch (e) {
        console.error("[FormulaInsertDialog] preview render failed", e);
        if (!cancelled) setPreviewDataUrl("");
      }
    };
    doRender();
    return () => { cancelled = true; };
  }, [dialog, formula, showDesignation, showFormula, showValue, showNumber, equationNumber, showDescription, descriptionText, formulaStore]);

  if (!dialog || !formula) return null;

  const handleInsert = async () => {
    setInserting(true);
    try {
      await insertFormulaImage({
        formulaId: dialog.formulaId,
        showDesignation,
        showFormula,
        showValue,
        showNumber,
        showDescription,
        descriptionText: descriptionText || undefined,
        equationNumber: useManualNumber ? equationNumber : undefined,
      });
    } finally {
      setInserting(false);
    }
  };

  return (
    <Dialog open={!!dialog} onOpenChange={(o) => !o && closeFormulaInsertDialog()}>
      <DialogContent
        className="max-w-5xl"
        style={{ zIndex: 100, width: "1000px", maxWidth: "95vw" }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FunctionSquare className="h-5 w-5" />
            Вставка формулы: {formula.name}
            <Badge variant="outline" className="text-xs font-mono">{formula.id}</Badge>
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 overflow-hidden" style={{ gridTemplateColumns: "minmax(0, 1fr) 380px" }}>
          {/* Preview — 1:1 scale, scrollable */}
          <div className="space-y-2 min-w-0 overflow-hidden">
            <Label className="text-xs flex items-center gap-1">
              <Eye className="h-3 w-3" />Предпросмотр (1:1)
            </Label>
            <div
              ref={previewRef}
              className="rounded-lg border-2 bg-white p-0 overflow-auto"
              style={{ maxHeight: "500px" }}
            >
              {previewDataUrl ? (
                <img
                  src={previewDataUrl}
                  alt="Предпросмотр формулы"
                  style={{ display: "block", height: "auto" }}
                />
              ) : (
                <div className="flex items-center justify-center min-h-[120px]">
                  <span className="text-sm text-muted-foreground">Загрузка...</span>
                </div>
              )}
            </div>
          </div>

          {/* Options */}
          <div className="space-y-3 overflow-hidden">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Что отображать</Label>
              <div className="flex gap-1">
                <button
                  className={`flex-1 min-w-0 h-8 text-[11px] rounded border-2 font-medium transition-all ${
                    showDesignation
                      ? "bg-primary text-primary-foreground border-primary shadow-sm"
                      : "bg-background text-muted-foreground border-input hover:border-primary/50"
                  }`}
                  onClick={() => setShowDesignation(!showDesignation)}
                >
                  Обозначение
                </button>
                <button
                  className={`flex-1 min-w-0 h-8 text-[11px] rounded border-2 font-medium transition-all ${
                    showFormula
                      ? "bg-primary text-primary-foreground border-primary shadow-sm"
                      : "bg-background text-muted-foreground border-input hover:border-primary/50"
                  }`}
                  onClick={() => setShowFormula(!showFormula)}
                >
                  Формула
                </button>
                <button
                  className={`flex-1 min-w-0 h-8 text-[11px] rounded border-2 font-medium transition-all ${
                    showValue
                      ? "bg-primary text-primary-foreground border-primary shadow-sm"
                      : "bg-background text-muted-foreground border-input hover:border-primary/50"
                  }`}
                  onClick={() => setShowValue(!showValue)}
                >
                  Значение
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <Label className="text-xs">Номер формулы справа</Label>
              <Switch checked={showNumber} onCheckedChange={setShowNumber} />
            </div>

            {showNumber && (
              <div className="space-y-2 border rounded p-2 bg-muted/20">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Номер вручную</Label>
                  <Switch checked={useManualNumber} onCheckedChange={setUseManualNumber} />
                </div>
                {useManualNumber && (
                  <div className="space-y-1.5">
                    <Input
                      type="number"
                      value={manualNumber}
                      onChange={(e) => setManualNumber(e.target.value)}
                      placeholder={`Авто: ${autoNumber}`}
                      className="text-sm"
                      min={1}
                    />
                    {numberAlreadyUsed && (
                      <div className="flex items-center gap-1.5 text-xs text-destructive">
                        <AlertTriangle className="h-3 w-3" />
                        Номер {equationNumber} уже используется другой формулой
                      </div>
                    )}
                    <p className="text-[10px] text-muted-foreground">
                      Текущий номер: ({equationNumber})
                    </p>
                  </div>
                )}
                {!useManualNumber && (
                  <p className="text-[10px] text-muted-foreground">
                    Автоматический номер: ({autoNumber})
                  </p>
                )}
              </div>
            )}

            <div className="flex items-center justify-between">
              <Label className="text-xs">Описание переменных</Label>
              <Switch checked={showDescription} onCheckedChange={setShowDescription} />
            </div>
            {showDescription && (
              <div className="space-y-1.5">
                <Label className="text-xs">Дополнительный текст</Label>
                <Input
                  value={descriptionText}
                  onChange={(e) => setDescriptionText(e.target.value)}
                  placeholder="Доп. описание..."
                  className="text-sm"
                />
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={closeFormulaInsertDialog}>
            Отмена
          </Button>
          <Button
            onClick={handleInsert}
            className="gap-1.5"
            disabled={numberAlreadyUsed || inserting}
            title={numberAlreadyUsed ? "Номер уже используется" : ""}
          >
            {inserting ? "Вставка..." : "Вставить в документ"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
