// berg:work: the Comments panel: every comment of the document with type and author filters, replies and review
// status, jump to the comment, XFDF export and import. The list is read from the session (see comment-index.js);
// the shell supplies the actions through measureStore (loadComments, reply, setStatus, reveal, exportXfdf,
// importXfdf).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { icon } from '../../../../../assets/icons.js';
import { REVIEW_STATES } from '../engine/comment-index.js';
import { commentToolStore, useCommentToolSettings } from './comment-tools.jsx';
import { useMeasureState } from './measure-layer.jsx';

const Icon = ({ name }) => <span className="oo-pdf-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon(name) }} />;

const TYPE_ICONS = {
  Note: 'sticky-note', 'Text box': 'text-box', Typewriter: 'type', Callout: 'message-square', Line: 'minus', Arrow: 'arrow-right',
  Rectangle: 'square', Ellipse: 'circle', Polygon: 'shapes', Polyline: 'measure-perimeter', Cloud: 'cloud', Drawing: 'pencil',
  Highlight: 'highlighter', Underline: 'underline', Strikethrough: 'strikethrough', Stamp: 'stamp', Redaction: 'scissors',
  Distance: 'measure-distance', Perimeter: 'measure-perimeter', Area: 'measure-area',
};
const STATUS_LABEL = { None: 'No status', Accepted: 'Accepted', Rejected: 'Rejected', Cancelled: 'Cancelled', Completed: 'Completed' };

function formatDate(value, locale) {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  } catch {
    return value;
  }
}

function CommentRow({ comment, author, onReveal, onReply, onStatus }) {
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      await onReply(comment, draft);
      setDraft('');
      setReplying(false);
    } catch { /* the shell shows the error */ } finally { setBusy(false); }
  };
  return (
    <li className={`oo-pdf-comment-row status-${comment.status.toLowerCase()}`}>
      <button type="button" className="oo-pdf-comment-main" onClick={() => onReveal(comment)} title="Show on the page">
        <span className="oo-pdf-comment-swatch" style={{ color: comment.color || undefined }}><Icon name={TYPE_ICONS[comment.type] || 'message-square'} /></span>
        <span className="oo-pdf-comment-text">
          <span className="oo-pdf-comment-meta">
            <strong>{comment.type}</strong>
            <span>p. {comment.pageNumber}</span>
            {comment.author && <span>{comment.author}</span>}
            {(comment.modified || comment.created) && <span>{formatDate(comment.modified || comment.created)}</span>}
          </span>
          {comment.contents && <span className="oo-pdf-comment-contents">{comment.contents}</span>}
        </span>
      </button>
      {comment.replies.length > 0 && (
        <ul className="oo-pdf-comment-replies" aria-label="Replies">
          {comment.replies.map((reply, index) => (
            <li key={reply.objectNumber ?? index}>
              <span className="oo-pdf-comment-meta"><strong>{reply.author || 'Reply'}</strong><span>{formatDate(reply.modified)}</span></span>
              <span className="oo-pdf-comment-contents">{reply.contents}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="oo-pdf-comment-actions">
        <select aria-label="Review status" value={comment.status} title={comment.statusAuthor ? `Set by ${comment.statusAuthor}` : 'Review status'}
          onChange={event => onStatus(comment, event.target.value)}>
          {REVIEW_STATES.map(state => <option key={state} value={state}>{STATUS_LABEL[state]}</option>)}
        </select>
        {!replying && <button type="button" className="oo-pdf-ghost-button" onClick={() => setReplying(true)}>Reply</button>}
      </div>
      {replying && (
        <div className="oo-pdf-comment-reply">
          <textarea rows="2" aria-label="Reply" value={draft} autoFocus placeholder={author ? `Reply as ${author}` : 'Reply'}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); }
              if (event.key === 'Escape') { event.stopPropagation(); setReplying(false); }
            }} />
          <div className="oo-pdf-comment-actions">
            <button type="button" className="oo-pdf-primary-button" disabled={busy || !draft.trim()} onClick={send}>Send</button>
            <button type="button" className="oo-pdf-ghost-button" onClick={() => setReplying(false)}>Cancel</button>
          </div>
        </div>
      )}
    </li>
  );
}

