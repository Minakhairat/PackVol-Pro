import React from 'react';
import {
  ArrowRight,
  Box,
  Boxes,
  Container,
  Layers,
  Plus,
  TrainFront,
  Truck,
  Copy,
  Trash2,
  FolderOpen,
} from 'lucide-react';
import {
  Language,
  LengthUnit,
  Project,
  SpaceCategory,
  WeightUnit,
} from '../types/packvol';
import { formatDims, formatVolume, formatWeight } from '../utils/units';
import { resolveDisplayProjectName } from '../utils/exporters';
import { t } from '../i18n/translations';

interface DashboardViewProps {
  projects: Project[];
  language: Language;
  lengthUnit: LengthUnit;
  weightUnit: WeightUnit;
  onStartTemplate: (category: SpaceCategory) => void;
  onOpenProject: (projectId: string) => void;
  onDuplicateProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onNavigateProjects: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  projects,
  language,
  lengthUnit,
  weightUnit,
  onStartTemplate,
  onOpenProject,
  onDuplicateProject,
  onDeleteProject,
  onNavigateProjects,
}) => {
  // Real calculated KPIs across all saved projects
  const totalProjects = projects.length;
  const totalPackages = projects.reduce(
    (sum, p) => sum + p.packages.reduce((s, pkg) => s + Math.max(0, pkg.quantity), 0),
    0
  );

  const optimizedProjects = projects.filter((p) => p.lastResult !== null);
  const avgUtilization =
    optimizedProjects.length > 0
      ? optimizedProjects.reduce((s, p) => s + (p.lastResult?.volumeUtilizationPct ?? 0), 0) /
        optimizedProjects.length
      : 0;

  const totalLoadedWeightKg = projects.reduce((sum, p) => {
    if (p.lastResult) return sum + p.lastResult.totalCargoWeightKg;
    return sum + p.packages.reduce((s, pkg) => s + pkg.weight * pkg.quantity, 0);
  }, 0);

  const totalRemainingVolMm3 = optimizedProjects.reduce(
    (sum, p) => sum + (p.lastResult?.remainingVolumeMm3 ?? 0),
    0
  );

  // Estimated transport savings based on packed efficiency vs naive 55% baseline
  const baselineTrips = optimizedProjects.reduce((sum, p) => {
    const res = p.lastResult;
    if (!res || res.occupiedVolumeMm3 <= 0) return sum;
    const singleVol = p.space.internalLength * p.space.internalWidth * p.space.internalHeight;
    return sum + Math.max(1, Math.ceil(res.occupiedVolumeMm3 / (singleVol * 0.55)));
  }, 0);
  const actualTrips = optimizedProjects.reduce((s, p) => s + (p.lastResult?.containersUsed ?? 0), 0);
  const tripsSaved = Math.max(0, baselineTrips - actualTrips);
  const estimatedSavingsPct =
    baselineTrips > 0 ? Math.round((tripsSaved / baselineTrips) * 100) : 0;

  const launchCards: {
    category: SpaceCategory;
    title: string;
    desc: string;
    icon: React.ReactNode;
  }[] = [
    {
      category: 'container',
      title: t(language, 'containerOpt'),
      desc: t(language, 'containerDesc'),
      icon: <Container className="w-5 h-5 text-red-600" />,
    },
    {
      category: 'truck',
      title: t(language, 'truckOpt'),
      desc: t(language, 'truckDesc'),
      icon: <Truck className="w-5 h-5 text-red-600" />,
    },
    {
      category: 'pallet',
      title: t(language, 'palletOpt'),
      desc: t(language, 'palletDesc'),
      icon: <Layers className="w-5 h-5 text-red-600" />,
    },
    {
      category: 'railway',
      title: t(language, 'railOpt'),
      desc: t(language, 'railDesc'),
      icon: <TrainFront className="w-5 h-5 text-red-600" />,
    },
    {
      category: 'custom',
      title: t(language, 'customSpace'),
      desc: t(language, 'customDesc'),
      icon: <Box className="w-5 h-5 text-red-600" />,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header Banner (White & Red) */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-white text-zinc-900 rounded-xl p-4 sm:p-6 border-2 border-red-100 shadow-sm">
        <div className="space-y-1 max-w-2xl border-s-4 border-red-600 ps-3 sm:ps-4">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-zinc-900">
            {language === 'ar'
              ? 'مركز تحسين الأحمال والمساحات ثلاثي الأبعاد'
              : '3D Cargo & Load Space Optimization Control'}
          </h1>
          <p className="text-sm text-zinc-600">
            {language === 'ar'
              ? 'حسابات فيزيائية دقيقة، كشف التصادمات، وتصور ثلاثي الأبعاد بدون اتصال بالإنترنت.'
              : 'Calculate collision-free 3D arrangements, enforce stacking & weight limits, and export actionable warehouse loading plans.'}
          </p>
        </div>
        <button
          onClick={() => onStartTemplate('container')}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-600 px-5 py-3 text-sm font-semibold text-white hover:bg-red-700 transition-colors whitespace-nowrap shrink-0 shadow-sm cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{t(language, 'newProject')}</span>
        </button>
      </div>

      {/* 6 Industrial KPI Cards (Real calculated data, tabular figures) */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="text-xs font-medium text-zinc-500">{t(language, 'totalProjects')}</div>
          <div className="mt-1.5 text-2xl font-bold font-mono tabular-nums text-zinc-900">
            {totalProjects}
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">
            {optimizedProjects.length} {language === 'ar' ? 'تم تحسينها' : 'optimized'}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="text-xs font-medium text-zinc-500">{t(language, 'totalPackages')}</div>
          <div className="mt-1.5 text-2xl font-bold font-mono tabular-nums text-zinc-900">
            {totalPackages.toLocaleString()}
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">
            {language === 'ar' ? 'إجمالي وحدات الشحن' : 'Total manifest units'}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="text-xs font-medium text-zinc-500">{t(language, 'avgUtilization')}</div>
          <div className="mt-1.5 text-2xl font-bold font-mono tabular-nums text-red-600">
            {avgUtilization.toFixed(1)}%
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">
            {optimizedProjects.length > 0
              ? language === 'ar'
                ? 'من نتائج التحسين'
                : 'Across solved plans'
              : language === 'ar'
                ? 'شغّل مشروعاً للحساب'
                : 'Run a plan to compute'}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-3.5 sm:p-4 min-w-0">
          <div className="text-xs font-medium text-zinc-500 truncate">{t(language, 'totalLoadedWeight')}</div>
          <div className="mt-1.5 text-lg sm:text-2xl font-bold font-mono tabular-nums text-zinc-900 truncate">
            {formatWeight(totalLoadedWeightKg, weightUnit)}
          </div>
          <div className="mt-1 text-[11px] text-zinc-500 truncate">
            {language === 'ar' ? 'الكتلة الإجمالية' : 'Cumulative cargo mass'}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-3.5 sm:p-4 min-w-0">
          <div className="text-xs font-medium text-zinc-500 truncate">{t(language, 'emptySpace')}</div>
          <div className="mt-1.5 text-lg sm:text-2xl font-bold font-mono tabular-nums text-zinc-900 truncate">
            {formatVolume(totalRemainingVolMm3, lengthUnit)}
          </div>
          <div className="mt-1 text-[11px] text-zinc-500 truncate">
            {language === 'ar' ? 'حجم متبقي غير مستغل' : 'Residual open volume'}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <div className="text-xs font-medium text-zinc-500">{t(language, 'transportSavings')}</div>
          <div className="mt-1.5 text-2xl font-bold font-mono tabular-nums text-emerald-700">
            {estimatedSavingsPct}%
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">
            {tripsSaved > 0
              ? `${tripsSaved} ${language === 'ar' ? 'وحدة تم توفيرها' : 'unit(s) vs 55% base'}`
              : language === 'ar'
                ? 'مقارنة بمعيار 55%'
                : 'vs 55% manual baseline'}
          </div>
        </div>
      </div>

      {/* Quick Start Mode Selector */}
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold text-zinc-900">{t(language, 'quickStartTitle')}</h2>
          <p className="text-xs text-zinc-500">{t(language, 'quickStartDesc')}</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {launchCards.map((card) => (
            <button
              key={card.category}
              onClick={() => onStartTemplate(card.category)}
              className="group text-start rounded-lg border border-zinc-200 bg-white p-4 hover:border-red-500 hover:shadow-sm transition-all cursor-pointer flex flex-col justify-between gap-3"
            >
              <div className="flex items-center justify-between">
                <div className="p-2 rounded-md bg-red-50 border border-red-100">
                  {card.icon}
                </div>
                <ArrowRight className="w-4 h-4 text-zinc-400 group-hover:text-red-600 transition-colors rtl:rotate-180" />
              </div>
              <div>
                <div className="text-sm font-semibold text-zinc-900">{card.title}</div>
                <div className="text-xs text-zinc-500 mt-1 line-clamp-2">{card.desc}</div>
              </div>
            </button>
          ))}
        </div>
      </section>

      {/* Recent Projects Table */}
      <section className="rounded-lg border border-zinc-200 bg-white overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200">
          <div className="flex items-center gap-2">
            <Boxes className="w-4 h-4 text-red-600" />
            <h2 className="text-sm font-semibold text-zinc-900">{t(language, 'recentProjects')}</h2>
          </div>
          <button
            onClick={onNavigateProjects}
            className="text-xs font-semibold text-red-600 hover:text-red-700 cursor-pointer"
          >
            {language === 'ar' ? 'عرض الكل' : 'View All Projects'}
          </button>
        </div>

        {projects.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-500">{t(language, 'noProjects')}</div>
        ) : (
          <div className="divide-y divide-zinc-100">
            {projects.slice(0, 6).map((proj) => {
              const pkgCount = proj.packages.reduce((s, p) => s + p.quantity, 0);
              const projName = resolveDisplayProjectName(proj, language);
              const spaceName =
                language === 'ar' && proj.space.nameAr ? proj.space.nameAr : proj.space.name;
              const fleetLen = proj.spaces?.length ?? 1;
              return (
                <div
                  key={proj.id}
                  className="flex flex-col md:flex-row md:items-center justify-between gap-3 px-4 py-3 hover:bg-zinc-50 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => onOpenProject(proj.id)}
                        className="text-sm font-semibold text-zinc-900 hover:text-red-600 truncate cursor-pointer text-start"
                      >
                        {projName}
                      </button>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 font-mono tabular-nums">
                      <span>
                        {spaceName}
                        {fleetLen > 1 ? ` (×${fleetLen})` : ''}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {formatDims(
                          proj.space.internalLength,
                          proj.space.internalWidth,
                          proj.space.internalHeight,
                          lengthUnit
                        )}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {pkgCount} {t(language, 'pkgsShort')}
                      </span>
                      {proj.lastResult && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-red-600 font-semibold">
                            {proj.lastResult.volumeUtilizationPct}% {t(language, 'volShort')}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => onOpenProject(proj.id)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700 cursor-pointer"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                      <span>{t(language, 'openWorkspace')}</span>
                    </button>
                    <button
                      onClick={() => onDuplicateProject(proj.id)}
                      title={t(language, 'duplicate')}
                      className="p-2 rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-100 cursor-pointer"
                    >
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => onDeleteProject(proj.id)}
                      title={t(language, 'delete')}
                      className="p-2 rounded-md border border-zinc-200 text-red-600 hover:bg-red-50 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};
