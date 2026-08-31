'use client';

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
        // eslint-disable-next-line @next/next/no-img-element
        <img src={item.assetUrl} width="1200" height="720" alt={item.type === 'image' ? t('Compare {side} · source photo', { side }) : t('Compare {side} · version {version}', { side, version: item.canvasVersion ?? 1 })} />
      ) : <div className="lineage-image-missing">{item.deletedAt ? t('Original removed by its creator') : t('This image is no longer available.')}</div>}
      {item.body ? <p>{item.body}</p> : null}
    </figure>
  );
}

export default function DrawingLineage({
  lineage,
  initialId,
  loading,
  error,
  truncated,
  onClose,
  onRetry,
  onContinue,
  canDecide,
  onDecision,
  decisionOwners,
}: {
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
  const initialCurrent = lineage.find((item) => item.id === initialId) ?? lineage[lineage.length - 1];
  const initialCurrentIndex = initialCurrent ? lineage.indexOf(initialCurrent) : -1;
  const initialParent = lineage.find((item) => item.id === initialCurrent?.canvasParentId)
    ?? (initialCurrentIndex > 0 ? lineage[initialCurrentIndex - 1] : undefined)
    ?? initialCurrent;
  const [selectedId, setSelectedId] = useState(initialCurrent?.id ?? initialId);
  const [leftId, setLeftId] = useState(initialParent?.id ?? initialId);
  const [rightId, setRightId] = useState(initialCurrent?.id ?? initialId);
  const [mobileSide, setMobileSide] = useState<'A' | 'B'>('B');
  const [decisionNote, setDecisionNote] = useState(initialCurrent?.decisionNote ?? '');
  const [decisionBusy, setDecisionBusy] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => titleRef.current?.focus());
  }, []);

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
  const left = byId.get(leftId) ?? lineage[0];
  const right = byId.get(rightId) ?? lineage[lineage.length - 1];
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(localeTag(locale), {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }), [locale]);
  const selectVersion = (item: CanvasLineageItem) => {
    const parent = item.canvasParentId ? byId.get(item.canvasParentId) : null;
    setSelectedId(item.id);
    setLeftId(parent?.id ?? item.id);
    setRightId(item.id);
    setMobileSide('B');
    setDecisionNote(item.decisionNote ?? '');
  };
  const versionLabel = (item: CanvasLineageItem) => {
    if (item.type === 'image') return t('Source Photo');
    const siblings = siblingsByParent.get(item.canvasParentId ?? 'root') ?? [item];
    const branch = siblings.findIndex((sibling) => sibling.id === item.id) + 1;
    return siblings.length > 1
      ? t('Version {version} · Branch {branch}', { version: item.canvasVersion ?? 1, branch })
      : t('Version {version}', { version: item.canvasVersion ?? 1 });
  };

  return (
    <AppDialog open onClose={onClose} labelledBy="lineage-title" describedBy="lineage-description" className="lineage-backdrop">
      <section className="lineage-dialog">
        <header className="lineage-header">
          <div>
            <span className="eyebrow">{lineage[0]?.type === 'image' ? t('Photo Thread') : t('Drawing Thread')}</span>
            <h2 id="lineage-title" ref={titleRef} tabIndex={-1}>{t('Visual History')}</h2>
            <p id="lineage-description">{lineage[0]?.type === 'image' ? t('Based on {name}’s photo. Compare variations, then continue from the direction that feels right.', { name: lineage[0].senderName }) : t('Compare changes, then continue from the version that feels right.')}</p>
          </div>
          <button type="button" className="dialog-close" onClick={onClose} aria-label={t('Close')}>×</button>
        </header>

        {loading ? <div className="lineage-loading" role="status">{t('Loading drawing history…')}</div> : null}
        {!loading && error ? <div className="lineage-error" role="alert"><p>{error}</p><button type="button" className="secondary-button" onClick={onRetry}>{t('Try Again')}</button></div> : null}
        {!loading && !error && lineage.length ? (
          <>
            <div className="lineage-count">{lineage[0]?.type === 'image' ? t('Source photo and {count} versions', { count: Math.max(0, lineage.length - 1) }) : t('{count} versions', { count: lineage.length })}</div>
            {truncated ? <p className="lineage-limit-note" role="status">{t('Showing the first 200 connected versions. Continue from a visible version or narrow the thread later.')}</p> : null}
            <nav className="lineage-timeline" aria-label={t('Drawing versions')}>
              {lineage.map((item) => {
                return (
                  <button type="button" key={item.id} className={selected?.id === item.id ? 'active' : ''} aria-pressed={selected?.id === item.id} onClick={() => selectVersion(item)}>
                    <span>{versionLabel(item)}</span>
                    <strong>{item.senderName}</strong>
                    <small>{dateFormatter.format(new Date(item.createdAt))}</small><em className={`visual-status ${item.visualStatus}`}>{item.visualStatus === 'selected' ? t('Selected') : item.visualStatus === 'needs_changes' ? t('Needs Changes') : t('Exploring')}</em>
                  </button>
                );
              })}
            </nav>

            <section className="lineage-compare" aria-labelledby="lineage-compare-title">
              <div className="lineage-compare-heading">
                <div><span className="eyebrow">{t('Compare')}</span><h3 id="lineage-compare-title">{t('See What Changed')}</h3></div>
                <div className="lineage-selectors">
                  <label>{t('Compare Version A')}<select value={left?.id ?? ''} onChange={(event) => setLeftId(event.target.value)}>{lineage.map((item) => <option key={item.id} value={item.id}>{versionLabel(item)} · {item.senderName}</option>)}</select></label>
                  <label>{t('Compare Version B')}<select value={right?.id ?? ''} onChange={(event) => setRightId(event.target.value)}>{lineage.map((item) => <option key={item.id} value={item.id}>{versionLabel(item)} · {item.senderName}</option>)}</select></label>
                </div>
              </div>
              {left && right ? <><div className="lineage-mobile-toggle" role="group" aria-label={t('Choose version to preview')}><button type="button" className={mobileSide === 'A' ? 'active' : ''} aria-pressed={mobileSide === 'A'} onClick={() => setMobileSide('A')}>A · {versionLabel(left)}</button><button type="button" className={mobileSide === 'B' ? 'active' : ''} aria-pressed={mobileSide === 'B'} onClick={() => setMobileSide('B')}>B · {versionLabel(right)}</button></div><div className="lineage-compare-grid"><VersionImage item={left} side="A" mobileActive={mobileSide === 'A'} /><VersionImage item={right} side="B" mobileActive={mobileSide === 'B'} /></div></> : null}
            </section>

            {selected ? <section className="lineage-decision" aria-labelledby="lineage-decision-title"><div><span className="eyebrow">{t('Team Direction')}</span><h3 id="lineage-decision-title">{t('Shortlist and decide')}</h3><p>{t('Votes help the team compare directions. The conversation owner records the final decision.')}</p></div><button type="button" className={selected.voted ? 'vote-button active' : 'vote-button'} aria-pressed={selected.voted} disabled={decisionBusy} onClick={async () => { setDecisionBusy(true); try { await onDecision(selected, { voted: !selected.voted }); } finally { setDecisionBusy(false); } }}>{selected.voted ? t('Shortlisted') : t('Shortlist')} · {selected.voteCount}</button>{canDecide ? <div className="decision-owner-controls"><label>{t('Status')}<select value={selected.visualStatus} onChange={async (event) => { setDecisionBusy(true); try { await onDecision(selected, { status: event.target.value as CanvasLineageItem['visualStatus'], note: decisionNote }); } finally { setDecisionBusy(false); } }} disabled={decisionBusy}><option value="exploring">{t('Exploring')}</option><option value="needs_changes">{t('Needs Changes')}</option><option value="selected">{t('Selected')}</option></select></label><label>{t('Decision Owner')}<select value={selected.decisionOwnerId ?? ''} onChange={async (event) => { setDecisionBusy(true); try { await onDecision(selected, { ownerId: event.target.value || null }); } finally { setDecisionBusy(false); } }} disabled={decisionBusy}><option value="">{t('Not Assigned')}</option>{decisionOwners.map((owner) => <option key={owner.id} value={owner.id}>{owner.displayName}</option>)}</select></label><label>{t('Decision Note')}<textarea value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} maxLength={500} placeholder={t('Why this direction, and what should happen next?')} /></label><button type="button" className="secondary-button" disabled={decisionBusy} onClick={async () => { setDecisionBusy(true); try { await onDecision(selected, { status: selected.visualStatus, note: decisionNote, ownerId: selected.decisionOwnerId }); } finally { setDecisionBusy(false); } }}>{t('Save Decision')}</button></div> : selected.decisionNote ? <blockquote>{selected.decisionNote}</blockquote> : null}</section> : null}

            {selected ? <footer className="lineage-footer"><div><strong>{selected.visualStatus === 'selected' ? t('Continue Selected Direction') : selected.type === 'image' ? t('Continue with This Photo') : t('Continue from version {version}', { version: selected.canvasVersion ?? 1 })}</strong><small>{t('The selected visual stays unchanged. Your contribution becomes a new branch.')}</small></div><button type="button" className="primary-button" onClick={() => onContinue(selected)} disabled={!selected.assetKey}>{selected.visualStatus === 'selected' ? t('Continue Selected Direction') : selected.type === 'image' ? t('Continue with This Photo') : t('Continue from version {version}', { version: selected.canvasVersion ?? 1 })}</button></footer> : null}
          </>
        ) : null}
      </section>
    </AppDialog>
  );
}