/** Body of the Comments panel in the tools drawer. `revision` changes after every document change. */
export function CommentListPanel({ docId, revision = 0, disabled = false }) {
  const measure = useMeasureState();
  const settings = useCommentToolSettings();
  const [comments, setComments] = useState(null);
  const [error, setError] = useState('');
  const [type, setType] = useState('');
  const [author, setAuthor] = useState('');
  const [status, setStatus] = useState('');
  const [notice, setNotice] = useState('');
  const fileRef = useRef(null);
  const actions = measure.actions;

  useEffect(() => {
    let cancelled = false;
    if (!docId || !actions.loadComments) { setComments(null); return undefined; }
    const timer = setTimeout(() => {
      actions.loadComments()
        .then(list => { if (!cancelled) { setComments(list); setError(''); } })
        .catch(loadError => { if (!cancelled) setError(loadError?.message || 'The comments could not be read.'); });
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [actions, docId, revision]);

  const types = useMemo(() => [...new Set((comments || []).map(item => item.type))].sort(), [comments]);
  const authors = useMemo(() => [...new Set((comments || []).map(item => item.author).filter(Boolean))].sort(), [comments]);
  const shown = (comments || []).filter(item => (!type || item.type === type) && (!author || item.author === author) &&
    (!status || item.status === status));
  const reply = (comment, value) => actions.reply?.(comment, value, settings.author);
  const setReviewStatus = (comment, state) => actions.setStatus?.(comment, state, settings.author);

  return (
    <div className="oo-pdf-comment-list">
      <div className="oo-pdf-comment-filters" role="group" aria-label="Filter comments">
        <select aria-label="Type" value={type} onChange={event => setType(event.target.value)}>
          <option value="">All types</option>
          {types.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
        <select aria-label="Author" value={author} onChange={event => setAuthor(event.target.value)}>
          <option value="">Anyone</option>
          {authors.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
        <select aria-label="Status" value={status} onChange={event => setStatus(event.target.value)}>
          <option value="">Status</option>
          {REVIEW_STATES.map(value => <option key={value} value={value}>{STATUS_LABEL[value]}</option>)}
        </select>
      </div>
      <label className="oo-pdf-comment-author">Your name <input type="text" value={settings.author} placeholder="For replies and new comments"
        onChange={event => commentToolStore.set({ author: event.target.value })} /></label>
      {error && <p className="oo-pdf-measure-error" role="alert">{error}</p>}
      {notice && <p className="oo-pdf-mini-stat" role="status">{notice}</p>}
      {comments == null && !error && <p className="oo-pdf-mini-stat">Reading comments…</p>}
      {comments && !shown.length && <p className="oo-pdf-mini-stat">{comments.length ? 'No comment matches the filter.' : 'This PDF has no comments yet.'}</p>}
      <ul className="oo-pdf-comment-items" aria-label="Comments">
        {shown.map(comment => (
          <CommentRow key={`${comment.pageIndex}:${comment.objectNumber ?? comment.annotationIndex}`} comment={comment} author={settings.author}
            onReveal={value => actions.reveal?.(value)} onReply={reply} onStatus={setReviewStatus} />
        ))}
      </ul>
      <div className="oo-pdf-comment-footer">
        <span className="oo-pdf-context-value">{comments ? `${shown.length} of ${comments.length}` : ''}</span>
        <button type="button" disabled={disabled || !comments?.length} onClick={() => actions.exportXfdf?.()} title="All comments as an XFDF file (Acrobat, PDF-XChange)">
          <Icon name="download" /><span>Export XFDF</span>
        </button>
        <button type="button" disabled={disabled} onClick={() => fileRef.current?.click()} title="Add the comments of an XFDF file">
          <Icon name="folder-open" /><span>Import XFDF</span>
        </button>
        <input ref={fileRef} className="sr-only" tabIndex={-1} type="file" accept=".xfdf,application/vnd.adobe.xfdf,application/xml,text/xml"
          onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            setNotice('');
            void file.text().then(content => actions.importXfdf?.(content)).then(result => {
              if (result) setNotice(`${result.added} comment${result.added === 1 ? '' : 's'} added${result.skipped ? `, ${result.skipped} already there or not placeable` : ''}.`);
            }).catch(() => {});
          }} />
      </div>
    </div>
  );
}
