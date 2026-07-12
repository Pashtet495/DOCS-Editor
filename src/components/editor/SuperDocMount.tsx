"use client";

import { useEffect, useRef, useState } from "react";
import { useEditorStore } from "@/store/editor-store";
import { createSuperDocBridge } from "@/lib/editor/superdoc-bridge";
import { loadMath } from "@/lib/editor/math-loader";

export function SuperDocMount() {
  const hostRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const setSuperdoc = useEditorStore((s) => s.setSuperdoc);
  const setBridge = useEditorStore((s) => s.setBridge);
  const onBlocksUpdated = useEditorStore((s) => s.onBlocksUpdated);
  const setTotalPages = useEditorStore((s) => s.setTotalPages);
  const setReady = useEditorStore((s) => s.setReady);
  const user = useEditorStore((s) => s.user);
  const formulaStore = useEditorStore((s) => s.formulaStore);
  const editorMode = useEditorStore((s) => s.editorMode);
  const mountedModeRef = useRef<"edit" | "view" | null>(null);

  // Initial mount only — mode switching is handled by editor-store.setEditorMode()
  useEffect(() => {
    // Preload math.js for formula evaluation and LaTeX conversion
    loadMath().catch((e) => console.warn("[SuperDocMount] math.js load failed", e));

    if (!hostRef.current || !toolbarRef.current) return;
    let destroyed = false;
    const bridge = createSuperDocBridge();
    bridge.setCallbacks({
      onReady: (superdoc) => {
        if (destroyed) return;
        setSuperdoc(superdoc);
        setReady(true);
      },
      onUpdate: (b) => !destroyed && onBlocksUpdated(b),
      onPagination: (n) => { if (!destroyed) setTotalPages(n); },
      onError: (e) => console.error("[superdoc]", e),
    });
    setBridge(bridge);
    bridge.mount(hostRef.current, toolbarRef.current, null, user, editorMode).catch((e) => {
      console.error("[superdoc mount failed]", e);
    });
    return () => {
      destroyed = true;
      bridge.destroy();
      setBridge(null);
      setSuperdoc(null);
      setReady(false);
    };
  }, []);

  // Register the formula store with the bridge
  const bridge = useEditorStore((s) => s.bridge);
  useEffect(() => {
    if (bridge && formulaStore) bridge.registerFormulaStore(formulaStore);
  }, [bridge, formulaStore]);

  // Listen for formula-edit events from formulaBlock NodeViews (edit button click)
  const openFormulaEditDialog = useEditorStore((s) => s.openFormulaEditDialog);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handleFormulaEdit = (e: Event) => {
      const detail = (e as CustomEvent).detail as { formulaId: string };
      if (detail?.formulaId) {
        openFormulaEditDialog(detail.formulaId);
      }
    };
    host.addEventListener("formula-edit", handleFormulaEdit);
    return () => host.removeEventListener("formula-edit", handleFormulaEdit);
  }, [openFormulaEditDialog]);

  return (
    <div className="flex h-full w-full flex-col">
      <div
        ref={toolbarRef}
        className="superdoc-toolbar-host border-b bg-background min-h-[52px] flex-shrink-0"
      />
      <div className="superdoc-scroll flex-1 overflow-auto flex justify-center">
        <div
          ref={hostRef}
          className="superdoc-host"
          style={{ width: "100%", maxWidth: "860px", minHeight: "100%" }}
        />
        <ZoomControls />
      </div>
    </div>
  );
}

function ZoomControls() {
  const superdoc = useEditorStore((s) => s.superdoc);
  const [zoom, setZoom] = useState(100);
  const changeZoom = (delta: number) => {
    const next = Math.max(25, Math.min(400, zoom + delta));
    setZoom(next);
    (superdoc as { setZoom?: (pct: number) => void } | null)?.setZoom?.(next);
  };
  return (
    <div className="zoom-controls flex items-center gap-1 bg-background/90 backdrop-blur rounded-md border px-1.5 py-1 shadow-md">
      <button className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground" onClick={() => changeZoom(-10)} title="Уменьшить">
        <span className="text-sm">−</span>
      </button>
      <span className="text-xs text-muted-foreground w-10 text-center tabular-nums">{zoom}%</span>
      <button className="h-7 w-7 flex items-center justify-center rounded hover:bg-muted text-muted-foreground" onClick={() => changeZoom(10)} title="Увеличить">
        <span className="text-sm">+</span>
      </button>
    </div>
  );
}
