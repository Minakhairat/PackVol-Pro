import { useEffect, useRef, useState } from 'react';
import {
  BarChart3,
  Box,
  FolderKanban,
  History,
  LayoutDashboard,
  Menu,
  Package,
  Phone,
  Settings as SettingsIcon,
  Globe,
  X,
} from 'lucide-react';
import {
  AppSettings,
  HistoryEntry,
  LengthUnit,
  PackageSpec,
  Project,
  SpaceCategory,
} from './types/packvol';
import {
  addHistoryEntryToDb,
  clearHistoryFromDb,
  DEFAULT_SETTINGS,
  deleteLibraryProductFromDb,
  deleteProjectFromDb,
  initializeStorage,
  replaceAllProjectsInDb,
  saveLibraryProductToDb,
  saveManyProjectsToDb,
  saveProjectToDb,
  saveSettingsToDb,
} from './db/storage';
import { SPACE_TEMPLATES } from './data/presets';
import { runOptimization } from './engine/packer';
import { t } from './i18n/translations';
import { DashboardView } from './components/DashboardView';
import { WorkspaceView } from './components/WorkspaceView';
import {
  HistoryView,
  ProductLibraryView,
  ProjectsView,
  ReportsView,
  SettingsView,
} from './components/ProjectsAndLibraryViews';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';

type NavTab =
  | 'dashboard'
  | 'workspace'
  | 'projects'
  | 'library'
  | 'history'
  | 'reports'
  | 'settings';

