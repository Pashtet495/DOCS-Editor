"use client";

import { useState, useEffect } from "react";
import { FunctionSquare, Eye, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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

export function FormulaEditDialog() {
  const dialog = useEditorStore((s) => s.formulaEditDialog);
  const closeDialog = useEditorStore((s) => s.closeFormulaEditDialog);
  const updateExistingFormulaBlock = useEditorStore((s) => s.updateExistingFormulaBlock);
  const formulaStore = useEditorStore((s) => s.formulaStore);

  const [showDesignation, setShowDesignation] = useState(true);
  const [showFormula, setShowFormula] = useState(true);
  const [showValue, setShowValue] = useState(true);
  const [showNumber, setShowNumber] = useState(true);
  const [showDescription, setShowDescription] = useState(false);
  const [descriptionText, setDescriptionText] = useState("");
  const [previewDataUrl, setPreviewDataUrl] = useState<string>("");

  const formula = dialog ? formulaStore?.formulas.find((f) => f.id === dialog.formulaId) : null;

  // Load current settings from the existing formulaBlock when dialog opens
  useEffect(() => {
    if (!dialog || !formula) return;
    const sd = useEditorStore.getState().superdoc as {
      activeEditor?: {
        view?: {
          state: {
            doc: {
              descendants: (cb: (node: { type: { name: string }; attrs: Record<string, unknown> }, pos: number) => boolean | void) => void;
            };
          };
        };
      };
    } | null;
    const ed = sd?.activeEditor;
    if (ed?.view) {
      ed.view.state.doc.descendants((node) => {
        if (node.type.name === "formulaBlock" && node.attrs.formulaId === dialog.formulaId) {
          setShowDesignation(node.attrs.showDesignation !== false);
          setShowFormula(node.attrs.showFormula !== false);
          setShowValue(node.attrs.showValue !== false);
          setShowNumber(node.attrs.showNumber !== false);
          setShowDescription(node.attrs.showDescription === true);
          setDescriptionText((node.attrs.descriptionText as string) || "");
          return false;
        }
      });
    }
  }, [dialog, formula]);

  // Render preview
  useEffect(() => {
    if (!dialog || !formula) return;
    let cancelled = false;
    const doRender = async () => {
      try {
        const { dataUrl } = await renderFormula({
          latex: formula.formula,
          designation: formula.name,
          value: formula.value,
          showDesignation,
          showFormula,
          showValue,
          showNumber,
          showDescription,
          descriptionText: descriptionText || undefined,
          formulaStore,
          formula,
        });
        if (!cancelled) setPreviewDataUrl(dataUrl || "");
      } catch (e) {
        console.error("[FormulaEditDialog] preview render failed", e);
      }
    };
    doRender();
    return () => { cancelled = true; };
  }, [dialog, formula, showDesignation, showFormula, showValue, showNumber, showDescription, descriptionText, formulaStore]);

  if (!dialog || !formula) return null;

  const handleApply = () => {
    updateExistingFormulaBlock({
      formulaId: dialog.formulaId,
      showDesignation,
      showFormula,
      showValue,
      showNumber,
      showDescription,
      descriptionText: descriptionText || undefined,
    });
  };

  return (
    <Dialog open={!!dialog} onOpenChange={(o) => !o && closeDialog()}>
      <DialogContent className="max-w-5xl" style={{ zIndex: 100, width: "1000px", maxWidth: "95vw" }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FunctionSquare className="h-5 w-5" />
            Редактирование формулы: {formula.name}
            <Badge variant="outline" className="text-xs font-mono">{formula.id}</Badge>
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 overflow-hidden" style={{ gridTemplateColumns: "minmax(0, 1fr) 380px" }}>
          <div className="space-y-2 min-w-0 overflow-hidden">
            <Label className="text-xs flex items-center gap-1">
              <Eye className="h-3 w-3" />Предпросмотр (1:1)
            </Label>
            <div className="rounded-lg border-2 bg-white p-0 overflow-auto" style={{ maxHeight: "500px" }}>
              {previewDataUrl ? (
                <img src={previewDataUrl} alt="Предпросмотр" style={{ display: "block", height: "auto" }} />
              ) : (
                <div className="flex items-center justify-center min-h-[120px]">
                  <span className="text-sm text-muted-foreground">Загрузка...</span>
                </div>
              )}
            </div>
          </div>
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
              <Label className="text-xs">Номер формулы</Label>
              <Switch checked={showNumber} onCheckedChange={setShowNumber} />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-xs">Описание переменных</Label>
              <Switch checked={showDescription} onCheckedChange={setShowDescription} />
            </div>
            {showDescription && (
              <div className="space-y-1.5">
                <Label className="text-xs">Дополнительный текст</Label>
                <Input value={descriptionText} onChange={(e) => setDescriptionText(e.target.value)} placeholder="Доп. описание..." className="text-sm" />
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={closeDialog}>Отмена</Button>
          <Button onClick={handleApply} className="gap-1.5">
            <Check className="h-4 w-4" />Применить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
