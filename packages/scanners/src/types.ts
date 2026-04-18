export interface TodoEntry {
  kind: 'TODO' | 'FIXME' | 'HACK' | 'XXX' | 'NOTE';
  line: number;
  text: string;
}
