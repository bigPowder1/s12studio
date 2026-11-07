/** Shared stub body for components that are not implemented yet. */
import type { DebuggerComponentProps } from './contract';

export function Placeholder({ title, note }: Pick<DebuggerComponentProps, 'title'> & { note: string }) {
  return (
    <div className="cw-placeholder" data-testid={`placeholder-${title}`}>
      {title}: {note}
    </div>
  );
}
