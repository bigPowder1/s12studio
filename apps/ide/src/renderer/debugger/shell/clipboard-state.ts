/**
 * What the toolbar's Cut/Copy/Paste can act on right now. hiwave greys these buttons unless the focused component can
 * take them (MFC update-UI; the reference screenshot shows them greyed with the Source window active and nothing
 * selected): Copy needs selected text, Cut a selection in an editable field, Paste an editable field with the focus
 * (the Command line, an edit in the Memory or Register window).
 */
import { useEffect, useState } from 'react';

export interface ClipboardState {
  cut: boolean;
  copy: boolean;
  paste: boolean;
}

export const NO_CLIPBOARD: ClipboardState = { cut: false, copy: false, paste: false };

/** Clipboard state from the focused element and the document selection. */
export function clipboardState(doc: Document = document): ClipboardState {
  const el = doc.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // a Monaco view keeps its selection in its (read-only) textarea, so Copy works there too
    const editable = !el.readOnly && !el.disabled;
    const s = el.selectionStart;
    const selected = s !== null && s !== el.selectionEnd;
    return { cut: editable && selected, copy: selected, paste: editable };
  }
  const editable = el instanceof HTMLElement && el.isContentEditable === true;
  const selected = (doc.getSelection()?.toString() ?? '').length > 0;
  return { cut: editable && selected, copy: selected, paste: editable };
}

/** clipboardState(), kept current on selection and focus changes. */
export function useClipboardState(): ClipboardState {
  const [st, setSt] = useState<ClipboardState>(NO_CLIPBOARD);
  useEffect(() => {
    const update = () => {
      const next = clipboardState();
      setSt((cur) => (cur.cut === next.cut && cur.copy === next.copy && cur.paste === next.paste ? cur : next));
    };
    const events = ['selectionchange', 'focusin', 'focusout', 'mouseup', 'keyup'] as const;
    // focusout fires before the new element has the focus: look again once it has
    const later = () => void setTimeout(update, 0);
    for (const e of events) document.addEventListener(e, e === 'focusout' ? later : update, true);
    update();
    return () => {
      for (const e of events) document.removeEventListener(e, e === 'focusout' ? later : update, true);
    };
  }, []);
  return st;
}
