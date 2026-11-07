/**
 * ListView (report-style list with column headers) and TreeView (hierarchical rows with +/- toggles and optional
 * extra columns, as the CodeWarrior project window uses).
 */
import { useState, type HTMLAttributes, type ReactNode } from 'react';

/** Extra attributes/handlers for a row (drag and drop, data-* attributes...). Added by the IDE shell track. */
export type RowProps = Omit<HTMLAttributes<HTMLTableRowElement>, 'className' | 'children'> & Record<`data-${string}`, string | undefined>;

export interface Column<T> {
  id: string;
  header: ReactNode;
  width?: number | string;
  align?: 'left' | 'right' | 'center';
  render: (row: T) => ReactNode;
}

export interface ListViewProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  selected?: string | null;
  onSelect?: (key: string, row: T) => void;
  onActivate?: (key: string, row: T) => void;
  onContextMenu?: (e: React.MouseEvent, key: string, row: T) => void;
  rowStyle?: (row: T) => React.CSSProperties | undefined;
  /** Extra row attributes (e.g. draggable + drag handlers). */
  rowProps?: (row: T, index: number) => RowProps | undefined;
  /** Extra class names for a row (e.g. 'drop-before'). */
  rowClass?: (row: T, index: number) => string | undefined;
  testId?: string;
}

export function ListView<T>({ columns, rows, rowKey, selected, onSelect, onActivate, onContextMenu, rowStyle, rowProps, rowClass, testId }: ListViewProps<T>) {
  return (
    <div className="cw-listview cw-sunken" data-testid={testId}>
      <table>
        <colgroup>
          {columns.map((c) => (
            <col key={c.id} style={{ width: c.width }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.id} style={{ textAlign: c.align }}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const k = rowKey(r);
            const extra = rowClass?.(r, i);
            return (
              <tr
                {...rowProps?.(r, i)}
                key={k}
                data-key={k}
                className={`cw-row${selected === k ? ' selected' : ''}${extra ? ` ${extra}` : ''}`}
                style={rowStyle?.(r)}
                onMouseDown={() => onSelect?.(k, r)}
                onDoubleClick={() => onActivate?.(k, r)}
                onContextMenu={(e) => {
                  onSelect?.(k, r);
                  onContextMenu?.(e, k, r);
                }}
              >
                {columns.map((c) => (
                  <td key={c.id} style={{ textAlign: c.align }}>
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export interface TreeNode<T = unknown> {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  children?: TreeNode<T>[];
  data?: T;
}

export interface TreeViewProps<T> {
  nodes: TreeNode<T>[];
  /** Extra columns after the tree column. */
  columns?: Column<TreeNode<T>>[];
  /** Extra columns before the tree column (CodeWarrior's touch column). */
  leadingColumns?: Column<TreeNode<T>>[];
  /** Extra row attributes (drag and drop...). */
  rowProps?: (node: TreeNode<T>) => RowProps | undefined;
  rowClass?: (node: TreeNode<T>) => string | undefined;
  treeHeader?: ReactNode;
  treeWidth?: number | string;
  selected?: string | null;
  onSelect?: (node: TreeNode<T>) => void;
  onActivate?: (node: TreeNode<T>) => void;
  onContextMenu?: (e: React.MouseEvent, node: TreeNode<T>) => void;
  /** Initially expanded keys (default: all groups). */
  defaultExpanded?: string[];
  testId?: string;
}

export function TreeView<T>({ nodes, columns = [], leadingColumns = [], treeHeader, treeWidth, selected, onSelect, onActivate, onContextMenu, rowProps, rowClass, defaultExpanded, testId }: TreeViewProps<T>) {
  // Without defaultExpanded every group starts expanded, including groups added later (tracked as a collapsed set).
  const [explicit, setExplicit] = useState<Set<string>>(() => new Set(defaultExpanded ?? []));
  const expanded = { has: (k: string) => (defaultExpanded ? explicit.has(k) : !explicit.has(k)) };
  const setExpanded = setExplicit;
  const rows: { node: TreeNode<T>; depth: number }[] = [];
  const walk = (ns: TreeNode<T>[], depth: number) => {
    for (const n of ns) {
      rows.push({ node: n, depth });
      if (n.children && expanded.has(n.key)) walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  const toggle = (k: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  return (
    <div className="cw-listview cw-sunken" role="tree" data-testid={testId}>
      <table>
        <colgroup>
          {leadingColumns.map((c) => (
            <col key={c.id} style={{ width: c.width }} />
          ))}
          <col style={{ width: treeWidth }} />
          {columns.map((c) => (
            <col key={c.id} style={{ width: c.width }} />
          ))}
        </colgroup>
        {(treeHeader !== undefined || columns.length > 0 || leadingColumns.length > 0) && (
          <thead>
            <tr>
              {leadingColumns.map((c) => (
                <th key={c.id} style={{ textAlign: c.align }}>
                  {c.header}
                </th>
              ))}
              <th>{treeHeader}</th>
              {columns.map((c) => (
                <th key={c.id} style={{ textAlign: c.align }}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map(({ node, depth }) => (
            <tr
              {...rowProps?.(node)}
              key={node.key}
              role="treeitem"
              aria-expanded={node.children ? expanded.has(node.key) : undefined}
              data-key={node.key}
              className={`cw-row${selected === node.key ? ' selected' : ''}${rowClass?.(node) ? ` ${rowClass(node)}` : ''}`}
              onMouseDown={() => onSelect?.(node)}
              onDoubleClick={() => (node.children ? toggle(node.key) : onActivate?.(node))}
              onContextMenu={(e) => {
                onSelect?.(node);
                onContextMenu?.(e, node);
              }}
            >
              {leadingColumns.map((c) => (
                <td key={c.id} style={{ textAlign: c.align }}>
                  {c.render(node)}
                </td>
              ))}
              <td style={{ paddingLeft: 4 + depth * 16 }}>
                {node.children ? (
                  <span
                    className="cw-tree-toggle"
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      toggle(node.key);
                    }}
                  >
                    {expanded.has(node.key) ? '−' : '+'}
                  </span>
                ) : (
                  <span style={{ display: 'inline-block', width: 12 }} />
                )}
                {node.icon && <span style={{ marginRight: 3 }}>{node.icon}</span>}
                {node.label}
              </td>
              {columns.map((c) => (
                <td key={c.id} style={{ textAlign: c.align }}>
                  {c.render(node)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
