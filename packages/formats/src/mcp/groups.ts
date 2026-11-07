// 'PLst' ("Project File List") group tree decoder. Spec: mcp-format.md §2.4.
//   u16 version=1; u32 groupCount;
//   node := 'ROOT' u32 0, u32 0, u8 0, u32 nChildren
//         | 'GRUP' u32 flags, u32 groupId, u8 len, char name[len], u32 nChildren
//         | 'FILE' u32 fileRef
// Children follow their parent depth-first. Tags are FourCCs (byte-reversed on LE files).
import type { LoocReader } from '../looc/container';

export interface McpGroupNode {
  type: 'group';
  name: string;
  id: number;
  flags: number;
  children: McpGroupChild[];
}

export interface McpFileRefNode {
  type: 'file';
  ref: number;
  /** leaf name, filled in by readMcp when the ref is known */
  name?: string;
}

export type McpGroupChild = McpGroupNode | McpFileRefNode;

export interface McpGroupTree {
  version: number;
  groupCount: number;
  root: McpGroupNode;
}

export function decodeGroupTree(r: LoocReader, size: number, warnings: string[]): McpGroupTree | undefined {
  let o = 0;
  const need = (n: number) => {
    if (o + n > size) throw new RangeError('PLst truncated');
  };
  try {
    need(6);
    const version = r.u16(0);
    const groupCount = r.u32(2);
    o = 6;
    const readNode = (depth: number): McpGroupChild => {
      if (depth > 64) throw new RangeError('PLst nesting too deep');
      need(4);
      const tag = r.fourcc(o);
      o += 4;
      if (tag === 'FILE') {
        need(4);
        const ref = r.u32(o);
        o += 4;
        return { type: 'file', ref };
      }
      if (tag !== 'ROOT' && tag !== 'GRUP') throw new RangeError(`unknown PLst node tag ${JSON.stringify(tag)} at 0x${(o - 4).toString(16)}`);
      need(9);
      const flags = r.u32(o);
      const id = r.u32(o + 4);
      const len = r.u8(o + 8);
      o += 9;
      need(len + 4);
      const name = r.cstr(o, len);
      o += len;
      const n = r.u32(o);
      o += 4;
      const node: McpGroupNode = { type: 'group', name: tag === 'ROOT' ? '' : name, id, flags, children: [] };
      for (let i = 0; i < n; i++) node.children.push(readNode(depth + 1));
      return node;
    };
    const root = readNode(0);
    if (root.type !== 'group') throw new RangeError('PLst does not start with ROOT');
    if (o !== size) warnings.push(`PLst: ${size - o} trailing bytes ignored`);
    return { version, groupCount, root };
  } catch (e) {
    warnings.push(`PLst decode failed: ${(e as Error).message}`);
    return undefined;
  }
}
