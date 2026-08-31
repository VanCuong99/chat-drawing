'use client';

/* eslint-disable @next/next/no-img-element -- lineage assets use short-lived authenticated URLs that cannot be delegated to the image optimizer. */

import { useEffect, useMemo, useRef, useState } from 'react';
import AppDialog from '@/src/shared/app-dialog';
import type { CanvasLineageItem } from '@/src/shared/chat.types';
import { useLanguage } from '@/src/i18n/language-provider';
import { localeTag } from '@/src/i18n/messages';

function VersionImage({ item, side, mobileActive }: { item: CanvasLineageItem; side: 'A' | 'B'; mobileActive: boolean }) {
  const { t } = useLanguage();
  const label = item.type === 'image' ? t('Source Photo') : t('Version {version}', { version: item.canvasVersion ?? 1 });
  return (
    <figure className={mobileActive ? 'lineage-compare-card mobile-active' : 'lineage-compare-card'}>
      <figcaption><span>{side}</span><strong>{label}</strong><small>{item.senderName}</small></figcaption>
      {item.assetUrl ? (
        // The API returns a short-lived, room-scoped URL for each version.
        <img src={item.assetUrl} width="1200" height="720" alt={item.type === 'image' ? t('Compare {side} · source photo', { side }) : t('Compare {side} · version {version}', { side, version: item.canvasVersion ?? 1 })} />
      ) : <div className="lineage-image-missing">{item.deletedAt ? t('Original removed by its creator') : t('This image is no longer available.')}</div>}
      {item.body ? <p>{item.body}</p> : null}
    </figure>
  );
}

