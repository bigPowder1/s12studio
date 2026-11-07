/**
 * Modal prompts of the editor windows: "save changes?" (Save / Don't Save / Cancel), yes/no confirmations, error
 * messages, and Go to Line. Driven by a promise-returning `ask()` so the imperative editor API can await answers.
 */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog, PromptDialog } from '../../common/controls';

export type SaveAnswer = 'save' | 'discard' | 'cancel';

export type ModalRequest =
  | { kind: 'save'; name: string }
  | { kind: 'confirm'; title: string; text: string; ok: string; cancel: string }
  | { kind: 'message'; title: string; text: string }
  | { kind: 'gotoLine'; max: number; current: number };

type Answer<R extends ModalRequest> = R extends { kind: 'save' } ? SaveAnswer : R extends { kind: 'confirm' } ? boolean : R extends { kind: 'gotoLine' } ? number | null : void;

interface Pending {
  req: ModalRequest;
  resolve: (v: unknown) => void;
}

/** One modal at a time; later requests queue behind the open one. */
export function useEditorModals(): { ask: <R extends ModalRequest>(req: R) => Promise<Answer<R>>; modal: ReactNode } {
  const [queue, setQueue] = useState<Pending[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const ask = useCallback(<R extends ModalRequest>(req: R) => new Promise<Answer<R>>((resolve) => setQueue((q) => [...q, { req, resolve: resolve as (v: unknown) => void }])), []);
  const top = queue[0];
  const done = useCallback((v: unknown) => {
    const p = queueRef.current[0];
    setQueue((q) => q.slice(1));
    p?.resolve(v);
  }, []);
  return { ask, modal: top ? <EditorModal key={queue.length} req={top.req} done={done} /> : null };
}

function EditorModal({ req, done }: { req: ModalRequest; done: (v: unknown) => void }) {
  switch (req.kind) {
    case 'save':
      // UNCERTAIN: exact CodeWarrior wording (Windows IDE: Save changes to "x" before closing? Yes/No/Cancel)
      return (
        <Dialog
          title="Save Changes"
          open
          onClose={() => done('cancel')}
          width={380}
          testId="editor-save-prompt"
          buttons={
            <>
              <Button isDefault onClick={() => done('save')} testId="save-prompt-save">
                Save
              </Button>
              <Button onClick={() => done('discard')} testId="save-prompt-discard">
                {"Don't Save"}
              </Button>
              <Button onClick={() => done('cancel')} testId="save-prompt-cancel">
                Cancel
              </Button>
            </>
          }
        >
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <WarnIcon />
            <span>
              Save changes to the document &ldquo;{req.name}&rdquo; before closing?
            </span>
          </div>
        </Dialog>
      );
    case 'confirm':
      return (
        <Dialog
          title={req.title}
          open
          onClose={() => done(false)}
          width={400}
          testId="editor-confirm"
          buttons={
            <>
              <Button isDefault onClick={() => done(true)} testId="editor-confirm-ok">
                {req.ok}
              </Button>
              <Button onClick={() => done(false)} testId="editor-confirm-cancel">
                {req.cancel}
              </Button>
            </>
          }
        >
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <WarnIcon />
            <span style={{ whiteSpace: 'pre-wrap' }}>{req.text}</span>
          </div>
        </Dialog>
      );
    case 'message':
      return (
        <Dialog title={req.title} open onClose={() => done(undefined)} width={400} testId="editor-message">
          <span style={{ whiteSpace: 'pre-wrap' }}>{req.text}</span>
        </Dialog>
      );
    case 'gotoLine':
      // UNCERTAIN: CodeWarrior's dialog is titled "Go to Line" with a "Line Number:" field (from memory)
      return (
        <PromptDialog
          title="Go to Line"
          label={`Line Number (1-${req.max}):`}
          open
          initial={String(req.current)}
          validate={(v) => (/^\s*\d+\s*$/.test(v) && +v >= 1 ? null : 'Enter a line number')}
          onOk={(v) => done(Math.min(req.max, Math.max(1, parseInt(v, 10))))}
          onCancel={() => done(null)}
          testId="goto-line-dialog"
        />
      );
  }
}

function WarnIcon() {
  return (
    <svg width={32} height={32} viewBox="0 0 32 32" aria-hidden>
      <path d="M16 3 L30 28 H2 Z" fill="#ffd700" stroke="#000" />
      <rect x="14.5" y="11" width="3" height="10" fill="#000" />
      <rect x="14.5" y="23" width="3" height="3" fill="#000" />
    </svg>
  );
}
