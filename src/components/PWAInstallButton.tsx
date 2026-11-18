import React, { useState } from 'react';
import { Download, Monitor, Smartphone, WifiOff, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall';
import { Language } from '../types/packvol';
import { t } from '../i18n/translations';

export const PWAInstallButton: React.FC<{ language: Language; compact?: boolean }> = ({
  language,
  compact = false,
}) => {
  const { isInstallable, isInstalled, isIOS, platform, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) return null;

  const isAr = language === 'ar';

  const handleClick = async () => {
    if (isInstallable) {
      const accepted = await install();
      if (accepted) return;
    }
    setShowGuide(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void handleClick()}
        title={t(language, 'installApp')}
        className={`inline-flex items-center justify-center gap-1.5 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
          compact
            ? 'px-2.5 py-1 text-[11px] font-semibold bg-red-600 text-white hover:bg-red-700'
            : 'w-full px-3 py-2 text-xs font-semibold bg-red-600 text-white hover:bg-red-700 shadow-sm'
        }`}
      >
        <Download className="w-3.5 h-3.5 shrink-0" />
        <span className={compact ? 'hidden sm:inline' : ''}>{t(language, 'installApp')}</span>
      </button>

      {showGuide && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl border border-zinc-200 space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-100 pb-3">
              <div className="flex items-center gap-2">
                {platform === 'windows' || platform === 'desktop' ? (
                  <Monitor className="w-4 h-4 text-red-600" />
                ) : (
                  <Smartphone className="w-4 h-4 text-red-600" />
                )}
                <h3 className="text-sm font-bold text-zinc-900">
                  {isAr ? 'تثبيت PackVol Pro كتطبيق مستقل' : 'Install PackVol Pro App'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="p-1 rounded-md text-zinc-500 hover:bg-zinc-100 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs text-zinc-700 leading-relaxed">
              {(platform === 'windows' || platform === 'desktop') && (
                <div className="rounded-lg border border-red-200 bg-red-50/70 p-3 space-y-1">
                  <div className="font-bold text-red-700">
                    {isAr ? 'على الكمبيوتر (Windows / Chrome / Edge)' : 'Windows / Desktop (Chrome / Edge)'}
                  </div>
                  <p>
                    {isAr
                      ? '1. اضغط على أيقونة التثبيت (⊕) في شريط العنوان أعلى المتصفح، أو افتح قائمة المتصفح (⋮ / ⋯).\n2. اختر "التطبيقات" ثم "تثبيت PackVol Pro" ليفتح كبرنامج مستقل على سطح المكتب ويعمل بدون إنترنت.'
                      : '1. Click the Install icon in the browser address bar, or open the browser menu (⋮ / ⋯).\n2. Select "Install PackVol Pro" to run as a standalone Windows desktop app with offline support.'}
                  </p>
                </div>
              )}

              {platform === 'android' && (
                <div className="rounded-lg border border-red-200 bg-red-50/70 p-3 space-y-1">
                  <div className="font-bold text-red-700">
                    {isAr ? 'على موبايل Android (Chrome)' : 'Android (Chrome)'}
                  </div>
                  <p>
                    {isAr
                      ? '1. افتح قائمة المتصفح (⋮) أعلى الشاشة.\n2. اختر "تثبيت التطبيق" أو "إضافة إلى الشاشة الرئيسية" لتشغيله بملء الشاشة وبدون إنترنت.'
                      : '1. Tap the browser menu (⋮) in Chrome.\n2. Tap "Install app" or "Add to Home screen" for standalone offline access.'}
                  </p>
                </div>
              )}

              {(isIOS || platform === 'ios') && (
                <div className="rounded-lg border border-red-200 bg-red-50/70 p-3 space-y-1">
                  <div className="font-bold text-red-700">
                    {isAr ? 'على iPhone / iPad (Safari)' : 'iPhone / iPad (Safari)'}
                  </div>
                  <p>
                    {isAr
                      ? '1. افتح الموقع في متصفح Safari واضغط على زر المشاركة (Share) أسفل أو أعلى الشاشة.\n2. مرر للأسفل واختر "إضافة إلى الشاشة الرئيسية" (Add to Home Screen).'
                      : '1. Open in Safari and tap the Share button.\n2. Scroll down and tap "Add to Home Screen".'}
                  </p>
                </div>
              )}

              <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-[11px] text-zinc-600">
                {isAr
                  ? 'يعمل التطبيق بكامل ميزاته وحساباته ثلاثية الأبعاد وتخزين المشاريع محلياً على الجهاز حتى بدون اتصال بالإنترنت.'
                  : 'Once installed, all 3D cargo calculations, projects, and Excel/PDF exports work offline locally on your device.'}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2">
              {isInstallable && (
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await install();
                    if (ok) setShowGuide(false);
                  }}
                  className="rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white hover:bg-red-700 cursor-pointer"
                >
                  {isAr ? 'تثبيت فوري الآن' : 'Install Now'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 cursor-pointer"
              >
                {t(language, 'close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export const OfflineIndicator: React.FC<{ language: Language }> = ({ language }) => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="fixed bottom-[calc(4rem+env(safe-area-inset-bottom))] md:bottom-4 left-4 z-40 flex items-center gap-2 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white shadow-md">
      <WifiOff className="w-3.5 h-3.5 shrink-0" />
      <span>{t(language, 'offlineBanner')}</span>
    </div>
  );
};
