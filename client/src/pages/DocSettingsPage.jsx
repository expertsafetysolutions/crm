import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDocSettings } from '../context/DocSettingsContext';
import { DEFAULT_DOC_SETTINGS } from '../utils/defaultDocSettings';
import {
  ChevronLeft, Save, RefreshCw, Image, FileText, Award,
  Eye, EyeOff, CheckSquare, Square, AlertCircle, CheckCircle2,
  Settings, Palette, LayoutTemplate, Stamp, Pen, Layers
} from 'lucide-react';

// ─── Reusable Toggle Switch ─────────────────────────────────────────────────
function Toggle({ checked, onChange, label, description }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer group py-2.5 px-3 rounded-xl hover:bg-slate-50 transition-colors">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 mt-0.5 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:ring-offset-2 ${checked ? 'bg-amber-600' : 'bg-slate-300'}`}
      >
        <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-md transform transition-transform duration-200 ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
      </button>
      <div className="flex-1">
        <div className={`text-sm font-semibold ${checked ? 'text-slate-900' : 'text-slate-500'}`}>{label}</div>
        {description && <div className="text-xs text-slate-400 mt-0.5 leading-snug">{description}</div>}
      </div>
    </label>
  );
}

// ─── Reusable Checkbox ───────────────────────────────────────────────────────
function Checkbox({ checked, onChange, label }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border text-sm font-medium transition-all ${
        checked
          ? 'bg-amber-50 border-amber-300 text-amber-900'
          : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'
      }`}
    >
      {checked ? <CheckSquare className="w-4 h-4 text-amber-600 shrink-0" /> : <Square className="w-4 h-4 text-slate-400 shrink-0" />}
      <span>{label}</span>
    </button>
  );
}

// ─── Asset URL Picker with thumbnail preview ─────────────────────────────────
function AssetPicker({ label, icon: Icon, value, defaultValue, onChange, description }) {
  const [imgError, setImgError] = useState(false);
  const displaySrc = value || defaultValue;
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4 flex gap-4 items-start hover:border-amber-300 hover:shadow-sm transition-all">
      {/* Thumbnail */}
      <div className="shrink-0 w-20 h-16 rounded-xl bg-slate-100 border border-slate-200 overflow-hidden flex items-center justify-center">
        {displaySrc && !imgError ? (
          <img
            src={displaySrc}
            alt={label}
            className="w-full h-full object-contain"
            onError={() => setImgError(true)}
          />
        ) : (
          <Icon className="w-7 h-7 text-slate-300" />
        )}
      </div>
      {/* Controls */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1.5">
          <Icon className="w-3.5 h-3.5 text-amber-600 shrink-0" />
          <span className="text-sm font-bold text-slate-800">{label}</span>
        </div>
        {description && <p className="text-xs text-slate-400 mb-2">{description}</p>}
        <div className="flex gap-2">
          <input
            type="text"
            value={value}
            onChange={e => { setImgError(false); onChange(e.target.value); }}
            placeholder={defaultValue}
            className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-700 focus:outline-none focus:ring-2 focus:ring-amber-400/40 focus:border-amber-400 min-w-0"
          />
          {value !== defaultValue && (
            <button
              type="button"
              onClick={() => { setImgError(false); onChange(defaultValue); }}
              className="px-2.5 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-bold transition shrink-0"
              title="Reset to default"
            >
              Reset
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Section Card ────────────────────────────────────────────────────────────
function SectionCard({ title, children, className = '' }) {
  return (
    <div className={`bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-xs ${className}`}>
      <div className="bg-gradient-to-r from-slate-50 to-amber-50/50 px-4 py-2.5 border-b border-slate-200">
        <h3 className="text-xs font-black text-slate-700 uppercase tracking-wide">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────
export default function DocSettingsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { docSettings, updateDocSettings, isSaving, saveError } = useDocSettings();

  // Guard: Admin only
  if (user?.Role !== 'Admin') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center p-8">
          <AlertCircle className="w-12 h-12 text-rose-400 mx-auto mb-3" />
          <p className="text-slate-700 font-bold">Admin access required.</p>
          <button onClick={() => navigate('/')} className="mt-4 px-4 py-2 bg-slate-800 text-white rounded-xl text-sm font-bold">Go Home</button>
        </div>
      </div>
    );
  }

  const [activeTab, setActiveTab] = useState('branding');
  const [localSettings, setLocalSettings] = useState(() => JSON.parse(JSON.stringify(docSettings)));
  const [saveStatus, setSaveStatus] = useState('idle'); // 'idle' | 'saving' | 'success' | 'error'
  const [isDirty, setIsDirty] = useState(false);

  // Sync when context loads
  useEffect(() => {
    setLocalSettings(JSON.parse(JSON.stringify(docSettings)));
    setIsDirty(false);
  }, [docSettings]);

  // Deep updater helpers
  const updateBranding = (key, val) => {
    setLocalSettings(prev => ({ ...prev, branding_assets: { ...prev.branding_assets, [key]: val } }));
    setIsDirty(true);
  };

  const updateServiceReport = (key, val) => {
    setLocalSettings(prev => ({
      ...prev,
      document_configs: {
        ...prev.document_configs,
        SERVICE_REPORT: { ...prev.document_configs.SERVICE_REPORT, [key]: val }
      }
    }));
    setIsDirty(true);
  };

  const updateSRColumn = (col, val) => {
    setLocalSettings(prev => ({
      ...prev,
      document_configs: {
        ...prev.document_configs,
        SERVICE_REPORT: {
          ...prev.document_configs.SERVICE_REPORT,
          visible_columns: { ...prev.document_configs.SERVICE_REPORT.visible_columns, [col]: val }
        }
      }
    }));
    setIsDirty(true);
  };

  const updateSRCheckpoint = (cp, val) => {
    setLocalSettings(prev => ({
      ...prev,
      document_configs: {
        ...prev.document_configs,
        SERVICE_REPORT: {
          ...prev.document_configs.SERVICE_REPORT,
          enabled_checkpoints: { ...prev.document_configs.SERVICE_REPORT.enabled_checkpoints, [cp]: val }
        }
      }
    }));
    setIsDirty(true);
  };

  const updateCertificate = (key, val) => {
    setLocalSettings(prev => ({
      ...prev,
      document_configs: {
        ...prev.document_configs,
        CERTIFICATE: { ...prev.document_configs.CERTIFICATE, [key]: val }
      }
    }));
    setIsDirty(true);
  };

  const updateCertColumn = (col, val) => {
    setLocalSettings(prev => ({
      ...prev,
      document_configs: {
        ...prev.document_configs,
        CERTIFICATE: {
          ...prev.document_configs.CERTIFICATE,
          visible_columns: { ...prev.document_configs.CERTIFICATE.visible_columns, [col]: val }
        }
      }
    }));
    setIsDirty(true);
  };

  const updateCertTableTitle = (formatType, val) => {
    setLocalSettings(prev => {
      const certConfig = prev.document_configs?.CERTIFICATE || {};
      const currentTitles = certConfig.equipment_table_titles || {};
      return {
        ...prev,
        document_configs: {
          ...prev.document_configs,
          CERTIFICATE: {
            ...certConfig,
            equipment_table_titles: {
              ...currentTitles,
              [formatType]: val
            }
          }
        }
      };
    });
    setIsDirty(true);
  };

  const handleSave = async () => {
    setSaveStatus('saving');
    const result = await updateDocSettings(localSettings);
    if (result?.success !== false) {
      setSaveStatus('success');
      setIsDirty(false);
      setTimeout(() => setSaveStatus('idle'), 3000);
    } else {
      setSaveStatus('error');
    }
  };

  const handleReset = () => {
    setLocalSettings(JSON.parse(JSON.stringify(DEFAULT_DOC_SETTINGS)));
    setIsDirty(true);
  };

  const ba = localSettings.branding_assets || {};
  const sr = localSettings.document_configs?.SERVICE_REPORT || {};
  const cert = localSettings.document_configs?.CERTIFICATE || {};

  const TABS = [
    { id: 'branding', label: 'Branding Assets', icon: Palette },
    { id: 'service_report', label: 'Service Report', icon: FileText },
    { id: 'certificate', label: 'Certificate', icon: Award }
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-amber-50/20 to-slate-100 flex flex-col">
      {/* ── Page Header ── */}
      <div className="sticky top-0 z-20 bg-white/95 backdrop-blur-sm border-b border-slate-200 shadow-sm">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => navigate('/')}
              className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 transition shrink-0"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div>
              <div className="flex items-center gap-2">
                <Settings className="w-4 h-4 text-amber-600" />
                <h1 className="text-base font-black text-slate-900">Document & Template Settings</h1>
              </div>
              <p className="text-xs text-slate-400">Configure branding, columns, and field visibility across all certificates and reports</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleReset}
              className="px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-bold flex items-center gap-1.5 transition"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Reset Defaults</span>
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving || saveStatus === 'saving'}
              className={`px-4 py-2 rounded-xl text-xs font-black flex items-center gap-2 transition shadow-sm ${
                saveStatus === 'success'
                  ? 'bg-emerald-500 text-white'
                  : saveStatus === 'error'
                  ? 'bg-rose-500 text-white'
                  : isDirty
                  ? 'bg-amber-600 hover:bg-amber-700 text-white'
                  : 'bg-slate-200 text-slate-400 cursor-default'
              }`}
            >
              {saveStatus === 'saving' ? (
                <><RefreshCw className="w-3.5 h-3.5 animate-spin" /><span>Saving…</span></>
              ) : saveStatus === 'success' ? (
                <><CheckCircle2 className="w-3.5 h-3.5" /><span>Saved!</span></>
              ) : saveStatus === 'error' ? (
                <><AlertCircle className="w-3.5 h-3.5" /><span>Failed</span></>
              ) : (
                <><Save className="w-3.5 h-3.5" /><span>Save Settings</span></>
              )}
            </button>
          </div>
        </div>

        {/* Dirty indicator */}
        {isDirty && saveStatus === 'idle' && (
          <div className="bg-amber-50 border-t border-amber-200 px-4 py-1.5 text-center">
            <span className="text-xs text-amber-700 font-semibold">⚠️ You have unsaved changes — click Save Settings to apply.</span>
          </div>
        )}
        {saveError && saveStatus === 'error' && (
          <div className="bg-rose-50 border-t border-rose-200 px-4 py-1.5 text-center">
            <span className="text-xs text-rose-700 font-semibold">Error: {saveError}</span>
          </div>
        )}
      </div>

      {/* ── Tab Bar ── */}
      <div className="max-w-5xl mx-auto w-full px-4 sm:px-6 pt-5">
        <div className="flex gap-1 bg-white border border-slate-200 rounded-2xl p-1 shadow-xs w-full sm:w-fit">
          {TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
                activeTab === tab.id
                  ? 'bg-gradient-to-r from-amber-600 to-amber-700 text-white shadow-md'
                  : 'text-slate-500 hover:text-slate-800 hover:bg-slate-50'
              }`}
            >
              <tab.icon className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Tab Content ── */}
      <div className="max-w-5xl mx-auto w-full px-4 sm:px-6 py-5 flex flex-col gap-5">

        {/* ════ TAB 1: BRANDING ASSETS ════ */}
        {activeTab === 'branding' && (
          <>
            <div className="bg-gradient-to-r from-amber-700 to-amber-900 text-white rounded-2xl px-5 py-4 flex items-center gap-3 shadow-md">
              <Palette className="w-8 h-8 opacity-80 shrink-0" />
              <div>
                <h2 className="font-black text-base">Branding Assets</h2>
                <p className="text-xs text-amber-200 mt-0.5">Configure the images displayed on all generated certificates and service reports. Enter the URL path of the asset as served by the server (e.g., <code className="bg-amber-800/60 px-1.5 py-0.5 rounded font-mono">/assets/filename.png</code>).</p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3">
              <AssetPicker
                label="Company Header"
                icon={Image}
                value={ba.header_image_url ?? ''}
                defaultValue={DEFAULT_DOC_SETTINGS.branding_assets.header_image_url}
                onChange={val => updateBranding('header_image_url', val)}
                description="Full-width header banner shown at the top of every document"
              />
              <AssetPicker
                label="Footer Banner"
                icon={Layers}
                value={ba.footer_image_url ?? ''}
                defaultValue={DEFAULT_DOC_SETTINGS.branding_assets.footer_image_url}
                onChange={val => updateBranding('footer_image_url', val)}
                description="Full-width footer banner shown at the bottom of every document"
              />
              <AssetPicker
                label="Company Stamp / Seal"
                icon={Stamp}
                value={ba.company_stamp_url ?? ''}
                defaultValue={DEFAULT_DOC_SETTINGS.branding_assets.company_stamp_url}
                onChange={val => updateBranding('company_stamp_url', val)}
                description="Circular company seal shown alongside signatures"
              />
              <AssetPicker
                label="Authorized Signature"
                icon={Pen}
                value={ba.authorized_signature_url ?? ''}
                defaultValue={DEFAULT_DOC_SETTINGS.branding_assets.authorized_signature_url}
                onChange={val => updateBranding('authorized_signature_url', val)}
                description="Handwritten signature image for authorized signatory (SVG or PNG)"
              />
              <AssetPicker
                label="Watermark Logo"
                icon={Image}
                value={ba.watermark_logo_url ?? ''}
                defaultValue={DEFAULT_DOC_SETTINGS.branding_assets.watermark_logo_url}
                onChange={val => updateBranding('watermark_logo_url', val)}
                description="Subtle background watermark overlay on certificates (opacity 8%)"
              />
            </div>
          </>
        )}

        {/* ════ TAB 2: SERVICE REPORT ════ */}
        {activeTab === 'service_report' && (
          <>
            <div className="bg-gradient-to-r from-indigo-700 to-indigo-900 text-white rounded-2xl px-5 py-4 flex items-center gap-3 shadow-md">
              <FileText className="w-8 h-8 opacity-80 shrink-0" />
              <div>
                <h2 className="font-black text-base">Service Report Settings</h2>
                <p className="text-xs text-indigo-200 mt-0.5">Control which sections, columns, and checkpoints appear on all Service Reports and Inspection documents.</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Document Sections */}
              <SectionCard title="📄 Document Sections">
                <div className="space-y-0.5">
                  <Toggle
                    checked={sr.show_header ?? true}
                    onChange={v => updateServiceReport('show_header', v)}
                    label="Show Company Header"
                    description="Header banner image at top of each page"
                  />
                  <Toggle
                    checked={sr.show_footer ?? true}
                    onChange={v => updateServiceReport('show_footer', v)}
                    label="Show Company Footer"
                    description="Footer image at bottom of document"
                  />
                  <Toggle
                    checked={sr.show_stamp_every_page ?? true}
                    onChange={v => updateServiceReport('show_stamp_every_page', v)}
                    label="Show Company Stamp"
                    description="Circular seal on signature section"
                  />
                  <Toggle
                    checked={sr.show_signature ?? true}
                    onChange={v => updateServiceReport('show_signature', v)}
                    label="Show Authorized Signature"
                    description="Signature image above signatory name"
                  />
                  <Toggle
                    checked={sr.show_amc_schedule ?? true}
                    onChange={v => updateServiceReport('show_amc_schedule', v)}
                    label="Show AMC Visit Schedule Table"
                    description="Annual maintenance contract visit schedule grid"
                  />
                </div>
              </SectionCard>

              {/* Equipment Table Columns */}
              <SectionCard title="📊 Equipment Table Columns">
                <p className="text-xs text-slate-400 mb-3">Select which columns appear in the equipment inspection table:</p>
                <div className="flex flex-wrap gap-2">
                  {[
                    { key: 'location', label: 'Location' },
                    { key: 'mfg_year', label: 'Mfg. Year' },
                    { key: 'refill_date', label: 'Refilling Date' },
                    { key: 'next_refill_due', label: 'Next Refill Due' },
                    { key: 'hpt_date', label: 'HPT Date' },
                    { key: 'hpt_due_date', label: 'HPT Due Date' },
                    { key: 'client_id_no', label: 'Client ID No.' },
                  ].map(col => (
                    <Checkbox
                      key={col.key}
                      checked={sr.visible_columns?.[col.key] ?? true}
                      onChange={v => updateSRColumn(col.key, v)}
                      label={col.label}
                    />
                  ))}
                </div>
              </SectionCard>

              {/* Inspection Checkpoints */}
              <SectionCard title="✅ Inspection Checkpoints" className="md:col-span-2">
                <p className="text-xs text-slate-400 mb-3">Select which checkpoints appear in the equipment condition inspection columns:</p>
                <div className="flex flex-wrap gap-2">
                  {[
                    { key: 'body_valve', label: 'Body / Valve' },
                    { key: 'safety_pin', label: 'Safety Pin' },
                    { key: 'pressure_gauge', label: 'Pressure / Weight' },
                    { key: 'hose_pipe', label: 'Hose / Horn' },
                    { key: 'seal', label: 'Seal' },
                  ].map(cp => (
                    <Checkbox
                      key={cp.key}
                      checked={sr.enabled_checkpoints?.[cp.key] ?? true}
                      onChange={v => updateSRCheckpoint(cp.key, v)}
                      label={cp.label}
                    />
                  ))}
                </div>
              </SectionCard>
            </div>
          </>
        )}

        {/* ════ TAB 3: CERTIFICATE ════ */}
        {activeTab === 'certificate' && (
          <>
            <div className="bg-gradient-to-r from-emerald-700 to-emerald-900 text-white rounded-2xl px-5 py-4 flex items-center gap-3 shadow-md">
              <Award className="w-8 h-8 opacity-80 shrink-0" />
              <div>
                <h2 className="font-black text-base">Certificate Settings</h2>
                <p className="text-xs text-emerald-200 mt-0.5">Control which sections and columns appear on all Compliance Certificates (Refilling, HP Testing, New FE, System, AMC).</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Visibility Sections */}
              <SectionCard title="🏅 Certificate Sections">
                <div className="space-y-0.5">
                  <Toggle
                    checked={cert.show_header ?? true}
                    onChange={v => updateCertificate('show_header', v)}
                    label="Show Company Header"
                    description="Header banner at top of certificate"
                  />
                  <Toggle
                    checked={cert.show_footer ?? true}
                    onChange={v => updateCertificate('show_footer', v)}
                    label="Show Footer Image"
                    description="Footer banner at bottom of certificate"
                  />
                  <Toggle
                    checked={cert.show_watermark ?? true}
                    onChange={v => updateCertificate('show_watermark', v)}
                    label="Show Background Watermark"
                    description="Subtle logo watermark overlay behind content"
                  />
                  <Toggle
                    checked={cert.show_stamp ?? true}
                    onChange={v => updateCertificate('show_stamp', v)}
                    label="Show Company Seal / Stamp"
                    description="Circular stamp in signature section"
                  />
                  <Toggle
                    checked={cert.show_signature ?? true}
                    onChange={v => updateCertificate('show_signature', v)}
                    label="Show Authorized Signature"
                    description="Signature image above signatory name"
                  />
                  <Toggle
                    checked={cert.show_qr_code ?? true}
                    onChange={v => updateCertificate('show_qr_code', v)}
                    label="Show QR Code Verification"
                    description="Scannable QR code for certificate authenticity"
                  />
                </div>
              </SectionCard>

              {/* Equipment Table Columns */}
              <SectionCard title="📋 Equipment Table Columns">
                <p className="text-xs text-slate-400 mb-3">Select which columns appear in the certificate equipment list table:</p>
                <div className="flex flex-wrap gap-2">
                  {[
                    { key: 'sr_no', label: 'Sr. No.' },
                    { key: 'item_name', label: 'Item Name' },
                    { key: 'capacity', label: 'Capacity' },
                    { key: 'qty', label: 'Qty (Nos.)' },
                    { key: 'refill_date', label: 'Service Date' },
                    { key: 'valid_until', label: 'Valid Until' },
                  ].map(col => (
                    <Checkbox
                      key={col.key}
                      checked={cert.visible_columns?.[col.key] ?? true}
                      onChange={v => updateCertColumn(col.key, v)}
                      label={col.label}
                    />
                  ))}
                </div>
              </SectionCard>

              {/* Equipment Table Titles */}
              <SectionCard title="✏️ Equipment Table Titles (per Certificate Type)" className="md:col-span-2">
                <p className="text-xs text-slate-400 mb-3">Customize the title displayed above the equipment table for each certificate format:</p>
                <div className="space-y-3">
                  {[
                    { key: 'Refilling', label: 'Refilling Certificate' },
                    { key: 'HP Testing', label: 'HP Testing Certificate' },
                    { key: 'New Fire Extinguisher', label: 'New Fire Extinguisher' },
                    { key: 'System Installation', label: 'System Installation' },
                    { key: 'AMC Certificate', label: 'AMC Certificate' },
                    { key: 'Visit Report', label: 'Visit Report' },
                  ].map(format => (
                    <div key={format.key} className="flex flex-col sm:flex-row sm:items-center gap-2">
                      <span className="text-xs font-bold text-slate-600 sm:w-1/3 truncate">{format.label}</span>
                      <input
                        type="text"
                        className="flex-1 px-3 py-1.5 rounded-lg border border-slate-300 focus:outline-hidden focus:ring-1 focus:ring-rose-500 font-bold text-xs"
                        value={cert.equipment_table_titles?.[format.key] ?? ''}
                        placeholder={
                          format.key === 'HP Testing' ? 'Certified Equipment & HPT Summary' :
                          format.key === 'New Fire Extinguisher' ? 'Certified Equipment Warranty & Summary' :
                          format.key === 'System Installation' ? 'Installed Systems & Equipment Summary' :
                          format.key === 'AMC Certificate' ? 'Certified Equipment & AMC Schedule Summary' :
                          format.key === 'Visit Report' ? 'Inspected Equipment & Observations Summary' :
                          'Certified Equipment & Schedule Summary'
                        }
                        onChange={e => updateCertTableTitle(format.key, e.target.value)}
                      />
                    </div>
                  ))}
                </div>
              </SectionCard>
            </div>

            {/* Info box */}
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex gap-3">
              <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-800">
                <p className="font-bold mb-1">About Certificate Types</p>
                <p>These settings apply across <strong>all certificate formats</strong> — Refilling, HP Testing, New Fire Extinguisher Supply, System Installation, and AMC Certificate. Column toggles control the equipment detail table visible in the certificate body.</p>
              </div>
            </div>
          </>
        )}

      </div>

      {/* ── Floating Save Button (mobile) ── */}
      {isDirty && (
        <div className="fixed bottom-6 right-6 z-30 sm:hidden">
          <button
            type="button"
            onClick={handleSave}
            disabled={isSaving}
            className="px-5 py-3 rounded-2xl bg-amber-600 hover:bg-amber-700 text-white font-black text-sm flex items-center gap-2 shadow-2xl transition active:scale-95"
          >
            <Save className="w-4 h-4" />
            Save Settings
          </button>
        </div>
      )}
    </div>
  );
}
