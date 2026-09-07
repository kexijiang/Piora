"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useI18n } from "@/hooks/useI18n";
import {
  getCompanionPetSourceKey,
  type CompanionPetSource,
} from "@/hooks/useCompanionPets";
import type { CompanionPet, CompanionPetSourceKind, CompanionPetsResponse } from "@/lib/companion-pets";
import { BUNDLED_COMPANION_PET_IDS, type CompanionPreferences } from "@/lib/companion-store";
import type { ModelsData } from "@/lib/models-cache";
import { AliIcon } from "./AliIcon";
import { BuiltinPet, SpritePet } from "./CompanionPet";
import { CompanionDataManager } from "./CompanionDataManager";
import { CompanionStorageSettings } from "./CompanionStorageSettings";
import styles from "./CompanionSettingsDialog.module.css";

const SOURCE_MESSAGE_KEYS: Record<CompanionPetSourceKind, string> = {
  "codex-builtin-cache": "companion.source.codexBuiltinCache",
  "codex-custom": "companion.source.codexCustom",
  "codex-legacy-avatar": "companion.source.codexLegacyAvatar",
  "piora-bundled": "companion.source.pioraBundled",
  "piora-installed": "companion.source.pioraInstalled",
};
const BUNDLED_PET_IDS = new Set<string>(BUNDLED_COMPANION_PET_IDS);

function resolvePetSourceKind(pet: CompanionPetSource): CompanionPetSourceKind {
  if (pet.sourceKind === "piora-bundled") return pet.sourceKind;
  if (pet.installed && pet.origin && pet.origin in SOURCE_MESSAGE_KEYS) return pet.origin;
  if (pet.sourceKind && pet.sourceKind in SOURCE_MESSAGE_KEYS) return pet.sourceKind;
  return pet.source === "codex" ? "codex-custom" : "piora-installed";
}

function PetPreview({ pet, large = false }: { pet?: CompanionPet; large?: boolean }) {
  return <span className={`${styles.petPreview}${large ? ` ${styles.petPreviewLarge}` : ""}`} aria-hidden="true">
    <span className={styles.petPreviewMotion}>{pet ? <SpritePet pet={pet} status="idle" /> : <BuiltinPet status="idle" />}</span>
  </span>;
}

function PetChoice({ pet, selected, name, meta, onSelect }: { pet?: CompanionPet; selected: boolean; name: string; meta: string; onSelect: () => void }) {
  return <button className={styles.petChoice} type="button" aria-pressed={selected} onClick={onSelect}>
    <PetPreview pet={pet} />
    <span className={styles.petChoiceCopy}><b>{name}</b><small>{meta}</small></span>
    <span className={styles.petChoiceCheck} aria-hidden="true"><AliIcon name={selected ? "check" : "arrowright"} size={12} /></span>
  </button>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  embedded?: boolean;
  companionOpen: boolean;
  onCompanionOpenChange: (open: boolean) => void;
  alwaysOnTop: boolean;
  onAlwaysOnTopChange: (alwaysOnTop: boolean) => void;
  idleTricks: boolean;
  onIdleTricksChange: (idleTricks: boolean) => void;
  desktopMode: boolean;
  preferences: CompanionPreferences;
  setPreferences: Dispatch<SetStateAction<CompanionPreferences>>;
  cwd?: string;
  canSendPhrase?: boolean;
  onSendPhrase?: (text: string) => boolean;
  selectedPetId: string;
  onSelectPet: (petId: string) => void;
  catalog: CompanionPetsResponse | null;
  loading: boolean;
  error: string | null;
  importingPetKey: string | null;
  importingArchive: boolean;
  onRefresh: () => void;
  onImportPet: (pet: CompanionPetSource) => Promise<CompanionPet | null>;
  onImportArchive: (file: File) => Promise<CompanionPet | null>;
}

