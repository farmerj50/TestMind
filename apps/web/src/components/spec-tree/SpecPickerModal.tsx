import { useEffect } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

type SuiteOption = { id: string; name: string };

type SpecPickerModalProps = {
  open: boolean;
  mode: "copy" | "move";
  specPath: string | null;
  suites: SuiteOption[];
  suiteId: string;
  onSuiteChange: (id: string) => void;
  folderOptions: string[];
  folderValue: string;
  onFolderChange: (value: string) => void;
  newFolderValue: string;
  onNewFolderChange: (value: string) => void;
  newNameValue: string;
  onNewNameChange: (value: string) => void;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

const NEW_FOLDER_VALUE = "__new_folder__";

export default function SpecPickerModal({
  open,
  mode,
  specPath,
  suites,
  suiteId,
  onSuiteChange,
  folderOptions,
  folderValue,
  onFolderChange,
  newFolderValue,
  onNewFolderChange,
  newNameValue,
  onNewNameChange,
  busy,
  onCancel,
  onConfirm,
}: SpecPickerModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const folderSelectValue = folderValue || "";
  const folderOptionsWithNew = [...folderOptions];
  if (!folderOptionsWithNew.includes(NEW_FOLDER_VALUE)) {
    folderOptionsWithNew.push(NEW_FOLDER_VALUE);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
      <div className="w-full max-w-lg rounded-lg bg-white shadow-xl">
        <div className="border-b px-4 py-3">
          <div className="text-sm font-semibold text-slate-900">
            {mode === "copy" ? "Copy spec" : "Move spec"}
          </div>
          {specPath && <div className="text-xs text-slate-500">{specPath}</div>}
        </div>
        <div className="space-y-4 px-4 py-4">
          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-600">Target suite</label>
            <Select value={suiteId} onValueChange={onSuiteChange}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select suite" />
              </SelectTrigger>
              <SelectContent>
                {suites.map((suite) => (
                  <SelectItem key={suite.id} value={suite.id}>
                    {suite.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-slate-600">Folder (optional)</label>
            <Select value={folderSelectValue} onValueChange={onFolderChange}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="No folder" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">No folder</SelectItem>
                {folderOptions.map((folder) => (
                  <SelectItem key={folder} value={folder}>
                    {folder}
                  </SelectItem>
                ))}
                <SelectItem value={NEW_FOLDER_VALUE}>+ New folder</SelectItem>
              </SelectContent>
            </Select>
            {folderSelectValue === NEW_FOLDER_VALUE && (
              <Input
                value={newFolderValue}
                onChange={(e) => onNewFolderChange(e.target.value)}
                placeholder="Folder name (e.g. regression)"
              />
            )}
          </div>

          {mode === "copy" && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-slate-600">New name (optional)</label>
              <Input
                value={newNameValue}
                onChange={(e) => onNewNameChange(e.target.value)}
                placeholder="Keep original name"
              />
              <p className="text-[11px] text-slate-500">Name is a UI label in this view.</p>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={busy || !suiteId}>
            {busy ? "Working..." : mode === "copy" ? "Copy spec" : "Move spec"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export { NEW_FOLDER_VALUE };
