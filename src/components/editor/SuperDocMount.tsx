"use client";

import { useEffect, useRef, useState } from "react";
import { useEditorStore } from "@/store/editor-store";
import { createSuperDocBridge, type SuperDocBridge } from "@/lib/editor/superdoc-bridge";

export function SuperDocMount() {
  const hostRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const setSuperdoc = useEditorStore((s) => s.setSuperdoc);
  const setBridge = useEditorStore((s) => s.setBridge);
  const onBlocksUpdated = useEditorStore((s) => s.onBlocksUpdated);
  const setTotalPages = useEditorStore((s) => s.setTotalPages);
  const setReady = useEditorStore((s) => s.setReady);
  const user = useEditorStore((s) => s.user);

  useEffect(() => {
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
      onPagination: (n) => !destroyed && setTotalPages(n),
      onError: (e) => console.error("[superdoc]", e),
    });
    setBridge(bridge);
    bridge.mount(hostRef.current, toolbarRef.current, null, user).catch((e) => {
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