export function CompanionSettingsDialog({
  open,
  onClose,
  embedded = false,
  companionOpen,
  onCompanionOpenChange,
  alwaysOnTop,
  onAlwaysOnTopChange,
  idleTricks,
  onIdleTricksChange,
  desktopMode,
  preferences,
  setPreferences,
  cwd,
  canSendPhrase,
  onSendPhrase,
  selectedPetId,
  onSelectPet,
  catalog,
  loading,
  error,
  importingPetKey,
  importingArchive,
  onRefresh,
  onImportPet,
  onImportArchive,
}: Props) {
  const { t } = useI18n();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const archiveInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [modelsData, setModelsData] = useState<ModelsData | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [archiveDragActive, setArchiveDragActive] = useState(false);
  useFocusTrap(dialogRef, open && !embedded, { onEscape: onClose });

  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setModelsLoading(true);
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    void fetch(`/api/models${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => response.ok ? response.json() as Promise<ModelsData> : null)
      .then((data) => { if (data) setModelsData(data); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        setModelsData((current) => current ?? {
          models: {}, modelList: [], defaultModel: null, thinkingLevels: {}, thinkingLevelMaps: {}, thinkingLevelPins: {}, modelError: message,
        });
      })
      .finally(() => { if (!controller.signal.aborted) setModelsLoading(false); });
    return () => controller.abort();
  }, [cwd, open]);

  const importArchive = (file: File) => {
    setArchiveDragActive(false);
    void onImportArchive(file).then((imported) => {
      if (imported) onSelectPet(imported.id);
    });
  };

  if (!open || (!embedded && !portalTarget)) return null;

  const installedPets = catalog?.installed ?? [];
  const bundledPets = installedPets.filter((pet) => pet.sourceKind === "piora-bundled" || BUNDLED_PET_IDS.has(pet.id));
  const personalPets = installedPets.filter((pet) => pet.sourceKind !== "piora-bundled" && !BUNDLED_PET_IDS.has(pet.id));
  const selectedPet = installedPets.find((pet) => pet.id === selectedPetId);
  const selectedName = selectedPet?.displayName ?? t("companion.builtinPet");
  const selectedDescription = selectedPet?.description ?? t("companion.builtinPetDescription");

  const content = (
    <div
      className="app-shell-dialog-backdrop"
      role={embedded ? undefined : "dialog"}
      aria-modal={embedded ? undefined : true}
      aria-label={t("companion.settingsTitle")}
      onClick={(event) => {
        if (!embedded && event.target === event.currentTarget) onClose();
      }}
      style={{
        position: embedded ? "relative" : "fixed", inset: embedded ? undefined : 0, zIndex: embedded ? undefined : 1200,
        width: "100%", height: "100%", minHeight: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: embedded ? "var(--bg)" : "rgba(0,0,0,0.35)",
      }}
    >
      <div ref={dialogRef} className={styles.dialog} style={embedded ? { width: "100%", maxWidth: "none", height: "100%", maxHeight: "none", border: 0, borderRadius: 0, boxShadow: "none" } : undefined}>
        <input
          ref={archiveInputRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            importArchive(file);
          }}
        />
        <header className={styles.header}>
          <div>
            <div className={styles.title}>{t("companion.settingsTitle")}</div>
            <div className={styles.subtitle}>{t("companion.settingsDescription")}</div>
          </div>
          {!embedded && <button className={styles.closeButton} type="button" onClick={onClose} title={t("i18n.close")} aria-label={t("i18n.close")}>
            <AliIcon name="close" size={14} />
          </button>}
        </header>

        <div className={styles.body}>
          <div className={styles.displayCard}>
            <span className={styles.displayIcon} aria-hidden="true">
              <AliIcon name="robot" size={18} />
            </span>
            <div className={styles.copy}>
              <div data-settings-id="companion.show" className={styles.label}>{t("companion.showCompanion")}</div>
              <div className={styles.description}>{t("companion.showCompanionDescription")}</div>
            </div>
            <button
              className={styles.switch}
              type="button"
              role="switch"
              aria-checked={companionOpen}
              aria-label={t("companion.showCompanion")}
              onClick={() => onCompanionOpenChange(!companionOpen)}
            >
              <span className={styles.switchThumb} />
            </button>
          </div>

          <div className={styles.displayCard} data-disabled={desktopMode ? undefined : "true"}>
            <span className={styles.displayIcon} aria-hidden="true">
              <AliIcon name="pushpin" size={18} />
            </span>
            <div className={styles.copy}>
              <div data-settings-id="companion.alwaysOnTop" className={styles.label}>{t("companion.alwaysOnTop")}</div>
              <div className={styles.description}>{t("companion.alwaysOnTopDescription")}</div>
            </div>
            <button
              className={styles.switch}
              type="button"
              role="switch"
              aria-checked={alwaysOnTop}
              aria-label={t("companion.alwaysOnTop")}
              disabled={!desktopMode}
              onClick={() => onAlwaysOnTopChange(!alwaysOnTop)}
            >
              <span className={styles.switchThumb} />
            </button>
          </div>

          <div className={styles.displayCard}>
            <span className={styles.displayIcon} aria-hidden="true">
              <AliIcon name="activity" size={18} />
            </span>
            <div className={styles.copy}>
              <div data-settings-id="companion.idle" className={styles.label}>{t("companion.idleTricks")}</div>
              <div className={styles.description}>{t("companion.idleTricksDescription")}</div>
            </div>
            <button
              className={styles.switch}
              type="button"
              role="switch"
              aria-checked={idleTricks}
              aria-label={t("companion.idleTricks")}
              onClick={() => onIdleTricksChange(!idleTricks)}
            >
              <span className={styles.switchThumb} />
            </button>
          </div>

          <div className={styles.modeCard} data-available={desktopMode ? "true" : "false"}>
            <span className={styles.modeIcon} aria-hidden="true"><AliIcon name="layout" size={16} /></span>
            <div className={styles.copy}>
              <div data-settings-id="companion.desktop" className={styles.label}>{t("companion.desktopMode")}</div>
              <div className={styles.description}>{t("companion.desktopModeDescription")}</div>
            </div>
            <span className={styles.modeBadge}>
              {desktopMode ? t("companion.desktopModeReady") : t("companion.desktopModeUnavailable")}
            </span>
            {desktopMode ? <button className={styles.primaryButton} type="button" onClick={() => void window.piDesktop?.companionAction?.("open-panel")}>打开随身舱</button> : null}
          </div>

          <section className={styles.section} aria-labelledby="companion-model-title">
            <div className={styles.sectionHeader}>
              <div>
                <div className={styles.sectionTitle} id="companion-model-title" data-settings-id="companion.model">{t("companion.model.title")}</div>
                <div className={styles.sectionDescription}>{t("companion.model.description")}</div>
              </div>
            </div>
            {desktopMode ? <div className={styles.importCard}>
              <span className={styles.importIcon} aria-hidden="true"><AliIcon name="sparkles" size={17} /></span>
              <div className={styles.copy}>
                <div className={styles.label}>互动模型与隐私策略由随身舱统一管理</div>
                <div className={styles.description}>在那里还可以设置性格、自主程度、安静时段和移动权限。</div>
              </div>
              <button className={styles.primaryButton} type="button" onClick={() => void window.piDesktop?.companionAction?.("open-panel")}>配置心智</button>
            </div> : null}
            <div className={styles.modelCard} style={desktopMode ? { display: "none" } : undefined}>
              <span className={styles.modelIcon} aria-hidden="true"><AliIcon name="sparkles" size={17} /></span>
              <div className={styles.modelControls}>
                <select
                  value={preferences.interactionModel ? JSON.stringify(preferences.interactionModel) : ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    setPreferences((current) => ({ ...current, interactionModel: value ? JSON.parse(value) as { provider: string; modelId: string } : null }));
                  }}
                  aria-label={t("companion.model.select")}
                >
                  <option value="">{modelsLoading ? t("companion.model.loading") : t("companion.model.select")}</option>
                  {preferences.interactionModel && !modelsData?.modelList.some((model) => model.provider === preferences.interactionModel?.provider && model.id === preferences.interactionModel?.modelId) ? (
                    <option value={JSON.stringify(preferences.interactionModel)}>{preferences.interactionModel.provider} · {preferences.interactionModel.modelId} ({t("companion.model.unavailable")})</option>
                  ) : null}
                  {modelsData?.modelList.map((model) => (
                    <option key={`${model.provider}:${model.id}`} value={JSON.stringify({ provider: model.provider, modelId: model.id })}>
                      {model.provider} · {model.name || model.id}
                    </option>
                  ))}
                </select>
                {modelsData?.modelError ? <div className={styles.modelError}>{modelsData.modelError}</div> : null}
                <div className={styles.privacyNote}>{t("companion.model.privacy")}</div>
              </div>
            </div>
            <div className={styles.displayCard} style={desktopMode ? { display: "none" } : { marginTop: 8 }}>
              <span className={styles.displayIcon} aria-hidden="true"><AliIcon name="activity" size={18} /></span>
              <div className={styles.copy}>
                <div className={styles.label}>{t("companion.model.shareContext")}</div>
                <div className={styles.description}>{t("companion.model.shareContextDescription")}</div>
              </div>
              <button className={styles.switch} type="button" role="switch" aria-checked={preferences.shareWorkContext} aria-label={t("companion.model.shareContext")} onClick={() => setPreferences((current) => ({ ...current, shareWorkContext: !current.shareWorkContext }))}>
                <span className={styles.switchThumb} />
              </button>
            </div>
          </section>

          <section className={styles.section} aria-labelledby="companion-workspace-title">
            <div className={styles.sectionHeader}>
              <div>
                <div className={styles.sectionTitle} id="companion-workspace-title">{t("companion.workspaceTitle")}</div>
                <div className={styles.sectionDescription}>{t("companion.workspaceDescription")}</div>
              </div>
            </div>
            {desktopMode ? (
              <div className={styles.importCard}>
                <span className={styles.importIcon} aria-hidden="true"><AliIcon name="layout" size={17} /></span>
                <div className={styles.copy}>
                  <div className={styles.label}>任务、资料与记忆已移到随身舱</div>
                  <div className={styles.description}>独立窗口不会扩大桌宠命中区域，也可以一直放在工作区旁边。</div>
                </div>
                <button className={styles.primaryButton} type="button" onClick={() => void window.piDesktop?.companionAction?.("open-panel")}>打开随身舱</button>
              </div>
            ) : <CompanionDataManager preferences={preferences} setPreferences={setPreferences} canSendPhrase={canSendPhrase} onSendPhrase={onSendPhrase} />}
          </section>

          <CompanionStorageSettings />

          <details className={styles.helpCard}>
            <summary>{t("companion.howToUse")}</summary>
            <ol>
              <li>{t("companion.helpStatus")}</li>
              <li>{t("companion.helpTodos")}</li>
              <li>{t("companion.helpPhrases")}</li>
              <li>{desktopMode ? t("companion.helpDesktop") : t("companion.helpBrowser")}</li>
            </ol>
          </details>

          <section className={`${styles.section} ${styles.petStudio}`} aria-labelledby="companion-installed-pets-title">
            <div className={styles.sectionHeader}>
              <div>
                <div className={styles.sectionTitle} id="companion-installed-pets-title" data-settings-id="companion.appearance">{t("companion.petAppearance")}</div>
                <div className={styles.sectionDescription}>{t("companion.petAppearanceDescription")}</div>
              </div>
              <span className={styles.bundledCount}>{t("companion.bundledCount", { count: bundledPets.length + 1 })}</span>
            </div>
            <div className={styles.petStage}>
              <PetPreview pet={selectedPet} large />
              <div className={styles.petStageCopy}>
                <span><i />{t("companion.livePreview")}</span>
                <b>{selectedName}</b>
                <p>{selectedDescription}</p>
              </div>
            </div>
            <div className={styles.petChoiceGrid} role="group" aria-label={t("companion.builtinCollection")}>
              <PetChoice selected={selectedPetId === "builtin"} name={t("companion.builtinPet")} meta={t("companion.builtinPetDescription")} onSelect={() => onSelectPet("builtin")} />
              {bundledPets.map((pet) => <PetChoice key={`bundled:${pet.id}`} pet={pet} selected={selectedPetId === pet.id} name={pet.displayName} meta={pet.description ?? t("companion.source.pioraBundled")} onSelect={() => onSelectPet(pet.id)} />)}
            </div>
            {personalPets.length ? <>
              <div className={styles.collectionLabel}>{t("companion.myPets")}</div>
              <div className={styles.petChoiceGrid} role="group" aria-label={t("companion.myPets")}>
                {personalPets.map((pet) => <PetChoice key={`installed:${pet.id}`} pet={pet} selected={selectedPetId === pet.id} name={pet.displayName} meta={t(SOURCE_MESSAGE_KEYS[resolvePetSourceKind(pet as CompanionPetSource)])} onSelect={() => onSelectPet(pet.id)} />)}
              </div>
            </> : null}
          </section>

          <section className={styles.section} aria-labelledby="companion-import-zip-title">
            <div className={styles.sectionHeader}>
              <div>
                <div className={styles.sectionTitle} id="companion-import-zip-title">{t("companion.importZip")}</div>
                <div className={styles.sectionDescription}>{t("companion.importZipDescription")}</div>
              </div>
            </div>
            <div
              className={styles.petDropZone}
              data-active={archiveDragActive || undefined}
              data-busy={importingArchive || undefined}
              onDragEnter={(event) => { event.preventDefault(); setArchiveDragActive(true); }}
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setArchiveDragActive(true); }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setArchiveDragActive(false); }}
              onDrop={(event) => {
                event.preventDefault();
                const file = event.dataTransfer.files[0];
                if (file) importArchive(file);
                else setArchiveDragActive(false);
              }}
            >
              <span className={styles.dropZoneIcon} aria-hidden="true"><AliIcon name={archiveDragActive ? "download" : "import"} size={20} /></span>
              <div><b>{archiveDragActive ? t("companion.dropZipActive") : t("companion.dropZip")}</b><span>{t("companion.importZipHint")}</span></div>
              <button className={styles.primaryButton} type="button" disabled={importingArchive || importingPetKey !== null} onClick={() => archiveInputRef.current?.click()}>{importingArchive ? t("companion.importing") : t("companion.chooseZip")}</button>
              <a data-open-pet-runtime href="https://github.com/alvinunreal/openpets" target="_blank" rel="noreferrer noopener">{t("companion.browseCatalog")}<AliIcon name="external-link" size={11} /></a>
            </div>

            {catalog?.sources.length ? <details className={styles.localPetSources}>
              <summary><span>{t("companion.discoveredCodexPets")}</span><small>{catalog.sources.length}</small><AliIcon name="arrowdown" size={11} /></summary>
              <div className={styles.localPetToolbar}><span>{t("companion.localOnly")}</span><button type="button" onClick={onRefresh} disabled={loading}>{t("companion.refresh")}</button></div>
              <ul className={styles.petList}>
                {catalog.sources.map((pet) => {
                  const sourcedPet = pet as CompanionPetSource;
                  const sourceKey = getCompanionPetSourceKey(sourcedPet);
                  return <li className={styles.petRow} key={`source:${sourceKey}`}>
                    <PetPreview pet={pet} />
                    <div className={styles.copy}><div className={styles.petName}>{pet.displayName}</div><div className={styles.petMeta}>{t(SOURCE_MESSAGE_KEYS[resolvePetSourceKind(sourcedPet)])} · {t("companion.codexCompatibleVersion", { version: pet.spriteVersionNumber })}</div></div>
                    <button className={styles.primaryButton} type="button" disabled={importingPetKey !== null} onClick={() => { void onImportPet(sourcedPet).then((imported) => { if (imported) onSelectPet(imported.id); }); }}>{importingPetKey === sourceKey ? t("companion.importing") : t("companion.import")}</button>
                  </li>;
                })}
              </ul>
            </details> : null}
            {loading && !catalog ? <div className={styles.notice}>{t("companion.loadingPets")}</div> : null}
            {error ? <div className={styles.error} role="alert">{error}</div> : null}
            {catalog?.diagnostics.map((diagnostic, index) => (
              <div className={styles.diagnostic} key={`${diagnostic.scope}:${diagnostic.id ?? "general"}:${index}`}>{diagnostic.message}</div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
  return embedded ? content : createPortal(content, portalTarget!);
}
