"use client";

import dynamic from "next/dynamic";
import { useRef, useState, useCallback } from "react";
import {
  Sparkles,
  Settings as SettingsIcon,
  Database,
  FileUp,
  Loader2,
  Code2,
  Ruler,
  Search,
  ZoomIn,
  ZoomOut,
  Lock,
  Unlock,
  Printer,
  ListOrdered,
  Undo2,
  Save,
  FolderOpen,
  FileText,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEditorStore } from "@/store/editor-store";
import { AgentPanel } from "@/components/agent/AgentPanel";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { ResourcesPanel } from "@/components/resources/ResourcesPanel";
import { AutoFillXmlEditorDialog } from "@/components/resources/AutoFillXmlEditorDialog";
import { TableEditorDialog } from "@/components/table/TableEditorDialog";
import { CanvasEditorDialog } from "@/components/editor/CanvasEditorDialog";
import { SearchPopover } from "@/components/editor/SearchPopover";
import { FormulaInsertDialog } from "@/components/calculator/FormulaInsertDialog";
import { FormulaEditDialog } from "@/components/calculator/FormulaEditDialog";

const SuperDocMount = dynamic(
  () => import("@/components/editor/SuperDocMount").then((m) => m.SuperDocMount),
  { ssr: false, loading: () => <EditorSkeleton /> },
);

