import React, { useRef, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  Download,
  Edit3,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Play,
  Plus,
  Printer,
  Search,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import {
  AppSettings,
  HistoryEntry,
  LengthUnit,
  PackageSpec,
  Project,
  WeightUnit,
} from '../types/packvol';
import { formatDims, formatVolume, formatWeight } from '../utils/units';
import { t, translateTestName } from '../i18n/translations';
import { PackageFormModal } from './PackageFormModal';
import { Views2D } from './Views2D';
import {
  exportProjectBackupJson,
  exportToCsv,
  exportToExcel,
  exportToPdf,
  parseImportedPackagesFile,
} from '../utils/exporters';
import { runAllVerificationTests, TestCaseResult } from '../engine/testSuite';

/* -------------------------------------------------------------------------- */
/* 1. Saved Projects View                                                     */
/* -------------------------------------------------------------------------- */

interface ProjectsViewProps {
  projects: Project[];
  settings: AppSettings;
  onCreateNew: () => void;
  onOpenProject: (id: string) => void;
  onDuplicateProject: (id: string) => void;
  onRenameProject: (id: string, newName: string) => void;
  onDeleteProject: (id: string) => void;
  onImportBackup: (proj: Project) => void;
}

export const ProjectsView: React.FC<ProjectsViewProps> = ({
  projects,
  settings,
  onCreateNew,
  onOpenProject,
  onDuplicateProject,
  onRenameProject,
  onDeleteProject,
  onImportBackup,
}) => {
  const { language, lengthUnit, weightUnit } = settings;
  const [search, setSearch] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const backupInputRef = useRef<HTMLInputElement>(null);

  const filtered = projects.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.space.name.toLowerCase().includes(search.toLowerCase())
  );

  const handleImportJson = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const txt = await file.text();
      const parsed = JSON.parse(txt) as Project;
      if (parsed && parsed.space && Array.isArray(parsed.packages)) {
        onImportBackup({
          ...parsed,
          id: `proj-${Date.now()}`,
          name: `${parsed.name} (Imported)`,
          updatedAt: Date.now(),
        });
      }
    } catch {
      // ignore invalid json
    } finally {
      e.target.value = '';
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-zinc-900">{t(language, 'projects')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t(language, 'searchPlaceholder')}
              className="pl-8 pr-3 py-1.5 text-xs rounded-md border border-zinc-300 bg-white focus:outline-none focus:border-orange-500"
            />
          </div>
          <button
            onClick={() => backupInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>{t(language, 'importJson')}</span>
          </button>
          <input
            ref={backupInputRef}
            type="file"
            accept=".json"
            onChange={handleImportJson}
            className="hidden"
          />
          <button
            onClick={onCreateNew}
            className="inline-flex items-center gap-1.5 rounded-md bg-orange-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-orange-500 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{t(language, 'newProject')}</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map((proj) => {
          const pkgTotal = proj.packages.reduce((s, p) => s + p.quantity, 0);
          const weightTotal = proj.packages.reduce((s, p) => s + p.weight * p.quantity, 0);
          const projName = language === 'ar' && proj.nameAr ? proj.nameAr : proj.name;
          const spaceName =
            language === 'ar' && proj.space.nameAr ? proj.space.nameAr : proj.space.name;

          return (
            <div
              key={proj.id}
              className="rounded-xl border border-zinc-200 bg-white p-4 flex flex-col justify-between gap-4"
            >
              <div className="space-y-2">
                {renamingId === proj.id ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={renameText}
                      onChange={(e) => setRenameText(e.target.value)}
                      className="flex-1 rounded border border-orange-500 px-2 py-1 text-sm font-semibold"
                    />
                    <button
                      onClick={() => {
                        if (renameText.trim()) onRenameProject(proj.id, renameText.trim());
                        setRenamingId(null);
                      }}
                      className="px-2.5 py-1 rounded bg-zinc-900 text-white text-xs cursor-pointer"
                    >
                      {t(language, 'save')}
                    </button>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-sm font-bold text-zinc-900 line-clamp-2">{projName}</h3>
                    <button
                      onClick={() => {
                        setRenamingId(proj.id);
                        setRenameText(projName);
                      }}
                      title={t(language, 'rename')}
                      className="p-1 text-zinc-400 hover:text-zinc-800 cursor-pointer shrink-0"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                <div className="text-xs text-zinc-500 space-y-1 font-mono tabular-nums">
                  <div>{spaceName}</div>
                  <div>
                    {formatDims(
                      proj.space.internalLength,
                      proj.space.internalWidth,
                      proj.space.internalHeight,
                      lengthUnit
                    )}
                  </div>
                  <div>
                    {pkgTotal} {t(language, 'pkgsShort')} · {formatWeight(weightTotal, weightUnit)}
                    {proj.lastResult ? ` · ${proj.lastResult.volumeUtilizationPct}% ${t(language, 'volShort')}` : ''}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 pt-3 border-t border-zinc-100">
                <button
                  onClick={() => onOpenProject(proj.id)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-800 cursor-pointer"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span>{t(language, 'openWorkspace')}</span>
                </button>

                <div className="flex items-center gap-1">
                  <button
                    onClick={() => exportProjectBackupJson(proj)}
                    title={t(language, 'backupJson')}
                    className="p-1.5 rounded border border-zinc-200 text-zinc-600 hover:bg-zinc-50 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => onDuplicateProject(proj.id)}
                    title={t(language, 'duplicate')}
                    className="p-1.5 rounded border border-zinc-200 text-zinc-600 hover:bg-zinc-50 cursor-pointer"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => onDeleteProject(proj.id)}
                    title={t(language, 'delete')}
                    className="p-1.5 rounded border border-zinc-200 text-red-600 hover:bg-red-50 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* 2. Products Library View                                                   */
/* -------------------------------------------------------------------------- */

interface ProductLibraryViewProps {
  library: PackageSpec[];
  lengthUnit: LengthUnit;
  weightUnit: WeightUnit;
  language: AppSettings['language'];
  onSaveProduct: (prod: PackageSpec) => void;
  onDeleteProduct: (id: string) => void;
  onAddToActiveProject: (prod: PackageSpec) => void;
}

export const ProductLibraryView: React.FC<ProductLibraryViewProps> = ({
  library,
  lengthUnit,
  weightUnit,
  language,
  onSaveProduct,
  onDeleteProduct,
  onAddToActiveProject,
}) => {
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<PackageSpec | null>(null);
  const [showModal, setShowModal] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const filtered = library.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.sku.toLowerCase().includes(search.toLowerCase()) ||
      p.category.toLowerCase().includes(search.toLowerCase())
  );

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = await parseImportedPackagesFile(file);
      parsed.forEach(onSaveProduct);
    } catch {
      // ignore
    } finally {
      e.target.value = '';
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-zinc-900">{t(language, 'library')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-zinc-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t(language, 'searchPlaceholder')}
              className="pl-8 pr-3 py-1.5 text-xs rounded-md border border-zinc-300 bg-white focus:outline-none focus:border-orange-500"
            />
          </div>
          <button
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>{t(language, 'importCsvExcel')}</span>
          </button>
          <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" onChange={handleImport} className="hidden" />
          <button
            onClick={() => {
              setEditing(null);
              setShowModal(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-orange-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-orange-500 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{t(language, 'addPackage')}</span>
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white overflow-x-auto">
        <table className="w-full text-xs text-start">
          <thead className="bg-zinc-50 border-b border-zinc-200 text-zinc-600">
            <tr>
              <th className="py-2.5 px-3 text-start font-semibold">{t(language, 'sku')}</th>
              <th className="py-2.5 px-3 text-start font-semibold">{t(language, 'productName')}</th>
              <th className="py-2.5 px-3 text-start font-semibold">{t(language, 'category')}</th>
              <th className="py-2.5 px-3 text-start font-semibold">{t(language, 'dimensions')}</th>
              <th className="py-2.5 px-3 text-end font-semibold">{t(language, 'weight')}</th>
              <th className="py-2.5 px-3 text-start font-semibold">{t(language, 'rulesCol')}</th>
              <th className="py-2.5 px-3 text-end font-semibold">{t(language, 'actionsCol')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {filtered.map((item) => (
              <tr key={item.id} className="hover:bg-zinc-50">
                <td className="py-2.5 px-3 font-mono text-zinc-700">{item.sku}</td>
                <td className="py-2.5 px-3 font-semibold text-zinc-900">
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-sm me-2 align-middle"
                    style={{ backgroundColor: item.color }}
                  />
                  {language === 'ar' && item.nameAr ? item.nameAr : item.name}
                </td>
                <td className="py-2.5 px-3 text-zinc-600">
                  {language === 'ar' && item.categoryAr ? item.categoryAr : item.category}
                </td>
                <td className="py-2.5 px-3 font-mono tabular-nums text-zinc-600">
                  {formatDims(item.length, item.width, item.height, lengthUnit)}
                </td>
                <td className="py-2.5 px-3 text-end font-mono tabular-nums text-zinc-800">
                  {formatWeight(item.weight, weightUnit)}
                </td>
                <td className="py-2.5 px-3 text-zinc-500">
                  {[
                    item.stackable ? t(language, 'stackLabel') : t(language, 'noStackLabel'),
                    item.rotatable ? t(language, 'rotateLabel') : t(language, 'fixedLabel'),
                    item.fragile ? t(language, 'fragileLabel') : '',
                    item.thisSideUp ? t(language, 'uprightLabel') : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </td>
                <td className="py-2.5 px-3 text-end">
                  <div className="inline-flex items-center gap-1.5">
                    <button
                      onClick={() => onAddToActiveProject(item)}
                      className="px-2.5 py-1 rounded bg-zinc-900 text-white text-[11px] font-semibold hover:bg-zinc-800 cursor-pointer"
                    >
                      {t(language, 'addToProjectBtn')}
                    </button>
                    <button
                      onClick={() => {
                        setEditing(item);
                        setShowModal(true);
                      }}
                      className="p-1 text-zinc-500 hover:text-zinc-900 cursor-pointer"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() =>
                        onSaveProduct({
                          ...item,
                          id: `prod-${Date.now()}`,
                          sku: `${item.sku}-COPY`,
                        })
                      }
                      className="p-1 text-zinc-500 hover:text-zinc-900 cursor-pointer"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => onDeleteProduct(item.id)}
                      className="p-1 text-red-500 hover:text-red-700 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <PackageFormModal
          initial={editing}
          lengthUnit={lengthUnit}
          weightUnit={weightUnit}
          language={language}
          onSave={(spec) => {
            onSaveProduct(spec);
            setShowModal(false);
            setEditing(null);
          }}
          onClose={() => {
            setShowModal(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* 3. Loading History View                                                    */
/* -------------------------------------------------------------------------- */

interface HistoryViewProps {
  history: HistoryEntry[];
  weightUnit: WeightUnit;
  language: AppSettings['language'];
  onOpenProject: (projectId: string) => void;
  onClearHistory: () => void;
}

export const HistoryView: React.FC<HistoryViewProps> = ({
  history,
  weightUnit,
  language,
  onOpenProject,
  onClearHistory,
}) => {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-zinc-900">{t(language, 'history')}</h1>
        {history.length > 0 && (
          <button
            onClick={onClearHistory}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 cursor-pointer"
          >
            {t(language, 'clearHistory')}
          </button>
        )}
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white overflow-x-auto">
        {history.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-500">
            {t(language, 'noHistory')}
          </div>
        ) : (
          <table className="w-full text-xs text-start">
            <thead className="bg-zinc-50 border-b border-zinc-200 text-zinc-600">
              <tr>
                <th className="py-2.5 px-3 text-start font-semibold">{t(language, 'dateTimeCol')}</th>
                <th className="py-2.5 px-3 text-start font-semibold">{t(language, 'projectCol')}</th>
                <th className="py-2.5 px-3 text-start font-semibold">{t(language, 'spaceCol')}</th>
                <th className="py-2.5 px-3 text-start font-semibold">{t(language, 'modeCol')}</th>
                <th className="py-2.5 px-3 text-end font-semibold">{t(language, 'loadedCol')}</th>
                <th className="py-2.5 px-3 text-end font-semibold">{t(language, 'volCol')}</th>
                <th className="py-2.5 px-3 text-end font-semibold">{t(language, 'weightCol')}</th>
                <th className="py-2.5 px-3 text-end font-semibold">{t(language, 'physicsCol')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {history.map((h) => (
                <tr key={h.id} className="hover:bg-zinc-50">
                  <td className="py-2.5 px-3 font-mono text-zinc-500">
                    {new Date(h.timestamp).toLocaleString(language === 'ar' ? 'ar-EG' : undefined)}
                  </td>
                  <td className="py-2.5 px-3 font-semibold">
                    <button
                      onClick={() => onOpenProject(h.projectId)}
                      className="text-zinc-900 hover:text-orange-600 cursor-pointer text-start"
                    >
                      {h.projectName}
                    </button>
                  </td>
                  <td className="py-2.5 px-3 text-zinc-600">{h.spaceName}</td>
                  <td className="py-2.5 px-3 font-mono text-zinc-600">{h.mode}</td>
                  <td className="py-2.5 px-3 text-end font-mono tabular-nums">
                    {h.loadedCount}/{h.totalCount}
                  </td>
                  <td className="py-2.5 px-3 text-end font-mono tabular-nums text-orange-600 font-semibold">
                    {h.volumeUtilizationPct}%
                  </td>
                  <td className="py-2.5 px-3 text-end font-mono tabular-nums">
                    {formatWeight(h.totalWeightKg, weightUnit)}
                  </td>
                  <td className="py-2.5 px-3 text-end font-mono">
                    <span className={h.isValid ? 'text-emerald-700' : 'text-red-600'}>
                      {h.isValid ? t(language, 'passLabel') : t(language, 'failLabel')}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* 4. Reports & 2D Blueprints View                                            */
/* -------------------------------------------------------------------------- */

interface ReportsViewProps {
  project: Project;
  settings: AppSettings;
  onGoToWorkspace: () => void;
}

export const ReportsView: React.FC<ReportsViewProps> = ({
  project,
  settings,
  onGoToWorkspace,
}) => {
  const { language, lengthUnit, weightUnit } = settings;
  const result = project.lastResult;

  if (!result) {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-10 text-center space-y-3">
        <h2 className="text-base font-bold text-zinc-900">{t(language, 'reports')}</h2>
        <p className="text-sm text-zinc-500 max-w-md mx-auto">{t(language, 'noResultsYet')}</p>
        <button
          onClick={onGoToWorkspace}
          className="rounded-lg bg-orange-600 px-4 py-2 text-xs font-semibold text-white hover:bg-orange-500 cursor-pointer"
        >
          {t(language, 'openWorkspace')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 no-print">
        <div>
          <h1 className="text-xl font-bold text-zinc-900">{t(language, 'reports')}</h1>
          <p className="text-xs text-zinc-500">
            {language === 'ar' && project.nameAr ? project.nameAr : project.name} ·{' '}
            {language === 'ar' && project.space.nameAr ? project.space.nameAr : project.space.name}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => exportToPdf(project, result, lengthUnit, weightUnit)}
            className="inline-flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-2 text-xs font-semibold text-white hover:bg-zinc-800 cursor-pointer"
          >
            <FileText className="w-3.5 h-3.5" />
            <span>{t(language, 'exportPdf')}</span>
          </button>
          <button
            onClick={() => exportToExcel(project, result, lengthUnit, weightUnit)}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 cursor-pointer"
          >
            <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
            <span>{t(language, 'exportExcel')}</span>
          </button>
          <button
            onClick={() => exportToCsv(project, result, lengthUnit, weightUnit)}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{t(language, 'exportCsv')}</span>
          </button>
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 cursor-pointer"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>{t(language, 'printViews')}</span>
          </button>
        </div>
      </div>

      {/* Executive Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="text-xs text-zinc-500">{t(language, 'volumeUtil')}</div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-orange-600">
            {result.volumeUtilizationPct}%
          </div>
          <div className="text-[11px] font-mono text-zinc-500">
            {formatVolume(result.occupiedVolumeMm3, lengthUnit)}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="text-xs text-zinc-500">{t(language, 'weightUtil')}</div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-zinc-900">
            {result.weightUtilizationPct}%
          </div>
          <div className="text-[11px] font-mono text-zinc-500">
            {formatWeight(result.totalCargoWeightKg, weightUnit)}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="text-xs text-zinc-500">{t(language, 'loadedPackages')}</div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-zinc-900">
            {result.loadedPackagesCount}/{result.totalRequiredPackages}
          </div>
          <div className="text-[11px] font-mono text-zinc-500">
            {result.containersUsed} {t(language, 'spaceUnit')}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="text-xs text-zinc-500">{t(language, 'balanceScore')}</div>
          <div className="mt-1 text-2xl font-bold font-mono tabular-nums text-zinc-900">
            {result.balanceScore}/100
          </div>
          <div className="text-[11px] font-mono text-zinc-500">
            {result.verification.isValid
              ? t(language, 'verifiedValidShort')
              : t(language, 'checkFailedShort')}
          </div>
        </div>
      </div>

      <Views2D
        space={project.space}
        result={result}
        lengthUnit={lengthUnit}
        language={language}
        containerIndex={0}
      />
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* 5. Settings & 13-Scenario Physics Verification Lab                         */
/* -------------------------------------------------------------------------- */

interface SettingsViewProps {
  settings: AppSettings;
  onUpdateSettings: (next: AppSettings) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ settings, onUpdateSettings }) => {
  const { language } = settings;
  const [testResults, setTestResults] = useState<TestCaseResult[] | null>(null);

  const handleRunTests = () => {
    const res = runAllVerificationTests();
    setTestResults(res);
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <h1 className="text-xl font-bold text-zinc-900">{t(language, 'settings')}</h1>

      <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-semibold text-zinc-700 mb-1.5">
              {t(language, 'languageLabel')}
            </label>
            <select
              value={settings.language}
              onChange={(e) =>
                onUpdateSettings({ ...settings, language: e.target.value as 'en' | 'ar' })
              }
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm"
            >
              <option value="en">English (LTR)</option>
              <option value="ar">العربية (RTL)</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-zinc-700 mb-1.5">
              {t(language, 'lengthUnitLabel')}
            </label>
            <select
              value={settings.lengthUnit}
              onChange={(e) =>
                onUpdateSettings({ ...settings, lengthUnit: e.target.value as LengthUnit })
              }
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-mono"
            >
              <option value="mm">{language === 'ar' ? 'ملليمتر (mm)' : 'Millimeters (mm)'}</option>
              <option value="cm">{language === 'ar' ? 'سنتيمتر (cm)' : 'Centimeters (cm)'}</option>
              <option value="m">{language === 'ar' ? 'متر (m)' : 'Meters (m)'}</option>
              <option value="in">{language === 'ar' ? 'بوصة (in)' : 'Inches (in)'}</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-zinc-700 mb-1.5">
              {t(language, 'weightUnitLabel')}
            </label>
            <select
              value={settings.weightUnit}
              onChange={(e) =>
                onUpdateSettings({ ...settings, weightUnit: e.target.value as WeightUnit })
              }
              className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-mono"
            >
              <option value="kg">{language === 'ar' ? 'كيلوجرام (kg)' : 'Kilograms (kg)'}</option>
              <option value="lb">{language === 'ar' ? 'رطل (lb)' : 'Pounds (lb)'}</option>
            </select>
          </div>
        </div>

        <label className="flex items-center justify-between pt-3 border-t border-zinc-100 cursor-pointer">
          <div>
            <div className="text-sm font-semibold text-zinc-900">{t(language, 'lowPerfLabel')}</div>
            <div className="text-xs text-zinc-500">{t(language, 'lowPerfDesc')}</div>
          </div>
          <input
            type="checkbox"
            checked={settings.lowPerfMode}
            onChange={(e) => onUpdateSettings({ ...settings, lowPerfMode: e.target.checked })}
            className="accent-orange-600 w-4 h-4"
          />
        </label>
      </div>

      {/* 13-Scenario Physics & Algorithm Verification Suite */}
      <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold text-zinc-900">
              {t(language, 'testsSuiteTitle')}
            </h2>
            <p className="text-xs text-zinc-500">
              {t(language, 'testsSuiteDesc')}
            </p>
          </div>
          <button
            onClick={handleRunTests}
            className="inline-flex items-center gap-2 rounded-lg bg-zinc-900 px-4 py-2 text-xs font-semibold text-white hover:bg-zinc-800 cursor-pointer shrink-0"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>{t(language, 'runTests')}</span>
          </button>
        </div>

        {testResults && (
          <div className="space-y-2">
            <div className="text-xs font-mono font-bold text-emerald-700">
              {t(language, 'passedScenarios')}: {testResults.filter((r) => r.passed).length} /{' '}
              {testResults.length} {t(language, 'scenariosLabel')}
            </div>
            <div className="divide-y divide-zinc-100 border border-zinc-200 rounded-lg overflow-hidden">
              {testResults.map((tc) => (
                <div key={tc.id} className="px-3 py-2 flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2.5 min-w-0">
                    {tc.passed ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    ) : (
                      <XCircle className="w-4 h-4 text-red-600 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="font-semibold text-zinc-900">
                        {tc.id}. {translateTestName(language, tc.id, tc.name)}
                      </div>
                      <div className="text-[11px] text-zinc-500 font-mono">{tc.details}</div>
                    </div>
                  </div>
                  <span className="font-mono text-[11px] text-zinc-400 shrink-0">
                    {tc.durationMs} ms
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