export default function App() {
  const [ready, setReady] = useState(false);
  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [library, setLibrary] = useState<PackageSpec[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<{
    type: 'project' | 'product';
    id: string;
    label: string;
  } | null>(null);

  // Initialize IndexedDB & solve initial sample project so real KPIs are populated
  useEffect(() => {
    let mounted = true;
    initializeStorage().then(async (data) => {
      if (!mounted) return;
      const updatedProjects = [...data.projects];
      // Compute genuine optimization for the primary sample project on first launch
      if (updatedProjects.length > 0 && !updatedProjects[0].lastResult) {
        const p0 = updatedProjects[0];
        const res = runOptimization({
          space: p0.space,
          packages: p0.packages,
          mode: p0.mode,
          allowRotation: p0.allowRotation,
          loadingDirection: p0.loadingDirection,
        });
        updatedProjects[0] = { ...p0, lastResult: res };
        await saveProjectToDb(updatedProjects[0]);
      }

      if (!mounted) return;
      setProjects(updatedProjects);
      setActiveProjectId(updatedProjects[0]?.id ?? null);
      setLibrary(data.library);
      setHistory(data.history);
      setSettings(data.settings);
      setReady(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Sync HTML dir and lang for English (LTR) / Arabic (RTL)
  useEffect(() => {
    const html = document.documentElement;
    html.lang = settings.language;
    html.dir = settings.language === 'ar' ? 'rtl' : 'ltr';
  }, [settings.language]);

  const projectsRef = useRef<Project[]>([]);
  projectsRef.current = projects;

  const activeProject =
    projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? null;

  const updateSettings = (next: AppSettings) => {
    setSettings(next);
    saveSettingsToDb(next);
  };

  const handleUpdateProject = (
    updatedOrUpdater: Project | ((prev: Project) => Project),
    recordHistory = false
  ) => {
    const currentList = projectsRef.current;
    const targetId =
      typeof updatedOrUpdater === 'function'
        ? activeProject?.id ?? currentList[0]?.id
        : updatedOrUpdater.id;
    const current = currentList.find((p) => p.id === targetId);
    if (!current) return;

    const updated =
      typeof updatedOrUpdater === 'function' ? updatedOrUpdater(current) : updatedOrUpdater;

    const nextList = currentList.map((p) => (p.id === updated.id ? updated : p));
    projectsRef.current = nextList;
    setProjects(nextList);
    saveProjectToDb(updated);

    if (recordHistory && updated.lastResult) {
      const res = updated.lastResult;
      const entry: HistoryEntry = {
        id: `hist-${Date.now()}`,
        projectId: updated.id,
        projectName:
          settings.language === 'ar' && updated.nameAr ? updated.nameAr : updated.name,
        spaceName:
          settings.language === 'ar' && updated.space.nameAr
            ? updated.space.nameAr
            : updated.space.name,
        mode: res.mode,
        loadedCount: res.loadedPackagesCount,
        totalCount: res.totalRequiredPackages,
        volumeUtilizationPct: res.volumeUtilizationPct,
        totalWeightKg: res.totalCargoWeightKg,
        containersUsed: res.containersUsed,
        isValid: res.verification.isValid,
        timestamp: res.timestamp,
      };
      setHistory((prev) => [entry, ...prev]);
      addHistoryEntryToDb(entry);
    }
  };

  const handleCreateFromCategory = (category: SpaceCategory) => {
    const tpl = SPACE_TEMPLATES.find((s) => s.category === category) ?? SPACE_TEMPLATES[0];
    const newProj: Project = {
      id: `proj-${Date.now()}`,
      name: `${tpl.name} Plan`,
      nameAr: `خطة تحميل — ${tpl.nameAr ?? tpl.name}`,
      description: `Created from ${tpl.name}`,
      descriptionAr: `تم الإنشاء من قالب ${tpl.nameAr ?? tpl.name}`,
      space: { ...tpl },
      spaces: [{ ...tpl }],
      packages: library.slice(0, 2).map((p, i) => ({
        ...p,
        id: `pkg-${Date.now()}-${i}`,
        quantity: i === 0 ? 8 : 16,
      })),
      mode: 'balanced',
      allowRotation: true,
      loadingDirection: tpl.loadingDirection,
      lastResult: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setProjects((prev) => [newProj, ...prev]);
    saveProjectToDb(newProj);
    setActiveProjectId(newProj.id);
    setActiveTab('workspace');
  };

  const handleOpenProject = (id: string) => {
    setActiveProjectId(id);
    setActiveTab('workspace');
  };

  const handleDuplicateProject = (id: string) => {
    const src = projects.find((p) => p.id === id);
    if (!src) return;
    const copy: Project = {
      ...src,
      id: `proj-${Date.now()}`,
      name: `${src.name} (Copy)`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setProjects((prev) => [copy, ...prev]);
    saveProjectToDb(copy);
  };

  const handleRenameProject = (id: string, newName: string) => {
    const target = projects.find((p) => p.id === id);
    if (!target) return;
    handleUpdateProject({ ...target, name: newName, updatedAt: Date.now() });
  };

  const handleRestoreProjectsList = (imported: Project[], mode: 'replace' | 'merge') => {
    const now = Date.now();
    if (mode === 'replace') {
      const seenIds = new Set<string>();
      const normalized = imported.map((p, idx) => {
        const uniqueId = !p.id || seenIds.has(p.id) ? `proj-rest-${now}-${idx}` : p.id;
        seenIds.add(uniqueId);
        return { ...p, id: uniqueId };
      });
      setProjects(normalized);
      setActiveProjectId(normalized[0]?.id ?? null);
      void replaceAllProjectsInDb(normalized);
    } else {
      const existingIds = new Set(projects.map((p) => p.id));
      const added = imported.map((p, idx) => {
        const uniqueId =
          !p.id || existingIds.has(p.id) ? `proj-imp-${now}-${idx}` : p.id;
        existingIds.add(uniqueId);
        return { ...p, id: uniqueId };
      });
      const nextList = [...added, ...projects];
      setProjects(nextList);
      if (!activeProjectId && nextList.length > 0) {
        setActiveProjectId(nextList[0].id);
      }
      void saveManyProjectsToDb(added);
    }
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    if (pendingDelete.type === 'project') {
      const next = projects.filter((p) => p.id !== pendingDelete.id);
      setProjects(next);
      deleteProjectFromDb(pendingDelete.id);
      if (activeProjectId === pendingDelete.id) {
        setActiveProjectId(next[0]?.id ?? null);
      }
    } else {
      setLibrary((prev) => prev.filter((p) => p.id !== pendingDelete.id));
      deleteLibraryProductFromDb(pendingDelete.id);
    }
    setPendingDelete(null);
  };

  const handleSaveLibraryProduct = (prod: PackageSpec) => {
    setLibrary((prev) => {
      const exists = prev.some((p) => p.id === prod.id);
      return exists ? prev.map((p) => (p.id === prod.id ? prod : p)) : [prod, ...prev];
    });
    saveLibraryProductToDb(prod);
  };

  const handleAddLibraryProductToActive = (prod: PackageSpec) => {
    if (!activeProject) {
      handleCreateFromCategory('container');
      return;
    }
    const copy: PackageSpec = {
      ...prod,
      id: `pkg-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    };
    handleUpdateProject({
      ...activeProject,
      packages: [...activeProject.packages, copy],
      updatedAt: Date.now(),
    });
    setActiveTab('workspace');
  };

  const navItems: { id: NavTab; label: string; icon: React.ReactNode }[] = [
    { id: 'dashboard', label: t(settings.language, 'dashboard'), icon: <LayoutDashboard className="w-4 h-4" /> },
    { id: 'workspace', label: t(settings.language, 'workspace'), icon: <Box className="w-4 h-4" /> },
    { id: 'projects', label: t(settings.language, 'projects'), icon: <FolderKanban className="w-4 h-4" /> },
    { id: 'library', label: t(settings.language, 'library'), icon: <Package className="w-4 h-4" /> },
    { id: 'history', label: t(settings.language, 'history'), icon: <History className="w-4 h-4" /> },
    { id: 'reports', label: t(settings.language, 'reports'), icon: <BarChart3 className="w-4 h-4" /> },
    { id: 'settings', label: t(settings.language, 'settings'), icon: <SettingsIcon className="w-4 h-4" /> },
  ];

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50 text-zinc-800">
        <div className="text-center space-y-2">
          <div className="text-lg font-bold tracking-tight text-red-600">{t(settings.language, 'appName')}</div>
          <div className="text-xs text-zinc-500">{t(settings.language, 'loadingApp')}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] flex flex-col md:flex-row bg-zinc-50 text-zinc-900">
      {/* Desktop Sidebar (White & Red) */}
      <aside className="hidden md:flex md:w-60 lg:w-64 md:flex-col md:fixed md:inset-y-0 bg-white text-zinc-900 border-e border-zinc-200 z-30 no-print">
        <div className="h-14 px-5 flex items-center justify-between border-b border-zinc-200">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex items-center justify-center w-7 h-7 rounded-md bg-red-600 text-white">
              <Box className="w-4 h-4" />
            </span>
            <span className="text-base font-bold tracking-tight text-zinc-900 whitespace-nowrap">
              {t(settings.language, 'appName')}
            </span>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  active
                    ? 'bg-red-600 text-white font-semibold shadow-sm'
                    : 'text-zinc-600 hover:bg-red-50 hover:text-red-700'
                }`}
              >
                {item.icon}
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Sidebar Bottom Controls: Unit Switcher, Language Switcher, PWA Install */}
        <div className="p-3 border-t border-zinc-200 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <select
              aria-label="Measurement Unit"
              value={settings.lengthUnit}
              onChange={(e) =>
                updateSettings({ ...settings, lengthUnit: e.target.value as LengthUnit })
              }
              className="flex-1 rounded-md bg-zinc-50 border border-zinc-300 px-2 py-1.5 text-xs font-mono text-zinc-800 focus:outline-none focus:border-red-600"
            >
              <option value="mm">mm</option>
              <option value="cm">cm</option>
              <option value="m">m</option>
              <option value="in">in</option>
            </select>

            <button
              onClick={() =>
                updateSettings({
                  ...settings,
                  language: settings.language === 'en' ? 'ar' : 'en',
                })
              }
              className="inline-flex items-center gap-1.5 rounded-md bg-zinc-50 border border-zinc-300 px-2.5 py-1.5 text-xs font-semibold text-zinc-800 hover:bg-red-50 hover:border-red-200 hover:text-red-700 cursor-pointer"
            >
              <Globe className="w-3.5 h-3.5 text-red-600" />
              <span>{settings.language === 'en' ? 'AR' : 'EN'}</span>
            </button>
          </div>

          <PWAInstallButton language={settings.language} />

          <div
            dir="rtl"
            className="pt-2.5 border-t border-zinc-200 text-center space-y-1 text-[11px] leading-snug"
          >
            <div className="font-semibold text-zinc-700">
              الملكية الفكرية للمهندس مينا خيرت
            </div>
            <a
              href="tel:01200224513"
              dir="ltr"
              className="inline-flex items-center justify-center gap-1 font-mono font-semibold text-red-600 hover:text-red-700"
            >
              <Phone className="w-3 h-3" />
              <span>01200224513</span>
            </a>
          </div>
        </div>
      </aside>

      {/* Mobile Compact Header + Full Drawer Trigger */}
      <header className="md:hidden sticky top-0 z-30 pt-[env(safe-area-inset-top)] bg-white text-zinc-900 border-b border-zinc-200 no-print">
        <div className="h-13 px-3 sm:px-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen((v) => !v)}
              aria-label="Menu"
              className="p-1.5 rounded-md text-zinc-700 hover:bg-red-50 hover:text-red-600 cursor-pointer shrink-0"
            >
              {mobileMenuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </button>
            <span className="inline-flex items-center justify-center w-6 h-6 rounded bg-red-600 text-white shrink-0">
              <Box className="w-3.5 h-3.5" />
            </span>
            <span className="text-sm font-bold tracking-tight truncate">
              {t(settings.language, 'appName')}
            </span>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <select
              value={settings.lengthUnit}
              onChange={(e) =>
                updateSettings({ ...settings, lengthUnit: e.target.value as LengthUnit })
              }
              className="rounded bg-zinc-50 border border-zinc-300 px-1.5 py-1 text-xs font-mono text-zinc-800"
            >
              <option value="mm">mm</option>
              <option value="cm">cm</option>
              <option value="m">m</option>
              <option value="in">in</option>
            </select>
            <button
              onClick={() =>
                updateSettings({
                  ...settings,
                  language: settings.language === 'en' ? 'ar' : 'en',
                })
              }
              className="rounded bg-zinc-50 border border-zinc-300 px-2 py-1 text-xs font-semibold text-red-600 cursor-pointer"
            >
              {settings.language === 'en' ? 'AR' : 'EN'}
            </button>
            <PWAInstallButton language={settings.language} compact />
          </div>
        </div>

        {mobileMenuOpen && (
          <div className="border-t border-zinc-200 bg-white px-3 py-3 space-y-2 shadow-lg">
            <div className="grid grid-cols-2 gap-1.5">
              {navItems.map((item) => {
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                      active
                        ? 'bg-red-600 text-white font-semibold'
                        : 'bg-zinc-50 text-zinc-700 hover:bg-red-50 hover:text-red-700'
                    }`}
                  >
                    {item.icon}
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </header>

      {/* Main Content Area */}
      <main className="flex-1 min-w-0 md:ms-60 lg:ms-64 p-3 sm:p-5 lg:p-6 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:pb-8 max-w-[1920px] w-full">
        {activeTab === 'dashboard' && (
          <DashboardView
            projects={projects}
            language={settings.language}
            lengthUnit={settings.lengthUnit}
            weightUnit={settings.weightUnit}
            onStartTemplate={handleCreateFromCategory}
            onOpenProject={handleOpenProject}
            onDuplicateProject={handleDuplicateProject}
            onDeleteProject={(id) => {
              const target = projects.find((p) => p.id === id);
              if (target) setPendingDelete({ type: 'project', id, label: target.name });
            }}
            onNavigateProjects={() => setActiveTab('projects')}
          />
        )}

        {activeTab === 'workspace' && activeProject && (
          <WorkspaceView
            project={activeProject}
            library={library}
            settings={settings}
            onUpdateProject={handleUpdateProject}
            onUpdateSettings={updateSettings}
            onSaveToLibrary={handleSaveLibraryProduct}
          />
        )}

        {activeTab === 'projects' && (
          <ProjectsView
            projects={projects}
            settings={settings}
            onCreateNew={() => handleCreateFromCategory('container')}
            onOpenProject={handleOpenProject}
            onDuplicateProject={handleDuplicateProject}
            onRenameProject={handleRenameProject}
            onDeleteProject={(id) => {
              const target = projects.find((p) => p.id === id);
              if (target) setPendingDelete({ type: 'project', id, label: target.name });
            }}
            onImportBackup={(proj) => {
              setProjects((prev) => [proj, ...prev]);
              saveProjectToDb(proj);
            }}
            onRestoreProjectsList={handleRestoreProjectsList}
          />
        )}

        {activeTab === 'library' && (
          <ProductLibraryView
            library={library}
            lengthUnit={settings.lengthUnit}
            weightUnit={settings.weightUnit}
            language={settings.language}
            onSaveProduct={handleSaveLibraryProduct}
            onDeleteProduct={(id) => {
              const target = library.find((p) => p.id === id);
              if (target) setPendingDelete({ type: 'product', id, label: target.name });
            }}
            onAddToActiveProject={handleAddLibraryProductToActive}
          />
        )}

        {activeTab === 'history' && (
          <HistoryView
            history={history}
            weightUnit={settings.weightUnit}
            language={settings.language}
            onOpenProject={handleOpenProject}
            onClearHistory={() => {
              setHistory([]);
              clearHistoryFromDb();
            }}
          />
        )}

        {activeTab === 'reports' && activeProject && (
          <ReportsView
            project={activeProject}
            settings={settings}
            onGoToWorkspace={() => setActiveTab('workspace')}
          />
        )}

        {activeTab === 'settings' && (
          <SettingsView settings={settings} onUpdateSettings={updateSettings} />
        )}

        <footer
          dir="rtl"
          className="md:hidden mt-8 pt-4 border-t border-zinc-200 text-center space-y-1 text-xs no-print"
        >
          <div className="font-semibold text-zinc-700">
            الملكية الفكرية للمهندس مينا خيرت
          </div>
          <a
            href="tel:01200224513"
            dir="ltr"
            className="inline-flex items-center justify-center gap-1 font-mono font-semibold text-red-600 hover:text-red-700"
          >
            <Phone className="w-3.5 h-3.5" />
            <span>01200224513</span>
          </a>
        </footer>
      </main>

      {/* Mobile Bottom Navigation Bar (thumb-friendly + iOS/Android safe-area) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 pb-[env(safe-area-inset-bottom)] bg-white text-zinc-500 border-t border-zinc-200 no-print shadow-sm">
        <div className="h-14 grid grid-cols-5 items-center">
          {(
            [
              { id: 'dashboard', label: t(settings.language, 'dashboard'), icon: <LayoutDashboard className="w-4 h-4" /> },
              { id: 'workspace', label: settings.language === 'ar' ? 'العرض 3D' : '3D', icon: <Box className="w-4 h-4" /> },
              { id: 'projects', label: t(settings.language, 'projects'), icon: <FolderKanban className="w-4 h-4" /> },
              { id: 'library', label: t(settings.language, 'library'), icon: <Package className="w-4 h-4" /> },
              { id: 'reports', label: t(settings.language, 'reports'), icon: <BarChart3 className="w-4 h-4" /> },
            ] as const
          ).map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  setActiveTab(item.id);
                  setMobileMenuOpen(false);
                }}
                className={`flex flex-col items-center justify-center h-full px-1 cursor-pointer ${
                  active ? 'text-red-600 font-semibold' : 'text-zinc-500'
                }`}
              >
                {item.icon}
                <span className="text-[10px] mt-0.5 truncate max-w-full">{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Delete Confirmation Modal */}
      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl border border-zinc-200 space-y-4">
            <h3 className="text-sm font-bold text-zinc-900">
              {t(settings.language, 'delete')} · {pendingDelete.label}
            </h3>
            <p className="text-xs text-zinc-600">{t(settings.language, 'deleteConfirm')}</p>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setPendingDelete(null)}
                className="rounded-lg border border-zinc-300 px-4 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 cursor-pointer"
              >
                {t(settings.language, 'cancel')}
              </button>
              <button
                onClick={confirmDelete}
                className="rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-500 cursor-pointer"
              >
                {t(settings.language, 'delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      <OfflineIndicator language={settings.language} />
    </div>
  );
}