export default function DrawingLineage({ lineage, initialId, loading, error, truncated, onClose, onRetry, onContinue, canDecide, onDecision, decisionOwners }: {
  lineage: CanvasLineageItem[];
  initialId: string;
  loading: boolean;
  error: string;
  truncated: boolean;
  onClose: () => void;
  onRetry: () => void;
  onContinue: (item: CanvasLineageItem) => void;
  canDecide: boolean;
  onDecision: (item: CanvasLineageItem, input: { voted?: boolean; status?: CanvasLineageItem['visualStatus']; note?: string; ownerId?: string | null }) => Promise<void>;
  decisionOwners: Array<{ id: string; displayName: string }>;
}) {
  const { locale, t } = useLanguage();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const compareTitleRef = useRef<HTMLHeadingElement>(null);
  const initialCurrent = lineage.find((item) => item.id === initialId) ?? lineage[lineage.length - 1];
  const initialCurrentIndex = initialCurrent ? lineage.indexOf(initialCurrent) : -1;
  const initialParent = lineage.find((item) => item.id === initialCurrent?.canvasParentId) ?? (initialCurrentIndex > 0 ? lineage[initialCurrentIndex - 1] : undefined) ?? initialCurrent;
  const [selectedId, setSelectedId] = useState(initialCurrent?.id ?? initialId);
  const [compareId, setCompareId] = useState(initialParent?.id ?? initialId);
  const [compareMode, setCompareMode] = useState(false);
  const [mobileSide, setMobileSide] = useState<'A' | 'B'>('B');
  const [decisionNote, setDecisionNote] = useState(initialCurrent?.decisionNote ?? '');
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [editingDecision, setEditingDecision] = useState(false);

  useEffect(() => { requestAnimationFrame(() => titleRef.current?.focus()); }, []);

  const byId = useMemo(() => new Map(lineage.map((item) => [item.id, item])), [lineage]);
  const siblingsByParent = useMemo(() => {
    const groups = new Map<string, CanvasLineageItem[]>();
    for (const item of lineage) {
      const key = item.canvasParentId ?? 'root';
      const siblings = groups.get(key) ?? [];
      siblings.push(item);
      groups.set(key, siblings);
    }
    return groups;
  }, [lineage]);
  const selected = byId.get(selectedId) ?? lineage[lineage.length - 1];
  const compare = byId.get(compareId) ?? lineage[0];
  const canCompare = lineage.length > 1;
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(localeTag(locale), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }), [locale]);
  const versionLabel = (item: CanvasLineageItem) => {
    if (item.type === 'image') return t('Source Photo');
    const siblings = siblingsByParent.get(item.canvasParentId ?? 'root') ?? [item];
    const branch = siblings.findIndex((sibling) => sibling.id === item.id) + 1;
    return siblings.length > 1 ? t('Version {version} · Branch {branch}', { version: item.canvasVersion ?? 1, branch }) : t('Version {version}', { version: item.canvasVersion ?? 1 });
  };
  const selectVersion = (item: CanvasLineageItem) => {
    const parent = item.canvasParentId ? byId.get(item.canvasParentId) : null;
    setSelectedId(item.id);
    if (parent) setCompareId(parent.id);
    setMobileSide('B');
    setDecisionNote(item.decisionNote ?? '');
    setEditingDecision(false);
  };
  const selectedLabel = selected ? versionLabel(selected) : '';
  const continueLabel = selected?.visualStatus === 'selected'
    ? t('Continue from {version} · selected by team', { version: selectedLabel })
    : selected?.type === 'image' ? t('Continue with This Photo') : t('Continue from version {version}', { version: selected?.canvasVersion ?? 1 });
  const toggleCompare = () => {
    const nextMode = !compareMode;
    setCompareMode(nextMode);
    if (nextMode) requestAnimationFrame(() => compareTitleRef.current?.focus());
  };

  return (
    <AppDialog open onClose={onClose} labelledBy="lineage-title" describedBy="lineage-description" className="lineage-backdrop">
      <section className="lineage-dialog">
        <header className="lineage-header"><div><span className="eyebrow">{lineage[0]?.type === 'image' ? t('Photo Thread') : t('Drawing Thread')}</span><h2 id="lineage-title" ref={titleRef} tabIndex={-1}>{t('Visual History')}</h2><p id="lineage-description">{t('Choose a direction, compare only when needed, then continue it as a new branch.')}</p></div><button type="button" className="dialog-close" onClick={onClose} aria-label={t('Close')}><svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="m6 6 12 12" /><path d="M18 6 6 18" /></svg></button></header>
        {loading ? <div className="lineage-loading" role="status">{t('Loading drawing history…')}</div> : null}
        {!loading && error ? <div className="lineage-error" role="alert"><p>{error}</p><button type="button" className="secondary-button" onClick={onRetry}>{t('Try Again')}</button></div> : null}
        {!loading && !error && lineage.length && selected ? <><div className="lineage-scroll-content">
          <div className="lineage-summary-bar"><span>{lineage[0]?.type === 'image' ? t('Source photo and {count} versions', { count: Math.max(0, lineage.length - 1) }) : t('{count} versions', { count: lineage.length })}</span>{canCompare ? <button type="button" className={compareMode ? 'active' : ''} aria-pressed={compareMode} onClick={toggleCompare}>{compareMode ? t('Close Compare') : t('Compare Versions')}</button> : null}</div>
          {truncated ? <p className="lineage-limit-note" role="status">{t('Showing the first 200 connected versions. Continue from a visible version or narrow the thread later.')}</p> : null}
          {canCompare && compareMode && compare ? <section className="lineage-compare lineage-compare-primary" aria-labelledby="lineage-compare-title"><div className="lineage-compare-heading"><div><span className="eyebrow">{t('Compare')}</span><h3 id="lineage-compare-title" ref={compareTitleRef} tabIndex={-1}>{t('Compare with {version}', { version: selectedLabel })}</h3></div><label>{t('Compare Against')}<select value={compare.id} onChange={(event) => { setCompareId(event.target.value); setMobileSide('A'); }}>{lineage.filter((item) => item.id !== selected.id).map((item) => <option key={item.id} value={item.id}>{versionLabel(item)} · {item.senderName}</option>)}</select></label></div><div className="lineage-mobile-toggle" role="group" aria-label={t('Choose version to preview')}><button type="button" className={mobileSide === 'A' ? 'active' : ''} aria-pressed={mobileSide === 'A'} onClick={() => setMobileSide('A')}>A · {versionLabel(compare)}</button><button type="button" className={mobileSide === 'B' ? 'active' : ''} aria-pressed={mobileSide === 'B'} onClick={() => setMobileSide('B')}>B · {selectedLabel}</button></div><div className="lineage-compare-grid"><VersionImage item={compare} side="A" mobileActive={mobileSide === 'A'} /><VersionImage item={selected} side="B" mobileActive={mobileSide === 'B'} /></div></section> : <section className="lineage-current" aria-labelledby="lineage-current-title"><div className="lineage-current-heading"><div><span className={`visual-status ${selected.visualStatus}`}>{selected.visualStatus === 'selected' ? t('Selected') : selected.visualStatus === 'needs_changes' ? t('Needs Changes') : t('Exploring')}</span><h3 id="lineage-current-title">{selectedLabel}</h3><p>{t('By {name} · {date}', { name: selected.senderName, date: dateFormatter.format(new Date(selected.createdAt)) })}</p></div>{selected.canvasParentId ? <small>{t('Continued from {version}', { version: byId.get(selected.canvasParentId) ? versionLabel(byId.get(selected.canvasParentId)!) : t('an earlier visual') })}</small> : <small>{t('Original direction')}</small>}</div><figure className="lineage-hero-artwork">{selected.assetUrl ? <><img src={selected.assetUrl} width="1200" height="720" alt={selected.type === 'image' ? t('Source photo by {name}', { name: selected.senderName }) : t('Drawing version {version} by {name}', { version: selected.canvasVersion ?? 1, name: selected.senderName })} /></> : <div className="lineage-image-missing">{selected.deletedAt ? t('Original removed by its creator') : t('This image is no longer available.')}</div>}{selected.body ? <figcaption>{selected.body}</figcaption> : null}</figure></section>}
          <nav className="lineage-filmstrip" aria-label={t('Drawing versions')}>{lineage.map((item) => <button type="button" key={item.id} className={selected.id === item.id ? 'active' : ''} aria-pressed={selected.id === item.id} onClick={() => selectVersion(item)}>{item.assetUrl ? <><img src={item.assetUrl} width="160" height="96" loading="lazy" alt="" /></> : <span className="filmstrip-missing" aria-hidden="true" />}<span><strong>{versionLabel(item)}</strong><small>{item.senderName}</small><em>{item.canvasParentId && byId.get(item.canvasParentId) ? t('From {version}', { version: versionLabel(byId.get(item.canvasParentId)!) }) : t('Starting Point')}</em></span></button>)}</nav>
          <section className="lineage-decision" aria-labelledby="lineage-decision-title"><div><span className="eyebrow">{t('Team Direction')}</span><h3 id="lineage-decision-title">{selected.visualStatus === 'selected' ? t('Selected Direction') : selected.visualStatus === 'needs_changes' ? t('Needs Another Pass') : t('Still Exploring')}</h3><p>{selected.decisionNote || t('Shortlist this direction or record what the team should do next.')}</p>{selected.decidedAt ? <small>{t('Updated {date}', { date: dateFormatter.format(new Date(selected.decidedAt)) })}</small> : null}</div><div className="lineage-decision-actions"><button type="button" className={selected.voted ? 'vote-button active' : 'vote-button'} aria-pressed={selected.voted} disabled={decisionBusy} onClick={async () => { setDecisionBusy(true); try { await onDecision(selected, { voted: !selected.voted }); } finally { setDecisionBusy(false); } }}>{selected.voted ? t('Shortlisted') : t('Shortlist')} · {selected.voteCount}</button>{canDecide ? <button type="button" className="secondary-button" aria-expanded={editingDecision} onClick={() => setEditingDecision((value) => !value)}>{editingDecision ? t('Close Editor') : t('Edit Decision')}</button> : null}</div>{canDecide && editingDecision ? <div className="decision-owner-controls"><label>{t('Status')}<select value={selected.visualStatus} onChange={async (event) => { setDecisionBusy(true); try { await onDecision(selected, { status: event.target.value as CanvasLineageItem['visualStatus'], note: decisionNote }); } finally { setDecisionBusy(false); } }} disabled={decisionBusy}><option value="exploring">{t('Exploring')}</option><option value="needs_changes">{t('Needs Changes')}</option><option value="selected">{t('Selected')}</option></select></label><label>{t('Decision Owner')}<select value={selected.decisionOwnerId ?? ''} onChange={async (event) => { setDecisionBusy(true); try { await onDecision(selected, { ownerId: event.target.value || null }); } finally { setDecisionBusy(false); } }} disabled={decisionBusy}><option value="">{t('Not Assigned')}</option>{decisionOwners.map((owner) => <option key={owner.id} value={owner.id}>{owner.displayName}</option>)}</select></label><label>{t('Decision Note')}<textarea value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} maxLength={500} placeholder={t('Why this direction, and what should happen next?')} /></label><button type="button" className="secondary-button" disabled={decisionBusy} onClick={async () => { setDecisionBusy(true); try { await onDecision(selected, { status: selected.visualStatus, note: decisionNote, ownerId: selected.decisionOwnerId }); setEditingDecision(false); } finally { setDecisionBusy(false); } }}>{t('Save Decision')}</button></div> : null}</section>
          </div>
          <footer className="lineage-footer"><div><strong>{continueLabel}</strong><small>{t('The selected visual stays unchanged. Your contribution becomes a new branch.')}</small></div><button type="button" className="primary-button" onClick={() => onContinue(selected)} disabled={!selected.assetKey}>{continueLabel}</button></footer>
        </> : null}
      </section>
    </AppDialog>
  );
}