export default function Home() {
  const docsInputRef = useRef<HTMLInputElement>(null);
  const docxInputRef = useRef<HTMLInputElement>(null);
  const activePanel = useEditorStore((s) => s.activePanel);
  const setActivePanel = useEditorStore((s) => s.setActivePanel);
  const ready = useEditorStore((s) => s.ready);
  const totalPages = useEditorStore((s) => s.totalPages);
  const blocks = useEditorStore((s) => s.blocks);
  const editorMode = useEditorStore((s) => s.editorMode);
  const setEditorMode = useEditorStore((s) => s.setEditorMode);
  const openCanvasEditor = useEditorStore((s) => s.openCanvasEditor);
  const superdoc = useEditorStore((s) => s.superdoc);
  const locked = useEditorStore((s) => s.locked);
  const setLocked = useEditorStore((s) => s.setLocked);
  const rollbackAi = useEditorStore((s) => s.rollbackAi);
  const preAiSnapshot = useEditorStore((s) => s.preAiSnapshot);
  const printDocument = useEditorStore((s) => s.printDocument);
  const fileName = useEditorStore((s) => s.fileName);
  const dirty = useEditorStore((s) => s.dirty);
  const recentDocs = useEditorStore((s) => s.recentDocs);
  const saveDocs = useEditorStore((s) => s.saveDocs);
  const saveDocsAs = useEditorStore((s) => s.saveDocsAs);
  const openDocsFile = useEditorStore((s) => s.openDocsFile);
  const [tocLocation, setTocLocation] = useState<"start" | "end" | "afterBlock">("start");
  const [printing, setPrinting] = useState(false);

  const toggleRuler = useCallback(() => {
    (superdoc as { toggleRuler?: () => void } | null)?.toggleRuler?.();
  }, [superdoc]);

  const insertToc = useCallback(() => {
    const ed = (superdoc as { activeEditor?: { doc: unknown } } | null)?.activeEditor;
    if (!ed) return;
    try {
      const docApi = (ed as { doc: DocApiForToc }).doc;
      const at = tocLocation === "start" ? { kind: "documentStart" as const } : { kind: "documentEnd" as const };
      docApi.create.tableOfContents({ at });
    } catch (e) { console.error("[toc] failed", e); }
  }, [superdoc, tocLocation]);

  const handlePrint = useCallback(() => {
    setPrinting(true);
    setTimeout(() => { window.print(); setTimeout(() => setPrinting(false), 500); }, 100);
  }, []);

  const handleOpenDocs = () => docsInputRef.current?.click();
  const handleImportDocx = () => docxInputRef.current?.click();

  const handleDocsFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await openDocsFile(file);
    e.target.value = "";
  };
  const handleDocxFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await openDocsFile(file);
    e.target.value = "";
  };

  const panelKey = activePanel as "agent" | "resources" | "settings";
  const docTitle = fileName || "Новый документ";

  return (
    <div className="flex h-screen flex-col bg-background">
      {/* Top bar */}
      <header className={`flex h-14 flex-shrink-0 items-center gap-2 border-b px-3 print:hidden ${printing ? "hidden" : ""}`}>
        {/* D icon with context menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground text-xs font-bold hover:opacity-90" title="Меню">
              D
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem onClick={handleOpenDocs} className="gap-2">
              <FolderOpen className="h-4 w-4" />
              Открыть DOCS документ
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleImportDocx} className="gap-2">
              <FileUp className="h-4 w-4" />
              Импортировать DOCX
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void saveDocs()} className="gap-2" disabled={!ready}>
              <Save className="h-4 w-4" />
              Сохранить
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void saveDocsAs()} className="gap-2" disabled={!ready}>
              <Save className="h-4 w-4" />
              Сохранить как...
            </DropdownMenuItem>
            {recentDocs.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <div className="px-2 py-1 text-xs font-medium text-muted-foreground">Недавние документы</div>
                {recentDocs.map((name) => (
                  <DropdownMenuItem key={name} className="gap-2 text-xs" onClick={() => {
                    // Can't re-open from filename alone (no path in browser) — just show name.
                    console.log("[recent] would open:", name);
                  }}>
                    <FileText className="h-3.5 w-3.5" />
                    {name}
                  </DropdownMenuItem>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Document tabs */}
        <div className="flex items-center gap-1 min-w-0">
          <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-3 py-1 text-xs">
            <span className="truncate max-w-[200px]">{docTitle}</span>
            {dirty && <span className="text-primary">*</span>}
          </div>
          {ready && (
            <div className="flex items-center gap-1.5 ml-1">
              <Badge variant="secondary" className="text-[10px]">{totalPages} стр.</Badge>
              <Badge variant="secondary" className="text-[10px] hidden sm:inline">{blocks.length} блоков</Badge>
            </div>
          )}
        </div>

        {!ready && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            загрузка…
          </span>
        )}

        {/* Right-aligned buttons */}
        <div className="ml-auto flex items-center gap-1">
          <SearchPopover />

          <Separator orientation="vertical" className="h-6 mx-1" />

          {/* Mode toggle: Edit (web) / View (paginated) */}
          <div className="flex items-center gap-1 rounded-md border bg-muted/30 px-1.5 py-0.5">
            <button
              className={`text-[10px] px-2 py-0.5 rounded transition-colors ${editorMode === "edit" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              onClick={() => setEditorMode("edit")}
              disabled={!ready}
              title="Режим редактирования (интерактивные блоки, разрывы страниц пунктиром)"
            >
              Редактирование
            </button>
            <button
              className={`text-[10px] px-2 py-0.5 rounded transition-colors ${editorMode === "view" ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              onClick={() => setEditorMode("view")}
              disabled={!ready}
              title="Режим просмотра (листы с колонтитулами, печать)"
            >
              Просмотр
            </button>
          </div>

          <Separator orientation="vertical" className="h-6 mx-1" />

          {/* Save (floppy disk) */}
          <IconButton icon={Save} title={dirty ? "Сохранить (есть изменения)" : "Сохранить"} onClick={() => void saveDocs()} disabled={!ready} active={dirty} />
          {/* Ruler — only available in view mode */}
          <IconButton icon={Ruler} title={editorMode === "view" ? "Линейки" : "Линейки доступны в режиме просмотра"} onClick={toggleRuler} disabled={!ready || editorMode !== "view"} />
          {/* TOC with popover */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title="Оглавление" disabled={!ready}>
                <ListOrdered className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-3">
              <div className="space-y-2">
                <div className="text-xs font-medium">Вставить оглавление</div>
                <Select value={tocLocation} onValueChange={(v) => setTocLocation(v as "start" | "end" | "afterBlock")}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="start">В начало документа</SelectItem>
                    <SelectItem value="end">В конец документа</SelectItem>
                  </SelectContent>
                </Select>
                <Button size="sm" className="w-full h-8" onClick={insertToc} disabled={!ready}>
                  <ListOrdered className="h-3.5 w-3.5 mr-1.5" />
                  Вставить
                </Button>
              </div>
            </PopoverContent>
          </Popover>
          {/* Lock */}
          <IconButton icon={locked ? Lock : Unlock} title={locked ? "Разблокировать" : "Заблокировать"} onClick={() => setLocked(!locked)} disabled={!ready} active={locked} />
          {/* Rollback AI */}
          <IconButton icon={Undo2} title="Отменить AI-изменения" onClick={() => void rollbackAi()} disabled={!preAiSnapshot} />
          {/* Print */}
          <IconButton icon={Printer} title={editorMode === "view" ? "Печать / PDF" : "Печать доступна в режиме просмотра"} onClick={handlePrint} disabled={!ready || editorMode !== "view"} />
          {/* Import */}
          <IconButton icon={FileUp} title="Импорт DOCX" onClick={handleImportDocx} disabled={!ready} />

          <Separator orientation="vertical" className="h-6 mx-1" />

          {/* Canvas */}
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2" onClick={() => openCanvasEditor(null, "// Canvas visualization\nctx.fillStyle = '#10b981';\nctx.fillRect(20, 20, 200, 120);", "js", "")}>
            <Code2 className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">Canvas</span>
          </Button>
        </div>
      </header>

      {/* Hidden file inputs */}
      <input ref={docsInputRef} type="file" accept=".docs" className="hidden" onChange={handleDocsFile} />
      <input ref={docxInputRef} type="file" accept=".docx" className="hidden" onChange={handleDocxFile} />

      {/* Main split */}
      <div className={`flex flex-1 overflow-hidden ${printing ? "no-sidebar" : ""}`}>
        <main className="flex flex-1 flex-col overflow-hidden print:!flex-1 print:!w-full">
          <SuperDocMount />
        </main>

        <aside className="flex w-[380px] flex-shrink-0 flex-col border-l bg-background print:hidden">
          <Tabs value={panelKey} onValueChange={(v) => setActivePanel(v as "agent" | "resources" | "settings")}>
            <div className="border-b">
              <TabsList className="grid w-full grid-cols-3 rounded-none bg-transparent h-11">
                <TabsTrigger value="agent" className="gap-1.5 text-xs">
                  <Sparkles className="h-3.5 w-3.5" />
                  Агент
                </TabsTrigger>
                <TabsTrigger value="resources" className="gap-1.5 text-xs">
                  <Database className="h-3.5 w-3.5" />
                  Ресурсы
                </TabsTrigger>
                <TabsTrigger value="settings" className="gap-1.5 text-xs">
                  <SettingsIcon className="h-3.5 w-3.5" />
                  Настройки
                </TabsTrigger>
              </TabsList>
            </div>
          </Tabs>
          <div className="flex-1 overflow-hidden">
            {panelKey === "agent" && <AgentPanel />}
            {panelKey === "resources" && <ResourcesPanel />}
            {panelKey === "settings" && <SettingsPanel />}
          </div>
        </aside>
      </div>

      <CanvasEditorDialog />
      <AutoFillXmlEditorDialog />
      <TableEditorDialog />
      <FormulaInsertDialog />
      <FormulaEditDialog />
    </div>
  );
}

interface DocApiForToc {
  create: {
    tableOfContents(input: { at?: { kind: "documentStart" } | { kind: "documentEnd" } }, options?: unknown): { success: boolean };
  };
}

function IconButton({ icon: Icon, title, onClick, disabled, active }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <Button variant={active ? "secondary" : "ghost"} size="sm" className="h-8 w-8 p-0" onClick={onClick} disabled={disabled} title={title}>
      <Icon className="h-3.5 w-3.5" />
    </Button>
  );
}

function EditorSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="h-11 border-b bg-muted/30 animate-pulse" />
      <div className="flex-1 overflow-auto bg-muted/20 p-4 flex justify-center">
        <div className="w-full max-w-[820px] bg-white shadow-lg animate-pulse" style={{ height: 600 }} />
      </div>
    </div>
  );
}
